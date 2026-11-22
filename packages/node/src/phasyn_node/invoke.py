"""Running one accepted call.

The call runs in its own task (a dropped HTTP connection still completes it and leaves a record): input
transfer, the runtime invoke, output publishing, then the final summary. A cooperative cancel that outlives
``cancel_grace_seconds`` ends only this instance's own process group. Acceptance and outcome rules are in
:mod:`.call`; output files in :mod:`.outputs`.

With the host protection (``NodeConfig.admission``, :mod:`.admission`) a gated call also waits between its inputs
and its runtime phase, and its runtime phase runs beside an emergency watch whose cancel is ``cancel_call``.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError, to_component_error
from phasyn_components.recorder import Recorder
from phasyn_components.settings import deep_overlay, effective_context
from phasyn_components.typed import file_links

from .call import ActiveCall, final_error
from .descriptor import recorder_state_of
from .outputs import publish_or_withdraw, withdraw_outputs
from .recordings import RecordingOperation
from .runtime import RuntimeGoneError, describe_returncode


if TYPE_CHECKING:
    from .admission import AdmissionGuard, EmergencyWatch, Trip
    from .service import NodeService
    from .supervisor import ComponentInstance

log = logging.getLogger("phasyn_node.invoke")

CANCEL_ACK_TIMEOUT_S = 2.0


# ---------------------------------------------------------------------- helpers
def fallback_context(instance: ComponentInstance, call: ActiveCall) -> dict[str, Any]:
    """元件程序沒有回報 EffectiveContext 時（例如輸入下載失敗）的 Node 端快照：requested 為真實請求， effective.load 取自 load 時元件回報的實際設定；不偽補 observed."""
    load_ctx = instance.load_context or {}
    loaded = dict(instance.settings.loaded or {})
    eff_load = (
        (load_ctx.get("effective") or {}).get("load")
        if isinstance(load_ctx.get("effective"), Mapping)
        else None
    )
    requested = {
        "load": loaded,
        "invoke": call.invoke_defaults,
        "recording": call.recording,
        "parameters": call.parameters,
    }
    effective = {
        "load": dict(eff_load) if isinstance(eff_load, Mapping) else loaded,
        "invoke": call.invoke_defaults,
        "recording": call.recording,
        "parameters": deep_overlay(call.invoke_defaults, call.parameters),
    }
    return effective_context(
        requested=requested,
        effective=effective,
        observed=dict(load_ctx.get("observed") or {}),
        stored_revision=call.stored_revision,
        loaded_revision=instance.settings.loaded_revision,
        expanded_parts={
            k: dict(v)
            for k, v in (load_ctx.get("expanded_parts") or {}).items()
            if isinstance(v, Mapping)
        },
        model_identity=dict(load_ctx.get("model_identity") or {}),
        runtime_identity=dict(load_ctx.get("runtime_identity") or {}),
    )


def input_summary(call: ActiveCall) -> dict[str, Any]:
    """Describe the input transport and materialization for the recorder."""
    capture = bool(call.recording.get("capture_prompt", True))
    out: dict[str, Any] = {}
    for name, item in call.inputs.items():
        if "file" in item:
            ref = item["file"]
            out[name] = {
                "type_id": item["type_id"],
                "file": {
                    k: ref.get(k)
                    for k in (
                        "node_id",
                        "file_id",
                        "sha256",
                        "size_bytes",
                        "media_type",
                    )
                },
                "metadata": ref.get("metadata"),
            }
        elif capture:
            out[name] = {"type_id": item["type_id"], "value": item.get("value")}
        else:
            out[name] = {
                "type_id": item["type_id"],
                "value_digest": digest(item.get("value")),
                "captured": False,
            }
    return out


def _first_error(exc: BaseException) -> ComponentError:
    if isinstance(exc, BaseExceptionGroup):
        for inner in exc.exceptions:
            if not isinstance(inner, asyncio.CancelledError):
                return _first_error(inner)
    return to_component_error(exc)


async def resolve_inputs(
    svc: NodeService, call: ActiveCall, recorder: Recorder
) -> dict[str, dict[str, Any]]:
    async def one(item: Mapping[str, Any]) -> dict[str, Any]:
        if "file" not in item:
            return {"type_id": item["type_id"], "value": item.get("value")}
        ref = dict(item["file"])
        main = await svc.resolver.materialize(ref, recorder=recorder)
        call.note_materialized(main)
        links: dict[str, dict[str, Any]] = {}
        for link_name, link_ref in file_links(ref).items():
            linked = await svc.resolver.materialize(link_ref, recorder=recorder)
            call.note_materialized(linked)
            links[link_name] = {"file": link_ref, "path": str(linked.path)}
        return {
            "type_id": item["type_id"],
            "file": ref,
            "path": str(main.path),
            "links": links,
        }

    tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
    async with asyncio.TaskGroup() as group:
        for name, item in call.inputs.items():
            tasks[name] = group.create_task(
                one(item), name=f"input-{call.call_id}-{name}"
            )
    return {name: task.result() for name, task in tasks.items()}


async def _send_cancel(call: ActiveCall) -> bool | None:
    proc = call.proc
    if not proc.alive:
        return None
    key = f"cancel_ack:{call.call_id}"
    fut = proc.expect(key)
    try:
        await proc.send({"type": "cancel", "call_id": call.call_id})
        ack = await proc.wait(fut, limit_s=CANCEL_ACK_TIMEOUT_S)
        return bool(ack.get("accepted"))
    except (RuntimeGoneError, TimeoutError):
        proc.discard(key, fut)
        return None


# ---------------------------------------------------------------------- phases
async def _input_phase(
    svc: NodeService, call: ActiveCall, recorder: Recorder
) -> tuple[dict[str, dict[str, Any]] | None, dict[str, Any] | None]:
    task = asyncio.create_task(
        resolve_inputs(svc, call, recorder), name=f"inputs-{call.call_id}"
    )
    call.input_task = task
    with recorder.phase("input_transfer"):
        done, _ = await asyncio.wait({task}, timeout=call.remaining_s())
    call.input_task = None
    if not done:
        task.cancel()
        with contextlib.suppress(BaseException):
            await task
        call.deadline_hit = True
        call.record("failed")
        return None, ComponentError(
            "CALL_TIMEOUT",
            f"輸入傳輸未在呼叫期限（timeout_seconds={call.timeout_seconds}）內完成",
            details={
                "phase": "input_transfer",
                "timeout_seconds": call.timeout_seconds,
            },
        ).to_dict()
    if task.cancelled():
        call.record("cancelled")
        return None, None
    exc = task.exception()
    if exc is not None:
        call.record("failed")
        return None, _first_error(exc).to_dict()
    return task.result(), None


async def _admission_phase(
    guard: AdmissionGuard,
    instance: ComponentInstance,
    call: ActiveCall,
    recorder: Recorder,
    inputs: dict[str, dict[str, Any]] | None,
) -> dict[str, Any] | None:
    """Hold a gated call back while the host protection says no (its inputs are ready: downloads never hold the GPU).

    The wait is the call's ``wait`` phase and, while it lasts, its ``input_task``: a cancel ends it at once, as it
    ends an input transfer. The call's deadline still applies.
    """
    wait = guard.admission(
        recorder=recorder, component_id=instance.component_id, call_id=call.call_id
    )
    if await wait.check():
        return None
    if call.cancel_requested:  # the cancel came during the readings
        call.record("cancelled")
        return None

    async def held() -> dict[str, dict[str, Any]]:
        await wait.run()
        return (
            inputs or {}
        )  # an input task's result, so that cancel_call can end this wait like a transfer

    task = asyncio.create_task(held(), name=f"admission-{call.call_id}")
    call.input_task = task
    with recorder.phase("wait"):
        done, _ = await asyncio.wait({task}, timeout=call.remaining_s())
    call.input_task = None
    if not done:
        task.cancel()
        with contextlib.suppress(BaseException):
            await task
        call.deadline_hit = True
        call.record("failed")
        return wait.timeout_error(call.timeout_seconds)
    if task.cancelled():
        call.record("cancelled")
        return None
    exc = task.exception()
    if exc is not None:
        call.record("failed")
        return _first_error(exc).to_dict()
    return None


def _guard_cancel(
    instance: ComponentInstance, call: ActiveCall, recorder: Recorder, trip: Trip
) -> bool:
    """An emergency of the host protection: cancel through the Node's own cancel path (cooperative, then only this instance's process group after the grace). Declined when the call already has an outcome or a cancel under way."""
    if call.final_state is not None or call.cancel_requested:
        return False
    recorder.log(
        "warning",
        trip.text,
        phase="runtime",
        reason=trip.reason,
        sensor=trip.sensor,
        reading=trip.reading,
        threshold=trip.threshold,
    )
    log.warning(
        "%s（元件 %s 的呼叫 %s）", trip.text, instance.component_id, call.call_id
    )
    _ = instance.service.spawn_call_task(
        cancel_call(instance, call.call_id, reason=trip.reason),
        name=f"admission-cancel-{call.call_id}",
    )
    return True


async def _watched_runtime_phase(
    instance: ComponentInstance,
    call: ActiveCall,
    recorder: Recorder,
    inputs: dict[str, dict[str, Any]] | None,
    watch: EmergencyWatch,
) -> dict[str, Any] | None:
    """``_runtime_phase`` with the host protection's emergency watch beside it, stopped when the phase ends (a cancel it started runs in its own task and is never cut short)."""
    task = asyncio.create_task(watch.run(), name=f"admission-watch-{call.call_id}")
    try:
        return await _runtime_phase(instance, call, recorder, inputs)
    finally:
        task.cancel()
        (outcome,) = await asyncio.gather(task, return_exceptions=True)
        if isinstance(outcome, Exception):
            log.error(
                "主機保護監看元件 %s 的呼叫 %s 時失敗：%s",
                instance.component_id,
                call.call_id,
                outcome,
                exc_info=outcome,
            )


def _gone_error(call: ActiveCall) -> dict[str, Any] | None:
    proc = call.proc
    if call.final_state is None:
        call.record("failed")
    if call.final_state == "cancelled":
        return None
    if call.kill_reason == "deadline":
        return ComponentError(
            "CALL_TIMEOUT",
            "超過呼叫期限且 cooperative 取消逾時；已終止自有 process group（HTTP 回覆不代表 GPU 已釋放）",
            details={
                "process_killed": True,
                "process_exited": call.process_exited,
                "timeout_seconds": call.timeout_seconds,
            },
        ).to_dict()
    return ComponentError(
        "RUNTIME_ERROR",
        f"元件程序在呼叫中結束（{describe_returncode(proc.returncode)}）；不自動重啟",
        details={"process_exited": True, **proc.exit_details()},
    ).to_dict()


async def _runtime_phase(
    instance: ComponentInstance,
    call: ActiveCall,
    recorder: Recorder,
    inputs: dict[str, dict[str, Any]] | None,
) -> dict[str, Any] | None:
    proc = call.proc
    key = f"run_done:{call.call_id}"
    fut = proc.expect(key)
    message = {
        "type": "invoke",
        "call_id": call.call_id,
        "run_id": call.run_id,
        "step_id": call.step_id,
        "recording_id": call.recording_id,
        "recording": call.recording,
        "parameters": call.parameters,
        "invoke_defaults": call.invoke_defaults,
        "inputs": inputs or {},
        "deadline_ns": call.deadline_ns,
        "output_types": call.output_types,
        "stored_revision": call.stored_revision,
    }
    with recorder.span("runtime_invoke", critical=True):
        try:
            await proc.send(message)
        except RuntimeGoneError:
            proc.discard(key, fut)
            return _gone_error(call)
        call.sent = True
        if call.cancel_requested:  # 取消在送出前就已受理：立即轉送
            _ = instance.service.spawn_task(
                _send_cancel(call), name=f"cancel-{call.call_id}"
            )
        try:
            await proc.wait(fut, limit_s=call.remaining_s())
        except RuntimeGoneError:
            return _gone_error(call)
        except TimeoutError:
            pass
        else:
            return None
        call.deadline_hit = True
        recorder.log(
            "warning",
            f"超過呼叫期限（timeout_seconds={call.timeout_seconds}）；送出 cooperative 取消",
            phase="deadline",
        )
        await _send_cancel(call)
        grace = float(instance.service.config.cancel_grace_seconds)
        try:
            await proc.wait(fut, limit_s=grace)
        except RuntimeGoneError:
            return _gone_error(call)
        except TimeoutError:
            exited = await instance.kill_for_call(call, reason="deadline")
            call.record("failed")
            return ComponentError(
                "CALL_TIMEOUT",
                f"超過呼叫期限且 {grace:.0f} 秒內未完成 cooperative 取消；已終止自有 process group"
                + ("（已確認退出）" if exited else "（未能確認退出）")
                + "；HTTP 回覆不代表 GPU 已釋放",
                details={
                    "process_killed": True,
                    "process_exited": exited,
                    "timeout_seconds": call.timeout_seconds,
                },
            ).to_dict()
        return ComponentError(
            "CALL_TIMEOUT",
            f"超過呼叫期限（timeout_seconds={call.timeout_seconds}）；已送出取消，元件程序在 grace 內結束本次呼叫",
            details={"timeout_seconds": call.timeout_seconds, "process_killed": False},
        ).to_dict()


async def _output_phase(
    svc: NodeService, call: ActiveCall, recorder: Recorder
) -> tuple[dict[str, dict[str, Any]], dict[str, Any] | None]:
    done = call.runtime_done or {}
    with recorder.phase("output_publish"):
        task = asyncio.ensure_future(
            asyncio.to_thread(publish_or_withdraw, svc.store, done)
        )
        finished, _ = await asyncio.wait({task}, timeout=call.remaining_s())
    if not finished:
        call.deadline_hit = True
        # The publishing thread cannot be interrupted: once it ends, take back whatever it published.
        task.add_done_callback(lambda late: _withdraw_late(svc, done, late))
        return {}, ComponentError(
            "CALL_TIMEOUT",
            "輸出發布未在呼叫期限內完成",
            details={
                "phase": "output_publish",
                "timeout_seconds": call.timeout_seconds,
            },
        ).to_dict()
    exc = task.exception()
    if exc is not None:
        return {}, to_component_error(exc).to_dict()
    return task.result(), None


def _withdraw_late(
    svc: NodeService, done: Mapping[str, Any], task: asyncio.Future[Any]
) -> None:
    """Done-callback of a publish that outlived the call's deadline (a failed one already withdrew itself)."""
    if task.cancelled() or task.exception() is not None:
        return
    _ = svc.spawn_task(
        asyncio.to_thread(withdraw_outputs, svc.store, done),
        name="withdraw-late-outputs",
    )


@dataclass
class _Protection:
    watch: EmergencyWatch | None = None


async def _compute(
    instance: ComponentInstance,
    call: ActiveCall,
    recorder: Recorder,
    guard: AdmissionGuard | None,
    protection: _Protection,
) -> dict[str, Any] | None:
    svc = instance.service
    error: dict[str, Any] | None = None
    inputs: dict[str, dict[str, Any]] | None = None
    if call.final_state is None:
        inputs, error = await _input_phase(svc, call, recorder)
    if guard is not None and call.final_state is None and not call.cancel_requested:
        error = await _admission_phase(guard, instance, call, recorder, inputs)
    if call.final_state is None:
        if call.cancel_requested:
            call.record("cancelled")
        elif guard is not None:
            protection.watch = guard.watch(
                instance.loaded_device(),
                functools.partial(_guard_cancel, instance, call, recorder),
            )
            error = await _watched_runtime_phase(
                instance, call, recorder, inputs, protection.watch
            )
        else:
            error = await _runtime_phase(instance, call, recorder, inputs)
    return error


async def run_call(instance: ComponentInstance, call: ActiveCall) -> dict[str, Any]:
    """受理後的整個呼叫；在獨立 task 執行（HTTP 連線中斷也會完成並留下紀錄）."""
    svc = instance.service
    proc = call.proc
    guard = svc.admission
    if guard is not None and not guard.gates(
        exclusive_group=instance.exclusive_group, provider_id=instance.provider_id
    ):
        guard = None  # the host protection holds back and watches gated calls only
    protection = _Protection()
    recorder: Recorder | None = None
    token: int | None = None
    error: dict[str, Any] | None = None
    outputs: dict[str, dict[str, Any]] = {}
    try:
        try:
            recorder = await svc.new_recorder(
                instance,
                config=call.recording,
                activity=RecordingOperation(
                    operation="invoke",
                    recording_id=call.recording_id,
                    run_id=call.run_id,
                    call_id=call.call_id,
                    synthetic=call.synthetic,
                ),
            )
            call.recorder = recorder
            instance.set_active_recorder(recorder, proc)
            token = svc.sampler.subscribe(instance.loaded_device(), recorder, proc.pid)
            recorder.set_metric(
                "node.lock_wait_ms",
                0.0,
                unit="ms",
                scope="call",
                method="try_lock",
                reason=None,
            )
            await asyncio.to_thread(
                recorder.write_context,
                settings=fallback_context(instance, call),
                input_summary=input_summary(call),
                environment=svc.environment(instance, proc),
            )
            error = await _compute(instance, call, recorder, guard, protection)
            if call.final_state == "succeeded":
                outputs, error = await _output_phase(svc, call, recorder)
                if error is not None:
                    call.fail_after_success()
                    outputs = {}
            else:
                await asyncio.to_thread(withdraw_outputs, svc.store, call.runtime_done)
        except Exception as exc:
            log.exception(
                "元件 %s 的呼叫 %s 發生 Node 端錯誤",
                instance.component_id,
                call.call_id,
            )
            error = to_component_error(exc).to_dict()
            call.record("failed")
            call.fail_after_success()
            outputs = {}
        state = call.final_state or "failed"
        error = final_error(call, state, error)
        trip = protection.watch.trip if protection.watch is not None else None
        if (
            trip is not None
            and state == "cancelled"
            and call.cancel_reason == trip.reason
        ):
            # Stopped by the host protection, not by a person: a failure that says why (the cancel path stopped it).
            state = call.final_state = "failed"
            error = trip.error(
                process_killed=call.kill_reason is not None,
                process_exited=call.process_exited,
            )
        return await _finalize(
            instance,
            call,
            recorder,
            _CallResult(state=state, error=error, outputs=outputs),
        )
    finally:
        call.preview = None  # previews only live while the call runs: the final output is the result
        svc.preview_notifier.discard(call)
        svc.sampler.unsubscribe(token)
        if recorder is not None:
            instance.clear_active_recorder(recorder)
        instance.end_call(call)


@dataclass(frozen=True, kw_only=True)
class _CallResult:
    """Terminal status, error and published outputs for an invoke."""

    state: str
    error: dict[str, Any] | None
    outputs: dict[str, dict[str, Any]]


async def _finalize(
    instance: ComponentInstance,
    call: ActiveCall,
    recorder: Recorder | None,
    result: _CallResult,
) -> dict[str, Any]:
    svc = instance.service
    done = call.runtime_done or {}
    runtime_summary = (
        done.get("summary") if isinstance(done.get("summary"), Mapping) else None
    )
    runtime_settings = done.get("settings")
    settings_ctx = (
        runtime_settings
        if contracts.is_valid("EffectiveContext", runtime_settings)
        else fallback_context(instance, call)
    )
    if recorder is not None:
        if call.file_inputs and not call.downloads:
            recorder.set_metric("network_received_bytes", 0, reason=None)
        await call.proc.drain_stderr()
        node_summary = await asyncio.to_thread(
            recorder.finalize, result.state, error=result.error, write=False
        )
        merged = svc.merge_summaries(node_summary, runtime_summary, result.state)
        instance.recorder_state = recorder_state_of(recorder.mode, merged)
    else:
        merged = svc.merge_summaries(
            svc.placeholder_summary(call.recording_id, result.state, result.error),
            runtime_summary,
            result.state,
        )
    await svc.publish_final_summary(call.recording_id, merged)
    summary_out = await svc.inline_or_fileref_summary(call.recording_id, merged)
    return {
        "call_id": call.call_id,
        "recording_id": call.recording_id,
        "state": result.state,
        "outputs": result.outputs if result.state == "succeeded" else {},
        "settings": settings_ctx,
        "error": result.error,
        "summary": summary_out,
    }


# ---------------------------------------------------------------------- cancel
def _inactive_cancel(
    instance: ComponentInstance, call_id: str, call: ActiveCall | None
) -> dict[str, Any]:
    previous = instance.recent_call_state(call_id)
    if previous is not None:
        message = f"呼叫 {call_id} 已結束（{previous}）；cancel 不另起取消任務"
    elif call is None:
        message = "此元件目前沒有進行中的呼叫；cancel 只作用於指定的 active call"
    else:
        message = f"進行中的呼叫是 {call.call_id}，不是 {call_id}；cancel 只作用於指定的 active call"
    return {
        "call_id": call_id,
        "accepted": False,
        "process_exited": None,
        "message": message,
    }


def _cancelled_process_status(call: ActiveCall) -> tuple[bool | None, str]:
    if call.process_exited is not None:
        exited = True if call.process_exited else None
    else:
        exited = not call.proc.alive
    if exited is False:
        message = "已取消（cooperative）；元件程序仍在執行並保持載入"
    elif exited:
        message = "已取消；元件程序已結束（HTTP 回覆不代表 GPU 已釋放）"
    else:
        message = "已取消；元件程序是否結束未能確認"
    return exited, message


async def cancel_call(
    instance: ComponentInstance, call_id: str, *, reason: str = "user"
) -> dict[str, Any]:
    """Request cancellation and report whether the owned process stopped."""
    svc = instance.service
    call = instance.active_call
    if call is None or call.call_id != call_id:
        return _inactive_cancel(instance, call_id, call)
    if call.final_state is not None and not call.cancel_requested:
        return {
            "call_id": call_id,
            "accepted": False,
            "process_exited": None,
            "message": f"呼叫已完成（{call.final_state}），正在整理輸出；取消未採用",
        }
    if not call.cancel_requested:
        call.cancel_requested = True
        call.cancel_reason = reason
        if call.recorder is not None:
            call.recorder.log("warning", "收到取消要求（cooperative）", reason=reason)
    task = call.input_task
    if task is not None and not task.done():
        task.cancel()
    if call.sent:
        await _send_cancel(call)
    grace = float(svc.config.cancel_grace_seconds)
    try:
        await asyncio.wait_for(call.outcome.wait(), timeout=grace)
        finished = True
    except TimeoutError:
        finished = False
    if finished:
        exited, message = _cancelled_process_status(call)
    else:
        exited = await instance.kill_for_call(call, reason="cancel")
        if exited:
            message = (
                f"cooperative 取消在 {grace:.0f} 秒內未完成；已終止這個 instance 的 process group 並確認退出。"
                "HTTP 回覆不代表 GPU 已釋放，請以裝置樣本確認"
            )
        else:
            message = f"cooperative 取消在 {grace:.0f} 秒內未完成；已送出 SIGKILL 但未能確認程序退出（未知），請人工處理"
    return {
        "call_id": call_id,
        "accepted": True,
        "process_exited": exited,
        "message": message,
    }


__all__ = [
    "CANCEL_ACK_TIMEOUT_S",
    "cancel_call",
    "fallback_context",
    "input_summary",
    "run_call",
]
