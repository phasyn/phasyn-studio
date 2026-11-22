"""SQLite compare-and-swap revision history and durable dispatch receipts."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.inference_presets.policy import Doc
from phasyn_components.timeutil import utc_now


class PresetStore:
    """Keep immutable versions independently of source run retention."""

    def __init__(self, path: Path) -> None:
        """Choose the database for immutable presets and submission receipts."""
        self.path = path

    def _open(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        with db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS revisions (id TEXT NOT NULL, revision INTEGER NOT NULL, label TEXT NOT NULL, stamp TEXT NOT NULL, document BLOB NOT NULL, PRIMARY KEY(id,revision))"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS submissions (request_id TEXT PRIMARY KEY, id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, run_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL)"
            )
        return db

    def summaries(self) -> list[Doc]:
        """List the latest revision of each preset with its identifying metadata."""
        with closing(self._open()) as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT r.id,r.revision,r.label,r.stamp FROM revisions r JOIN (SELECT id,max(revision) AS revision FROM revisions GROUP BY id) t USING (id,revision) ORDER BY r.id"
                )
            ]

    def get(self, pid: str, rev: int | None = None) -> Doc:
        """Load an immutable preset revision."""
        with closing(self._open()) as db:
            row = db.execute(
                "SELECT * FROM revisions WHERE id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT 1",
                (pid, rev, rev),
            ).fetchone()
        if row is None:
            raise ComponentError(
                "NOT_FOUND",
                "找不到推論配方版本",
                details={"preset_id": pid, "revision": rev},
            )
        return {
            "preset_id": pid,
            "revision": row["revision"],
            "created_at": row["stamp"],
            **json.loads(row["document"]),
        }

    def put(self, pid: str, expected: int, doc: Doc) -> Doc:
        """Insert the captured revision under its digest."""
        with closing(self._open()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            current = (
                db.execute(
                    "SELECT max(revision) FROM revisions WHERE id=?", (pid,)
                ).fetchone()[0]
                or 0
            )
            if current != expected:
                raise ComponentError(
                    "STATE_CONFLICT",
                    "推論配方版本已更新",
                    details={"expected": expected, "current": current},
                )
            rev = current + 1
            db.execute(
                "INSERT INTO revisions VALUES (?,?,?,?,?)",
                (pid, rev, doc["label"], utc_now(), canonical_json(doc)),
            )
        return self.get(pid, rev)

    def reserve(self, key: str, pid: str, rev: int, sha: str) -> tuple[str, bool, str]:
        """Reserve a run for a single preset submission."""
        with closing(self._open()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM submissions WHERE request_id=?", (key,)
            ).fetchone()
            if row:
                if (row["id"], row["revision"], row["payload"]) != (pid, rev, sha):
                    raise ComponentError(
                        "STATE_CONFLICT", "同一提交識別碼的推論配方內容不同"
                    )
                return row["run_id"], False, row["state"]
            rid = new_id()
            db.execute(
                "INSERT INTO submissions VALUES (?,?,?,?,?,?)",
                (key, pid, rev, sha, rid, "reserved"),
            )
            return rid, True, "reserved"

    def mark(self, rid: str, state: str) -> None:
        """Update the outcome of the reserved submission."""
        with closing(self._open()) as db, db:
            db.execute("UPDATE submissions SET state=? WHERE run_id=?", (state, rid))

    def runs(self, pid: str, rev: int) -> list[Doc]:
        """List the runs associated with the specified preset."""
        with closing(self._open()) as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT run_id, state, request_id FROM submissions WHERE id=? AND revision=? ORDER BY rowid DESC LIMIT 100",
                    (pid, rev),
                )
            ]

    def lookup(self, key: str, pid: str, rev: int, sha: str) -> tuple[str, str] | None:
        """Read the reservation that identifies the submitted run."""
        with closing(self._open()) as db:
            row = db.execute(
                "SELECT * FROM submissions WHERE request_id=?", (key,)
            ).fetchone()
        if row is None:
            return None
        if (row["id"], row["revision"], row["payload"]) != (pid, rev, sha):
            raise ComponentError("STATE_CONFLICT", "同一提交識別碼的推論配方內容不同")
        return row["run_id"], row["state"]
