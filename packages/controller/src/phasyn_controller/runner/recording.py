"""The controller's own recording of a run (stream ``controller``): every invoke/cancel it sent, the observed wall
time, and a per-step summary. It is written locally and indexed directly (never posted to itself). A recording
that cannot be created never stops the run.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Mapping
from contextlib import AbstractContextManager
from typing import TYPE_CHECKING, Any

from phasyn_components.recorder import Recorder, environment_facts

from .plan import StepPlan, input_summary

if TYPE_CHECKING:
    from ..state import Controller

log = logging.getLogger("phasyn_controller.runner")

COUNTERS = ("controller.invoke_posts", "controller.cancel_posts", "controller.cancel_unanswered")
STEP_STATES = ("succeeded", "failed", "cancelled", "skipped", "interrupted")


class RunRecording:
    def __init__(
        self, ctl: Controller, run: Mapping[str, Any], plans: Mapping[str, StepPlan], recording_id: str
    ) -> None:
        self.ctl = ctl
        self.run = run
        self.plans = plans
        self.recording_id = recording_id
        self.recorder: Recorder | None = None

    async def open(self) -> None:
        request = self.run["request"]
        pipeline = request["pipeline"]
        environment = {
            **environment_facts(),
            "role": "controller",
            "controller_id": self.ctl.instance_id,
            "controller_label": self.ctl.config.label,
            "pipeline_id": pipeline.get("pipeline_id"),
            "run_label": request.get("label"),
            "origin": request.get("origin"),
            "steps": {sid: {"node_id": p.node_id, "component_id": p.component_id} for sid, p in self.plans.items()},
        }

        def create() -> Recorder:
            rec = Recorder(
                recordings_root=self.ctl.recordings_root,
                recording_id=self.recording_id,
                stream_id="controller",
                node_id=self.ctl.instance_id,
                component_id="controller",
                provider_id="controller",
                process_instance_id=self.ctl.process_instance_id,
                operation="controller",
                run_id=self.run["run_id"],
                call_id=None,
                config=self.ctl.config.recording,
            )
            rec.declare(*COUNTERS)
            rec.write_context(
                settings=None, input_summary=input_summary(request.get("inputs") or {}), environment=environment
            )
            self.ctl.store.index_recording(self.recording_id)
            return rec

        try:
            self.recorder = await asyncio.to_thread(create)
        except Exception:
            log.exception("run %s 的主控 recording 無法建立（run 繼續）", self.run["run_id"])
            return
        self.log(
            "info", f"run 開始：接線 {pipeline.get('pipeline_id')}，{len(self.plans)} 個步驟", run_id=self.run["run_id"]
        )

    def log(self, level: str, message: str, **fields: Any) -> None:
        if self.recorder is not None:
            self.recorder.log(level, message, **fields)

    def count(self, name: str) -> None:
        if self.recorder is not None:
            self.recorder.count(name)

    def notice(self, code: str, message: str) -> None:
        if self.recorder is not None:
            self.recorder.notice(code, message)

    def span(self, name: str, *, part: str) -> AbstractContextManager[Any]:
        return self.recorder.span(name, part=part) if self.recorder is not None else contextlib.nullcontext()

    def summarize(self, order: list[str], steps: Mapping[str, Mapping[str, Any]]) -> None:
        """Summary notes per step (terminal state and identifiers) and step counters; only observed facts."""
        rec = self.recorder
        if rec is None:
            return
        counts: dict[str, int] = {}
        for sid in order:
            entry = steps[sid]
            counts[entry["state"]] = counts.get(entry["state"], 0) + 1
            code = (entry.get("error") or {}).get("code")
            unknown = "；遠端結果未知" if entry.get("remote_outcome_unknown") else ""
            rec.note(
                f"步驟 {sid}：{entry['state']}（node {entry['node_id']}／component {entry['component_id']}"
                f"／call {entry.get('call_id') or '未送出'}{f'／{code}' if code else ''}{unknown}）"
            )
        meta = {"unit": "count", "scope": "controller_run", "method": "controller_runner"}
        rec.set_metric("controller.steps_total", len(steps), **meta)
        for state in STEP_STATES:
            rec.set_metric(f"controller.steps_{state}", counts.get(state, 0), **meta)

    async def close(self, state: str, error: dict[str, Any] | None) -> None:
        rec, self.recorder = self.recorder, None
        if rec is None:
            return

        def close() -> None:
            rec.finalize(state, error=error)
            self.ctl.store.index_recording(self.recording_id)

        try:
            await asyncio.to_thread(close)
        except Exception:
            log.exception("run %s 的主控 recording 無法結束", self.run["run_id"])


__all__ = ["COUNTERS", "RunRecording"]
