"""One accepted call on a Node and how its outcome is classified.

Acceptance is synchronous (no await): the instance must be ready, ``required_loaded_revision`` must match, the
call_id must not be in progress, ports and parameters must be valid and the resource_group try-lock must be
won. The deadline counts from acceptance (monotonic) and covers input download, compute and output publishing.

Cancellation and success are decided by synchronous sections on one event loop: whatever is recorded first
wins. A runtime that stops at the deadline on its own reports "cancelled"; only the Node knows whether anybody
asked to cancel, so without a cancel request that is a CALL_TIMEOUT, never a user cancellation.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.recorder import Recorder
from phasyn_components.timeutil import mono_ns

from .files import Materialized
from .previews import NodePreview
from .runtime import RuntimeProcess


DEFAULT_TIMEOUT_S = int(contracts.defaults_of("InvokeRequest")["timeout_seconds"])


@dataclass(frozen=True, kw_only=True)
class CallResources:
    """Loaded settings, process and lock reserved during invoke admission."""

    stored_revision: int
    invoke_defaults: dict[str, Any]
    output_types: dict[str, str]
    group: str
    holder: str
    proc: RuntimeProcess
    synthetic: bool


class ActiveCall:
    """Track a single invoke from admission through cancellation and finalization."""

    def __init__(
        self,
        *,
        body: Mapping[str, Any],
        recording_id: str,
        resources: CallResources,
    ) -> None:
        """Capture the request identity, limits and resources of the call."""
        self.call_id = str(body["call_id"])
        self.run_id: str | None = body.get("run_id")
        self.step_id: str | None = body.get("step_id")
        self.inputs: dict[str, dict[str, Any]] = {
            k: dict(v) for k, v in (body.get("inputs") or {}).items()
        }
        self.parameters: dict[str, Any] = dict(body.get("parameters") or {})
        self.recording: dict[str, Any] = dict(body.get("recording") or {})
        self.timeout_seconds = int(body.get("timeout_seconds") or DEFAULT_TIMEOUT_S)
        self.accepted_ns = mono_ns()
        self.deadline_ns = self.accepted_ns + self.timeout_seconds * 1_000_000_000
        self.recording_id = recording_id
        self.stored_revision = resources.stored_revision
        self.invoke_defaults = resources.invoke_defaults
        self.output_types = resources.output_types
        self.group = resources.group
        self.holder = resources.holder
        self.proc = resources.proc
        self.synthetic = resources.synthetic
        self.file_inputs = sum(1 for v in self.inputs.values() if "file" in v)
        self.downloads = 0
        self.cancel_requested = False
        self.cancel_reason: str | None = None
        self.deadline_hit = False
        self.final_state: str | None = None
        self.outcome = asyncio.Event()
        self.runtime_done: dict[str, Any] | None = None
        self.sent = False
        self.input_task: asyncio.Task[dict[str, dict[str, Any]]] | None = None
        self.recorder: Recorder | None = None
        self.kill_reason: str | None = None
        self.kill_lock = asyncio.Lock()
        self.process_exited: bool | None = None
        # 中間預覽（非最終結果）：只留最新一張，呼叫結束即刪除；notice 是給主控的 best-effort 通知
        self.preview: NodePreview | None = None
        self.preview_notice: asyncio.Task[None] | None = None
        self.preview_notice_dirty = False

    def remaining_s(self) -> float:
        """Return the remaining wall-clock budget in seconds."""
        return max(0.0, (self.deadline_ns - mono_ns()) / 1e9)

    def past_deadline(self) -> bool:
        """Report whether the call deadline has elapsed."""
        return mono_ns() >= self.deadline_ns

    def record(self, state: str) -> str:
        """The first recorded outcome wins (an output publish failure is the exception, see fail_after_success).

        A runtime that stops because the call's deadline passed often reports "cancelled" (providers see one
        cancel/deadline token). Only the Node knows whether anybody asked to cancel, so a "cancelled" without a
        cancel request after the deadline is recorded as a failed, timed-out call (CALL_TIMEOUT).
        """
        if self.final_state is None:
            if self.cancel_requested:
                state = "cancelled"
            elif self.deadline_hit or (state == "cancelled" and self.past_deadline()):
                self.deadline_hit = True
                state = "failed"
            self.final_state = state
            self.outcome.set()
        return self.final_state

    def fail_after_success(self) -> None:
        """Report a failure discovered while publishing the runtime result."""
        if self.final_state == "succeeded":
            self.final_state = "failed"

    def on_runtime_done(self, message: dict[str, Any]) -> None:
        """在讀取控制通道的同一個同步步驟內記錄結果（與 cancel 判定互斥）."""
        if self.runtime_done is None:
            self.runtime_done = message
        state = str(message.get("state") or "failed")
        self.record(
            state if state in ("succeeded", "failed", "cancelled") else "failed"
        )

    def note_materialized(self, item: Materialized) -> None:
        """Record the verified local copy used by this call."""
        if item.source == "download":
            self.downloads += 1


def check_inputs(
    description: Mapping[str, Any], inputs: Mapping[str, Mapping[str, Any]]
) -> None:
    """Validate each supplied input against the runtime ports."""
    ports = {
        str(p.get("name")): p
        for p in description.get("inputs") or []
        if isinstance(p, Mapping)
    }
    for name, value in inputs.items():
        port = ports.get(name)
        if port is None:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"元件沒有名為「{name}」的輸入 port",
                details={"port": name, "known": sorted(ports)},
            )
        if value.get("type_id") != port.get("type_id"):
            raise ComponentError(
                "PORT_MISMATCH",
                f"輸入 {name} 的 type_id「{value.get('type_id')}」與 port 宣告的「{port.get('type_id')}」不同；不猜轉換",
                details={
                    "port": name,
                    "expected": port.get("type_id"),
                    "actual": value.get("type_id"),
                },
            )
        transport = port.get("transport", "either")
        if transport == "inline" and "file" in value:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"輸入 {name} 只接受 inline JSON",
                details={"port": name},
            )
        if transport == "file" and "value" in value:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"輸入 {name} 只接受 FileRef",
                details={"port": name},
            )
    missing = sorted(
        n for n, p in ports.items() if p.get("required", True) and n not in inputs
    )
    if missing:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"缺少必填輸入：{', '.join(missing)}",
            details={"missing": missing},
        )


def deadline_error(call: ActiveCall) -> dict[str, Any]:
    """Build the terminal error for an expired call."""
    return ComponentError(
        "CALL_TIMEOUT",
        f"超過呼叫期限（timeout_seconds={call.timeout_seconds}）；元件程序在期限內沒有完成",
        details={
            "timeout_seconds": call.timeout_seconds,
            "reason": "deadline",
            "process_killed": False,
        },
    ).to_dict()


def final_error(
    call: ActiveCall, state: str, error: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Choose the terminal error consistent with the final call state."""
    runtime_error = (call.runtime_done or {}).get("error")
    if state == "succeeded":
        return None
    if state == "cancelled":
        # cancel_reason is None when the runtime stopped by itself (no cancel request reached the Node)
        details: dict[str, Any] = {"reason": call.cancel_reason or "runtime"}
        if call.kill_reason is not None:
            details.update(
                {"process_killed": True, "process_exited": call.process_exited}
            )
        message = "呼叫已取消"
        if call.cancel_reason == "shutdown":
            message = "Node 關閉中，呼叫已取消"
        if call.kill_reason is not None:
            message += "；cooperative 取消逾時，已終止自有 process group（HTTP 回覆不代表 GPU 已釋放）"
        return ComponentError("CANCELLED", message, details=details).to_dict()
    if error is not None:
        return error
    if (
        call.deadline_hit
    ):  # the runtime stopped at the deadline on its own (often reported as "cancelled")
        return deadline_error(call)
    if isinstance(runtime_error, Mapping) and runtime_error.get("code"):
        return ComponentError.from_dict(runtime_error).to_dict()
    return ComponentError(
        "RUNTIME_ERROR", "呼叫失敗（元件程序沒有提供錯誤細節）"
    ).to_dict()


__all__ = [
    "DEFAULT_TIMEOUT_S",
    "ActiveCall",
    "check_inputs",
    "deadline_error",
    "final_error",
]
