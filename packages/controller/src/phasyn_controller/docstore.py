"""以本地 ID 為檔名的 JSON 文件（pipeline 草稿、preset、Studio 專案）。單一 writer、原子替換."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from phasyn_components.canonical import read_json
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.fs import atomic_write_json
from phasyn_components.ids import is_local_id, require_local_id


log = logging.getLogger("phasyn_controller.docstore")


class JsonDocStore:
    """Persist documents under validated local IDs using atomic replacement."""

    def __init__(self, root: Path, *, id_field: str, what: str) -> None:
        """Bind a document directory to its ID field and error label."""
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.id_field = id_field
        self.what = what

    def path(self, doc_id: str) -> Path:
        """Return the local path for the validated document identity."""
        return self.root / f"{require_local_id(doc_id, self.id_field)}.json"

    def entries(self) -> list[Path]:
        """The document files with valid local IDs, in name order (nothing is read)."""
        return [
            entry
            for entry in sorted(self.root.glob("*.json"))
            if is_local_id(entry.stem)
        ]

    def read_entry(self, entry: Path) -> dict[str, Any] | None:
        """One listed document, or None when it cannot be read or names another ID."""
        try:
            doc = read_json(entry)
        except (OSError, ValueError) as exc:
            log.warning("略過無法讀取的%s %s：%s", self.what, entry.name, exc)
            return None
        if isinstance(doc, dict) and doc.get(self.id_field) == entry.stem:
            return doc
        return None

    def list(self) -> list[dict[str, Any]]:
        """List readable documents with valid local IDs."""
        return [
            doc
            for entry in self.entries()
            if (doc := self.read_entry(entry)) is not None
        ]

    def get(self, doc_id: str) -> dict[str, Any]:
        """Read one stored JSON object or report that its ID is missing."""
        path = self.path(doc_id)
        try:
            doc = read_json(path)
        except FileNotFoundError as exc:
            raise ComponentError(
                "NOT_FOUND",
                f"找不到{self.what} {doc_id}",
                details={self.id_field: doc_id},
            ) from exc
        except (OSError, ValueError) as exc:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"{self.what} {doc_id} 無法讀取：{exception_message(exc)}",
            ) from exc
        if not isinstance(doc, dict):
            raise ComponentError(
                "RUNTIME_ERROR", f"{self.what} {doc_id} 內容不是 JSON object"
            )
        return doc

    def put(self, doc_id: str, doc: dict[str, Any]) -> dict[str, Any]:
        """Atomically save and return a JSON document."""
        atomic_write_json(self.path(doc_id), doc)
        return doc

    def delete(self, doc_id: str) -> bool:
        """刪除文件檔；不存在 → False."""
        try:
            self.path(doc_id).unlink()
        except FileNotFoundError:
            return False
        except OSError as exc:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"{self.what} {doc_id} 無法刪除：{exception_message(exc)}",
            ) from exc
        return True


type Stamp = tuple[int, int, int]


def file_stamp(path: Path) -> Stamp:
    """The identity of one file version: inode, modification time (ns) and size.

    Every write is an atomic replacement (a new inode with a new mtime), so a changed document never keeps its stamp.
    """
    stat = path.stat()
    return (stat.st_ino, stat.st_mtime_ns, stat.st_size)


class DocProjection[T]:
    """Memoize a pure projection of each stored document per file version.

    Listing then reads and projects only the documents whose file changed since the last call, whoever wrote them.
    ``project`` returns None to leave a document out of ``all`` (for example an invalid one); it may raise, and a
    raised error is never cached. Projected values are shared between callers and must be treated as read-only.
    """

    def __init__(
        self, store: JsonDocStore, project: Callable[[dict[str, Any]], T | None]
    ) -> None:
        """Bind the projection to the documents of one store."""
        self._store = store
        self._project = project
        self._memo: dict[str, tuple[Stamp, T | None]] = {}
        self._lock = threading.Lock()

    def _remember(self, doc_id: str, stamp: Stamp, value: T | None) -> None:
        with self._lock:
            self._memo[doc_id] = (stamp, value)

    def _hit(self, doc_id: str, stamp: Stamp) -> tuple[bool, T | None]:
        with self._lock:
            memo = self._memo.get(doc_id)
        if memo is not None and memo[0] == stamp:
            return True, memo[1]
        return False, None

    def one(self, doc_id: str) -> T | None:
        """The projection of one document (the store's NOT_FOUND or read error when it cannot be read).

        The stamp is taken before the read: a write in between is projected under the older stamp, so the next call
        sees a changed stamp and projects again (never a stale value).
        """
        path = self._store.path(doc_id)
        try:
            stamp = file_stamp(path)
        except OSError:
            # Uncached: the read reports its own error (NOT_FOUND for a missing document).
            return self._project(self._store.get(doc_id))
        hit, value = self._hit(doc_id, stamp)
        if hit:
            return value
        value = self._project(self._store.get(doc_id))
        self._remember(doc_id, stamp, value)
        return value

    def all(self) -> list[T]:
        """The projections of every listed document that projects to a value, in name order."""
        out: list[T] = []
        listed: set[str] = set()
        for entry in self._store.entries():
            try:
                stamp = file_stamp(entry)
            except OSError as exc:
                log.warning(
                    "略過無法讀取的%s %s：%s", self._store.what, entry.name, exc
                )
                continue
            listed.add(entry.stem)
            hit, value = self._hit(entry.stem, stamp)
            if not hit:
                doc = self._store.read_entry(entry)
                if doc is None:
                    continue
                value = self._project(doc)
                self._remember(entry.stem, stamp, value)
            if value is not None:
                out.append(value)
        with self._lock:
            for doc_id in self._memo.keys() - listed:
                del self._memo[doc_id]
        return out


__all__ = ["DocProjection", "JsonDocStore", "Stamp", "file_stamp"]
