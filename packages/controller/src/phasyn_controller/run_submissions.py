"""Persist one immutable run reservation per operation key before work can be dispatched."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter
from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import is_local_id, new_id
from phasyn_server.http import json_response
from starlette.responses import JSONResponse


if TYPE_CHECKING:
    from .state import Controller


@dataclass(frozen=True)
class Reservation:
    """Represent the durable key, digest and run identity for one submission."""

    signature: str
    run_id: str
    error: dict[str, Any] | None
    status: int | None


def _key_hash(key: str) -> str:
    if not is_local_id(key):
        raise ComponentError("INVALID_ARGUMENT", "執行收據鍵格式無效")
    return hashlib.sha256(key.encode("ascii")).hexdigest()


def initialize(root: Path) -> None:
    """Open the receipt ledger while the Controller holds its data directory lock."""
    with closing(sqlite3.connect(root / "run-submissions.sqlite")) as db, db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS submissions (key TEXT PRIMARY KEY, signature TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, error TEXT, status INTEGER)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS studio_pending (run_id TEXT PRIMARY KEY, project TEXT NOT NULL, intent TEXT NOT NULL)"
        )


def _receipt(
    root: Path,
    key: str,
    signature: str | None,
    *,
    studio: tuple[str, Any] | None = None,
) -> tuple[Reservation, bool]:
    identity = _key_hash(key)
    with closing(sqlite3.connect(root / "run-submissions.sqlite")) as db, db:
        if signature is not None:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT signature,run_id,error,status FROM submissions WHERE key=?",
            (identity,),
        ).fetchone()
        if row is None:
            if signature is None:
                raise ComponentError("NOT_FOUND", "找不到執行收據")
            run_id = new_id()
            db.execute(
                "INSERT INTO submissions(key,signature,run_id) VALUES(?,?,?)",
                (identity, signature, run_id),
            )
            if studio is not None:
                project, intent = studio
                db.execute(
                    "INSERT INTO studio_pending(run_id,project,intent) VALUES(?,?,?)",
                    (run_id, project, json.dumps(intent, ensure_ascii=False)),
                )
            return Reservation(signature, run_id, None, None), True
        previous = Reservation(
            row[0], row[1], json.loads(row[2]) if row[2] else None, row[3]
        )
        if signature is not None and signature != previous.signature:
            raise ComponentError(
                "STATE_CONFLICT",
                "同一執行收據鍵已綁定其他內容",
                details={"run_id": previous.run_id},
            )
        return previous, False


def _reject(root: Path, receipt: Reservation, error: ComponentError) -> None:
    with closing(sqlite3.connect(root / "run-submissions.sqlite")) as db, db:
        db.execute(
            "UPDATE submissions SET error=?,status=? WHERE run_id=?",
            (
                json.dumps(error.to_dict(), ensure_ascii=False),
                error.status,
                receipt.run_id,
            ),
        )


async def _existing(ctl: Controller, run_id: str) -> dict[str, Any] | None:
    current = ctl.runner.snapshot(run_id)
    if current is not None:
        return current
    try:
        return await asyncio.to_thread(ctl.runs.read, run_id)
    except ComponentError as exc:
        if exc.code != "NOT_FOUND":
            raise
        return None


def reserve_studio(
    root: Path, key: str, pid: str, body: dict[str, Any]
) -> tuple[Reservation, bool]:
    """Reserve the destination, branch snapshots and run identity in one transaction."""
    return _receipt(root, key, digest([pid, body]), studio=(pid, body))


def pending_studio(root: Path) -> list[tuple[str, str]]:
    """List unfinished Studio reservations; the frozen payload stays on disk."""
    with closing(sqlite3.connect(root / "run-submissions.sqlite")) as db:
        return list(db.execute("SELECT run_id,project FROM studio_pending"))


def settle_studio(root: Path, run_id: str, error: ComponentError | None = None) -> None:
    """Retain the immutable receipt and drop the transient dispatch journal."""
    with closing(sqlite3.connect(root / "run-submissions.sqlite")) as db, db:
        if error is not None:
            db.execute(
                "UPDATE submissions SET error=?,status=? WHERE run_id=?",
                (json.dumps(error.to_dict(), ensure_ascii=False), error.status, run_id),
            )
        db.execute("DELETE FROM studio_pending WHERE run_id=?", (run_id,))


async def existing_run(ctl: Controller, receipt: Reservation) -> dict[str, Any]:
    """Replay the original run or refusal without dispatching again."""
    if receipt.error is not None:
        raise ComponentError.from_dict(receipt.error, status=receipt.status)
    current = await _existing(ctl, receipt.run_id)
    if current is not None:
        return current
    raise ComponentError(
        "STATE_CONFLICT",
        "執行收據已保留，等待核對執行紀錄",
        details={"run_id": receipt.run_id},
        remote_outcome_unknown=True,
    )


async def create(ctl: Controller, body: Any, key: str | None) -> dict[str, Any]:
    """Resolve an existing receipt or reserve and dispatch a new run."""
    if key is None:
        return await ctl.runner.create(body)
    contracts.validate("RunRequest", body)
    receipt, first = await asyncio.to_thread(_receipt, ctl.data_dir, key, digest(body))
    if first:
        try:
            return await ctl.runner.create(body, reserved_run_id=receipt.run_id)
        except ComponentError as error:
            await asyncio.to_thread(_reject, ctl.data_dir, receipt, error)
            raise
    return await existing_run(ctl, receipt)


def routes(ctl: Controller) -> APIRouter:
    """Expose creation and readback of idempotent run submissions."""
    router = APIRouter()

    @router.get("/api/run-submissions/{key}")
    async def get_receipt(key: str) -> JSONResponse:
        receipt, _ = await asyncio.to_thread(_receipt, ctl.data_dir, key, None)
        current = await _existing(ctl, receipt.run_id)
        return json_response(
            {
                "run_id": receipt.run_id,
                "request_sha256": receipt.signature,
                "state": current["state"]
                if current
                else "rejected"
                if receipt.error
                else "unconfirmed",
                "error": receipt.error,
            }
        )

    return router
