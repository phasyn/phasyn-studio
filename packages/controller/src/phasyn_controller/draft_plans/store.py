"""Small fsynced plan ledger. The Controller's exclusive data-directory lock owns the writer."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError

from .plan import Doc


class Store:
    """Store draft plans and references to their Controller runs."""

    def __init__(self, root: Path) -> None:
        """Select the draft database in the Controller data directory."""
        self.filename = root / "draft-plans.sqlite"

    def open(self) -> None:
        """Initialize the plan, run-reference and release tables."""
        with sqlite3.connect(self.filename) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS plans (project TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, doc BLOB NOT NULL, PRIMARY KEY(project,id))"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS refs (run_id TEXT PRIMARY KEY,project TEXT NOT NULL,id TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS released(project TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(project,id))"
            )
            db.execute("CREATE INDEX IF NOT EXISTS active_plans ON plans(status)")

    def listing(self, project: str, after: str, limit: int) -> Doc:
        """List the plans belonging to one project."""
        with sqlite3.connect(self.filename) as db:
            rows = db.execute(
                "SELECT id,status FROM plans WHERE project=? AND id>? ORDER BY id LIMIT ?",
                (project, after, limit + 1),
            ).fetchall()
        page = rows[:limit]
        return {
            "items": [{"plan_id": pid, "status": status} for pid, status in page],
            "next_cursor": page[-1][0] if len(rows) > limit else None,
        }

    def get(self, pid: str, plan: str) -> Doc:
        """Load one plan by its project and plan IDs."""
        with sqlite3.connect(self.filename) as db:
            row = db.execute(
                "SELECT doc FROM plans WHERE project=? AND id=?", (pid, plan)
            ).fetchone()
        if not row:
            raise ComponentError("NOT_FOUND", "找不到草稿計畫")
        result: Doc = json.loads(row[0])
        return result

    def save(self, d: Doc) -> None:
        """Commit a plan snapshot and its reserved run IDs together."""
        with sqlite3.connect(self.filename) as db:
            db.execute("PRAGMA synchronous=FULL")
            db.execute(
                "INSERT INTO plans VALUES(?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET status=excluded.status,doc=excluded.doc",
                (d["project_id"], d["plan_id"], d["status"], canonical_json(d)),
            )

            db.executemany(
                "INSERT OR IGNORE INTO refs VALUES(?,?,?)",
                [
                    (r["run_id"], d["project_id"], d["plan_id"])
                    for item in d["results"]
                    for r in item["runs"].values()
                ],
            )

    def references(self, rid: str) -> bool:
        """Check whether a plan still references this run."""
        with sqlite3.connect(self.filename) as db:
            return (
                db.execute("SELECT 1 FROM refs WHERE run_id=?", (rid,)).fetchone()
                is not None
            )

    def active(self) -> list[tuple[str, str]]:
        """List the plans the worker must advance."""
        with sqlite3.connect(self.filename) as db:
            return list(
                db.execute(
                    "SELECT project,id FROM plans WHERE status IN ('running','stopping') ORDER BY rowid"
                )
            )

    def released(self, pid: str, plan: str) -> str | None:
        """Look up the digest of a previously released plan."""
        with sqlite3.connect(self.filename) as db:
            row = db.execute(
                "SELECT digest FROM released WHERE project=? AND id=?", (pid, plan)
            ).fetchone()
            return str(row[0]) if row else None

    def project_in_use(self, pid: str) -> bool:
        """Check for plan references before deleting a project."""
        with sqlite3.connect(self.filename) as db:
            return (
                db.execute(
                    "SELECT 1 FROM plans WHERE project=? LIMIT 1", (pid,)
                ).fetchone()
                is not None
            )

    def remove(self, pid: str, plan: str, signature: str) -> None:
        """Record the released digest and remove the live plan and its references."""
        with sqlite3.connect(self.filename) as db:
            db.execute(
                "INSERT INTO released(project,id,digest) VALUES(?,?,?)",
                (pid, plan, signature),
            )
            db.execute("DELETE FROM refs WHERE project=? AND id=?", (pid, plan))
            db.execute("DELETE FROM plans WHERE project=? AND id=?", (pid, plan))
