"""The plain runner.

``POST /api/runs`` checks the wiring and inputs, freezes what every step will send, writes ``run.json``
atomically and answers 202; the run then executes as an asyncio task in this process. There is no outbox, no
redispatch at start-up and no reliable delivery. At most ``max_active_runs`` runs are active (default one); all of
them share one (node_id, resource_group) occupancy, handed out by ``RunManager.dispatch`` oldest run first, so two
runs never send calls to one component at the same time.

- ``plan``: wiring check and the frozen per-step snapshots (pure functions)
- ``node_calls``: the single invoke/cancel HTTP call per step and how answers are classified (never retried)
- ``execution``: ``RunExecution``, the DAG scheduler, stopping and finishing
- ``recording``: the controller's own recording of the run
"""

from __future__ import annotations

import asyncio
import copy
import logging
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.timeline_edit.export import PROVIDER_ID as PROXY_PROVIDER_ID
from phasyn_components.timeutil import utc_now

from ..run_previews import overlay_previews
from .execution import Holders, RunExecution
from .node_calls import READ_GRACE_SECONDS
from .plan import DEFAULT_TIMEOUT_SECONDS, StepPlan, plan_run

if TYPE_CHECKING:
    from ..state import Controller

log = logging.getLogger("phasyn_controller.runner")


def is_proxy(request: Any) -> bool:
    """A proxy rendition (RunRequest.purpose = proxy): exempt from max_active_runs."""
    return isinstance(request, dict) and request.get("purpose") == "proxy"


class RunManager:
    def __init__(self, ctl: Controller) -> None:
        self.ctl = ctl
        self.active: list[RunExecution] = []  # the runs holding a slot, oldest (first created) first
        self.executions: dict[str, RunExecution] = {}
        self.closing = False

    def _check_slot(self) -> None:
        # A proxy run (a small CPU rendition) holds no slot, so it neither waits for nor blocks one
        slots = [execution for execution in self.active if not is_proxy(execution.run["request"])]
        if len(slots) >= self.ctl.config.max_active_runs:
            ids = [execution.run_id for execution in slots]
            raise ComponentError(
                "RUN_ACTIVE",
                f"已有執行中的 run {'、'.join(ids)}；同時只允許 {self.ctl.config.max_active_runs} 個 active run，請等它結束或取消",
                details={"active_run_id": ids[0], **({"active_run_ids": ids} if len(ids) > 1 else {})},
            )

    def holders(self) -> Holders:
        """Every key an active run occupies (one occupancy for all runs)."""
        held: Holders = {}
        for execution in self.active:
            for key, holder in execution.holds().items():
                held.setdefault(key, holder)
        return held

    def dispatch(self) -> None:
        """Start every ready step whose key is free across all active runs (synchronous: no await in between).

        Runs pick oldest first, each with its own order and lane rule, so a younger run only gets a key that no older
        run's ready step took in this pass. A run whose state changed persists it in its own loop (``dirty``/``wake``).
        """
        if self.closing:
            return
        held = self.holders()
        for execution in self.active:
            if not execution.scheduling or execution.stop_reason is not None or execution.finishing:
                continue
            if execution.start_ready(held):
                execution.dirty = True
                execution.wake.set()

    async def create(self, body: Any) -> dict[str, Any]:
        contracts.validate("RunRequest", body, what="執行請求")
        proxy = is_proxy(body)
        if not proxy:
            self._check_slot()
        request = copy.deepcopy(body)
        for step in request["pipeline"]["steps"]:
            step["node_id"] = str(step["node_id"]).lower()
        # Copy only the descriptors this pipeline uses, off the event loop (the full catalog is large).
        keys = {(str(step["node_id"]), str(step["component_id"])) for step in request["pipeline"]["steps"]}
        descriptors = await asyncio.to_thread(self.ctl.catalog.descriptors, keys)
        order, plans, steps = await asyncio.to_thread(plan_run, request, descriptors)
        if proxy and any(str(d.get("provider_id")) != PROXY_PROVIDER_ID for d in descriptors.values()):
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"purpose=proxy 的 run 只能使用序列匯出元件（{PROXY_PROVIDER_ID}）",
                details={"field_paths": ["purpose"]},
            )
        for node_id in sorted({p.node_id for p in plans.values()}):
            self.ctl.catalog.endpoint_for_call(node_id)  # offline or duplicated Node: no run is created
        if not proxy:
            self._check_slot()
        run_id = new_id()
        recording_id = new_id()
        created_at = utc_now()
        run: dict[str, Any] = {
            "run_id": run_id,
            "state": "running",
            "request": request,
            "created_at": created_at,
            "finished_at": None,
            "steps": steps,
            "outputs": {},
            "recording_ids": [recording_id],
            "error": None,
        }
        execution = RunExecution(self, run, plans, order, recording_id)
        self.active.append(execution)
        self.executions[run_id] = execution
        try:
            await execution.persist(raise_errors=True)
        except BaseException:
            self.release(execution)
            self.forget(execution)
            raise
        self.ctl.runs.add(created_at, run_id)
        execution.start()
        log.info("run %s 建立：接線 %s，%d 個步驟", run_id, request["pipeline"]["pipeline_id"], len(plans))
        return copy.deepcopy(run)

    def snapshot(self, run_id: str) -> dict[str, Any] | None:
        execution = self.executions.get(run_id)
        if execution is None:
            return None
        return overlay_previews(copy.deepcopy(execution.run), execution.previews)

    async def cancel(self, run_id: str) -> dict[str, Any]:
        execution = self.executions.get(run_id)
        if execution is None:
            run = await asyncio.to_thread(self.ctl.runs.read, run_id)
            raise ComponentError(
                "STATE_CONFLICT",
                f"run {run_id} 已結束（{run.get('state')}），沒有可取消的呼叫",
                details={"run_id": run_id, "state": run.get("state")},
            )
        return await execution.cancel()

    def release(self, execution: RunExecution) -> None:
        """The run no longer holds the active slot nor any key (a new run may start; waiting steps of others may)."""
        if execution in self.active:
            self.active.remove(execution)
            self.dispatch()

    def forget(self, execution: RunExecution) -> None:
        """The run is no longer live: reads come from ``run.json`` from now on."""
        if self.executions.get(execution.run_id) is execution:
            del self.executions[execution.run_id]

    async def shutdown(self) -> None:
        self.closing = True  # a run stopping here frees keys: nothing else may start meanwhile
        for execution in list(self.executions.values()):
            try:
                await execution.shutdown()
            except Exception:
                log.exception("run %s 關閉時發生錯誤", execution.run_id)


__all__ = ["DEFAULT_TIMEOUT_SECONDS", "READ_GRACE_SECONDS", "RunExecution", "RunManager", "StepPlan"]
