"""Single-writer lock on a ``data_dir``: an exclusive, non-blocking ``flock`` on ``<data_dir>/.lock``.

It only keeps two local processes from writing the same data; it is not a distributed lock or a lease.
The holder's PID is written into the file so the refusal can name it. POSIX only (``fcntl``).
"""

from __future__ import annotations

import errno
import fcntl
import os
from pathlib import Path

LOCK_FILE = ".lock"
_BUSY_ERRNOS = frozenset({errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES})


class DataDirBusy(Exception):
    """Another process holds the lock (or the lock file cannot be created)."""


class DataDirLock:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / LOCK_FILE
        self._fd: int | None = None

    @property
    def held(self) -> bool:
        return self._fd is not None

    def acquire(self) -> None:
        if self._fd is not None:
            return
        try:
            # Recordings hold prompts and file names: a data directory this service creates is its owner's only.
            # An existing directory keeps the permissions its operator gave it.
            self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        except OSError as exc:
            raise DataDirBusy(f"無法建立資料目錄鎖 {self.path}：{exc.strerror or exc}") from exc
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            holder = self._holder(fd)
            os.close(fd)
            if exc.errno in _BUSY_ERRNOS:
                who = f"（持有者 PID {holder}）" if holder else ""
                raise DataDirBusy(
                    f"data_dir {self.data_dir} 已被另一個程序使用{who}；同一個 data_dir 只能有一個 writer，"
                    "請先停止另一個程序，或改用不同的 data_dir"
                ) from exc
            raise DataDirBusy(f"無法鎖定資料目錄 {self.path}：{exc.strerror or exc}") from exc
        try:
            os.ftruncate(fd, 0)
            os.pwrite(fd, f"{os.getpid()}\n".encode("ascii"), 0)
        except OSError:
            pass  # the PID is informational only
        self._fd = fd

    @staticmethod
    def _holder(fd: int) -> str:
        try:
            text = os.pread(fd, 64, 0).decode("ascii", "replace").strip()
        except OSError:
            return ""
        return text if text.isdigit() else ""

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            os.close(fd)

    def __enter__(self) -> DataDirLock:
        self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


__all__ = ["LOCK_FILE", "DataDirBusy", "DataDirLock"]
