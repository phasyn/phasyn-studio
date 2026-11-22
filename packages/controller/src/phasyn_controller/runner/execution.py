"""Executing one run: the DAG scheduler, settling steps, stopping and finishing.

- Steps run when their dependencies succeeded; independent ready branches run in parallel. Steps sharing
  (node_id, resource_group) wait for the previous one (``waiting``), in this run or in another active run: the
  ``RunManager`` holds one occupancy for every active run (``dispatch``); this is not a hidden queue on a Node.
- Of the ready steps sharing a key the first in run order starts, unless a later one feeds another key that is about
  to run dry (``choose_starts``): a second DiT lane is kept one step ahead, and a single lane keeps the plain order.
- Between runs the older run picks first; a younger run's step takes a key that no older run's ready step took.
- First failure: no new step starts (the rest are skipped) and every other running call gets exactly one cancel.
  An unanswered cancel marks that step remote_outcome_unknown and the controller stops waiting for it.
- ``run.json`` is the run's snapshot and result, rewritten atomically after each change. There is no outbox and
  the Controller reconciles persisted attempts by identity before advancing a recovered run.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import errno
import logging
import time
from collections.abc import Collection, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Literal

from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.ids import new_id
from phasyn_components.timeutil import utc_now

from ..runs import STOP_MESSAGE, TERMINAL_STEP_STATES, encode_run, interrupted_error
from .node_calls import ActiveCall, CancelOutcome, StepOutcome, post_cancel, post_invoke
from .on_demand import Fail, Stopped, Wait
from .plan import StepPlan, invoke_request, resolve_inputs
from .recording import RunRecording
from .recovery import reconcile, unknown, watch


if TYPE_CHECKING:
    from . import RunManager

log = logging.getLogger("phasyn_controller.runner")

FINISH_WAIT_S = 15.0
StopReason = Literal["failure", "cancelled", "user"]
ResourceKey = tuple[str, str]  # (node_id, resource_group)
Holders = dict[
    ResourceKey, tuple["RunExecution", str]
]  # key -> (run, step) that holds it


def final_state(
    steps: Mapping[str, Mapping[str, Any]],
    reason: StopReason | None,
    stop_step: str | None,
) -> tuple[str, dict[str, Any] | None]:
    """The run's terminal state and Error from its steps and why it stopped (pure)."""
    if reason is None:
        if all(e["state"] == "succeeded" for e in steps.values()):
            return "succeeded", None
        reason = "failure"
    if reason == "user":
        return "cancelled", {
            "code": "CANCELLED",
            "message": "使用者取消此 run；未開始的步驟不會執行",
        }
    entry = steps.get(stop_step or "") or {}
    if reason == "cancelled":
        return "cancelled", {
            "code": "CANCELLED",
            "message": f"步驟 {stop_step} 的呼叫已被取消，run 停止",
            "details": {"step_id": stop_step},
        }
    step_error = entry.get("error") or {}
    err: dict[str, Any] = {
        "code": str(step_error.get("code") or "RUNTIME_ERROR"),
        "message": f"步驟 {stop_step} 失敗：{step_error.get('message') or '沒有錯誤內容'}"[
            :16384
        ],
        "details": {"step_id": stop_step},
    }
    if step_error.get("remote_outcome_unknown") or entry.get("remote_outcome_unknown"):
        err["remote_outcome_unknown"] = True
    return "failed", err


def collect_outputs(
    pipeline: Mapping[str, Any], steps: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    """The pipeline outputs that exist (a missing upstream output is simply absent)."""
    out: dict[str, Any] = {}
    for name, ref in (pipeline.get("outputs") or {}).items():
        value = (steps.get(str(ref["from_step"]), {}).get("outputs") or {}).get(
            str(ref["output"])
        )
        if value is not None:
            out[name] = copy.deepcopy(value)
    return out


def dependents_of(
    order: Sequence[str], plans: Mapping[str, StepPlan]
) -> dict[str, tuple[str, ...]]:
    """step_id -> the steps that read its outputs, in run order (pure)."""
    found: dict[str, list[str]] = {sid: [] for sid in order}
    for sid in order:
        for dep in plans[sid].deps:
            found[dep].append(sid)
    return {sid: tuple(dependents) for sid, dependents in found.items()}


def ready_steps(
    order: Sequence[str],
    plans: Mapping[str, StepPlan],
    steps: Mapping[str, Mapping[str, Any]],
) -> list[str]:
    """The steps that may start now, in run order: not started yet and every dependency succeeded (pure)."""
    return [
        sid
        for sid in order
        if steps[sid]["state"] in ("pending", "waiting")
        and all(steps[dep]["state"] == "succeeded" for dep in plans[sid].deps)
    ]


def choose_starts(
    ready: Sequence[str],
    plans: Mapping[str, StepPlan],
    steps: Mapping[str, Mapping[str, Any]],
    dependents: Mapping[str, Sequence[str]],
    busy: Collection[ResourceKey],
) -> dict[ResourceKey, str]:
    """The step each free key in ``ready`` starts now (pure: the same states always give the same choice).

    Normally the first ready step in run order. A later one goes first when it feeds a key about to run dry: a
    dependent on another key that has nothing ready or waiting beyond the step it runs or starts now, and whose other
    dependencies are done, running or ready. A dependent on the step's own key never counts; ties keep run order.
    """
    queues: dict[ResourceKey, list[str]] = {}
    for sid in ready:
        queues.setdefault(plans[sid].resource_key, []).append(sid)
    ready_set = set(ready)

    def runs_dry(key: ResourceKey) -> bool:
        return len(queues.get(key, ())) <= (0 if key in busy else 1)

    def feeds_dry_key(sid: str) -> bool:
        own = plans[sid].resource_key
        for dependent in dependents.get(sid, ()):
            target = plans[dependent]
            if target.resource_key == own or not runs_dry(target.resource_key):
                continue
            if all(
                dep == sid
                or dep in ready_set
                or steps[dep]["state"] in ("succeeded", "running")
                for dep in target.deps
            ):
                return True
        return False

    return {
        key: next((sid for sid in queue if feeds_dry_key(sid)), queue[0])
        for key, queue in queues.items()
        if key not in busy
    }


class RunExecution:
    """Schedule, cancel and complete the steps of one saved run."""

    def __init__(
        self,
        manager: RunManager,
        run: dict[str, Any],
        plans: dict[str, StepPlan],
        order: list[str],
        recording_id: str,
    ) -> None:
        """Keep the frozen run, dependency order and recording identity."""
        self.manager = manager
        self.ctl = manager.ctl
        self.run = run
        self.run_id: str = run["run_id"]
        self.steps: dict[str, dict[str, Any]] = run["steps"]
        self.plans = plans
        self.order = order
        self.dependents = dependents_of(order, plans)
        self.recording = RunRecording(self.ctl, run, plans, recording_id)
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._task_steps: dict[asyncio.Task[None], str] = {}
        self.active_calls: dict[str, ActiveCall] = {}
        self.previews: dict[
            str, dict[str, Any]
        ] = {}  # step_id -> RunStepPreview (memory only; dropped on settle)
        self.cancel_tasks: list[asyncio.Task[CancelOutcome]] = []
        self.receipt_waiters: set[str] = set()
        self.waiting_for_node = False
        # step_id -> loop time before which a step that waits for an on_demand load is not dispatched again
        self.retry_at: dict[str, float] = {}
        self.restoring = False
        self.stop_reason: StopReason | None = run.get("stop_reason")
        self.stop_step: str | None = run.get("stop_step")
        self.finishing = False
        self.task: asyncio.Task[None] | None = None
        self.scheduling = False  # the scheduler loop runs: ``RunManager.dispatch`` may start this run's steps
        self.dirty = False  # a dispatch changed step states that are not on disk yet
        self.wake = (
            asyncio.Event()
        )  # another run's dispatch started a step here, or a cancel needs a look
        self._persist_lock = asyncio.Lock()

    async def persist(
        self, *, raise_errors: bool = False, run: dict[str, Any] | None = None
    ) -> None:
        """Write ``run`` (the live snapshot unless given) to ``run.json``."""
        async with self._persist_lock:
            try:
                data = encode_run(self.run if run is None else run)
                write = asyncio.create_task(
                    asyncio.to_thread(self.ctl.runs.write, self.run_id, data)
                )
                try:
                    await asyncio.shield(write)
                except asyncio.CancelledError:
                    await write  # the disk writer must finish before releasing the serialization lock
                    raise
            except (OSError, ValueError) as exc:
                if raise_errors:
                    code = (
                        "DISK_FULL"
                        if isinstance(exc, OSError) and exc.errno == errno.ENOSPC
                        else "RUNTIME_ERROR"
                    )
                    raise ComponentError(
                        code, f"run.json 寫入失敗：{exception_message(exc)}"
                    ) from exc
                log.error(  # noqa: TRY400 — keep external failures out of tracebacks.
                    "run %s 的 run.json 寫入失敗（記憶體狀態繼續）：%s",
                    self.run_id,
                    exception_message(exc),
                )

    # ------------------------------------------------------------------ main flow
    def start(self) -> None:
        """Schedule the run in an asyncio task."""
        self.task = asyncio.create_task(self._main(), name=f"run-{self.run_id}")

    async def _main(self) -> None:
        try:
            await self.recording.open()
            if self.restoring:
                await self._reattach()
            await self._schedule()
            await self._finish()
        except asyncio.CancelledError:
            await self._cancel_children()
            raise
        except Exception as exc:
            log.exception("run %s：runner 內部錯誤", self.run_id)
            await self._cancel_children()
            try:
                await self._crash(exc)
            finally:
                self.manager.release(self)
                self.manager.forget(self)

    async def _reattach(self) -> None:
        if self.stop_reason is None:
            for sid in self.order:
                state = self.steps[sid]["state"]
                if state in ("failed", "cancelled", "interrupted"):
                    self._begin_stop(
                        "cancelled" if state == "cancelled" else "failure", sid
                    )
                    break
        for sid in self.order:
            entry = self.steps[sid]
            if entry["state"] != "running":
                continue
            attempts = entry.get("attempts") or []
            if not attempts or (
                attempts[-1].get("superseded")
                and attempts[-1]["call_id"] != entry["call_id"]
            ):
                # v1 cannot have sent HTTP before the first durable dispatch record.
                if self.stop_reason:
                    self._not_started(sid)
                else:
                    entry.update(state="pending", call_id=None)
                continue
            self.receipt_waiters.add(sid)
            entry.update(awaiting_receipt=True, remote_outcome_unknown=True)
            task = asyncio.create_task(
                self._run_step(sid, recovering=True), name=f"resume-{self.run_id}-{sid}"
            )
            self.tasks[sid] = task
            self._task_steps[task] = sid
        # Pending steps must use their original immutable settings after their Node re-registers.
        await self.persist(raise_errors=True)

    async def _schedule(self) -> None:
        self.scheduling = True
        try:
            await self._schedule_loop()
        finally:
            self.scheduling = False

    async def _schedule_loop(self) -> None:
        while True:
            self.manager.dispatch()  # every key freed since the last pass, in any run, is handed out here
            self.wake.clear()  # what this pass started is in self.tasks below
            if self.dirty:
                self.dirty = False
                await self.persist()
            if not self.tasks and (self.stop_reason is not None or not self._ready()):
                break
            waiter = asyncio.create_task(self._woken(), name=f"run-{self.run_id}-wake")
            try:
                done, _ = await asyncio.wait(
                    {*self.tasks.values(), waiter},
                    return_when=asyncio.FIRST_COMPLETED,
                    timeout=1 if self.waiting_for_node or self.retry_at else None,
                )
            finally:
                waiter.cancel()
            done.discard(waiter)
            if not done:  # only woken: another run started a step here, or a cancel left nothing to wait for
                continue
            for task in done:
                sid = self._task_steps.pop(task)
                del self.tasks[sid]
                if task.cancelled() or task.exception() is not None:
                    exc = None if task.cancelled() else task.exception()
                    log.error(
                        "run %s 步驟 %s 內部錯誤：%s",
                        self.run_id,
                        sid,
                        type(exc).__name__ if exc else "cancelled",
                    )
                    error = ComponentError(
                        "RUNTIME_ERROR",
                        f"runner 處理步驟 {sid} 時發生內部錯誤：{type(exc).__name__ if exc else 'cancelled'}",
                        remote_outcome_unknown=True,
                    )
                    self._settle(
                        sid, StepOutcome("failed", error.to_dict(), unknown=True)
                    )
                state = self.steps[sid]["state"]
                # waiting: the step gave its key back to wait for an on_demand load (dispatched again later)
                if self.stop_reason is None and state not in (
                    "succeeded",
                    "pending",
                    "waiting",
                ):
                    self._begin_stop(
                        "cancelled" if state == "cancelled" else "failure", sid
                    )
            await self.persist()
        if self.cancel_tasks:
            await asyncio.gather(*self.cancel_tasks, return_exceptions=True)

    async def _woken(self) -> None:
        await self.wake.wait()

    def _ready(self) -> list[str]:
        return ready_steps(self.order, self.plans, self.steps)

    def ready_now(self) -> list[str]:
        """The steps that may start now and have no task yet (an on_demand load wait included)."""
        return [sid for sid in self._ready() if sid not in self.tasks]

    @property
    def only_reconciling(self) -> bool:
        """Check whether the execution is waiting only for prior attempt evidence."""
        if self.tasks:
            return self.tasks.keys() <= self.receipt_waiters
        if self.waiting_for_node:
            return True
        holders = self.manager.holders()
        blocking = [holders.get(self.plans[sid].resource_key) for sid in self._ready()]
        return bool(blocking) and all(
            hold is not None and hold[1] in hold[0].receipt_waiters for hold in blocking
        )

    @property
    def computing(self) -> bool:
        """Report whether this execution currently occupies compute capacity."""
        return any(
            sid not in self.receipt_waiters and not task.done()
            for sid, task in self.tasks.items()
        )

    def holds(self) -> Holders:
        """The keys this run occupies: its running steps, then (once stopped) steps whose call may still run."""
        held: Holders = {
            self.plans[sid].resource_key: (self, sid) for sid in self.tasks
        }
        if self.stop_reason is not None:
            for sid in self.order:  # an unanswered cancel or a lost answer: the Node may still be busy with it
                if self.steps[sid].get("remote_outcome_unknown"):
                    held.setdefault(self.plans[sid].resource_key, (self, sid))
        return held

    def _enforce_dispatch_deadline(self) -> None:
        deadline = self.run.get("dispatch_deadline")
        if (
            deadline is not None
            and self.stop_reason is None
            and time.time() >= deadline
        ):
            self._begin_stop("user", None)

    def start_ready(self, held: Holders) -> bool:
        """Start the ready steps whose key is free in ``held`` (every active run's keys); add them to ``held``."""
        self._enforce_dispatch_deadline()
        changed = False
        ready = []
        self.waiting_for_node = False
        now = asyncio.get_running_loop().time()
        for sid in self._ready():
            if (
                sid in self.tasks
            ):  # its task is still giving the key back (on_demand wait)
                continue
            if self.retry_at.get(sid, now) > now:
                continue
            self.retry_at.pop(sid, None)
            if self.restoring:
                try:
                    self.ctl.catalog.endpoint_for_call(self.plans[sid].node_id)
                except ComponentError:
                    self.waiting_for_node = True
                    if self.steps[sid]["state"] != "waiting":
                        self.steps[sid]["state"] = "waiting"
                        changed = True
                    continue
            ready.append(sid)
        chosen = choose_starts(
            ready, self.plans, self.steps, self.dependents, held.keys()
        )
        holders: Holders = {**held, **{key: (self, sid) for key, sid in chosen.items()}}
        for sid in ready:
            entry = self.steps[sid]
            plan = self.plans[sid]
            owner, holder = holders[plan.resource_key]
            if owner is not self or holder != sid:
                if entry["state"] != "waiting":
                    entry["state"] = "waiting"
                    changed = True
                    where = "" if owner is self else f"（run {owner.run_id}）"
                    self.recording.log(
                        "info",
                        f"步驟 {sid} 等待同一 Node／resource_group 的步驟 {holder}{where} 完成",
                        node_id=plan.node_id,
                        resource_group=plan.resource_key[1],
                    )
                continue
            entry["state"] = "running"
            entry["started_at"] = utc_now()
            entry["call_id"] = new_id()
            task = asyncio.create_task(
                self._start_step(sid), name=f"run-{self.run_id}-{sid}"
            )
            self.tasks[sid] = task
            self._task_steps[task] = sid
            held[plan.resource_key] = (self, sid)
            changed = True
        return changed

    async def _step_endpoint(self, sid: str, *, recovering: bool) -> str | None:
        node = self.plans[sid].node_id
        while True:
            try:
                return self.ctl.catalog.endpoint_for_call(node)
            except ComponentError:
                if not recovering:
                    raise
                if self.stop_reason is not None:
                    self._settle(
                        sid,
                        unknown(
                            str(self.steps[sid]["call_id"]), "Node 離線；未能確認舊呼叫"
                        ),
                    )
                    return None
                await asyncio.sleep(1)

    async def _freeze_attempt(
        self, sid: str, body: dict[str, Any], fingerprint: str, *, recovering: bool
    ) -> dict[str, Any] | None:
        entry = self.steps[sid]
        if recovering:
            attempt: dict[str, Any] = entry["attempts"][-1]
            if (
                attempt["call_id"] != body["call_id"]
                or attempt["request_digest"] != fingerprint
            ):
                self._settle(
                    sid, unknown(str(body["call_id"]), "原派送資料無法核對；未重送")
                )
                return None
        else:
            attempt = {
                "call_id": body["call_id"],
                "request_digest": fingerprint,
                "cancel_sent": False,
            }
            entry["attempts"].append(attempt)
            try:
                await self.persist(raise_errors=True)
            except ComponentError as exc:
                self._settle(sid, StepOutcome("failed", exc.to_dict(), sent=False))
                return None
        return attempt

    async def _send_attempt(
        self, call: ActiveCall, body: dict[str, Any], fingerprint: str
    ) -> tuple[StepOutcome, bool]:
        sid = call.step_id
        entry = self.steps[sid]
        self.recording.log(
            "info",
            f"步驟 {sid} 送出 invoke",
            call_id=call.call_id,
            node_id=call.node_id,
        )
        self.recording.count("controller.invoke_posts")
        with self.recording.span("invoke", part=sid):
            outcome, settled = await self._invoke_or_receipt(call, body, fingerprint)
        if settled is not None:
            self.recording.log(
                "warning",
                f"步驟 {sid} 的 invoke 回覆沒有回來；依 Node 的呼叫紀錄結束",
                call_id=call.call_id,
            )
            return settled
        code = (outcome.error or {}).get("code")
        if outcome.unknown or (
            outcome.sent
            and code
            in {
                "CALL_ID_CONFLICT",
                "COMPONENT_BUSY",
                "COMPONENT_NOT_READY",
                "CALL_TIMEOUT",
            }
        ):
            self.receipt_waiters.add(sid)
            entry.update(awaiting_receipt=True, remote_outcome_unknown=True)
            self.manager.dispatch()
            await self.persist()
            return await reconcile(self.ctl, call, body, fingerprint)
        return outcome, False

    async def _invoke_or_receipt(
        self, call: ActiveCall, body: dict[str, Any], fingerprint: str
    ) -> tuple[StepOutcome, tuple[StepOutcome, bool] | None]:
        """The invoke reply, or the Node's receipt when it settles the call first (the reply was lost)."""
        post = asyncio.create_task(
            post_invoke(
                self.ctl.http, call, body, self.plans[call.step_id].timeout_seconds
            )
        )
        receipt = asyncio.create_task(watch(self.ctl, call, body, fingerprint))
        try:
            await asyncio.wait({post, receipt}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (post, receipt):
                if not task.done():
                    task.cancel()
            await asyncio.gather(post, receipt, return_exceptions=True)
        if post.done() and not post.cancelled() and post.exception() is None:
            return post.result(), None
        if receipt.done() and not receipt.cancelled() and receipt.exception() is None:
            settled = receipt.result()
            return settled[0], settled
        if post.done() and not post.cancelled():
            return post.result(), None  # re-raises the invoke's own error
        raise receipt.exception() or RuntimeError("呼叫紀錄監看意外結束")

    def _may_retry(self, entry: dict[str, Any]) -> bool:
        return (
            self.stop_reason is None
            and len(entry["attempts"]) == 1
            and entry.get("retry_after_verified_stop") is True
            and self.run["request"].get("recovery_policy", "observe_only")
            == "retry_verified"
        )

    async def _start_step(self, sid: str) -> None:
        """A freshly dispatched step: its on_demand component is loaded first, then the call goes out."""
        if await self._component_loaded(sid):
            await self._run_step(sid)

    async def _component_loaded(self, sid: str) -> bool:
        """Load the step's on_demand component first; False = the step waits again, was stopped or failed."""
        verdict = await self.manager.on_demand.ensure_loaded(self, sid)
        if isinstance(verdict, Wait):
            return False
        if isinstance(verdict, Stopped):
            self._not_started(sid)
            return False
        if isinstance(verdict, Fail):
            self._settle(
                sid, StepOutcome("failed", verdict.error.to_dict(), sent=False)
            )
            return False
        return True

    async def _run_step(self, sid: str, *, recovering: bool = False) -> None:
        entry = self.steps[sid]
        plan = self.plans[sid]
        try:
            inputs = resolve_inputs(
                plan, self.run["request"].get("inputs") or {}, self.steps
            )
            endpoint = await self._step_endpoint(sid, recovering=recovering)
            if endpoint is None:
                return
            body = invoke_request(self.run_id, plan, entry, inputs)
        except ComponentError as err:
            outcome = (
                unknown(str(entry["call_id"]), "無法重建舊呼叫以供核對")
                if recovering
                else StepOutcome(
                    "failed",
                    err.to_dict(),
                    unknown=err.remote_outcome_unknown,
                    sent=False,
                )
            )
            self._settle(sid, outcome)
            return
        fingerprint = digest(body)
        attempt = await self._freeze_attempt(
            sid, body, fingerprint, recovering=recovering
        )
        if attempt is None:
            return
        self._enforce_dispatch_deadline()
        if self.stop_reason is not None and not recovering:
            self._not_started(sid)
            return
        label = self.ctl.catalog.label(plan.node_id)
        call = ActiveCall(
            sid, plan.node_id, plan.component_id, str(entry["call_id"]), endpoint, label
        )
        self.active_calls[sid] = call
        try:
            if recovering:
                # cancel_sent is durable intent, not proof that the Node received the POST.
                # Re-arm the idempotent cancellation only for this exact running attempt.
                def cancel_if_stopping() -> None:
                    if self.stop_reason:
                        _ = self._ensure_cancel(call)

                outcome, retry = await reconcile(
                    self.ctl, call, body, fingerprint, on_running=cancel_if_stopping
                )
            else:
                outcome, retry = await self._send_attempt(call, body, fingerprint)
            if entry["call_id"] != call.call_id:
                return
            if retry and self._may_retry(entry):
                attempt["superseded"] = True
                entry.update(
                    state="pending",
                    call_id=None,
                    started_at=None,
                    finished_at=None,
                    awaiting_receipt=False,
                    remote_outcome_unknown=False,
                )
                await self.persist(raise_errors=True)
                return
        finally:
            self.receipt_waiters.discard(sid)
            self.active_calls.pop(sid, None)
        self._settle(sid, outcome)

    def _settle(self, sid: str, outcome: StepOutcome) -> None:
        """The only place a started step reaches its terminal state."""
        entry = self.steps[sid]
        entry.pop("component_load", None)
        plan = self.plans[sid]
        self.manager.on_demand.touch((plan.node_id, plan.component_id))
        entry["awaiting_receipt"] = False
        entry["state"] = outcome.state
        entry["finished_at"] = utc_now()
        self.previews.pop(
            sid, None
        )  # an intermediate preview is not a result: gone once the step ends
        if not outcome.sent:
            entry["call_id"] = None
        if outcome.outputs is not None:
            entry["outputs"] = outcome.outputs
        if outcome.settings is not None:
            entry["settings"] = outcome.settings
        if outcome.recording_id:
            entry["recording_id"] = outcome.recording_id
            if outcome.recording_id not in self.run["recording_ids"]:
                self.run["recording_ids"].append(outcome.recording_id)
        entry["error"] = outcome.error
        entry["remote_outcome_unknown"] = outcome.unknown
        fields = {
            "call_id": entry.get("call_id"),
            "recording_id": outcome.recording_id,
            "remote_outcome_unknown": outcome.unknown,
        }
        if outcome.state == "succeeded":
            self.recording.log("info", f"步驟 {sid} 完成", **fields)
            return
        error = outcome.error or {}
        code = error.get("code")
        detail = f"（{code}：{error.get('message')}）" if code else ""
        self.recording.log(
            "warning", f"步驟 {sid} 結束：{outcome.state}{detail}", **fields
        )
        log.warning(
            "run %s 步驟 %s：%s %s", self.run_id, sid, outcome.state, code or ""
        )

    def _not_started(self, sid: str) -> None:
        entry = self.steps[sid]
        entry.pop("component_load", None)
        self.retry_at.pop(sid, None)
        entry["state"] = "cancelled" if self.stop_reason == "user" else "skipped"
        entry["call_id"] = None
        entry["started_at"] = None
        entry["finished_at"] = utc_now()

    # ------------------------------------------------------------------ stopping / cancel
    def _begin_stop(self, reason: StopReason, sid: str | None) -> None:
        self.stop_reason = reason
        self.stop_step = sid
        self.run.update(stop_reason=reason, stop_step=sid)
        target = "cancelled" if reason == "user" else "skipped"
        now = utc_now()
        self.retry_at.clear()
        for entry in self.steps.values():
            if entry["state"] in ("pending", "waiting"):
                entry["state"] = target
                entry["finished_at"] = now
                entry.pop("component_load", None)
        why = (
            "使用者取消"
            if reason == "user"
            else f"步驟 {sid} {'被取消' if reason == 'cancelled' else '失敗'}"
        )
        self.recording.log(
            "warning",
            f"{why}：不再開始新步驟，對其他執行中的呼叫各送一次取消",
            active_calls=sorted(self.active_calls),
        )
        for call in list(self.active_calls.values()):
            _ = self._ensure_cancel(call)

    def _ensure_cancel(self, call: ActiveCall) -> asyncio.Task[CancelOutcome]:
        if call.cancel_task is None:
            call.cancel_task = asyncio.create_task(
                self._send_cancel(call), name=f"cancel-{call.call_id}"
            )
            self.cancel_tasks.append(call.cancel_task)
        return call.cancel_task

    async def _send_cancel(self, call: ActiveCall) -> CancelOutcome:
        self.recording.count("controller.cancel_posts")
        self.recording.log(
            "info",
            f"對步驟 {call.step_id} 送出取消",
            call_id=call.call_id,
            node_id=call.node_id,
        )
        attempt = self.steps[call.step_id]["attempts"][-1]
        attempt["cancel_sent"] = True
        await self.persist(raise_errors=True)
        outcome = await post_cancel(self.ctl.http, call)
        if not outcome.answered:
            if (
                self.active_calls.get(call.step_id) is call
            ):  # an invoke answer that already arrived stays known
                self.steps[call.step_id]["remote_outcome_unknown"] = True
            self.recording.count("controller.cancel_unanswered")
            self.recording.notice("CANCEL_NO_ANSWER", outcome.message)
            call.abandon.set()
            await self.persist()
        return outcome

    async def cancel(self) -> dict[str, Any]:
        """Request cancellation and return the state of the affected execution."""
        if self.finishing:
            raise ComponentError(
                "STATE_CONFLICT",
                f"run {self.run_id} 正在結束，沒有可取消的呼叫",
                details={"run_id": self.run_id},
            )
        previous = self.stop_reason
        if previous is None:
            self._begin_stop("user", None)
            self.wake.set()  # a run with only waiting steps has no call to end its wait
        calls = list(self.active_calls.values())
        tasks = [self._ensure_cancel(call) for call in calls]
        await self.persist(raise_errors=True)
        results = [
            r
            for r in await asyncio.gather(*tasks, return_exceptions=True)
            if isinstance(r, CancelOutcome)
        ]
        accepted = sum(1 for r in results if r.accepted)
        unanswered = sum(1 for r in results if not r.answered)
        if not calls:
            message = "已取消：沒有執行中的呼叫；未開始的步驟標記為 cancelled"
        else:
            message = (
                f"已對 {len(calls)} 個執行中的呼叫各送出一次取消：{accepted} 個接受、"
                f"{len(results) - accepted - unanswered} 個未接受、{unanswered} 個沒有回覆（遠端結果未知）"
            )
        if previous is not None and previous != "user":
            message = f"run 已因步驟 {self.stop_step} 停止；" + message
        return {
            "call_id": None,
            "accepted": True,
            "process_exited": None,
            "message": message,
        }

    async def _cancel_children(self) -> None:
        pending = [
            t for t in [*self.tasks.values(), *self.cancel_tasks] if not t.done()
        ]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    # ------------------------------------------------------------------ finishing
    async def _finish(
        self, *, state: str | None = None, error: dict[str, Any] | None = None
    ) -> None:
        self.finishing = True
        if state is None:
            state, error = final_state(self.steps, self.stop_reason, self.stop_step)
        outputs = collect_outputs(self.run["request"]["pipeline"], self.steps)
        self.recording.log(
            "info" if state == "succeeded" else "warning",
            f"run 結束：{state}",
            error=error,
        )
        self.recording.summarize(self.order, self.steps)
        await self.recording.close(state, error)
        # run.json gets the result first. The live snapshot (what GET answers while the run is registered) turns
        # terminal only in the step that also frees the slot and forgets the run: delete, archive and recording
        # removal refuse a registered run, so a run that reads finished must already be gone from the runner.
        final = {
            **self.run,
            "outputs": outputs,
            "error": error,
            "finished_at": utc_now(),
            "state": state,
        }
        try:
            await self.persist(run=final)
        finally:  # a cancelled or failed write changes nothing about the result (shutdown must not mark it interrupted)
            self.run.update(final)
            self.manager.release(self)
            self.manager.forget(self)
        log.info("run %s 結束：%s", self.run_id, state)
        # Studio projects whose takes wait on this run get its result even when no tab has them open
        _ = self.ctl.spawn(self.ctl.backfill_studio_later(copy.deepcopy(final)))

    async def _crash(self, exc: BaseException) -> None:
        for sid, entry in self.steps.items():
            if entry["state"] in TERMINAL_STEP_STATES:
                continue
            if entry["state"] == "running":
                error = {
                    "code": "RUNTIME_ERROR",
                    "message": "runner 內部錯誤，此步驟結果未知",
                    "remote_outcome_unknown": True,
                }
                self._settle(sid, StepOutcome("failed", error, unknown=True))
            else:
                entry["state"] = "skipped"
                entry["finished_at"] = utc_now()
        self.stop_reason = "failure"
        await self._finish(
            state="failed",
            error={
                "code": "RUNTIME_ERROR",
                "message": f"runner 內部錯誤：{type(exc).__name__}: {exception_message(exc)}"[
                    :2000
                ],
                "details": {
                    "exception_type": f"{type(exc).__module__}.{type(exc).__qualname__}"
                },
            },
        )

    async def shutdown(self) -> None:
        """Controller stopping: no cancel is sent (Nodes may finish accepted calls); receipt-backed attempts are left for the next Controller."""
        task = self.task
        if task is None or task.done():
            return
        if self.finishing:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.shield(task), FINISH_WAIT_S)
            if task.done():
                return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if self.run["state"] == "running":
            self.recording.log("warning", STOP_MESSAGE)
            self.recording.summarize(self.order, self.steps)
            await self.recording.close("interrupted", interrupted_error(STOP_MESSAGE))
            self.manager.release(self)
            await self.persist(raise_errors=True)
        self.manager.forget(self)


__all__ = [
    "FINISH_WAIT_S",
    "Holders",
    "RunExecution",
    "choose_starts",
    "collect_outputs",
    "dependents_of",
    "final_state",
    "ready_steps",
]
