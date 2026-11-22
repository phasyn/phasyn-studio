"""Loading on use and unloading when idle (``InstanceDefinition.load_policy = on_demand``).

Load on use (``OnDemand.ensure_loaded``, called by a step's task before it builds its invoke): the step already
holds its (node_id, resource_group) key, so nothing else of this Controller runs on that device while the model
loads. What happens depends on the target component as the catalog reports it:

- not on_demand, unknown, ``ready``/``busy``/``error`` → the call goes out as before (no change for resident
  components: a stopped resident component still answers COMPONENT_NOT_READY);
- ``loading`` → wait for it (``component_load.phase = loading``, the step stays ``running``);
- ``stopping`` (an idle unload, a person) → the step goes back to ``waiting`` and is looked at again;
- ``stopped`` → the other members of its exclusive group on that Node decide:
  a member that is loading, stopping or calling (or being unloaded here) → wait (``exclusive_busy``);
  a loaded *resident* member → wait (``exclusive_resident``): resident components are never evicted;
  a loaded on_demand member that a ready or running step of a live run still needs → wait
  (``exclusive_reserved``); otherwise only idle on_demand members hold the group and the start replaces them
  (``replace_exclusive: true``). Then the Controller sends one start and waits for ``ready``.

A step that has to wait gives its key back (state ``waiting`` with ``component_load.phase = waiting``) and is
dispatched again after :data:`RETRY_S`, so a blocked load never holds a device that other steps could use. A
start the Node refuses for a transient reason (EXCLUSIVE_GROUP_BUSY/CONFLICT, DEVICE_BUSY, STATE_CONFLICT) is a
wait, not a failure. A load that ends in ``error`` (or stops) fails the step with COMPONENT_NOT_READY; no call
was sent, so nothing is unknown.

Idle unload (``OnDemand.idle_loop``): every :data:`IDLE_CHECK_S` the Controller looks at every on_demand
component of the online Nodes. A component counts as used while it is loading or busy, has an active call, or a
live run has a pending, waiting or running step on it; it is stopped once it has been ``ready`` and unused for
its ``idle_unload_seconds`` (default 600). The stop goes out once; the Node refuses a busy component itself
(COMPONENT_BUSY), and a refused stop waits another full period. While the stop is in flight the key is marked,
so a step dispatched meanwhile waits (``stopping``) instead of meeting a component that is going away.

Idle time is the Controller's own observation: after a Controller restart a loaded component gets a full new
period before it is unloaded.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote

import httpx
from phasyn_components.errors import ComponentError
from phasyn_components.load_policy import idle_unload_seconds, is_on_demand
from phasyn_components.timeutil import utc_now

from ..nodeclient import FORWARD_TIMEOUT, error_from_response, transport_error


if TYPE_CHECKING:
    from . import RunManager
    from .execution import RunExecution

log = logging.getLogger("phasyn_controller.runner.on_demand")

RETRY_S = 3.0  # a waiting step is dispatched again after this
POLL_S = 1.0  # how often a loading component is looked at
START_GRACE_S = 30.0  # the catalog may still say "stopped" this long after the Node accepted a start
LOAD_WAIT_MAX_S = 3600.0  # the Node bounds a load itself (load_timeout_seconds); this only ends a lost wait
IDLE_CHECK_S = 15.0
LIVE_STEP_STATES = frozenset({"pending", "waiting", "running"})
TRANSIENT_START_ERRORS = frozenset(
    {
        "EXCLUSIVE_GROUP_BUSY",
        "EXCLUSIVE_GROUP_CONFLICT",
        "DEVICE_BUSY",
        "STATE_CONFLICT",
    }
)
HOLDING_STATES = frozenset({"loading", "ready", "busy", "stopping"})
BUSY_STATES = frozenset({"loading", "busy", "stopping"})

Key = tuple[str, str]  # (node_id, component_id)
Reason = Literal[
    "loading",
    "exclusive_busy",
    "exclusive_resident",
    "exclusive_reserved",
    "device_busy",
    "stopping",
]


@dataclass(frozen=True)
class Go:
    """Send the call now (the component is loaded, or load-on-use does not apply)."""


@dataclass(frozen=True)
class Wait:
    """The step went back to ``waiting``; it is dispatched again after :data:`RETRY_S`."""


@dataclass(frozen=True)
class Fail:
    """The load failed; the step fails without a call (nothing sent)."""

    error: ComponentError


@dataclass(frozen=True)
class Stopped:
    """The run stopped while the step waited for the load; the step was not started."""


Verdict = Go | Wait | Fail | Stopped
GO = Go()


class OnDemand:
    """Load-on-use for the steps of every live run, and the idle unloader (one per Controller)."""

    def __init__(self, manager: RunManager) -> None:
        """Bind to the run manager (its live runs are the reservations)."""
        self.manager = manager
        self.ctl = manager.ctl
        self.unloading: set[Key] = set()
        self.last_used: dict[Key, float] = {}
        self.unloads = 0  # stops sent by the idle unloader (observability and tests)

    # ------------------------------------------------------------------ shared facts
    def _now(self) -> float:
        return self.ctl.catalog.clock()

    def touch(self, key: Key) -> None:
        """The component was just used (a step on it started or ended)."""
        self.last_used[(key[0].lower(), key[1])] = self._now()

    def _live_steps(self) -> list[tuple[RunExecution, str]]:
        return [
            (execution, sid)
            for execution in list(self.manager.executions.values())
            for sid in execution.order
            if execution.steps[sid]["state"] in LIVE_STEP_STATES
        ]

    def reserved(self, key: Key) -> bool:
        """A live run has a pending, waiting or running step on the component (idle unload never stops it)."""
        return any(
            (execution.plans[sid].node_id, execution.plans[sid].component_id) == key
            for execution, sid in self._live_steps()
        )

    def needed_now(self, key: Key) -> bool:
        """A running or ready step of a live run uses the component (so it is not swapped out)."""
        for execution, sid in self._live_steps():
            plan = execution.plans[sid]
            if (plan.node_id, plan.component_id) != key:
                continue
            if (
                execution.steps[sid]["state"] == "running"
                or sid in execution.ready_now()
            ):
                return True
        return False

    # ------------------------------------------------------------------ load on use
    async def ensure_loaded(self, execution: RunExecution, sid: str) -> Verdict:
        """Make the step's on_demand component ready before its call (see the module docstring)."""
        plan = execution.plans[sid]
        key: Key = (plan.node_id, plan.component_id)
        view = self.ctl.catalog.lifecycle_view()
        target = view.get(key)
        early = self._early(execution, sid, key, target)
        if early is not None or target is None:
            return early or GO
        state = target.get("state")
        # an idle unload in flight goes first: the component is about to stop even while it still says ready
        if state == "stopping" or key in self.unloading:
            return await self._wait(
                execution,
                sid,
                "stopping",
                f"{plan.component_id} 正在停止；停好後會重新載入",
                [],
            )
        if state == "stopped":
            blocked = self._exclusive_block(key, target, view)
            if blocked is not None:
                reason, message, holders = blocked
                return await self._wait(execution, sid, reason, message, holders)
            replace = bool(self._group_members(key, target, view))
            started = await self._start(execution, sid, replace=replace)
            if started is not None:
                return started
        return await self._await_ready(execution, sid, key)

    def _early(
        self,
        execution: RunExecution,
        sid: str,
        key: Key,
        target: dict[str, Any] | None,
    ) -> Verdict | None:
        """What needs no load: not on_demand (or unknown), the run stopped, or already loaded and staying."""
        if target is None or not is_on_demand(target):
            return GO
        if execution.stop_reason is not None:
            return Stopped()
        if (
            target.get("state") in ("ready", "busy", "error")
            and key not in self.unloading
        ):
            self.touch(key)
            if execution.steps[sid].pop("component_load", None) is not None:
                execution.dirty = True
            return GO
        return None

    def _group_members(
        self, key: Key, target: dict[str, Any], view: dict[Key, dict[str, Any]]
    ) -> list[tuple[Key, dict[str, Any]]]:
        group = target.get("exclusive_group")
        if not group:
            return []
        return sorted(
            (
                (other, facts)
                for other, facts in view.items()
                if other != key
                and other[0] == key[0]
                and facts.get("exclusive_group") == group
                and (facts.get("state") in HOLDING_STATES or other in self.unloading)
            ),
            key=lambda item: item[0][1],
        )

    def _exclusive_block(
        self,
        key: Key,
        target: dict[str, Any],
        view: dict[Key, dict[str, Any]],
    ) -> tuple[Reason, str, list[str]] | None:
        members = self._group_members(key, target, view)
        if not members:
            return None
        group = target.get("exclusive_group")
        busy = [
            other[1]
            for other, facts in members
            if facts.get("state") in BUSY_STATES
            or facts.get("active_call_id")
            or other in self.unloading
        ]
        if busy:
            return (
                "exclusive_busy",
                f"互斥群組 {group} 的 {'、'.join(busy)} 正在載入、停止或執行呼叫；等它閒置後再載入 {key[1]}",
                busy,
            )
        resident = [other[1] for other, facts in members if not is_on_demand(facts)]
        if resident:
            return (
                "exclusive_resident",
                f"互斥群組 {group} 已由常駐元件 {'、'.join(resident)} 載入；主控不會替換常駐元件，請先停止它，{key[1]} 才能載入",
                resident,
            )
        needed = [other[1] for other, _facts in members if self.needed_now(other)]
        if needed:
            return (
                "exclusive_reserved",
                f"互斥群組 {group} 的 {'、'.join(needed)} 還有排隊中的步驟要用；等它們完成後再載入 {key[1]}",
                needed,
            )
        return None

    async def _start(
        self, execution: RunExecution, sid: str, *, replace: bool
    ) -> Verdict | None:
        """One start; None = accepted (wait for ready), else what the step does instead."""
        plan = execution.plans[sid]
        await self._note(execution, sid, "loading", f"正在載入 {plan.component_id}", [])
        try:
            endpoint = self.ctl.catalog.endpoint_for_call(plan.node_id)
        except ComponentError as offline:
            return Fail(offline)
        label = self.ctl.catalog.label(plan.node_id)
        url = f"{endpoint}/api/components/{quote(plan.component_id, safe='')}/control"
        body = {"action": "start", "replace_exclusive": replace}
        try:
            resp = await self.ctl.http.post(url, json=body, timeout=FORWARD_TIMEOUT)
        except httpx.HTTPError as exc:
            lost = transport_error(
                exc,
                node_label=label,
                endpoint=endpoint,
                what="元件啟動",
                side_effect=True,
                read_timeout=FORWARD_TIMEOUT.read,
            )
            if not lost.remote_outcome_unknown:
                return Fail(lost)
            log.warning(
                "run %s 步驟 %s：啟動 %s 的回覆遺失，改看目錄狀態",
                execution.run_id,
                sid,
                plan.component_id,
            )
            return None
        if resp.status_code == HTTPStatus.OK:
            execution.recording.log(
                "info",
                f"步驟 {sid}：自動載入 {plan.component_id}"
                + ("（替換互斥群組內閒置的 on_demand 元件）" if replace else ""),
                node_id=plan.node_id,
                component_id=plan.component_id,
            )
            return None
        refused = error_from_response(resp, what=f"Node {label} 的元件啟動")
        return await self._refused(execution, sid, refused)

    async def _refused(
        self, execution: RunExecution, sid: str, err: ComponentError
    ) -> Verdict:
        """A start the Node refused: a transient reason is a wait, anything else fails the step."""
        plan = execution.plans[sid]
        if err.code in TRANSIENT_START_ERRORS:
            reason: Reason = (
                "device_busy"
                if err.code == "DEVICE_BUSY"
                else ("stopping" if err.code == "STATE_CONFLICT" else "exclusive_busy")
            )
            holders = [
                str(item.get("component_id"))
                for item in (err.details.get("holders") or [])
                if isinstance(item, dict)
            ]
            return await self._wait(execution, sid, reason, err.message, holders)
        return Fail(
            ComponentError(
                "COMPONENT_NOT_READY",
                f"無法自動載入 {plan.component_id}：{err.message}",
                details={"component_id": plan.component_id, "cause": err.code},
            )
        )

    async def _await_ready(
        self, execution: RunExecution, sid: str, key: Key
    ) -> Verdict:
        plan = execution.plans[sid]
        entry = execution.steps[sid]
        if (entry.get("component_load") or {}).get("phase") != "loading":
            await self._note(
                execution, sid, "loading", f"正在載入 {plan.component_id}", []
            )
        began = self._now()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + LOAD_WAIT_MAX_S
        while True:
            if execution.stop_reason is not None:
                return Stopped()
            facts = self.ctl.catalog.lifecycle_view().get(key)
            state = None if facts is None else facts.get("state")
            if state in ("ready", "busy"):
                self.touch(key)
                entry.pop("component_load", None)
                execution.dirty = True
                return GO
            if state == "error" or (
                state == "stopped" and self._now() - began > START_GRACE_S
            ):
                return Fail(
                    ComponentError(
                        "COMPONENT_NOT_READY",
                        f"自動載入 {plan.component_id} 沒有完成（目前 {state}）；請到元件頁查看錯誤",
                        details={"component_id": plan.component_id, "state": state},
                    )
                )
            if loop.time() > deadline:
                return Fail(
                    ComponentError(
                        "COMPONENT_NOT_READY",
                        f"等待 {plan.component_id} 載入超過 {int(LOAD_WAIT_MAX_S)} 秒",
                        details={"component_id": plan.component_id, "state": state},
                    )
                )
            await asyncio.sleep(POLL_S)

    async def _note(
        self,
        execution: RunExecution,
        sid: str,
        reason: Reason,
        message: str,
        holders: list[str],
    ) -> None:
        """Write ``component_load`` on the step and persist it (the Studio reads it from the run)."""
        plan = execution.plans[sid]
        entry = execution.steps[sid]
        previous = entry.get("component_load") or {}
        phase = "loading" if reason == "loading" else "waiting"
        same = previous.get("phase") == phase and previous.get("reason") == reason
        entry["component_load"] = {
            "phase": phase,
            "reason": reason,
            "message": message[:2000],
            "component_id": plan.component_id,
            "holders": holders[:64],
            "since": previous["since"] if same else utc_now(),
            "estimated_load_ms": previous.get("estimated_load_ms")
            if "estimated_load_ms" in previous
            else await self._estimate(plan.node_id, plan.component_id),
        }
        if not same:
            execution.recording.log(
                "info",
                f"步驟 {sid}：{message}",
                node_id=plan.node_id,
                component_id=plan.component_id,
            )
        await execution.persist()

    async def _wait(
        self,
        execution: RunExecution,
        sid: str,
        reason: Reason,
        message: str,
        holders: list[str],
    ) -> Verdict:
        """Give the key back: the step waits and is dispatched again after :data:`RETRY_S`."""
        if (
            execution.stop_reason is not None
        ):  # stopped meanwhile: never turn a stopped step back into waiting
            return Stopped()
        entry = execution.steps[sid]
        entry.update(state="waiting", call_id=None, started_at=None)
        execution.retry_at[sid] = asyncio.get_running_loop().time() + RETRY_S
        await self._note(execution, sid, reason, message, holders)
        return Wait()

    async def _estimate(self, node_id: str, component_id: str) -> float | None:
        """The median load time of this component's recorded loads (cost profiles); None without any."""
        try:
            doc = await asyncio.to_thread(
                self.ctl.cost_profiles.profiles,
                node_id=node_id,
                component_id=component_id,
            )
        except (ComponentError, OSError, ValueError) as exc:
            log.debug("載入時間估計不可用：%s", type(exc).__name__)
            return None
        loads = [
            (item.get("load_samples") or 0, float(item["load_ms"]))
            for item in doc.get("items") or []
            if isinstance(item.get("load_ms"), int | float)
        ]
        return max(loads)[1] if loads else None

    # ------------------------------------------------------------------ idle unload
    async def idle_loop(self, stop: asyncio.Event) -> None:
        """Stop idle on_demand components until ``stop`` is set (one Controller background task)."""
        while not stop.is_set():
            try:
                await self.unload_idle()
            except Exception:
                log.exception("閒置卸載檢查失敗（下一輪再試）")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), IDLE_CHECK_S)

    def idle_candidates(self) -> list[Key]:
        """The on_demand components idle past their limit (and updates what counts as used)."""
        now = self._now()
        view = self.ctl.catalog.lifecycle_view()
        for key in [k for k in self.last_used if k not in view]:
            del self.last_used[key]
        due: list[Key] = []
        for key, facts in view.items():
            if not is_on_demand(facts):
                self.last_used.pop(key, None)
                continue
            state = facts.get("state")
            if (
                state in ("loading", "busy")
                or facts.get("active_call_id")
                or self.reserved(key)
                or key in self.unloading
            ):
                self.last_used[key] = now
                continue
            if state != "ready":
                self.last_used.pop(key, None)
                continue
            since = self.last_used.setdefault(key, now)
            if now - since >= idle_unload_seconds(facts):
                due.append(key)
        return due

    async def unload_idle(self) -> None:
        """Send one stop to each idle on_demand component (one at a time)."""
        for key in self.idle_candidates():
            if self.reserved(key) or key in self.unloading:
                continue
            self.unloading.add(key)
            try:
                await self._stop(key)
            finally:
                self.unloading.discard(key)
                self.last_used[key] = self._now()

    async def _stop(self, key: Key) -> None:
        node_id, component_id = key
        try:
            endpoint = self.ctl.catalog.endpoint_for_call(node_id)
        except ComponentError:
            return
        url = f"{endpoint}/api/components/{quote(component_id, safe='')}/control"
        try:
            resp = await self.ctl.http.post(
                url, json={"action": "stop"}, timeout=FORWARD_TIMEOUT
            )
        except httpx.HTTPError as exc:
            log.warning(
                "閒置卸載 %s：停止請求失敗（%s），下個閒置期再試",
                component_id,
                type(exc).__name__,
            )
            return
        if resp.status_code != HTTPStatus.OK:
            err = error_from_response(resp, what="閒置卸載")
            log.info(
                "閒置卸載 %s：Node 拒絕（%s），下個閒置期再試", component_id, err.code
            )
            return
        self.unloads += 1
        log.info("閒置卸載：已停止 on_demand 元件 %s（node %s）", component_id, node_id)


__all__ = [
    "IDLE_CHECK_S",
    "RETRY_S",
    "Fail",
    "Go",
    "OnDemand",
    "Stopped",
    "Wait",
]
