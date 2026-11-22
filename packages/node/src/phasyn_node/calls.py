"""Durable admission and exact completed results, separate from the rebuildable telemetry index."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import sqlite3
import stat
import threading
from contextlib import closing
from functools import lru_cache, partial
from pathlib import Path
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError, to_component_error
from phasyn_components.files import META, PAYLOAD
from phasyn_components.typed import file_links
from phasyn_server.http import DEFAULT_JSON_BODY_BYTES

from .invoke import cancel_call, run_call


if TYPE_CHECKING:
    from typing import BinaryIO

    from phasyn_components.files import FileStore

    from .call import ActiveCall
    from .service import NodeService


_RECEIPT_ROW = """SELECT c.boot,c.receipt,s.child,EXISTS (
        SELECT 1 FROM cancellations x WHERE x.id=c.id AND x.component=?
    ) FROM calls c LEFT JOIN successors s ON s.parent=c.id WHERE c.id=?"""

# The stored evidence of a predecessor (its receipt row) and what verifying its outputs made of it.
type VerifiedParent = tuple[tuple[Any, ...] | None, dict[str, Any] | ComponentError]

_STALE_ATTEMPTS = 3


class StaleParentError(RuntimeError):
    """The predecessor's receipt changed between verifying it and claiming its retry."""


class CallStore:
    """Persist call identity, admission, cancellation and terminal results across restarts."""

    def __init__(self, path: Path, node_id: str, boot: str) -> None:
        """Open the node-owned receipt database and initialize its durable tables."""
        self.path, self.node_id, self.boot = path, node_id, boot
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS calls (
                id TEXT PRIMARY KEY, boot TEXT NOT NULL, receipt TEXT NOT NULL)""")

            db.execute(
                "CREATE TABLE IF NOT EXISTS successors (parent TEXT PRIMARY KEY, child TEXT UNIQUE NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS cancellations (id TEXT, component TEXT, PRIMARY KEY(id,component))"
            )

    def fence_cancel(self, component_id: str, call_id: str) -> None:
        """Record cancellation even if its invoke has not reached this node yet."""
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute(
                "INSERT OR IGNORE INTO cancellations VALUES(?,?)",
                (call_id, component_id),
            )

    def claim(
        self,
        component_id: str,
        body: dict[str, Any],
        provider_id: str,
        *,
        safe: bool,
        verified: VerifiedParent | None,
    ) -> bool:
        """Claim a call once, checking the predecessor before recording any retry.

        ``verified`` is ``verify_parent``'s result for this body, taken without any lock: hashing the predecessor's
        outputs can take long. The claim compares the receipt row that was verified with the current one and raises
        ``StaleParentError`` when they differ.
        """
        parent = body.get("retry_of")
        if parent is not None and verified is None:
            raise ValueError("a retry needs its verified predecessor")
        row = {
            "node_id": self.node_id,
            "component_id": component_id,
            "call_id": body["call_id"],
            "run_id": body["run_id"],
            "step_id": body["step_id"],
            "request_digest": digest(body),
            "provider_id": provider_id,
            "retry_after_verified_stop": safe,
            "operation_digest": digest(
                {k: v for k, v in body.items() if k not in {"call_id", "retry_of"}}
            ),
            "phase": "running",
            "result": None,
            "error": None,
        }
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute(
                "SELECT 1 FROM calls WHERE id=?", (body["call_id"],)
            ).fetchone():
                return False
            if parent is not None and verified is not None:
                if (
                    _row_key(
                        db.execute(_RECEIPT_ROW, (component_id, parent["call_id"]))
                    )
                    != verified[0]
                ):
                    raise StaleParentError
                previous = verified[1]
                if isinstance(previous, ComponentError):
                    raise previous
                rejected = previous["phase"] == "not_started" and (
                    previous["error"] or {}
                ).get("code") in {
                    "COMPONENT_BUSY",
                    "COMPONENT_NOT_READY",
                }
                stopped = previous["phase"] in {"output_missing", "stopped"}
                fenced_cancel = db.execute(
                    "SELECT 1 FROM cancellations WHERE id=? AND component=?",
                    (parent["call_id"], component_id),
                ).fetchone()
                if (
                    not safe
                    or not previous.get("retry_after_verified_stop")
                    or previous.get("provider_id") != provider_id
                    or previous.get("operation_digest") != row["operation_digest"]
                    or previous["request_digest"] != parent["request_digest"]
                    or previous.get("superseded_by")
                    or db.execute(
                        "SELECT 1 FROM successors WHERE child=?", (parent["call_id"],)
                    ).fetchone()
                    or fenced_cancel
                    or not (rejected or stopped)
                ):
                    raise ComponentError(
                        "STATE_CONFLICT", "舊呼叫的重試策略或終態允許條件未成立"
                    )
                if not db.execute(
                    "INSERT OR IGNORE INTO successors(parent,child) VALUES(?,?)",
                    (parent["call_id"], body["call_id"]),
                ).rowcount:
                    raise ComponentError("CALL_ID_CONFLICT", "這個嘗試已有接替者")
            cancelled = (
                db.execute(
                    "SELECT 1 FROM cancellations WHERE id=? AND component=?",
                    (body["call_id"], component_id),
                ).fetchone()
                is not None
            )
            if cancelled:
                row.update(
                    phase="not_started",
                    error=ComponentError(
                        "CANCELLED", "此呼叫已取消，不會開始"
                    ).to_dict(),
                )
            claimed = (
                db.execute(
                    "INSERT OR IGNORE INTO calls VALUES(?,?,?)",
                    (body["call_id"], self.boot, json.dumps(row)),
                ).rowcount
                == 1
            )
        if cancelled and claimed:
            raise ComponentError("CANCELLED", "此呼叫已取消，不會開始")
        return claimed

    def verify_parent(
        self, component_id: str, body: dict[str, Any], files: FileStore
    ) -> VerifiedParent | None:
        """Verify a retry's predecessor outside any lock; ``claim`` checks that its receipt row is unchanged."""
        parent = body.get("retry_of")
        if parent is None:
            return None
        call_id = parent["call_id"]
        with closing(sqlite3.connect(self.path)) as db:
            row = _row_key(db.execute(_RECEIPT_ROW, (component_id, call_id)))
        try:
            return row, self._interpret(row, component_id, call_id, files)
        except ComponentError as exc:
            return row, exc

    def receipt(
        self, component_id: str, call_id: str, files: FileStore
    ) -> dict[str, Any]:
        """Read the original receipt and check locally owned output availability."""
        with closing(sqlite3.connect(self.path)) as db:
            row = _row_key(db.execute(_RECEIPT_ROW, (component_id, call_id)))
        return self._interpret(row, component_id, call_id, files)

    def _interpret(
        self,
        row: tuple[Any, ...] | None,
        component_id: str,
        call_id: str,
        files: FileStore,
    ) -> dict[str, Any]:
        if row is None:
            raise ComponentError(
                "NOT_FOUND", "這筆呼叫沒有可核對的持久紀錄", status=404
            )
        receipt = json.loads(row[1])
        if not contracts.is_valid("CallReceipt", receipt):
            raise ComponentError("INTEGRITY_MISMATCH", "Node 持久呼叫收據不完整")
        if (
            receipt["component_id"] != component_id
            or receipt["node_id"] != self.node_id
            or receipt["call_id"] != call_id
        ):
            raise ComponentError(
                "NOT_FOUND", "這個元件沒有該呼叫的持久紀錄", status=404
            )
        if receipt["phase"] == "running" and row[0] != self.boot:
            receipt["phase"] = "unknown"
        if row[2] is not None:
            receipt["superseded_by"] = row[2]
        if row[3]:
            receipt["retry_after_verified_stop"] = False
        self._verify_outcome(receipt, files)
        return receipt

    def _verify_outcome(self, receipt: dict[str, Any], files: FileStore) -> None:
        result = receipt["result"]
        if _conflicting_receipt(receipt):
            receipt.update(
                phase="unknown",
                result=None,
                error=ComponentError(
                    "INTEGRITY_MISMATCH",
                    "持久呼叫階段與終態證據矛盾",
                    remote_outcome_unknown=True,
                ).to_dict(),
            )
        elif receipt["phase"] == "finished" and result["state"] == "succeeded":
            try:
                if _missing_local_file(result["outputs"], files, self.node_id):
                    receipt["phase"] = "output_missing"
            except _CheckingOutputError as exc:
                raise ComponentError(
                    "RUNTIME_ERROR",
                    "已發布輸出仍在對帳中",
                    status=503,
                    remote_outcome_unknown=True,
                ) from exc
            except (OSError, ValueError, RecursionError):
                receipt.update(
                    phase="unknown",
                    result=None,
                    error=ComponentError(
                        "INTEGRITY_MISMATCH",
                        "不能核對已發布輸出的內容或中繼資料",
                        remote_outcome_unknown=True,
                    ).to_dict(),
                )

    def seal(
        self,
        call_id: str,
        *,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        uncertain: bool = False,
        stopped: bool = False,
    ) -> None:
        """Seal a running call exactly once under the claiming node process."""
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT boot,receipt FROM calls WHERE id=?", (call_id,)
            ).fetchone()
            if row is None or row[0] != self.boot:
                raise RuntimeError("call receipt owner changed")
            receipt = json.loads(row[1])
            if receipt["phase"] != "running":
                raise RuntimeError("call receipt already sealed")
            receipt.update(
                phase="unknown"
                if uncertain
                else "stopped"
                if stopped
                else "finished"
                if result is not None
                else "not_started",
                result=result,
                error=error,
            )
            encoded = json.dumps(receipt, ensure_ascii=False)
            if len(encoded.encode("utf-8")) > DEFAULT_JSON_BODY_BYTES:
                raise ValueError("call receipt exceeds the API response limit")
            db.execute("UPDATE calls SET receipt=? WHERE id=?", (encoded, call_id))


def _row_key(cursor: sqlite3.Cursor) -> tuple[Any, ...] | None:
    row = cursor.fetchone()
    return None if row is None else tuple(row)


def _conflicting_receipt(receipt: dict[str, Any]) -> bool:
    phase, result, error = receipt["phase"], receipt["result"], receipt["error"]
    if phase == "unknown":
        return False
    if phase == "running":
        return result is not None or error is not None
    if phase == "not_started":
        return (
            result is not None or not error or bool(error.get("remote_outcome_unknown"))
        )
    if not result or result["call_id"] != receipt["call_id"] or error is not None:
        return True
    cause = result["error"] or {}
    details = cause.get("details") or {}
    return (
        (
            phase == "stopped"
            and (
                result["state"] != "failed"
                or (
                    "process_exited" in details
                    and details["process_exited"] is not True
                )
            )
        )
        or (phase == "output_missing" and result["state"] != "succeeded")
        or (result["state"] == "succeeded" and bool(cause))
        or (result["state"] != "succeeded" and bool(result["outputs"]))
        or cause.get("remote_outcome_unknown") is True
        or (
            details.get("process_killed") is True
            and details.get("process_exited") is not True
        )
    )


class _CheckingOutputError(RuntimeError):
    """A concurrent receipt reader is already verifying this immutable file."""


_Stamp = tuple[int, int, int, int, int]
_hash_lock = threading.Lock()
_hashing: set[tuple[Path, _Stamp]] = set()


def _open_published(directory: Path, leaf: str) -> BinaryIO:
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    stream = os.fdopen(fd, "rb")
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        stream.close()
        raise ValueError("Published artifact is not a regular file")
    return stream


def _stamp(stream: BinaryIO) -> _Stamp:
    info = os.fstat(stream.fileno())
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@lru_cache(maxsize=512)
def _payload_digest(directory: Path, stamp: _Stamp) -> str:
    key = directory, stamp
    with _hash_lock:
        if key in _hashing:
            raise _CheckingOutputError
        _hashing.add(key)
    try:
        with _open_published(directory, PAYLOAD) as stream:
            if _stamp(stream) != stamp:
                raise ValueError("Published payload changed before verification")
            remaining = stamp[2]
            digest = hashlib.sha256()
            while remaining:
                block = stream.read(min(4 * 1024**2, remaining))
                if not block:
                    raise ValueError("Published payload changed while verifying")
                digest.update(block)
                remaining -= len(block)
            if _stamp(stream) != stamp:
                raise ValueError("Published payload changed while verifying")
            return digest.hexdigest()
    finally:
        with _hash_lock:
            _hashing.discard(key)


def _missing_local_file(value: Any, files: FileStore, node_id: str) -> bool:
    if isinstance(value, list):
        return any(_missing_local_file(item, files, node_id) for item in value)
    if not isinstance(value, dict):
        return False
    if (
        value.get("node_id") == node_id
        and "file_id" in value
        and contracts.is_valid("FileRef", value)
    ):
        return _missing_ref(value, files, node_id)
    return any(_missing_local_file(item, files, node_id) for item in value.values())


def _missing_ref(value: dict[str, Any], files: FileStore, node_id: str) -> bool:
    directory = files.directory(value["file_id"])
    try:
        with _open_published(directory, META) as stream:
            metadata = stream.read(DEFAULT_JSON_BODY_BYTES + 1)
        if len(metadata) > DEFAULT_JSON_BODY_BYTES:
            raise ValueError("Invalid publication metadata size")
        meta = json.loads(metadata)
        if (
            not isinstance(meta, dict)
            or meta.get("published") is not True
            or meta.get("fileref") != value
        ):
            raise ValueError("Publication metadata conflicts with the output receipt")
        with _open_published(directory, PAYLOAD) as stream:
            stamp = _stamp(stream)
            missing = (
                stamp[2] != value["size_bytes"]
                or _payload_digest(directory, stamp) != value["sha256"]
            )
            if _stamp(stream) != stamp:
                raise ValueError("Published payload changed while verifying")
            if missing:
                return True
    except FileNotFoundError:
        return True
    return any(
        _missing_local_file(link, files, node_id) for link in file_links(value).values()
    )


async def _admit(
    service: NodeService, component_id: str, body: dict[str, Any]
) -> ActiveCall | None:
    """Claim and accept a new call; None when its call id is already recorded."""
    inst = service.instance(component_id)
    store = service.calls
    safe = inst.settings.definition.get("retry_after_verified_stop") is True
    for _ in range(_STALE_ATTEMPTS):
        # Hashing a predecessor's outputs must not hold the admission lock or the receipt database.
        verified = await asyncio.to_thread(
            store.verify_parent, component_id, body, service.store
        )
        try:
            async with service.call_admission_lock:
                claimed = await asyncio.to_thread(
                    partial(
                        store.claim,
                        component_id,
                        body,
                        inst.provider_id,
                        safe=safe,
                        verified=verified,
                    )
                )
                if not claimed:
                    return None
                try:
                    return inst.accept_call(body)
                except ComponentError as exc:
                    await asyncio.to_thread(
                        store.seal, body["call_id"], error=exc.to_dict()
                    )
                    raise
        except StaleParentError:
            continue
    raise ComponentError("STATE_CONFLICT", "舊呼叫的重試策略或終態允許條件未成立")


async def invoke_once(
    service: NodeService, component_id: str, body: dict[str, Any]
) -> dict[str, Any]:
    """Admit one call or replay its sealed result without executing it twice."""
    inst = service.instance(component_id)
    store = service.calls
    cid = body["call_id"]
    call = await _admit(service, component_id, body)
    if call is None:
        # Hashing an earlier result must not hold up unrelated admissions or cancellation.
        known = await asyncio.to_thread(store.receipt, component_id, cid, service.store)
        if (
            known["request_digest"] == digest(body)
            and known["phase"] == "finished"
            and not known.get("superseded_by")
            and isinstance(known["result"], dict)
        ):
            return dict(known["result"])
        raise ComponentError(
            "CALL_ID_CONFLICT",
            "呼叫已登記；請依識別碼核對狀態",
            details={"call_id": cid},
        )
    uncertainty: ComponentError | None = None
    try:
        result = await run_call(inst, call)
        contracts.validate("InvokeResult", result, what="持久呼叫結果")
        if (
            call.kill_reason is not None
            and call.process_exited is not True
            and call.runtime_done is None
        ):
            uncertainty = ComponentError(
                "RUNTIME_ERROR",
                "已要求終止呼叫，尚未確認程序退出",
                remote_outcome_unknown=True,
            )
        stopped = (
            result["state"] == "failed"
            and call.kill_reason == "deadline"
            and call.process_exited is True
            and call.cancel_reason != "user"
        )
        if uncertainty is not None:
            await asyncio.to_thread(
                store.seal, cid, error=uncertainty.to_dict(), uncertain=True
            )
        else:
            await asyncio.to_thread(store.seal, cid, result=result, stopped=stopped)
    except Exception as exc:
        error = to_component_error(exc)
        with contextlib.suppress(sqlite3.Error, RuntimeError):
            await asyncio.to_thread(
                store.seal, cid, error=error.to_dict(), uncertain=True
            )
        raise ComponentError(
            "RUNTIME_ERROR", "已受理的呼叫無法確認終態", remote_outcome_unknown=True
        ) from exc
    if uncertainty is not None:
        raise uncertainty
    return result


async def cancel_registered(
    service: NodeService, component_id: str, call_id: str
) -> dict[str, Any]:
    """Fence future admission before cancelling the active call, if any."""
    instance = service.instance(component_id)
    async with service.call_admission_lock:
        await asyncio.to_thread(service.calls.fence_cancel, component_id, call_id)
    return await cancel_call(instance, call_id)
