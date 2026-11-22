"""The storage inventory and the selected deletions of one data directory (x-phasyn-extension).

A Node answers ``GET /api/node/storage`` and ``POST /api/node/storage/clean`` with these functions over its
FileStore and RecordingStore; the Controller uses the same ones for its own uploads and recording copies. Nothing
here decides what may be collected: the Controller's reference graph does. This module only lists what is on disk
and deletes exactly the listed items, keeping anything the caller reports as busy (inputs of active calls, downloads
in progress, recordings still being written). Every item is answered on its own: one failure never stops the rest.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable, Iterator, Mapping
from pathlib import Path
from typing import Any

from .canonical import read_json
from .errors import ComponentError
from .files import META, PAYLOAD, FileStore
from .ids import is_uuid
from .records import RecordingStore
from .typed import file_links, is_fileref


log = logging.getLogger("phasyn_components.storage")

type FileKey = tuple[str, str]


def key_of(ref: Mapping[str, Any]) -> FileKey:
    """(node_id, file_id) in lowercase: the identity of a FileRef or StorageFileKey."""
    return str(ref.get("node_id") or "").lower(), str(ref.get("file_id") or "").lower()


def fileref_keys(value: Any) -> Iterator[FileKey]:
    """Every FileRef in any JSON value, with its ``metadata.links`` attachments (iteratively, any depth)."""
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, Mapping):
            if is_fileref(current):
                yield key_of(current)
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def tree_size(path: Path) -> int:
    """Bytes of the regular files under ``path`` (links are not followed; unreadable entries count 0)."""
    total = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _published(directory: Path) -> dict[str, Any] | None:
    try:
        doc = read_json(directory / META)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("published") is not True:
        return None
    ref = doc.get("fileref")
    if not is_fileref(ref):
        return None
    return doc


def _links(ref: Mapping[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    stack = list(file_links(ref).values())
    while stack:
        link = stack.pop()
        node, fid = key_of(link)
        out.append({"node_id": node, "file_id": fid})
        stack.extend(file_links(link).values())
    return out


def _stamp(doc: Mapping[str, Any]) -> str | None:
    value = doc.get("created_at")
    return value if isinstance(value, str) and len(value) <= 64 else None  # noqa: PLR2004


def _payload_size(directory: Path, declared: int) -> int:
    try:
        return (directory / PAYLOAD).stat().st_size
    except OSError:
        return declared


def local_files(store: FileStore) -> list[dict[str, Any]]:
    """The published files of this store (not the downloaded copies of other nodes' files)."""
    out: list[dict[str, Any]] = []
    try:
        entries = sorted(store.root.iterdir())
    except OSError:
        return out
    for entry in entries:
        if not is_uuid(entry.name) or not entry.is_dir():
            continue
        doc = _published(entry)
        if doc is None:
            continue
        ref = doc["fileref"]
        out.append(
            {
                "file_id": entry.name.lower(),
                "size_bytes": _payload_size(entry, int(ref["size_bytes"])),
                "sha256": str(ref["sha256"]),
                "created_at": _stamp(doc),
                "links": _links(ref),
            }
        )
    return out


def remote_copies(store: FileStore) -> list[dict[str, Any]]:
    """The verified downloads under ``files/remote/<origin node>/<file_id>``."""
    out: list[dict[str, Any]] = []
    root = store.root / "remote"
    try:
        origins = sorted(root.iterdir())
    except OSError:
        return out
    for origin in origins:
        if not is_uuid(origin.name) or not origin.is_dir():
            continue
        try:
            entries = sorted(origin.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not is_uuid(entry.name) or not entry.is_dir():
                continue
            doc = _published(entry)
            if doc is None:
                continue
            ref = doc["fileref"]
            out.append(
                {
                    "node_id": origin.name.lower(),
                    "file_id": entry.name.lower(),
                    "size_bytes": _payload_size(entry, int(ref["size_bytes"])),
                    "sha256": str(ref["sha256"]),
                    "created_at": _stamp(doc),
                }
            )
    return out


def recordings_of(
    recordings: RecordingStore, open_ids: Iterable[str]
) -> list[dict[str, Any]]:
    """Indexed recordings with their directory size; ``open``: no summary yet, or still being written."""
    still_open = {rid.lower() for rid in open_ids}
    out: list[dict[str, Any]] = []
    for rid, created_at, run_id, finished in recordings.retention_rows():
        if not is_uuid(rid):
            continue
        directory = recordings.root / rid
        out.append(
            {
                "recording_id": rid.lower(),
                "created_at": created_at or None,
                "run_id": run_id.lower() if run_id and is_uuid(run_id) else None,
                "size_bytes": tree_size(directory) if directory.is_dir() else 0,
                "open": not finished or rid.lower() in still_open,
            }
        )
    return out


def inventory(
    store: FileStore,
    recordings: RecordingStore,
    *,
    busy: Iterable[FileKey] = (),
    open_recordings: Iterable[str] = (),
) -> dict[str, Any]:
    """NodeStorageInventory of one data directory."""
    return {
        "node_id": store.node_id.lower(),
        "files": local_files(store),
        "remote": remote_copies(store),
        "recordings": recordings_of(recordings, open_recordings),
        "busy_files": [{"node_id": n, "file_id": f} for n, f in sorted(set(busy))],
    }


def _failed(item: dict[str, Any], err: ComponentError, what: str) -> dict[str, Any]:
    log.warning("儲存清理：%s %s 無法刪除：%s", what, item["id"], err)
    return {**item, "status": "failed", "code": err.code, "message": err.message}


def clean(
    store: FileStore,
    recordings: RecordingStore,
    request: Mapping[str, Any],
    *,
    busy: Iterable[FileKey] = (),
    open_recordings: Iterable[str] = (),
) -> dict[str, Any]:
    """Delete the listed items (NodeStorageCleanRequest → NodeStorageCleanResult); busy ones are ``kept``."""
    held = set(busy)
    still_open = {rid.lower() for rid in open_recordings}
    me = store.node_id.lower()
    items: list[dict[str, Any]] = []
    for raw in request.get("files") or []:
        fid = str(raw).lower()
        meta = store.meta(fid)
        item: dict[str, Any] = {
            "kind": "file",
            "node_id": me,
            "id": fid,
            "size_bytes": int(meta["fileref"]["size_bytes"]) if meta else None,
        }
        if (me, fid) in held:
            items.append({**item, "status": "kept"})
            continue
        try:
            items.append(
                {**item, "status": "deleted" if store.delete(fid) else "missing"}
            )
        except ComponentError as err:
            items.append(_failed(item, err, "檔案"))
    for ref in request.get("remote") or []:
        key = key_of(ref)
        found = _published(
            store.remote_directory({"node_id": key[0], "file_id": key[1]})
        )
        item = {
            "kind": "remote",
            "node_id": key[0],
            "id": key[1],
            "size_bytes": int(found["fileref"]["size_bytes"]) if found else None,
        }
        if key in held:
            items.append({**item, "status": "kept"})
            continue
        try:
            removed = store.delete_remote({"node_id": key[0], "file_id": key[1]})
            items.append({**item, "status": "deleted" if removed else "missing"})
        except ComponentError as err:
            items.append(_failed(item, err, "遠端副本"))
    for raw in request.get("recordings") or []:
        rid = str(raw).lower()
        directory = recordings.root / rid
        item = {
            "kind": "recording",
            "node_id": me,
            "id": rid,
            "size_bytes": tree_size(directory) if directory.is_dir() else None,
        }
        if rid in still_open or (
            directory.is_dir() and recordings.read_summary(rid) is None
        ):
            items.append({**item, "status": "kept"})
            continue
        try:
            items.append(
                {**item, "status": "deleted" if recordings.delete(rid) else "missing"}
            )
        except ComponentError as err:
            items.append(_failed(item, err, "紀錄"))
    return {"items": items}


__all__ = [
    "FileKey",
    "clean",
    "fileref_keys",
    "inventory",
    "key_of",
    "local_files",
    "recordings_of",
    "remote_copies",
    "tree_size",
]
