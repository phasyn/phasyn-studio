"""The runner's HTTP to Nodes and how each answer is classified (no retries, ever).

- ``post_invoke``: exactly one ``POST …/invoke``. Not sent → NODE_UNREACHABLE (known outcome); sent then
  timed out or disconnected → remote_outcome_unknown. The wait can be abandoned (unanswered cancel).
- ``post_cancel``: exactly one ``POST …/cancel``; no answer means the remote outcome is unknown.
- ``response_outcome``: what a Node's HTTP answer means for the step (pure; testable with ``httpx.Response``).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_server.http import parse_json_bytes

from ..nodeclient import CANCEL_TIMEOUT, CONNECT_TIMEOUT_S, error_from_response, request_sent, transport_error

READ_GRACE_SECONDS = 120
WRITE_TIMEOUT_S = 60.0


@dataclass
class ActiveCall:
    step_id: str
    node_id: str
    component_id: str
    call_id: str
    endpoint: str
    node_label: str
    abandon: asyncio.Event = field(default_factory=asyncio.Event)
    cancel_task: asyncio.Task[CancelOutcome] | None = None

    @property
    def component_url(self) -> str:
        return f"{self.endpoint}/api/components/{quote(self.component_id, safe='')}"


@dataclass(frozen=True)
class StepOutcome:
    """How a step ended: its state, contract Error, and whether the Node may still be working on it."""

    state: str
    error: dict[str, Any] | None = None
    unknown: bool = False
    outputs: dict[str, Any] | None = None
    recording_id: str | None = None
    settings: dict[str, Any] | None = None
    sent: bool = True


@dataclass(frozen=True)
class CancelOutcome:
    step_id: str
    answered: bool
    accepted: bool
    message: str


def invoke_timeout(timeout_seconds: int) -> httpx.Timeout:
    """The Node answers after the call ends; reading may take the call's own deadline plus a grace."""
    read = float(timeout_seconds + READ_GRACE_SECONDS)
    return httpx.Timeout(connect=CONNECT_TIMEOUT_S, read=read, write=WRITE_TIMEOUT_S, pool=CONNECT_TIMEOUT_S)


def response_outcome(call: ActiveCall, resp: httpx.Response) -> StepOutcome:
    if resp.status_code != 200:
        err = error_from_response(resp, what=f"Node {call.node_label} 的 invoke ")
        return StepOutcome("failed", err.to_dict(), err.remote_outcome_unknown)
    try:
        doc = parse_json_bytes(resp.content, what="InvokeResult")
        contracts.validate("InvokeResult", doc, what="Node 回覆的 InvokeResult")
        if doc["call_id"] != call.call_id:
            raise ComponentError(
                "RUNTIME_ERROR", f"InvokeResult 的 call_id {doc['call_id']} 與送出的 {call.call_id} 不同"
            )
    except ComponentError as err:
        bad = ComponentError(
            "RUNTIME_ERROR",
            f"Node 回覆無法解讀，結果未知：{err.message}",
            details={"cause": err.code, **err.details},
            remote_outcome_unknown=True,
        )
        return StepOutcome("failed", bad.to_dict(), True)
    error = doc.get("error")
    if doc["state"] == "failed" and error is None:
        error = {"code": "RUNTIME_ERROR", "message": "Node 回報失敗但沒有附錯誤內容"}
    return StepOutcome(
        doc["state"], error, False, outputs=doc["outputs"], recording_id=doc["recording_id"], settings=doc["settings"]
    )


def transport_outcome(call: ActiveCall, exc: httpx.HTTPError, *, read_timeout: float) -> StepOutcome:
    err = transport_error(
        exc,
        node_label=call.node_label,
        endpoint=call.endpoint,
        what="invoke 呼叫",
        side_effect=True,
        read_timeout=read_timeout,
    )
    err.details.update({"call_id": call.call_id, "step_id": call.step_id})
    return StepOutcome("failed", err.to_dict(), err.remote_outcome_unknown, sent=request_sent(exc))


def abandoned_outcome(call: ActiveCall) -> StepOutcome:
    err = ComponentError(
        "NODE_UNREACHABLE",
        f"取消請求沒有回覆，主控不再等待步驟 {call.step_id} 的呼叫；Node {call.node_label} 可能仍在運算（遠端結果未知），結果請查該 Node 的紀錄",
        details={"endpoint": call.endpoint, "call_id": call.call_id, "step_id": call.step_id},
        remote_outcome_unknown=True,
    )
    return StepOutcome("failed", err.to_dict(), True)


async def post_invoke(
    http: httpx.AsyncClient, call: ActiveCall, body: dict[str, Any], timeout_seconds: int
) -> StepOutcome:
    """One invoke; returns early (outcome unknown) when ``call.abandon`` is set."""
    timeout = invoke_timeout(timeout_seconds)
    post = asyncio.create_task(http.post(f"{call.component_url}/invoke", json=body, timeout=timeout))
    abandon = asyncio.create_task(call.abandon.wait())
    try:
        done, _ = await asyncio.wait({post, abandon}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        abandon.cancel()
        if not post.done():
            post.cancel()
        await asyncio.gather(post, abandon, return_exceptions=True)
    if post not in done or post.cancelled():
        return abandoned_outcome(call)
    exc = post.exception()
    if exc is None:
        return response_outcome(call, post.result())
    if isinstance(exc, httpx.HTTPError):
        return transport_outcome(call, exc, read_timeout=float(timeout.read or 0))
    raise exc


async def post_cancel(http: httpx.AsyncClient, call: ActiveCall) -> CancelOutcome:
    """One cancel of the step's call (``answered=False`` when the Node could not be reached or did not reply)."""
    try:
        resp = await http.post(f"{call.component_url}/cancel", json={"call_id": call.call_id}, timeout=CANCEL_TIMEOUT)
    except httpx.HTTPError as exc:
        message = (
            f"步驟 {call.step_id} 的取消沒有回覆（{type(exc).__name__}）；遠端結果未知，主控不再等待此呼叫、不重送"
        )
        return CancelOutcome(call.step_id, False, False, message)
    if resp.status_code == 200:
        try:
            doc = parse_json_bytes(resp.content, what="CancelResult")
            contracts.validate("CancelResult", doc, what="CancelResult")
        except ComponentError as bad:
            return CancelOutcome(call.step_id, True, False, bad.message)
        return CancelOutcome(call.step_id, True, bool(doc["accepted"]), str(doc["message"]))
    refused = error_from_response(resp, what="取消")
    return CancelOutcome(call.step_id, True, False, f"{refused.code}：{refused.message}")


__all__ = [
    "READ_GRACE_SECONDS",
    "ActiveCall",
    "CancelOutcome",
    "StepOutcome",
    "abandoned_outcome",
    "invoke_timeout",
    "post_cancel",
    "post_invoke",
    "response_outcome",
    "transport_outcome",
]
