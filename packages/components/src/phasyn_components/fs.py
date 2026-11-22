"""Crash-safe file replacement shared by every package.

Readers always see either the complete old file or the complete new one: the data goes to a
temporary file in the target's directory, is flushed and fsynced, renamed over the target, and the
directory is fsynced so the rename itself survives a power loss. On any error the temporary file is
removed and the target is left untouched.
"""

from __future__ import annotations

import contextlib
import errno
import json
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO


# Filesystems that cannot fsync a directory report one of these; the rename is still atomic there.
_DIR_FSYNC_UNSUPPORTED = frozenset({errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP})


def fsync_dir(directory: Path) -> None:
    """Persist the directory entry changes (renames, creations) made inside ``directory``."""
    fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    except OSError as exc:
        if exc.errno not in _DIR_FSYNC_UNSUPPORTED:
            raise
    finally:
        os.close(fd)


@contextlib.contextmanager
def atomic_writer(path: Path) -> Iterator[BinaryIO]:
    """Yield a binary file whose content replaces ``path`` atomically when the block succeeds.

    The parent directory is created if needed. The new file is created with mode ``0o600``.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    try:
        with os.fdopen(fd, "wb") as fh:
            yield fh
            fh.flush()
            os.fsync(fh.fileno())
        Path(tmp).replace(target)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            Path(tmp).unlink()
        raise
    fsync_dir(target.parent)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Atomically replace the destination with the supplied bytes."""
    with atomic_writer(path) as fh:
        fh.write(data)


def atomic_write_json(path: Path, obj: Any, *, indent: int | None = 2) -> None:
    """Atomically write ``obj`` as UTF-8 JSON (NaN and Infinity are rejected with ``ValueError``)."""
    data = json.dumps(obj, ensure_ascii=False, allow_nan=False, indent=indent).encode(
        "utf-8"
    )
    atomic_write_bytes(path, data)


__all__ = ["atomic_write_bytes", "atomic_write_json", "atomic_writer", "fsync_dir"]
