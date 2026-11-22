"""Durable reservations and deduplicated historical responses for Studio document mutations."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import zlib
from collections.abc import Iterator
from contextlib import closing
from http import HTTPStatus
from pathlib import Path
from typing import Any

from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError
from phasyn_components.ids import is_local_id, require_local_id


type Doc = dict[str, Any]

_MIN_CHUNK = 2048
_MAX_CHUNK = 16384
# Structural landmarks keep unchanged ranges reusable when an earlier shot or clip grows.
_LANDMARK = re.compile(rb'[}\]],(?=["{\[])')


def chunks(raw: bytes) -> Iterator[bytes]:
    """Partition the exact canonical payload with bounded chunk sizes and stable JSON landmarks."""
    start = 0
    while len(raw) - start > _MIN_CHUNK:
        end = min(start + _MAX_CHUNK, len(raw))
        match = _LANDMARK.search(raw, start + _MIN_CHUNK, end)
        cut = match.end() if match else end
        yield raw[start:cut]
        start = cut
    if start < len(raw):
        yield raw[start:]


def key_identity(value: str) -> str:
    """Validate a caller-supplied idempotency key."""
    if not is_local_id(value):
        raise ComponentError("INVALID_ARGUMENT", "Studio 寫入收據鍵格式無效")
    return hashlib.sha256(value.encode("ascii")).hexdigest()


class StudioLedger:
    """One global operation per key; payload pages are shared within each live project."""

    def __init__(self, path: Path) -> None:
        """Select the SQLite receipt database."""
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA secure_delete=ON")
        with db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, project TEXT NOT NULL, operation TEXT NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, project_revision INTEGER, result_sha TEXT, chunks TEXT)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS receipts_project ON receipts(project)"
            )
            db.execute("CREATE TABLE IF NOT EXISTS deleting (project TEXT PRIMARY KEY)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS payloads (project TEXT NOT NULL, sha TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(project, sha))"
            )
        return db

    def reserve(self, key: str, project: str, operation: str, signature: str) -> bool:
        """Commit the key and request fingerprint before calling any document mutation."""
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self._resolve_delete(db, project)
            row = db.execute(
                "SELECT project,operation,signature,state FROM receipts WHERE key=?",
                (key,),
            ).fetchone()
            if row is None:
                db.execute(
                    "INSERT INTO receipts(key,project,operation,signature,state) VALUES(?,?,?,?,'reserved')",
                    (key, project, operation, signature),
                )
                return True
            if (row["project"], row["operation"], row["signature"]) != (
                project,
                operation,
                signature,
            ):
                raise ComponentError(
                    "STATE_CONFLICT", "Studio 收據鍵已綁定其他寫入內容或操作"
                )
            return False

    def finish(
        self,
        key: str,
        project: str,
        *,
        status: int,
        revision: int | None,
        document: Doc,
    ) -> None:
        """Commit a final response and its deduplicated payload."""
        state = (
            "committed"
            if HTTPStatus.OK <= status < HTTPStatus.MULTIPLE_CHOICES
            else "rejected"
        )
        raw = canonical_json(document)
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(
                "SELECT 1 FROM receipts WHERE key=? AND project=? AND state='reserved'",
                (key, project),
            ).fetchone():
                raise ComponentError("STATE_CONFLICT", "Studio 寫入收據已失效")
            parts = []
            for part in chunks(raw):
                sha = hashlib.sha256(part).hexdigest()
                parts.append(sha)
                if (
                    db.execute(
                        "SELECT 1 FROM payloads WHERE project=? AND sha=?",
                        (project, sha),
                    ).fetchone()
                    is None
                ):
                    db.execute(
                        "INSERT INTO payloads VALUES(?,?,?)",
                        (project, sha, zlib.compress(part, 3)),
                    )
            db.execute(
                "UPDATE receipts SET state=?,status=?,project_revision=?,result_sha=?,chunks=? WHERE key=?",
                (
                    state,
                    status,
                    revision,
                    hashlib.sha256(raw).hexdigest(),
                    json.dumps(parts),
                    key,
                ),
            )

    def release(self, key: str, project: str) -> None:
        """Forget a reservation whose command failed before it could change anything."""
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "DELETE FROM receipts WHERE key=? AND project=? AND state='reserved'",
                (key, project),
            )

    def read(self, key: str, project: str) -> Doc:
        """Read a project receipt and reassemble its original response."""
        with closing(self._connect()) as db, db:
            db.execute("BEGIN")
            self._resolve_delete(db, project)
            row = db.execute(
                "SELECT * FROM receipts WHERE key=? AND project=?", (key, project)
            ).fetchone()
            if row is None:
                raise ComponentError("NOT_FOUND", "找不到 Studio 寫入收據")
            result = None
            if row["chunks"]:
                parts = []
                for sha in json.loads(row["chunks"]):
                    found = db.execute(
                        "SELECT payload FROM payloads WHERE project=? AND sha=?",
                        (project, sha),
                    ).fetchone()
                    if found is None:
                        raise ComponentError(
                            "RUNTIME_ERROR", "Studio 寫入收據內容不完整"
                        )
                    parts.append(zlib.decompress(found["payload"]))
                raw = b"".join(parts)
                if hashlib.sha256(raw).hexdigest() != row["result_sha"]:
                    raise ComponentError("RUNTIME_ERROR", "Studio 寫入收據內容不完整")
                result = json.loads(raw)
        return {
            "project_id": project,
            "operation": row["operation"],
            "request_sha256": row["signature"],
            "state": row["state"],
            "http_status": row["status"],
            "project_revision": row["project_revision"],
            "result_sha256": row["result_sha"],
            "result": result,
        }

    def _resolve_delete(self, db: sqlite3.Connection, project: str) -> None:
        """Complete or undo a deletion intent using the authoritative project document under the project lock."""
        if (
            db.execute("SELECT 1 FROM deleting WHERE project=?", (project,)).fetchone()
            is None
        ):
            return
        # Only a missing file is evidence of deletion. Preserve the intent on other filesystem errors.
        try:
            (
                self.path.parent / (require_local_id(project, "project_id") + ".json")
            ).stat()
        except FileNotFoundError:
            db.execute(
                "UPDATE receipts SET state='retired',status=NULL,project_revision=NULL,result_sha=NULL,chunks=NULL WHERE project=?",
                (project,),
            )
            db.execute("DELETE FROM payloads WHERE project=?", (project,))
        db.execute("DELETE FROM deleting WHERE project=?", (project,))

    def reconcile(self, project: str | None = None) -> None:
        """Settle interrupted removals at startup and before reusing a missing project's ID."""
        if not self.path.exists():
            return
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if project is not None:
                self._resolve_delete(db, project)
            else:
                for row in db.execute("SELECT project FROM deleting").fetchall():
                    self._resolve_delete(db, row["project"])

    def remove_document(self, project: str, path: Path) -> None:
        """Make result erasure recoverable across file removal, SQLite commit and process failure."""
        if not self.path.exists():
            path.unlink()
            return
        with closing(self._connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO deleting(project) VALUES(?)", (project,))
        try:
            path.unlink()
        finally:
            self.reconcile(project)
