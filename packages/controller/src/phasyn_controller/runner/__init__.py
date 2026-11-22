"""The plain runner.

``POST /api/runs`` checks the wiring and inputs, freezes what every step will send, writes ``run.json``
atomically and answers 202. At startup the runner reconciles frozen attempts with their original Node. At most ``max_active_runs`` runs compute at once (default one; a run that only waits for a busy
resource takes no slot, at most ``MAX_WAITING_RUNS`` of them); all of
them share one (node_id, resource_group) occupancy, handed out by ``RunManager.dispatch`` oldest run first, so two
runs never send calls to one component at the same time.

- ``plan``: wiring check and the frozen per-step snapshots (pure functions)
- ``node_calls``: the single invoke/cancel HTTP call per attempt and how answers are classified
- ``execution``: ``RunExecution``, the DAG scheduler, stopping and finishing
- ``recording``: the controller's own recording of the run
- ``on_demand``: loading an on_demand component when a step needs it, and unloading it when idle
"""

from __future__ import annotations

import asyncio
import copy
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.timeline_edit.export import PROVIDER_ID as PROXY_PROVIDER_ID
from phasyn_components.timeutil import utc_now

from .. import placement
from ..run_previews import overlay_previews
from .execution import Holders, RunExecution
from .node_calls import READ_GRACE_SECONDS
from .on_demand import OnDemand
from .plan import DEFAULT_TIMEOUT_SECONDS, StepPlan, plan_run, restore_plans


if TYPE_CHECKING:
    from ..state import Controller

log = logging.getLogger("phasyn_controller.runner")

# Runs that only wait for a resource (they take no max_active_runs slot) are still bounded.
MAX_WAITING_RUNS = 16


def is_proxy(request: Any) -> bool:
    """A proxy rendition (RunRequest.purpose = proxy): exempt from max_active_runs."""
    return isinstance(request, dict) and request.get("purpose") == "proxy"


def _check_proxy_components(
    *, proxy: bool, descriptors: dict[tuple[str, str], dict[str, Any]]
) -> None:
    if proxy and any(
        str(d.get("provider_id")) != PROXY_PROVIDER_ID for d in descriptors.values()
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"purpose=proxy 的 run 只能使用序列匯出元件（{PROXY_PROVIDER_ID}）",
            details={"field_paths": ["purpose"]},
        )


class RunManager:
    """Coordinate running graphs and their component reservations."""

    def __init__(self, ctl: Controller) -> None:
        """Track active runs and coordinate access to components."""
        self.ctl = ctl
        self.active: list[
            RunExecution
        ] = []  # the runs holding a slot, oldest (first created) first
        self.executions: dict[str, RunExecution] = {}
        self.closing = False
        self.on_demand = OnDemand(
            self
        )  # load on use and idle unload (load_policy = on_demand)

    def _check_slot(self) -> None:
        # A proxy run (a small CPU rendition) holds no slot, so it neither waits for nor blocks one. A run that only
        # waits for a busy (node_id, resource_group) computes nothing and takes no slot either: a
        # CPU-only fix is not refused because GPU renders queue; dispatch still lets at most max_active_runs compute.
        slots = [
            execution
            for execution in self.active
            if not is_proxy(execution.run["request"]) and not execution.only_reconciling
        ]
        computing = [execution for execution in slots if execution.computing]
        waiting = len(slots) - len(computing)
        limit = self.ctl.config.max_active_runs
        if len(computing) >= limit or waiting >= MAX_WAITING_RUNS:
            ids = [execution.run_id for execution in computing or slots]
            reason = (
                f"已有執行中的 run {'、'.join(ids)}；同時只允許 {limit} 個 run 執行（只在等待資源的 run 不計入）"
                if len(computing) >= limit
                else f"已有 {waiting} 個 run 在等待資源（上限 {MAX_WAITING_RUNS} 個）"
            )
            raise ComponentError(
                "RUN_ACTIVE",
                f"{reason}，請等它結束或取消",
                details={
                    "active_run_id": ids[0],
                    "waiting_runs": waiting,
                    **({"active_run_ids": ids} if len(ids) > 1 else {}),
                },
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
        computing = {
            item
            for item in self.active
            if item.computing and not is_proxy(item.run["request"])
        }
        for execution in self.active:
            if (
                not execution.scheduling
                or execution.stop_reason is not None
                or execution.finishing
            ):
                continue
            proxy = is_proxy(execution.run["request"])
            if (
                not proxy
                and execution not in computing
                and len(computing) >= self.ctl.config.max_active_runs
            ):
                continue
            if execution.start_ready(held):
                if execution.computing and not proxy:
                    computing.add(execution)
                execution.dirty = True
                execution.wake.set()

    def has_slot(self) -> bool:
        """Check whether a new run can enter the active set."""
        try:
            self._check_slot()
        except ComponentError as exc:
            if exc.code == "RUN_ACTIVE":
                return False
            raise
        return True

    async def create(
        self,
        body: Any,
        *,
        reserved_run_id: str | None = None,
        dispatch_deadline: float | None = None,
        verified_preset: dict[str, Any] | None = None,
        register_takes: Callable[[dict[str, Any], dict[str, str]], None] | None = None,
    ) -> dict[str, Any]:
        """Persist the frozen run and schedule the new execution."""
        contracts.validate("RunRequest", body, what="執行請求")
        if (body.get("origin") or {}).get("inference_preset") != verified_preset:
            raise ComponentError(
                "INVALID_ARGUMENT", "配方執行來源須由已驗證的配方提交建立"
            )
        proxy = is_proxy(body)
        if not proxy:
            self._check_slot()
        request = copy.deepcopy(body)
        for step in request["pipeline"]["steps"]:
            step["node_id"] = str(step["node_id"]).lower()
        # Copy only the descriptors this pipeline uses, off the event loop (the full catalog is large).
        keys = {
            (str(step["node_id"]), str(step["component_id"]))
            for step in request["pipeline"]["steps"]
        }
        descriptors = await asyncio.to_thread(self.ctl.catalog.descriptors, keys)
        order, plans, steps = await asyncio.to_thread(plan_run, request, descriptors)
        if "placement" in request:
            await placement.verify(self.ctl, request, steps, descriptors)
        _check_proxy_components(proxy=proxy, descriptors=descriptors)
        for node_id in sorted({p.node_id for p in plans.values()}):
            self.ctl.catalog.endpoint_for_call(
                node_id
            )  # offline or duplicated Node: no run is created
        if not proxy:
            self._check_slot()
        run_id = reserved_run_id or new_id()
        if reserved_run_id is not None and (
            any(item.run_id == run_id for item in self.active)
            or run_id in self.executions
            or self.ctl.runs.path(run_id).exists()
        ):
            raise ComponentError("STATE_CONFLICT", "草稿計畫預留的執行 ID 已存在")
        recording_id = new_id()
        created_at = utc_now()
        run: dict[str, Any] = {
            "run_id": run_id,
            "state": "running",
            "recovery_version": 1,
            "request": request,
            "created_at": created_at,
            "finished_at": None,
            "steps": steps,
            "outputs": {},
            "recording_ids": [recording_id],
            "error": None,
        }
        if dispatch_deadline is not None:
            run["dispatch_deadline"] = dispatch_deadline
        execution = RunExecution(self, run, plans, order, recording_id)
        await self._publish(execution, descriptors, register_takes)
        self.executions[run_id] = execution
        self.ctl.runs.add(created_at, run_id, request)
        execution.start()
        log.info(
            "run %s 建立：接線 %s，%d 個步驟",
            run_id,
            request["pipeline"]["pipeline_id"],
            len(plans),
        )
        return copy.deepcopy(run)

    async def _publish(
        self,
        execution: RunExecution,
        descriptors: dict[tuple[str, str], dict[str, Any]],
        register_takes: Callable[[dict[str, Any], dict[str, str]], None] | None,
    ) -> None:
        """Reserve capacity while preparing the project and run; enable dispatch only after both writes."""
        self.active.append(execution)
        try:
            if register_takes is not None:
                types: dict[str, str] = {}
                for key, ref in execution.run["request"]["pipeline"]["outputs"].items():
                    source = execution.plans[ref["from_step"]]
                    ports = descriptors[(source.node_id, source.component_id)][
                        "outputs"
                    ]
                    types[key] = next(
                        port["type_id"]
                        for port in ports
                        if port["name"] == ref["output"]
                    )
                await asyncio.to_thread(register_takes, execution.run, types)
            await execution.persist(raise_errors=True)
        except BaseException:
            self.release(execution)
            raise

    def restore(self, run: dict[str, Any]) -> None:
        """Reattach a frozen run to the scheduler using its persisted attempts."""
        order, plans = restore_plans(run)
        for entry in run["steps"].values():
            entry.pop(
                "component_load", None
            )  # an on_demand wait is looked at again from scratch
        recording_id = new_id()
        run["recording_ids"].append(recording_id)
        execution = RunExecution(self, run, plans, order, recording_id)
        execution.restoring = True
        self.active.append(execution)
        self.executions[execution.run_id] = execution
        execution.start()

    def snapshot(self, run_id: str) -> dict[str, Any] | None:
        """Read the current in-memory snapshot of a known execution."""
        execution = self.executions.get(run_id)
        if execution is None:
            return None
        return overlay_previews(copy.deepcopy(execution.run), execution.previews)

    async def cancel(self, run_id: str) -> dict[str, Any]:
        """Request cancellation and return the state of the affected execution."""
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
        """Stop outstanding work and release owned resources."""
        self.closing = (
            True  # a run stopping here frees keys: nothing else may start meanwhile
        )
        for execution in list(self.executions.values()):
            try:
                await execution.shutdown()
            except Exception:
                log.exception("run %s 關閉時發生錯誤", execution.run_id)


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "READ_GRACE_SECONDS",
    "RunExecution",
    "RunManager",
    "StepPlan",
]
