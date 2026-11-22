"""Pick video files that already sit on the Controller's machine (``import_roots`` of the Controller config).

Only directories named in the configuration are browsable; nothing else is. Paths are relative to one root,
walked component by component without following a symbolic link, and a file is imported only when it is a
regular single-link file with a video extension. Importing copies the bytes into the Controller's file store
(hashed while copied, the source checked unchanged afterwards); the source is never modified or moved.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore


VIDEO_EXTENSIONS = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".m4v": "video/mp4",
    ".avi": "video/x-msvideo",
}
MAX_ENTRIES = 500
_BLOCK = 8 * 1024 * 1024


def _refuse(message: str) -> ComponentError:
    return ComponentError("INVALID_ARGUMENT", message, status=422)


def _parts(relative: str) -> list[str]:
    if "\x00" in relative or relative.startswith(("/", "\\")):
        raise _refuse("路徑必須是匯入資料夾內的相對路徑")
    parts = [
        p
        for p in PurePosixPath(relative.replace("\\", "/")).parts
        if p not in ("", ".")
    ]
    if any(p == ".." for p in parts):
        raise _refuse("路徑不可離開匯入資料夾")
    return parts


def resolve(
    roots: Sequence[Path], root: int, relative: str
) -> tuple[Path, os.stat_result]:
    """The path inside ``roots[root]`` and its lstat, refusing links and escapes."""
    if not 0 <= root < len(roots):
        raise ComponentError("NOT_FOUND", "沒有這個匯入資料夾", status=404)
    current = roots[root]
    info = current.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise _refuse("匯入資料夾不是一般資料夾")
    for part in _parts(relative):
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError as exc:
            raise ComponentError(
                "NOT_FOUND", "找不到這個檔案或資料夾", status=404
            ) from exc
        if stat.S_ISLNK(info.st_mode):
            raise _refuse("不跟隨符號連結")
    return current, info


def roots_listing(roots: Sequence[Path]) -> dict[str, Any]:
    """The configured roots (by index and folder name only)."""
    return {
        "roots": [{"root": i, "name": r.name or str(i)} for i, r in enumerate(roots)]
    }


def listing(roots: Sequence[Path], root: int, relative: str) -> dict[str, Any]:
    """Folders and video files of one directory inside a root."""
    path, info = resolve(roots, root, relative)
    if not stat.S_ISDIR(info.st_mode):
        raise _refuse("這不是資料夾")
    entries: list[dict[str, Any]] = []
    with os.scandir(path) as it:
        for entry in it:
            if entry.name.startswith(".") or entry.is_symlink():
                continue
            st = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                entries.append({"name": entry.name, "kind": "folder"})
            elif (
                stat.S_ISREG(st.st_mode)
                and Path(entry.name).suffix.lower() in VIDEO_EXTENSIONS
            ):
                entries.append(
                    {
                        "name": entry.name,
                        "kind": "video",
                        "size_bytes": st.st_size,
                        "modified": st.st_mtime,
                    }
                )
            if len(entries) >= MAX_ENTRIES:
                break
    entries.sort(key=lambda e: (e["kind"] != "folder", e["name"].lower()))
    parts = _parts(relative)
    return {
        "root": root,
        "path": "/".join(parts),
        "entries": entries,
        "truncated": len(entries) >= MAX_ENTRIES,
    }


def import_file(
    roots: Sequence[Path], root: int, relative: str, store: FileStore, *, max_bytes: int
) -> dict[str, Any]:
    """Copy one video into the file store and return its FileRef."""
    path, info = resolve(roots, root, relative)
    media_type = VIDEO_EXTENSIONS.get(path.suffix.lower())
    if not stat.S_ISREG(info.st_mode) or media_type is None:
        raise _refuse("只能匯入影片檔")
    if info.st_nlink != 1:
        raise _refuse("拒絕有多個硬連結的檔案")
    if info.st_size > max_bytes:
        raise ComponentError("PAYLOAD_TOO_LARGE", "檔案超過上傳上限", status=413)
    writer = store.new_writer(
        media_type, {"original_name": path.name[:255], "source": "local_import"}
    )
    try:
        _copy(path, info, writer)
        return writer.commit(expected_size=info.st_size)
    except BaseException:
        writer.abort()
        raise


def _copy(path: Path, info: os.stat_result, writer: Any) -> None:
    """Stream the very file that was checked (same inode, unchanged size and time) into ``writer``."""
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_ino, opened.st_dev) != (info.st_ino, info.st_dev):
            raise _refuse("檔案在匯入時被替換")
        while block := handle.read(_BLOCK):
            writer.write(block)
    after = path.lstat()
    if (after.st_size, after.st_mtime_ns) != (info.st_size, info.st_mtime_ns):
        raise ComponentError("INTEGRITY_MISMATCH", "檔案在匯入時被修改")


__all__ = ["VIDEO_EXTENSIONS", "import_file", "listing", "resolve", "roots_listing"]
