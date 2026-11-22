"""A single local queue. Each dispatch is durable before entering RunManager; observations never resubmit a run."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import TYPE_CHECKING

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id

from ..revisions import require_revision
from .plan import Doc, descriptors, planned, request, settings_fingerprint
from .store import Store


if TYPE_CHECKING:
    from ..state import Controller

log = logging.getLogger(__name__)
_MAX_ACTIVE_PLANS = 4


def conflict(reason: str) -> ComponentError:
    """Build a draft plan conflict with a machine-readable reason."""
    return ComponentError(
        "STATE_CONFLICT", "草稿計畫無法執行這項操作", details={"reason": reason}
    )


def sign(d: Doc, signature: str) -> None:
    """Require the digest of the plan the operator reviewed."""
    if signature != d["digest"]:
        raise conflict("plan_digest_mismatch")


def succeeded_asset(run: Doc, key: str) -> Doc | None:
    """Extract a complete, validated video asset from the specified output."""
    typed = run["outputs"].get(key) or {}
    asset = typed.get("value")
    if (
        typed.get("type_id") == "media.asset.v1"
        and isinstance(asset, dict)
        and contracts.is_valid("Asset", asset)
        and asset["complete"]
        and asset["kind"] in {"video", "final"}
        and asset["file"]["media_type"].startswith("video/")
    ):
        return asset
    return None


def quality(run: Doc, key: str, asset: Doc) -> Doc:
    """Compare the media probe with the published asset and retain the observed values."""
    value = run["outputs"].get(key) or {}
    probe = value.get("value") or {}
    if value.get("type_id") != "media.probe.v1" or not isinstance(probe, dict):
        return {"issues": ["missing_probe_report"], "evidence": {}}
    issues = []
    if (
        probe.get("kind") != "video"
        or not probe.get("video_codec")
        or not probe.get("duration_seconds")
    ):
        issues.append("missing_or_unplayable_video")
    if (probe.get("width"), probe.get("height")) != (asset["width"], asset["height"]):
        issues.append("dimensions_mismatch")
    if (
        probe.get("frame_count_exact")
        and probe.get("frame_count") != asset["frame_count"]
    ):
        issues.append("frame_count_mismatch")
    if probe.get("size_bytes") != asset["file"]["size_bytes"]:
        issues.append("size_mismatch")
    return {
        "issues": issues,
        "evidence": {
            k: probe.get(k)
            for k in (
                "kind",
                "width",
                "height",
                "frame_count",
                "frame_count_exact",
                "fps_num",
                "fps_den",
                "video_codec",
                "has_audio",
                "duration_seconds",
                "size_bytes",
            )
        },
        "output_files": {
            k: v["file"] for k, v in run["outputs"].items() if "file" in v
        },
    }


def _select_candidate(d: Doc, cid: str) -> None:
    selected = next((r for r in d["results"] if r["candidate_id"] == cid), None)
    if (
        not selected
        or "asset" not in selected
        or selected["state"] not in {"review", "ready"}
    ):
        raise conflict("candidate_not_ready_for_selection")
    shot = next(
        c["shot_id"] for c in d["plan"]["candidates"] if c["candidate_id"] == cid
    )
    d["selected"][shot] = cid


def _settle_candidate(d: Doc, result: Doc, run: Doc, phase: str) -> None:
    if run["state"] != "succeeded":
        if any(v.get("remote_outcome_unknown") for v in run["steps"].values()):
            d["status"] = "uncertain"
        else:
            result["state"] = "failed"
            result["error"] = run.get("error") or {"code": run["state"]}
    elif phase == "draft":
        asset = succeeded_asset(run, d["plan"]["draft_output"])
        if not asset:
            result.update(state="failed", error={"code": "missing_complete_video"})
        else:
            result.update(asset=asset, stage="qc", state="queued")
    else:
        result["quality"] = quality(run, d["plan"]["qc_output"], result["asset"])
        result["state"] = "review" if result["quality"]["issues"] else "ready"


class DraftPlans:
    """Dispatch approved draft candidates and reconcile their recorded runs."""

    def __init__(self, ctl: Controller) -> None:
        """Create the persistent ledger, worker lock and wake event."""
        self.ctl = ctl
        self.store = Store(ctl.data_dir)
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()
        self.worker: asyncio.Task[None] | None = None

    async def startup(self) -> None:
        """Open the plan store and start the background worker."""
        await asyncio.to_thread(self.store.open)
        self.worker = asyncio.create_task(self.loop(), name="studio-draft-plans")

    async def shutdown(self) -> None:
        """Stop the worker while retaining its durable references."""
        if self.worker:
            self.worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.worker

    async def get(self, pid: str, plan: str) -> Doc:
        """Read the named plan for one project."""
        return await asyncio.to_thread(self.store.get, pid, plan)

    async def save(self, d: Doc) -> None:
        """Persist the plan and references outside the event loop."""
        writer = asyncio.create_task(asyncio.to_thread(self.store.save, d))
        try:
            await asyncio.shield(writer)
        except asyncio.CancelledError:
            await writer
            raise

    async def create(self, pid: str, plan: str, spec: Doc) -> Doc:
        """Freeze candidates and budgets before approval."""
        contracts.validate("StudioDraftPlanRequest", spec)
        key = digest(spec)
        async with self.lock:
            try:
                previous = await self.get(pid, plan)
            except ComponentError as exc:
                if exc.code != "NOT_FOUND":
                    raise
            else:
                if previous["spec_digest"] != key:
                    raise conflict("plan_id_already_has_a_different_request")
                return previous
            if await asyncio.to_thread(self.store.released, pid, plan):
                raise conflict("plan_id_was_released")
            summary = await asyncio.to_thread(planned, self.ctl, pid, plan, spec)
            d = {
                "plan_id": plan,
                "project_id": pid,
                "digest": digest(summary),
                "spec_digest": key,
                "plan": summary,
                "status": "planned",
                "deadline": None,
                "reserved_runs": 0,
                "reserved_step_attempts": 0,
                "selected": {},
                "stop_reason": None,
                "results": [
                    {
                        "candidate_id": c["candidate_id"],
                        "stage": "draft",
                        "state": "queued",
                        "runs": {},
                    }
                    for c in summary["candidates"]
                ],
            }
            await self.save(d)
            return d

    async def _start_plan(self, pid: str, d: Doc) -> None:
        current = await asyncio.to_thread(self.ctl.studio.get, pid)
        require_revision(
            current["revision"],
            d["plan"]["project_revision"],
            what="專案",
            suffix="請建立新的草稿計畫",
        )
        if len(await asyncio.to_thread(self.store.active)) >= _MAX_ACTIVE_PLANS:
            raise conflict("too_many_active_plans")
        d["status"] = "running"
        d["deadline"] = time.time() + d["plan"]["budget"]["timeout_seconds"]

    async def action(self, pid: str, plan: str, action: str, body: Doc) -> Doc:
        """Apply an operator action to the plan under its lock."""
        async with self.lock:
            if action == "release":
                released = await asyncio.to_thread(self.store.released, pid, plan)
                if released:
                    if released != body["digest"]:
                        raise conflict("plan_digest_mismatch")
                    return {"released": True, "project_id": pid, "plan_id": plan}
            d = await self.get(pid, plan)
            sign(d, body["digest"])
            if action == "start" and d["status"] == "planned":
                await self._start_plan(pid, d)
            elif action == "cancel" and d["status"] in {
                "planned",
                "running",
                "uncertain",
            }:
                d["status"] = "stopping"
                d["stop_reason"] = "cancelled"
            elif action == "reconcile" and d["status"] == "uncertain":
                d["status"] = "stopping" if d["stop_reason"] else "running"
            elif action == "select":
                _select_candidate(d, body["candidate_id"])
            elif action == "release":
                if d["status"] not in {
                    "completed",
                    "cancelled",
                    "expired",
                    "planned",
                    "budget_exhausted",
                    "uncertain",
                }:
                    raise conflict("unresolved_plan")
                await asyncio.to_thread(self.store.remove, pid, plan, d["digest"])
                return {"released": True, "project_id": pid, "plan_id": plan}
            await self.save(d)
            self.wake.set()
            return d

    async def loop(self) -> None:
        """Process active plans and wait for more work."""
        while True:
            self.wake.clear()
            for pid, plan in await asyncio.to_thread(self.store.active):
                try:
                    async with self.lock:
                        await self.tick(await self.get(pid, plan))
                except ComponentError as exc:
                    log.warning("Draft plan %s could not advance: %s", plan, exc.code)
                except Exception:
                    log.exception("Draft plan %s could not advance", plan)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.wake.wait(), timeout=0.5)

    async def tick(self, d: Doc) -> None:
        """Advance one plan in budget order."""
        if d["status"] not in {"running", "stopping"}:
            return
        if d["deadline"] and time.time() >= d["deadline"] and not d["stop_reason"]:
            d["stop_reason"] = "expired"
            d["status"] = "stopping"
            await self.save(d)
        for candidate, result in zip(
            d["plan"]["candidates"], d["results"], strict=True
        ):
            if result["state"] in {"ready", "review", "failed", "skipped"}:
                continue
            if result["state"] == "queued":
                if d["stop_reason"]:
                    result["state"] = "skipped"
                    continue
                await self.dispatch(d, candidate, result)
            else:
                await self.observe(d, result)
            return
        d["status"] = d["stop_reason"] or "completed"
        await self.save(d)

    async def dispatch(self, d: Doc, candidate: Doc, result: Doc) -> None:
        """Reserve a run before submitting its frozen request."""
        if not self.ctl.runner.has_slot():
            return
        stage = result["stage"]
        plan = d["plan"]
        cfg = plan["budget"]
        body = (
            candidate["draft"]
            if stage == "draft"
            else request(
                plan["qc_pipeline"],
                {
                    plan["qc_input"]: {
                        "type_id": "media.video.v1",
                        "file": result["asset"]["file"],
                    }
                },
            )
        )
        try:
            for node_id in {s["node_id"] for s in body["pipeline"]["steps"]}:
                self.ctl.catalog.endpoint_for_call(node_id)
        except ComponentError:
            return
        observed = await asyncio.to_thread(descriptors, self.ctl, body["pipeline"])
        if settings_fingerprint(observed, cfg) != plan["components"][stage]:
            result.update(
                state="failed", error={"code": "approved_component_settings_changed"}
            )
            await self.save(d)
            return
        count = len(body["pipeline"]["steps"])
        if (
            d["reserved_runs"] + 1 > cfg["max_runs"]
            or d["reserved_step_attempts"] + count > cfg["max_step_attempts"]
        ):
            d["stop_reason"] = "budget_exhausted"
            d["status"] = "stopping"
            await self.save(d)
            return
        rid = new_id()
        result["state"] = "dispatched"
        result["runs"][stage] = {"run_id": rid, "request_digest": digest(body)}
        d["reserved_runs"] += 1
        d["reserved_step_attempts"] += count
        await self.save(d)
        # A crash on either side of this call is recovered only by observing this exact run id.
        if time.time() >= d["deadline"]:
            result["state"] = "skipped"
            d["stop_reason"] = "expired"
            d["status"] = "stopping"
            await self.save(d)
            return
        try:
            await self.ctl.runner.create(
                body, reserved_run_id=rid, dispatch_deadline=d["deadline"]
            )
        except ComponentError as exc:
            if (
                exc.code
                in {
                    "RUN_ACTIVE",
                    "NODE_UNREACHABLE",
                    "NOT_FOUND",
                    "INVALID_ARGUMENT",
                    "SCHEMA_VIOLATION",
                    "COMPONENT_NOT_READY",
                }
                and not exc.remote_outcome_unknown
            ):
                result.update(state="failed", error={"code": exc.code})
                await self.save(d)
            else:
                d["status"] = "uncertain"
                await self.save(d)

    async def observe(self, d: Doc, result: Doc) -> None:
        """Read the reserved run and update the candidate from its outcome."""
        phase = result["stage"]
        receipt = result["runs"][phase]
        rid = receipt["run_id"]
        run = self.ctl.runner.snapshot(rid)
        if run is None:
            try:
                run = await asyncio.to_thread(self.ctl.runs.read, rid)
            except ComponentError:
                d["status"] = "uncertain"
                await self.save(d)
                return
        if (
            run.get("run_id") != rid
            or digest(run["request"]) != receipt["request_digest"]
        ):
            d["status"] = "uncertain"
            await self.save(d)
            return
        receipt["state"] = run["state"]
        if run["state"] == "running":
            if d["stop_reason"] and not receipt.get("cancel_requested"):
                receipt["cancel_requested"] = True
                await self.save(d)
                try:
                    await self.ctl.runner.cancel(rid)
                except ComponentError as exc:
                    if exc.code != "STATE_CONFLICT":
                        raise
            return
        _settle_candidate(d, result, run, phase)
        await self.save(d)
