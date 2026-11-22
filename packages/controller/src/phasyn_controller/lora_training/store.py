"""The durable LoRA training jobs: one SQLite row per job holding its whole document (fsynced writes).

The Controller's exclusive data-directory lock owns the writer. Every run a job reserves is written into its
document before the run is created, so a Controller restart finds it again by its run id.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError


type Doc = dict[str, Any]
ACTIVE = ("running", "stopping")


class TrainingStore:
    """Store LoRA training documents by id."""

    def __init__(self, root: Path) -> None:
        """Select the database file in the Controller data directory."""
        self.filename = root / "lora-trainings.sqlite"

    def open(self) -> None:
        """Create the table on first use."""
        with sqlite3.connect(self.filename) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created TEXT NOT NULL, doc BLOB NOT NULL)"
            )
            db.execute("CREATE INDEX IF NOT EXISTS job_status ON jobs(status)")

    def save(self, doc: Doc) -> None:
        """Insert or replace one job document."""
        with sqlite3.connect(self.filename) as db:
            db.execute("PRAGMA synchronous=FULL")
            db.execute(
                "INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,doc=excluded.doc",
                (
                    doc["training_id"],
                    doc["status"],
                    doc["created_at"],
                    canonical_json(doc),
                ),
            )

    def get(self, training_id: str) -> Doc:
        """Read one job document."""
        with sqlite3.connect(self.filename) as db:
            row = db.execute(
                "SELECT doc FROM jobs WHERE id=?", (training_id,)
            ).fetchone()
        if row is None:
            raise ComponentError("NOT_FOUND", "找不到這個訓練工作", status=404)
        doc: Doc = json.loads(row[0])
        return doc

    def listing(self) -> list[Doc]:
        """Every job document, newest first."""
        with sqlite3.connect(self.filename) as db:
            rows = db.execute("SELECT doc FROM jobs ORDER BY created DESC").fetchall()
        return [json.loads(r[0]) for r in rows]

    def active(self) -> list[str]:
        """Ids of the jobs the worker advances."""
        with sqlite3.connect(self.filename) as db:
            return [
                r[0]
                for r in db.execute(
                    "SELECT id FROM jobs WHERE status IN (?,?) ORDER BY created",
                    ACTIVE,
                )
            ]


__all__ = ["ACTIVE", "Doc", "TrainingStore"]
