"""Local-file guards, cancel-aware hashing and atomic publication of outputs.

Media input only comes from already-uploaded local artifacts:
anything that is a URL, a protocol string, a directory, FIFO, device, socket
or an empty/oversized file is rejected before any tool sees it.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._paths import absolute
from .errors import MediaError, raise_if_canceled
from .limits import DEFAULT_LIMITS, MediaLimits
from .tools import is_within


_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")
HASH_CHUNK = 4 * 1024 * 1024


@dataclass(frozen=True)
class LocalFile:
    """Identity and size of a validated local media file."""

    path: Path  # absolute (symlinks resolved)
    size_bytes: int
    inode: tuple[int, int, int]  # (st_dev, st_ino, st_mtime_ns)


def check_local_file(
    path: Any,
    *,
    limits: MediaLimits = DEFAULT_LIMITS,
    allowed_roots: Sequence[str | os.PathLike[str]] | None = None,
    field_path: str | None = None,
) -> LocalFile:
    """Return the resolved regular file or raise ``INVALID_ARGUMENT``."""
    fields = [field_path] if field_path else []
    if not isinstance(path, (str, os.PathLike)):
        raise MediaError(
            "INVALID_ARGUMENT", "媒體輸入必須是本機檔案路徑", field_paths=fields
        )
    text = os.fspath(path)
    if isinstance(text, bytes) or not text or "\x00" in text:
        raise MediaError("INVALID_ARGUMENT", "媒體輸入路徑不合法", field_paths=fields)
    if "://" in text or (not Path(text).is_absolute() and _SCHEME.match(text)):
        raise MediaError(
            "INVALID_ARGUMENT",
            "只接受已上傳的本機 artifact，不讀取 URL 或協定字串",
            field_paths=fields,
        )
    resolved = Path(os.path.realpath(absolute(text)))
    try:
        st = resolved.stat()
    except FileNotFoundError:
        raise MediaError(
            "INVALID_ARGUMENT", "媒體檔案不存在", field_paths=fields
        ) from None
    except OSError as exc:
        raise MediaError(
            "INVALID_ARGUMENT", f"無法讀取媒體檔案：{exc.strerror}", field_paths=fields
        ) from None
    if not stat.S_ISREG(st.st_mode):
        raise MediaError(
            "INVALID_ARGUMENT",
            "媒體輸入必須是單一一般檔案（不接受目錄、裝置、FIFO 或 socket）",
            field_paths=fields,
        )
    if st.st_size <= 0:
        raise MediaError("INVALID_ARGUMENT", "媒體檔案是空的", field_paths=fields)
    if st.st_size > limits.max_file_bytes:
        raise MediaError(
            "INVALID_ARGUMENT",
            "媒體檔案超過大小上限",
            field_paths=fields,
            expected=f"<= {limits.max_file_bytes} bytes",
            actual=f"{st.st_size} bytes",
        )
    if allowed_roots is not None and not is_within(
        resolved, [Path(r) for r in allowed_roots]
    ):
        raise MediaError(
            "INVALID_ARGUMENT", "媒體檔案不在授權的目錄內", field_paths=fields
        )
    return LocalFile(resolved, int(st.st_size), (st.st_dev, st.st_ino, st.st_mtime_ns))


def unchanged_since(local: LocalFile) -> bool:
    """Check whether the file still has its validated identity."""
    try:
        st = Path(local.path).stat()
    except OSError:
        return False
    return (
        st.st_dev,
        st.st_ino,
        st.st_mtime_ns,
    ) == local.inode and st.st_size == local.size_bytes


def file_sha256(
    path: str | os.PathLike[str], *, cancel: Any = None, chunk: int = HASH_CHUNK
) -> tuple[str, int]:
    """Streaming SHA-256 (lower-case hex, size) with cancel checks per chunk."""
    digest = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as fh:
        while True:
            raise_if_canceled(cancel, "雜湊計算")
            block = fh.read(chunk)
            if not block:
                break
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def partial_path(final: Path, suffix: str | None = None) -> Path:
    """Hidden, unique temp path next to ``final`` (same filesystem for atomic rename)."""
    ext = final.suffix if suffix is None else suffix
    return final.with_name(
        f".{final.stem}.partial-{os.getpid()}-{uuid.uuid4().hex[:12]}{ext}"
    )


def fsync_file(path: Path) -> None:
    """Flush file contents to stable storage."""
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_dir(directory: Path) -> None:
    """Flush directory changes to stable storage."""
    try:
        fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def publish(partial: Path, final: Path) -> None:
    """Fsync and atomically rename a finished temp file onto its final name."""
    fsync_file(partial)
    Path(partial).replace(final)
    fsync_dir(final.parent)


def remove_quietly(path: Path | None) -> None:
    """Remove the temporary file if it exists."""
    if path is None:
        return
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def check_output_path(output: Any, *, inputs: Sequence[Path] = ()) -> Path:
    """Validate a proposed destination before writing media."""
    if not isinstance(output, (str, os.PathLike)):
        raise MediaError("INVALID_ARGUMENT", "輸出必須是本機檔案路徑")
    text = os.fspath(output)
    if isinstance(text, bytes) or not text or "://" in text or "\x00" in text:
        raise MediaError("INVALID_ARGUMENT", "輸出路徑不合法")
    final = absolute(text)
    if not final.parent.is_dir():
        raise MediaError("INVALID_ARGUMENT", "輸出目錄不存在")
    if final.exists() and not final.is_file():
        raise MediaError("INVALID_ARGUMENT", "輸出路徑已存在且不是一般檔案")
    real_final = os.path.realpath(final)
    for item in inputs:
        if real_final == os.path.realpath(item):
            raise MediaError("INVALID_ARGUMENT", "輸出不可覆寫輸入檔案")
    return final
