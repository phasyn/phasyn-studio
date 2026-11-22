"""Reconcile one frozen attempt against the Node's authoritative call receipt."""

from __future__ import annotations

import asyncio
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

import httpx
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_server.http import DEFAULT_JSON_BODY_BYTES, parse_json_bytes

from .node_calls import ActiveCall, StepOutcome, response_outcome


if TYPE_CHECKING:
    from collections.abc import Callable

    from ..state import Controller


def unknown(call_id: str, message: str) -> StepOutcome:
    """Build an unresolved step outcome with the existing call identity."""
    err = ComponentError(
        "NODE_UNREACHABLE",
        message,
        details={"call_id": call_id},
        remote_outcome_unknown=True,
    )
    return StepOutcome("failed", err.to_dict(), unknown=True)


class _InvalidReceiptError(ValueError):
    """Identify an unreadable reply from a reachable Node."""


async def _read_receipt(ctl: Controller, call: ActiveCall) -> tuple[int, bytes]:
    call.endpoint = ctl.catalog.endpoint_for_call(call.node_id)
    async with (
        asyncio.timeout(8),
        ctl.http.stream(
            "GET",
            f"{call.component_url}/calls/{call.call_id}",
            headers={"Accept-Encoding": "identity"},
            timeout=5.0,
        ) as answer,
    ):
        if answer.status_code != HTTPStatus.OK:
            return answer.status_code, b""
        if answer.headers.get("content-encoding", "identity").lower() != "identity":
            raise _InvalidReceiptError("Node 呼叫紀錄的傳輸編碼無法核對")
        payload = bytearray()
        async for chunk in answer.aiter_raw(chunk_size=65536):
            if len(payload) + len(chunk) > DEFAULT_JSON_BODY_BYTES:
                raise _InvalidReceiptError("Node 呼叫紀錄超過回應上限")
            payload.extend(chunk)
        return answer.status_code, bytes(payload)


def _has_local_artifact(value: Any, node_id: str) -> bool:
    if isinstance(value, list):
        return any(_has_local_artifact(item, node_id) for item in value)
    if not isinstance(value, dict):
        return False
    if (
        value.get("node_id") == node_id
        and "file_id" in value
        and contracts.is_valid("FileRef", value)
    ):
        return True
    return any(_has_local_artifact(item, node_id) for item in value.values())


def _verified_receipt(
    call: ActiveCall, body: dict[str, Any], fingerprint: str, payload: bytes
) -> dict[str, Any]:
    try:
        receipt = parse_json_bytes(payload, what="CallReceipt")
        contracts.validate("CallReceipt", receipt, what="呼叫對帳")
    except ComponentError as exc:
        raise _InvalidReceiptError("Node 呼叫紀錄不完整；未重送") from exc
    keys = ("node_id", "component_id", "call_id", "run_id", "step_id", "request_digest")
    identity = (
        call.node_id,
        call.component_id,
        call.call_id,
        body["run_id"],
        body["step_id"],
        fingerprint,
    )
    if tuple(receipt[key] for key in keys) != identity:
        raise _InvalidReceiptError("Node 呼叫紀錄不符合派送身分；未重送")
    if receipt.get("result") and receipt["result"]["call_id"] != call.call_id:
        raise _InvalidReceiptError("回執結果與原呼叫不符")
    phase = receipt["phase"]
    error, result = receipt["error"], receipt["result"]
    if (
        (phase == "running" and (error is not None or result is not None))
        or (
            phase == "not_started"
            and (result is not None or not error or error.get("remote_outcome_unknown"))
        )
        or (
            phase in {"finished", "stopped", "output_missing"}
            and (error is not None or result is None)
        )
        or (phase == "stopped" and result["state"] != "failed")
        or (
            phase == "output_missing"
            and (
                result["state"] != "succeeded"
                or result["error"] is not None
                or not _has_local_artifact(result["outputs"], call.node_id)
            )
        )
    ):
        raise _InvalidReceiptError("Node 呼叫階段與終態證據矛盾；未重送")
    if receipt.get("superseded_by"):
        raise _InvalidReceiptError("Node 已記錄此嘗試由其他呼叫接手；停止使用舊結果")
    return dict(receipt)


def _terminal(call: ActiveCall, receipt: dict[str, Any]) -> tuple[StepOutcome, bool]:
    phase = receipt["phase"]
    result = receipt.get("result") or {}
    may_retry = receipt.get("retry_after_verified_stop") is True
    if phase == "not_started" and receipt["error"]:
        err = receipt["error"]
        state = "cancelled" if err["code"] == "CANCELLED" else "failed"
        return StepOutcome(state, err), may_retry and err["code"] in {
            "COMPONENT_BUSY",
            "COMPONENT_NOT_READY",
        }
    if (phase == "finished" and result) or (
        phase == "stopped" and result.get("state") == "failed"
    ):
        outcome = response_outcome(call, httpx.Response(HTTPStatus.OK, json=result))
        details = (result.get("error") or {}).get("details") or {}
        if (
            phase == "stopped"
            and "process_exited" in details
            and details["process_exited"] is not True
        ):
            return unknown(call.call_id, "Node 的程序退出證據不支持已停止狀態"), False
        return outcome, phase == "stopped" and may_retry and not outcome.unknown
    if phase == "output_missing" and result.get("state") == "succeeded":
        error = ComponentError(
            "FILE_NOT_FOUND",
            "原呼叫已結束，已發布的輸出或其附檔缺失或內容不符",
            details={"call_id": call.call_id},
        )
        return StepOutcome("failed", error.to_dict()), may_retry
    reason = (receipt.get("error") or {}).get("message")
    return unknown(call.call_id, reason or "Node 未能確認呼叫終態；未重送"), False


async def reconcile(
    ctl: Controller,
    call: ActiveCall,
    body: dict[str, Any],
    fingerprint: str,
    *,
    on_running: Callable[[], None] | None = None,
) -> tuple[StepOutcome, bool]:
    """Poll the original attempt and notify once after verifying a running receipt."""
    while not call.abandon.is_set():
        try:
            status, payload = await _read_receipt(ctl, call)
            if status in (
                HTTPStatus.BAD_GATEWAY,
                HTTPStatus.SERVICE_UNAVAILABLE,
                HTTPStatus.GATEWAY_TIMEOUT,
            ):
                await asyncio.sleep(1)
                continue
            if status != HTTPStatus.OK:
                return unknown(
                    call.call_id, f"Node 無法證實此呼叫（HTTP {status}）；未重送"
                ), False
            receipt = _verified_receipt(call, body, fingerprint, payload)
        except (ComponentError, httpx.TransportError, TimeoutError):
            await asyncio.sleep(1)
            continue
        except _InvalidReceiptError as exc:
            return unknown(call.call_id, str(exc)), False
        if receipt["phase"] != "running":
            return _terminal(call, receipt)
        if on_running is not None:
            on_running()
            on_running = None
        await asyncio.sleep(0.5)
    return unknown(call.call_id, "已停止等待取消回覆；遠端結果未知"), False


WATCH_INTERVAL_S = 60.0
WATCH_UNKNOWN_LIMIT = 3


async def watch(
    ctl: Controller,
    call: ActiveCall,
    body: dict[str, Any],
    fingerprint: str,
    *,
    interval: float | None = None,
) -> tuple[StepOutcome, bool]:
    """Watch the Node's receipt while the invoke request is still open; return once the receipt settles the call.

    A long call keeps one HTTP request open for its whole length; when that request's reply is lost (a dropped
    connection nobody noticed), the Node has the result and the run would otherwise wait until its timeout. The
    receipt is read every ``interval`` seconds: a terminal receipt settles the step with the Node's own result,
    and a reachable Node that keeps not knowing the call (no record, or a call of an earlier Node process) ends
    the wait with an unknown outcome for the usual reconciliation. Unreachable reads and running receipts only
    mean keep waiting.
    """
    misses = 0
    while True:
        await asyncio.sleep(WATCH_INTERVAL_S if interval is None else interval)
        try:
            status, payload = await _read_receipt(ctl, call)
        except (ComponentError, httpx.TransportError, TimeoutError):
            continue
        if status == HTTPStatus.NOT_FOUND:
            misses += 1
            if misses >= WATCH_UNKNOWN_LIMIT:
                return unknown(
                    call.call_id, "Node 不認得這個仍在等待的呼叫；未重送"
                ), False
            continue
        misses = 0
        if status != HTTPStatus.OK:
            continue
        try:
            receipt = _verified_receipt(call, body, fingerprint, payload)
        except _InvalidReceiptError:
            continue
        if receipt["phase"] != "running":
            return _terminal(call, receipt)
