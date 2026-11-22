"""Advance LoRA training jobs phase by phase; each phase is one or more ordinary runs.

Phases: ``clips`` (cut the sources) -> ``review`` (automatic captions) -> ``select`` (clip choice, held-out
split, leakage check; optionally a user review) -> ``encode`` (text and reference conditioning) -> ``train``
(chunks; the trainer resumes from its checkpoint) -> ``compare`` (the same prompts and seed at every LoRA
strength, at an early checkpoint and at the end) -> ``decide`` (the user keeps or discards) -> ``register``.

Every run is reserved in the job document before it is created and observed by its id afterwards, so a
Controller restart continues where it was; a run is never sent twice. A training chunk whose attempt stopped
(for example a Node restart) is continued by a new run up to ``max_auto_resumes`` times; the trainer picks
up its own checkpoint. A watchdog stops a training or comparison run whose progress (step states and the
running step's previews, which the trainer also sends while it prepares data or waits for cooling) stands
still for longer than the phase allows; the stopped chunk is continued from its checkpoint like any other
interrupted chunk, and a stopped comparison run is sent again a bounded number of times. Comparison DiTs are on-demand instances the job defines for itself; an idle resident
DiT that blocks them is stopped only when the job allows it, and started again when the job ends.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.lora_training import constants as c, plan, selection
from phasyn_components.timeutil import utc_now

from ..forward import forward
from . import artifacts, requests as rq
from .store import Doc, TrainingStore


if TYPE_CHECKING:
    from ..state import Controller

log = logging.getLogger(__name__)
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
MAX_EVENTS = 200
TICK_S = 2.0
LOST_AFTER_S = 120.0
TRAINER_STOPS = ("void", "diverged")
# A step refused because its device or component was busy never started: a new run is sent (bounded)
BUSY_CODES = {"DEVICE_BUSY", "COMPONENT_BUSY", "EXCLUSIVE_GROUP_BUSY"}
MAX_BUSY_RETRIES = 30
_TRANSIENT = {"RUN_ACTIVE", "NODE_UNREACHABLE", "COMPONENT_NOT_READY", "DEVICE_BUSY"}
# watchdog: a run stands still once none of its steps changed state and the running step sent no new preview for
# this long; a training chunk allows three of its own steps plus loading, never less than the floor
STALL_FLOOR_S = 900.0
STALL_LOAD_S = 600.0
STALL_STEPS = 3
STALL_COMPARE_S = 1800.0
DEFAULT_STEP_S = 60.0
MAX_STALL_RETRIES = 2
STALLED = "STALLED"


def event(job: Doc, kind: str, **params: Any) -> None:
    """Append a timeline event (kind + parameters; the UI words it)."""
    job.setdefault("events", []).append(
        {"at": utc_now(), "kind": kind, "params": params}
    )
    del job["events"][:-MAX_EVENTS]


class JobError(Exception):
    """A phase cannot continue; the job pauses with this error until the user resumes it."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        fatal: bool = False,
        details: Doc | None = None,
    ) -> None:
        """Keep the error code, the message, whether resuming can help and the run's error details."""
        super().__init__(message)
        self.code, self.message, self.fatal = code, message, fatal
        self.details: Doc = dict(details or {})


class LoraTrainings:
    """The training job ledger and its worker."""

    def __init__(self, ctl: Controller) -> None:
        """Create the store, the lock and the wake event."""
        self.ctl = ctl
        self.store = TrainingStore(ctl.data_dir)
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()
        self.worker: asyncio.Task[None] | None = None

    async def startup(self) -> None:
        """Open the store and start the worker."""
        await asyncio.to_thread(self.store.open)
        self.worker = asyncio.create_task(self.loop(), name="lora-trainings")

    async def shutdown(self) -> None:
        """Stop the worker; the documents keep every reserved run."""
        if self.worker:
            self.worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.worker

    async def save(self, job: Doc) -> None:
        """Persist a document outside the event loop (shielded from cancellation)."""
        job["updated_at"] = utc_now()
        writer = asyncio.create_task(
            asyncio.to_thread(self.store.save, copy.deepcopy(job))
        )
        try:
            await asyncio.shield(writer)
        except asyncio.CancelledError:
            await writer
            raise

    async def get(self, training_id: str) -> Doc:
        """One job document."""
        return await asyncio.to_thread(self.store.get, training_id)

    async def listing(self) -> list[Doc]:
        """Summaries of every job, newest first."""
        docs = await asyncio.to_thread(self.store.listing)
        keys = (
            "training_id",
            "name",
            "direction",
            "status",
            "phase",
            "created_at",
            "updated_at",
            "progress",
            "error",
            "decision",
            "registered",
        )
        return [{k: d.get(k) for k in keys} for d in docs]

    # -- creation and actions ------------------------------------------------------------------------------------
    async def create(self, body: Doc) -> Doc:
        """A new job from sources, a direction and optional settings; it starts at once."""
        contracts.validate("LoraTrainingRequest", body, what="LoRA 訓練請求")
        options = _options(body.get("options") or {})
        tid = new_id()
        now = utc_now()
        sources = []
        for i, src in enumerate(body["sources"]):
            sources.append(
                {
                    "source_id": f"s{i + 1:02d}",
                    "label": str(src.get("label") or f"影片 {i + 1}")[
                        :120
                    ],  # i18n-ignore: stored default name
                    "role": src.get("role", "train"),
                    "file": dict(src["file"]),
                }
            )
        if not any(s["role"] == c.SOURCE_ROLES[0] for s in sources):
            raise ComponentError(
                "INVALID_ARGUMENT", "至少要有一支影片用來訓練", status=422
            )
        name = str(body.get("name") or body["direction"])[:80]
        job: Doc = {
            "training_id": tid,
            "job_key": tid.replace("-", "")[:24],
            "name": name,
            "direction": body["direction"],
            "created_at": now,
            "updated_at": now,
            "status": "running",
            "phase": "clips",
            "progress": None,
            "options": options,
            "sources": sources,
            "placement": {},
            "runs": [],
            "attempts": {},
            "artifacts": {},
            "selection": None,
            "eval_items": [],
            "training": None,
            "comparison": {"rounds": []},
            "decision": None,
            "registered": None,
            "error": None,
            "stopped_components": [],
            "events": [],
        }
        event(job, "created", sources=len(sources))
        await self.save(job)
        self.wake.set()
        return job

    async def action(self, training_id: str, body: Doc) -> Doc:
        """Apply one user action under the worker lock."""
        contracts.validate("LoraTrainingAction", body, what="LoRA 訓練操作")
        async with self.lock:
            job = await self.get(training_id)
            await _ACTIONS[body["action"]](self, job, body)
            await self.save(job)
        self.wake.set()
        return job

    async def edit_clips(self, training_id: str, body: Doc) -> Doc:
        """Drop, restore or re-caption clips while the job waits for its dataset review."""
        contracts.validate("LoraTrainingClipEdit", body, what="訓練片段修改")
        async with self.lock:
            job = await self.get(training_id)
            if job["status"] != "review" or job["phase"] != "select":
                raise ComponentError(
                    "STATE_CONFLICT", "只有在檢查訓練資料時可以修改片段", status=409
                )
            edits = job.setdefault("edits", {"dropped": [], "captions": {}})
            dropped = set(edits["dropped"]) | set(body.get("drop") or [])
            dropped -= set(body.get("restore") or [])
            edits["dropped"] = sorted(dropped)
            edits["captions"].update(
                {k: v for k, v in (body.get("captions") or {}).items() if v.strip()}
            )
            await self._select(job, reviewed=True)
            await self.save(job)
        return job

    # -- worker ---------------------------------------------------------------------------------------------------
    async def loop(self) -> None:
        """Advance every active job, then wait for an action or the next tick."""
        while True:
            self.wake.clear()
            for tid in await asyncio.to_thread(self.store.active):
                try:
                    async with self.lock:
                        await self.tick(await self.get(tid))
                except Exception:
                    log.exception("LoRA training %s could not advance", tid)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.wake.wait(), timeout=TICK_S)

    async def tick(self, job: Doc) -> None:
        """One step of the job's state machine."""
        if job["status"] == "stopping":
            await self._stop_all(job)
            return
        try:
            await _PHASES[job["phase"]](self, job)
        except JobError as exc:
            job["status"] = "failed" if exc.fatal else "paused"
            job["error"] = {
                "code": exc.code,
                "message": exc.message,
                "phase": job["phase"],
            }
            event(job, "error", code=exc.code, phase=job["phase"])
            await self._restore_components(job)
            await self.save(job)
        except ComponentError as exc:
            if exc.code in _TRANSIENT and not exc.remote_outcome_unknown:
                return
            job["status"] = "paused"
            job["error"] = {
                "code": exc.code,
                "message": exc.message,
                "phase": job["phase"],
            }
            event(job, "error", code=exc.code, phase=job["phase"])
            await self.save(job)

    # -- runs -----------------------------------------------------------------------------------------------------
    def _record(self, job: Doc, key: str) -> Doc | None:
        attempt = int(job["attempts"].get(key, 0))
        return next(
            (
                r
                for r in reversed(job["runs"])
                if r["key"] == key and r["attempt"] == attempt
            ),
            None,
        )

    async def _submit(self, job: Doc, key: str, phase: str, body: Doc) -> bool:
        """Reserve and create one run; False when it must wait (no slot, Node offline)."""
        if not self.ctl.runner.has_slot():
            return False
        for node_id in {s["node_id"] for s in body["pipeline"]["steps"]}:
            try:
                self.ctl.catalog.endpoint_for_call(node_id)
            except ComponentError:
                return False
        rid = new_id()
        rec = {
            "run_id": rid,
            "key": key,
            "attempt": int(job["attempts"].get(key, 0)),
            "phase": phase,
            "request_digest": digest(body),
            "state": "dispatched",
            "created_at": utc_now(),
        }
        job["runs"].append(rec)
        await self.save(job)
        try:
            await self.ctl.runner.create(body, reserved_run_id=rid)
        except ComponentError as exc:
            if exc.code in _TRANSIENT and not exc.remote_outcome_unknown:
                job["runs"].remove(rec)
                await self.save(job)
                return False
            if exc.remote_outcome_unknown:
                rec["state"] = "unknown"
                raise JobError(
                    exc.code, "建立 run 的回覆遺失；請到執行紀錄確認後再繼續"
                ) from exc
            rec["state"] = "rejected"
            raise JobError(exc.code, exc.message) from exc
        event(job, "run", key=key, run_id=rid)
        await self.save(job)
        return True

    async def _observe(self, rec: Doc) -> Doc | None:
        """The run of a record once it is terminal (None while it runs)."""
        run = self.ctl.runner.snapshot(rec["run_id"])
        if run is None:
            try:
                run = await asyncio.to_thread(self.ctl.runs.read, rec["run_id"])
            except ComponentError:
                if (
                    rec["state"] == "dispatched"
                    and _age_s(rec["created_at"]) > LOST_AFTER_S
                ):
                    rec["state"] = (
                        "lost"  # never persisted by the runner: nothing was sent
                    )
                return None
        if digest(run["request"]) != rec["request_digest"]:
            raise JobError("STATE_CONFLICT", "run 的內容與訓練工作的紀錄不同")
        rec["state"] = run["state"]
        return run if run["state"] in TERMINAL else None

    async def _run_once(self, job: Doc, key: str, phase: str, build: Any) -> Doc | None:
        """Dispatch ``build()`` once for ``key`` and return its succeeded run (None while pending or waiting)."""
        rec = self._record(job, key)
        if rec is None:
            await self._submit(job, key, phase, build())
            return None
        run = await self._observe(rec)
        if rec["state"] == "lost":
            job["attempts"][key] = int(job["attempts"].get(key, 0)) + 1
            return None
        if run is None:
            await self._unblock(job, rec)
            await self._watchdog(job, key, phase, rec)
            return None
        if run["state"] != "succeeded":
            job["attempts"][key] = int(job["attempts"].get(key, 0)) + 1
            if rec.get("stalled"):
                if phase != "train" and job["attempts"][key] <= MAX_STALL_RETRIES:
                    event(job, "stall_retry", key=key)
                    await self.save(job)
                    return None
                # a training chunk continues from its checkpoint through the auto-resume of the train phase
                raise JobError(
                    STALLED, "執行的進度停住太久，已停止", details={"key": key}
                )
            err = _step_error(run)
            if (
                err.get("code") in BUSY_CODES
                and job["attempts"][key] <= MAX_BUSY_RETRIES
            ):
                event(job, "busy_retry", code=err.get("code"))
                await self.save(job)
                return None
            raise JobError(
                str(err.get("code") or run["state"].upper()),
                str(err.get("message") or "run 沒有成功"),
                details=err.get("details"),
            )
        return run

    async def _watchdog(self, job: Doc, key: str, phase: str, rec: Doc) -> None:
        """Stop a run whose progress stood still for longer than the phase allows (verified stop, then resumed)."""
        if phase not in ("train", "compare") or rec.get("stalled"):
            return
        run = self.ctl.runner.snapshot(rec["run_id"])
        if run is None:
            return
        steps = run.get("steps") or {}
        if not any(s.get("state") == "running" for s in steps.values()):
            rec.pop(
                "progress_at", None
            )  # waiting for a slot or a component is not a stall
            return
        mark = digest(
            sorted(
                (sid, s.get("state"), (s.get("preview") or {}).get("seq"))
                for sid, s in steps.items()
            )
        )
        if mark != rec.get("progress_mark") or "progress_at" not in rec:
            rec["progress_mark"], rec["progress_at"] = mark, utc_now()
            return
        limit = self._stall_limit(job, phase)
        idle = _age_s(rec["progress_at"])
        if idle < limit:
            return
        rec["stalled"] = True
        event(job, "watchdog_stall", key=key, minutes=round(idle / 60))
        await self.save(job)
        try:
            await self.ctl.runner.cancel(rec["run_id"])
        except ComponentError as exc:
            log.warning("看門狗停止 run %s 沒有成功：%s", rec["run_id"], exc)

    @staticmethod
    def _stall_limit(job: Doc, phase: str) -> float:
        """Seconds of standstill allowed: three training steps (from the last chunk's pace) plus loading."""
        if phase != "train":
            return STALL_COMPARE_S
        t = job["training"]
        step_s = DEFAULT_STEP_S
        for report in t.get("reports", {}).values():
            seconds, step = report.get("seconds"), report.get("step")
            if isinstance(seconds, int | float) and isinstance(step, int) and step > 0:
                done = [int(s) for s in t["reports"] if int(s) < step]
                span = step - (max(done) if done else 0)
                step_s = max(step_s, float(seconds) / max(span, 1))
        return max(STALL_FLOOR_S, STALL_STEPS * step_s + STALL_LOAD_S)

    async def _unblock(self, job: Doc, rec: Doc) -> None:
        """Stop an idle resident member of an exclusive group that keeps one of this job's steps waiting."""
        if not job["options"].get("allow_replace_idle_dit"):
            return
        run = self.ctl.runner.snapshot(rec["run_id"]) or {}
        nodes = {
            s["step_id"]: str(s["node_id"]).lower()
            for s in run.get("request", {}).get("pipeline", {}).get("steps", [])
        }
        for sid, step in (run.get("steps") or {}).items():
            load = step.get("component_load") or {}
            if load.get("reason") != "exclusive_resident" or sid not in nodes:
                continue
            for holder in load.get("holders") or []:
                await self._stop_idle(job, nodes[sid], str(holder))

    async def _stop_idle(self, job: Doc, node: str, component: str) -> None:
        desc = (
            await asyncio.to_thread(self.ctl.catalog.descriptors, [(node, component)])
        ).get((node, component))
        if desc is None or desc.get("state") != "ready" or desc.get("active_call_id"):
            return
        if self.ctl.runner.on_demand.needed_now((node, component)):
            return
        await self._control(node, component, "stop")
        job["stopped_components"].append({"node_id": node, "component_id": component})
        event(job, "stopped_component", component_id=component)

    async def _control(self, node: str, component: str, action: str) -> None:
        resp = await forward(
            self.ctl,
            "POST",
            node,
            f"/api/components/{quote(component, safe='')}/control",
            {"action": action},
            what="元件啟停",
        )
        if resp.status_code >= 400 and resp.status_code != 409:  # noqa: PLR2004 - HTTP error range
            raise ComponentError(
                "RUNTIME_ERROR",
                "元件啟停沒有成功",
                details={"status": resp.status_code},
            )

    async def _restore_components(self, job: Doc) -> None:
        """Start again what this job stopped (once each; a refusal is left to the user)."""
        for item in job.get("stopped_components") or []:
            if item.get("restored"):
                continue
            item["restored"] = True
            try:
                await self._control(item["node_id"], item["component_id"], "start")
                event(job, "restored_component", component_id=item["component_id"])
            except ComponentError as exc:
                event(
                    job,
                    "restore_failed",
                    component_id=item["component_id"],
                    code=exc.code,
                )

    async def _remove_eval_components(self, job: Doc) -> None:
        """Delete the comparison DiTs this job defined (best effort: a loaded one unloads itself when idle)."""
        for component in list((job.get("eval_components") or {}).keys()):
            for node in {str(k[0]) for k in job["placement"].get("register") or []}:
                ds = await asyncio.to_thread(
                    self.ctl.catalog.descriptors, [(node, component)]
                )
                desc = ds.get((node, component))
                if desc is None:
                    continue
                if desc.get("state") == "ready" and not desc.get("active_call_id"):
                    with contextlib.suppress(ComponentError):
                        await self._control(node, component, "stop")
                with contextlib.suppress(ComponentError):
                    await forward(
                        self.ctl,
                        "DELETE",
                        node,
                        f"/api/components/{quote(component, safe='')}",
                        what="比較用 DiT",
                    )

    async def _stop_all(self, job: Doc) -> None:
        live = []
        for rec in job["runs"]:
            if rec["state"] in TERMINAL or rec["state"] in ("rejected", "unknown"):
                continue
            if await self._observe(rec) is None:
                live.append(rec)
                if not rec.get("cancel_requested"):
                    rec["cancel_requested"] = True
                    with contextlib.suppress(ComponentError):
                        await self.ctl.runner.cancel(rec["run_id"])
        if not live:
            job["status"] = "cancelled"
            await self._restore_components(job)
            await self._remove_eval_components(job)
        await self.save(job)

    # -- phases ---------------------------------------------------------------------------------------------------
    async def _descriptors(self) -> dict[tuple[str, str], Doc]:
        return await asyncio.to_thread(self.ctl.catalog.descriptors)

    async def _place(self, job: Doc) -> None:
        """Choose the components of every phase once (the trainer's Node first)."""
        if job["placement"].get("train"):
            return
        ds = await self._descriptors()
        node = job["options"].get("train_node_id")
        train = rq.find_component(ds, c.PROVIDER_TRAIN, node=node)
        if train is None:
            raise JobError(
                "COMPONENT_NOT_READY", "沒有可用的 LoRA 訓練元件（h3.lora_train）"
            )
        home = train[0]
        picks = {"train": train}
        for name, provider in (
            ("clips", c.PROVIDER_CLIPS),
            ("review", c.PROVIDER_REVIEW),
            ("conditioning", c.PROVIDER_CONDITIONING),
            ("video_encode", c.PROVIDER_VIDEO_ENCODE),
            ("audio_encode", c.PROVIDER_AUDIO_ENCODE),
        ):
            key = rq.find_component(ds, provider, prefer_node=home)
            if key is None:
                raise JobError("COMPONENT_NOT_READY", f"沒有可用的元件：{provider}")
            picks[name] = key
        register = rq.all_components(ds, c.PROVIDER_REGISTER)
        if not register:
            raise JobError(
                "COMPONENT_NOT_READY", "沒有可用的 LoRA 登錄元件（lora.register）"
            )
        job["placement"] = {k: list(v) for k, v in picks.items()} | {
            "register": [list(k) for k in register]
        }
        job["te_parameters"] = await self._te_parameters(job)

    async def _te_parameters(self, job: Doc) -> Doc:
        routes = job["options"].get("eval_routes") or []
        if not routes:
            return {}
        template = await asyncio.to_thread(
            self.ctl.pipelines.get, routes[0]["pipeline_id"]
        )
        ds = await self._descriptors()
        annotated = rq.annotate(template, ds)
        te = [
            s
            for s in annotated["pipeline"]["steps"]
            if s.get("_provider") == c.PROVIDER_CONDITIONING
        ]
        return dict(te[0].get("parameters") or {}) if te else {}

    async def _phase_clips(self, job: Doc) -> None:
        await self._place(job)
        key = tuple(job["placement"]["clips"])
        run = await self._run_once(
            job, "clips", "clips", lambda: rq.clips_request(job, key)
        )
        if run is None:
            return
        outputs = run["steps"]["clips"]["outputs"]
        job["artifacts"]["dataset"] = outputs["dataset"]["file"]
        doc = await artifacts.read_json(self.ctl, job["artifacts"]["dataset"])
        job["artifacts"]["silence"] = doc["silence"]
        job["dataset_summary"] = {"sources": doc["sources"], "counts": doc["counts"]}
        job["phase"] = "review"
        event(job, "clips_done", kept=doc["counts"]["kept"])
        await self.save(job)

    async def _phase_review(self, job: Doc) -> None:
        key = tuple(job["placement"]["review"])
        run = await self._run_once(
            job, "review", "review", lambda: rq.review_request(job, key)
        )
        if run is None:
            return
        job["artifacts"]["reviews"] = run["steps"]["review"]["outputs"]["reviews"][
            "file"
        ]
        job["phase"] = "select"
        await self._select(job, reviewed=False)
        await self.save(job)

    async def _select(self, job: Doc, *, reviewed: bool) -> None:
        dataset = await artifacts.read_json(self.ctl, job["artifacts"]["dataset"])
        reviews = (await artifacts.read_json(self.ctl, job["artifacts"]["reviews"]))[
            "reviews"
        ]
        parsed = {k: v.get("parsed") for k, v in reviews.items() if v.get("parsed")}
        edits = job.get("edits") or {}
        o = job["options"]
        opts = selection.SelectionOptions(
            max_clips=int(o["max_clips"]),
            max_source_share=float(o["max_source_share"]),
            eval_count=int(o["eval_count"]),
            seed=int(o["seed"]),
            caption_prefix=str(o["caption_prefix"]),
            dropped=frozenset(edits.get("dropped") or []),
            edited_captions=dict(edits.get("captions") or {}),
        )
        chosen = selection.select(dataset, parsed, opts)
        by_id = {cl["clip_id"]: cl for cl in dataset["clips"]}
        job["selection"] = {
            "stats": chosen["stats"],
            "leakage": chosen["leakage"],
            "eval": chosen["eval"],
            "rejected": chosen["rejected"],
        }
        job["clips"] = _clip_rows(dataset, chosen, reviews)
        job["train_clips"] = [
            {
                **t,
                "video": by_id[t["clip_id"]]["video"],
                "references": by_id[t["clip_id"]]["references"],
            }
            for t in chosen["train"]
        ]
        items = [
            {
                "eval_id": f"h{i + 1}",
                "kind": "heldout",
                "clip_id": cid,
                "prompt": next(
                    h["caption"] for h in chosen["heldout"] if h["clip_id"] == cid
                ),
                "references": by_id[cid]["references"],
                "sheet": by_id[cid].get("sheet"),
            }
            for i, cid in enumerate(chosen["eval"])
        ]
        items += [
            {
                "eval_id": f"p{i + 1}",
                "kind": "custom",
                "prompt": p["prompt"],
                "references": p["references"],
            }
            for i, p in enumerate(o.get("eval_prompts") or [])
        ]
        job["eval_items"] = items
        if not job["train_clips"]:
            raise JobError(
                "INVALID_ARGUMENT", "沒有任何片段通過篩選，無法訓練", fatal=True
            )
        if o["review_before_training"] and not reviewed:
            job["status"] = "review"
            event(job, "waiting_review")
            return
        if not reviewed:
            self._start_training_phase(job)

    def _start_training_phase(self, job: Doc) -> None:
        params = plan.training_parameters(
            job["options"], train_clips=len(job["train_clips"])
        )
        job["training"] = {
            "steps": params["steps"],
            "parameters": params,
            "chunk_ends": plan.chunk_ends(params["steps"], int(params["chunk_steps"])),
            "done_step": 0,
            "loras": {},
            "reports": {},
            "loss_curve": [],
            "auto_resumes": 0,
            "stop_requested": False,
        }
        job["encodings"] = {}
        job["phase"] = "encode"
        event(job, "selected", train=len(job["train_clips"]), steps=params["steps"])

    async def _phase_select(self, job: Doc) -> None:
        if job["status"] == "running" and job.get("training") is None:
            self._start_training_phase(job)
            await self.save(job)

    async def _phase_encode(self, job: Doc) -> None:
        keys = {
            k: tuple(job["placement"][k])
            for k in ("conditioning", "video_encode", "audio_encode")
        }
        clips = job["train_clips"]
        if "silence_audio" not in job["artifacts"]:
            image = clips[0]["references"][0]
            run = await self._run_once(
                job, "silence", "encode", lambda: rq.silence_request(job, keys, image)
            )
            if run is not None:
                job["artifacts"]["silence_audio"] = run["steps"]["audio"]["outputs"][
                    "audio_references"
                ]["file"]
                await self.save(job)
            return
        size = rq.ENCODE_BATCH
        batches = [clips[i : i + size] for i in range(0, len(clips), size)]
        for b, batch in enumerate(batches):
            if all(cl["clip_id"] in job["encodings"] for cl in batch):
                continue
            run = await self._run_once(
                job,
                f"encode:{b}",
                "encode",
                lambda b=b, batch=batch: rq.encode_request(job, batch, keys, b),
            )
            if run is None:
                progress = {"phase": "encode", "done": b, "total": len(batches)}
                if job["progress"] != progress:
                    job["progress"] = progress
                    await self.save(job)
                return
            for i, cl in enumerate(batch):
                job["encodings"][cl["clip_id"]] = {
                    "conditioning": run["steps"][f"c{i}"]["outputs"]["conditioning"][
                        "file"
                    ],
                    "video_references": run["steps"][f"v{i}"]["outputs"][
                        "video_references"
                    ]["file"],
                }
            await self.save(job)
            return
        doc = {
            "schema": c.ENCODINGS_SCHEMA,
            "width": c.CLIP_WIDTH,
            "height": c.CLIP_HEIGHT,
            "silence_audio": job["artifacts"]["silence_audio"],
            "clips": [
                {
                    "clip_id": cl["clip_id"],
                    "source_id": cl["source_id"],
                    "video": cl["video"],
                    "loss_masks": cl["loss_masks"],
                    **job["encodings"][cl["clip_id"]],
                }
                for cl in clips
            ],
        }
        job["artifacts"]["encodings"] = await asyncio.to_thread(
            artifacts.write_json, self.ctl, doc, meta={"role": "lora_encodings"}
        )
        job["phase"] = "train"
        job["progress"] = None
        event(job, "encoded", clips=len(clips))
        await self.save(job)

    async def _phase_train(self, job: Doc) -> None:
        t = job["training"]
        ends = [e for e in t["chunk_ends"] if e > t["done_step"]]
        if t.get("stop_requested") or not ends:
            self._begin_round(job, final=True)
            await self.save(job)
            return
        until = ends[0]
        key = f"train:{until}"
        train_key = tuple(job["placement"]["train"])
        try:
            run = await self._run_once(
                job, key, "train", lambda: rq.train_request(job, train_key, until)
            )
        except JobError as exc:
            if exc.details.get("status") in TRAINER_STOPS:
                raise JobError(
                    exc.code, exc.message, fatal=True, details=exc.details
                ) from exc
            if t.get("stop_requested"):
                self._begin_round(job, final=True)
                await self.save(job)
                return
            if (
                t["auto_resumes"] < int(job["options"]["max_auto_resumes"])
                and exc.code != "CANCELLED"
            ):
                t["auto_resumes"] += 1
                event(job, "auto_resume", step=t["done_step"], code=exc.code)
                await self.save(job)
                return
            raise
        if run is None:
            return
        out = run["steps"]["train"]["outputs"]
        report = out["report"]["value"]
        step = int(report["step"])
        t["done_step"] = step
        job["progress"] = {"phase": "train", "done": step, "total": int(t["steps"])}
        t["loss_curve"] = report.get("loss_curve") or t["loss_curve"]
        t["reports"][str(step)] = {
            k: report.get(k)
            for k in ("status", "reason", "seconds", "thermal", "drift", "step")
        }
        t["loras"][str(step)] = out["lora"]["file"]
        if (
            step < until
        ):  # paused inside the chunk (heat, memory, deadline): continue from its checkpoint
            job["attempts"][key] = int(job["attempts"].get(key, 0)) + 1
            event(job, "chunk_paused", step=step, reason=report.get("reason"))
        else:
            event(job, "chunk_done", step=step)
            early = job["options"].get("early_compare_step")
            if early and step == int(early) and step < int(t["steps"]):
                self._begin_round(job, final=False)
        await self.save(job)

    # -- comparison -------------------------------------------------------------------------------------------
    def _begin_round(self, job: Doc, *, final: bool) -> None:
        t = job["training"]
        step = max((int(s) for s in t["loras"]), default=0)
        if step == 0:
            raise JobError(
                "RUNTIME_ERROR", "沒有任何已完成的 LoRA 可以比較", fatal=True
            )
        rounds = job["comparison"]["rounds"]
        if (
            final
            and rounds
            and int(rounds[-1]["step"]) == step
            and rounds[-1]["status"] == "done"
        ):
            rounds[-1]["final"] = (
                True  # the early round already compared this very LoRA
            )
            job["phase"], job["status"] = "decide", "review"
            event(job, "waiting_decision", step=step)
            return
        routes = job["options"].get("eval_routes") or []
        strengths = plan.check_strengths(job["options"]["strengths"])
        if not final:  # the early round only has to show whether the LoRA helps; the final one sweeps the grid
            strengths = plan.early_strengths(strengths)
        job["comparison"]["rounds"].append(
            {
                "step": step,
                "final": final,
                "status": "running",
                "candidate": None,
                "routes": [
                    {
                        "route_id": r["route_id"],
                        "label": r.get("label") or r["route_id"],
                        "pipeline_id": r["pipeline_id"],
                        "status": "pending",
                        "error": None,
                        "cells": {str(s): {"state": "pending"} for s in strengths},
                    }
                    for r in routes
                ],
            }
        )
        job["phase"] = "compare"
        event(job, "compare_started", step=step, final=final)

    async def _phase_compare(self, job: Doc) -> None:
        rnd = job["comparison"]["rounds"][-1]
        if rnd["candidate"] is None:
            await self._register_candidate(job, rnd)
            return
        for route in rnd["routes"]:
            if route["status"] in ("done", "skipped"):
                continue
            await self._compare_route(job, rnd, route)
            return
        rnd["status"] = "done"
        if rnd["final"]:
            job["phase"] = "decide"
            job["status"] = "review"
            await self._restore_components(job)
            event(job, "waiting_decision", step=rnd["step"])
        else:
            job["phase"] = "train"
        await self.save(job)

    async def _register_candidate(self, job: Doc, rnd: Doc) -> None:
        step = int(rnd["step"])
        lora = job["training"]["loras"][str(step)]
        lora_id = f"{job['job_key']}-step{step:05d}"
        manifest = self._manifest(job, lora_id=lora_id, step=step, status="candidate")
        nodes = await self._route_nodes(job)
        keys = [tuple(k) for k in job["placement"]["register"] if k[0] in nodes] or [
            tuple(k) for k in job["placement"]["register"]
        ]
        run = await self._run_once(
            job,
            f"candidate:{step}",
            "compare",
            lambda: rq.register_request(job, keys, lora, manifest, candidate=True),
        )
        if run is None:
            return
        rnd["candidate"] = {
            s["outputs"]["registered"]["value"]["node_id"]: s["outputs"]["registered"][
                "value"
            ]["manifest_path"]
            for s in run["steps"].values()
        }
        await self.save(job)

    async def _route_nodes(self, job: Doc) -> set[str]:
        nodes = set()
        for spec in job["options"].get("eval_routes") or []:
            try:
                template = await asyncio.to_thread(
                    self.ctl.pipelines.get, spec["pipeline_id"]
                )
            except ComponentError:
                continue
            nodes |= {str(s["node_id"]).lower() for s in template.get("steps") or []}
        return nodes

    def _manifest(self, job: Doc, *, lora_id: str, step: int, status: str) -> Doc:
        stats = (job.get("selection") or {}).get("stats") or {}
        t = job["training"]
        p = t["parameters"]
        notes = [f"方向：{job['direction']}", f"訓練片段 {stats.get('train_clips')} 段；第 {step} 步（共 {t['steps']} 步）",  # i18n-ignore: manifest notes
                 f"rank {p['rank']}、alpha {p['alpha']}、學習率 {p['learning_rate']}"]  # fmt: skip  # i18n-ignore: manifest notes
        doc = plan.manifest(
            lora_id=lora_id,
            label=f"{job['name']}（第 {step} 步）",
            relative_path="",
            sha256="",
            size_bytes=0,  # i18n-ignore: manifest label
            rank=int(p["rank"]),
            alpha=float(p["alpha"]),
            revision=f"{job['job_key']}-step{step}",
            notes=notes,
            status=status,
        )
        doc.pop("file")
        return doc

    async def _compare_route(self, job: Doc, rnd: Doc, route: Doc) -> None:
        spec = next(
            r
            for r in job["options"]["eval_routes"]
            if r["route_id"] == route["route_id"]
        )
        ds = await self._descriptors()
        template = rq.annotate(
            await asyncio.to_thread(self.ctl.pipelines.get, spec["pipeline_id"]), ds
        )
        dit = rq.dit_step_of(template)
        base_key = (str(dit["node_id"]).lower(), str(dit["component_id"]))
        base = ds.get(base_key)
        manifest_path = (rnd["candidate"] or {}).get(base_key[0])
        if base is None or manifest_path is None:
            route.update(status="skipped", error="no_component")
            return
        for strength, cell in route["cells"].items():
            if cell["state"] == "done":
                continue
            s = float(strength)
            # every strength, 0 included, renders on the job's own on-demand copy of the route's DiT: the route's
            # component may be resident (never loaded on demand), and the copies differ only in the job's LoRA
            eval_key = (
                base_key[0],
                f"lora-eval-{job['job_key'][:8]}-{route['route_id']}",
            )
            try:
                want = rq.eval_definition(
                    base,
                    component_id=eval_key[1],
                    manifest_path=manifest_path,
                    strength=s,
                )
            except ComponentError as exc:
                route.update(status="skipped", error=exc.code)
                await self.save(job)
                return
            if not await self._ensure_definition(job, eval_key, want, ds, cell):
                await self.save(job)
                return
            key = f"render:{rnd['step']}:{route['route_id']}:{strength}"
            label = f"LoRA 訓練「{job['name']}」：比較 {route['label']}・強度 {strength}・第 {rnd['step']} 步"  # i18n-ignore: run label
            run = await self._run_once(
                job,
                key,
                "compare",
                lambda eval_key=eval_key, label=label: rq.render_request(
                    job,
                    template,
                    items=job["eval_items"],
                    dit=eval_key,
                    route=spec,
                    label=label,
                ),
            )
            if run is None:
                pending = self._record(job, key)
                cell.update(
                    state="running",
                    run_id=None if pending is None else pending["run_id"],
                )
                return
            sid, port = rq.asset_output(template)
            cell.update(
                state="done",
                run_id=run["run_id"],
                assets=[
                    run["steps"][f"e{j}_{sid}"]["outputs"][port]["value"]
                    for j in range(len(job["eval_items"]))
                ],
            )
            await self.save(job)
            return
        route["status"] = "done"
        await self.save(job)

    async def _ensure_definition(
        self,
        job: Doc,
        key: tuple[str, str],
        want: Doc,
        ds: dict[tuple[str, str], Doc],
        cell: Doc,
    ) -> bool:
        """True once the comparison DiT is defined as ``want`` (stopped first when it holds another strength)."""
        current = ds.get(key)
        wanted = digest(want)
        defined = job.setdefault("eval_components", {})
        if current is not None and defined.get(key[1]) == wanted:
            return True
        if current is not None and current.get("state") not in ("stopped", "error"):
            if current.get("state") == "ready" and not current.get("active_call_id"):
                await self._control(key[0], key[1], "stop")
            cell["state"] = "waiting"
            return False
        resp = await forward(
            self.ctl,
            "PUT",
            key[0],
            f"/api/components/{quote(key[1], safe='')}",
            want,
            what="比較用 DiT",
        )
        if resp.status_code >= 400:  # noqa: PLR2004 - HTTP error range
            raise JobError("RUNTIME_ERROR", "無法建立比較用的 DiT 元件")
        defined[key[1]] = wanted
        event(job, "eval_component", component_id=key[1])
        cell["state"] = "waiting"
        return False

    # -- decision and registration ------------------------------------------------------------------------------
    async def _phase_decide(self, job: Doc) -> None:
        del job  # waits for the user's decision

    async def _phase_register(self, job: Doc) -> None:
        t = job["training"]
        step = max(int(s) for s in t["loras"])
        lora_id = plan.lora_slug(job["name"], job["training_id"])
        manifest = self._manifest(job, lora_id=lora_id, step=step, status="registered")
        manifest["label"] = job["name"]
        strength = (job.get("decision") or {}).get("strength")
        if strength is not None:
            manifest["notes_zh"].append(
                f"建議強度 {strength}"
            )  # i18n-ignore: manifest note
        keys = [tuple(k) for k in job["placement"]["register"]]
        run = await self._run_once(
            job,
            "register",
            "register",
            lambda: rq.register_request(
                job, keys, t["loras"][str(step)], manifest, candidate=False
            ),
        )
        if run is None:
            return
        job["registered"] = {
            "lora_id": lora_id,
            "step": step,
            "strength": strength,
            "nodes": {
                s["outputs"]["registered"]["value"]["node_id"]: s["outputs"][
                    "registered"
                ]["value"]["manifest_path"]
                for s in run["steps"].values()
            },
        }
        job["status"] = "completed"
        job["phase"] = "registered"
        event(job, "registered", lora_id=lora_id)
        await self.save(job)

    async def _phase_done(self, job: Doc) -> None:
        del job  # nothing left to do


def _age_s(stamp: str) -> float:
    try:
        then = datetime.fromisoformat(stamp)
    except ValueError:
        return 0.0
    return (datetime.now(UTC) - then).total_seconds()


def _step_error(run: Doc) -> Doc:
    """The first failed step's error (its details carry the trainer's stop status), else the run's."""
    for step in (run.get("steps") or {}).values():
        if step.get("state") == "failed" and step.get("error"):
            return dict(step["error"])
    return dict(run.get("error") or {})


def _clip_rows(dataset: Doc, chosen: Doc, reviews: Doc) -> list[Doc]:
    """One row per extracted clip for the review screen: status, reason, caption, sheet, masked overlays."""
    train = {t["clip_id"]: t for t in chosen["train"]}
    held = {h["clip_id"]: h for h in chosen["heldout"]}
    rows = []
    for clip in dataset["clips"]:
        cid = clip["clip_id"]
        status = "train" if cid in train else "heldout" if cid in held else "rejected"
        chosen_clip = train.get(cid) or held.get(cid) or {}
        caption = chosen_clip.get("caption")
        masks = chosen_clip.get("loss_masks") or clip.get("loss_masks") or []
        if caption is None:
            caption = ((reviews.get(cid) or {}).get("parsed") or {}).get("caption")
        rows.append(
            {
                "clip_id": cid,
                "source_id": clip["source_id"],
                "role": clip["role"],
                "status": status,
                "reason": chosen["rejected"].get(cid),
                "caption": caption,
                "sheet": clip.get("sheet"),
                "start_seconds": clip.get("start_seconds"),
                "masks": sorted({str(m.get("reason")) for m in masks}),
            }
        )
    return rows


def _options(raw: Doc) -> Doc:
    """Job options with every default filled in."""
    defaults: Doc = {
        "review_before_training": False,
        "strengths": list(plan.DEFAULT_STRENGTHS),
        "early_compare_step": 150,
        "eval_count": 3,
        "eval_prompts": [],
        "eval_routes": [],
        "eval_width": 1280,
        "eval_height": 736,
        "eval_frames": 124,
        "seed": plan.DEFAULTS["seed"],
        "steps": None,
        "max_clips": 220,
        "max_source_share": 0.45,
        "caption_prefix": "",
        "allow_replace_idle_dit": True,
        "train_node_id": None,
        "max_auto_resumes": 3,
        **{
            k: plan.DEFAULTS[k]
            for k in ("rank", "alpha", "learning_rate", "sigma_min", "chunk_steps")
        },
    }
    out = {**defaults, **{k: v for k, v in raw.items() if v is not None}}
    out["strengths"] = plan.check_strengths(out["strengths"])
    return out


async def _act_start(self: LoraTrainings, job: Doc, body: Doc) -> None:
    del body
    if job["status"] != "review" or job["phase"] != "select":
        raise ComponentError(
            "STATE_CONFLICT", "這個訓練工作不在等待開始的狀態", status=409
        )
    job["status"] = "running"
    self._start_training_phase(job)


async def _act_cancel(self: LoraTrainings, job: Doc, body: Doc) -> None:
    del self, body
    if job["status"] in ("completed", "failed", "cancelled"):
        raise ComponentError("STATE_CONFLICT", "這個訓練工作已經結束", status=409)
    job["status"] = "stopping"
    event(job, "cancel_requested")


async def _act_resume(self: LoraTrainings, job: Doc, body: Doc) -> None:
    del self, body
    if job["status"] != "paused":
        raise ComponentError("STATE_CONFLICT", "只有暫停的訓練工作可以繼續", status=409)
    job["status"] = "running"
    job["error"] = None
    if job.get("training"):
        job["training"]["auto_resumes"] = 0
    event(job, "resumed")


async def _act_stop_training(self: LoraTrainings, job: Doc, body: Doc) -> None:
    del body
    t = job.get("training")
    if t is None or job["phase"] not in ("train", "compare") or not t["loras"]:
        raise ComponentError("STATE_CONFLICT", "還沒有可以比較的 LoRA", status=409)
    t["stop_requested"] = True
    for rec in job["runs"]:
        if (
            rec["phase"] == "train"
            and rec["state"] not in TERMINAL
            and not rec.get("cancel_requested")
        ):
            rec["cancel_requested"] = True
            with contextlib.suppress(ComponentError):
                await self.ctl.runner.cancel(rec["run_id"])
    if job["phase"] == "train" and job["status"] == "paused":
        job["status"] = "running"
    event(job, "stop_training", step=max(int(s) for s in t["loras"]))


async def _act_decide(self: LoraTrainings, job: Doc, body: Doc) -> None:
    if job["phase"] != "decide":
        raise ComponentError("STATE_CONFLICT", "比較還沒完成", status=409)
    choice = body.get("choice")
    job["decision"] = {
        "choice": choice,
        "strength": body.get("strength"),
        "at": utc_now(),
    }
    if choice == "keep":
        job["status"], job["phase"] = "running", "register"
    else:
        job["status"], job["phase"] = "completed", "discarded"
    event(job, "decided", choice=choice)
    await self._remove_eval_components(job)


_ACTIONS = {
    "start_training": _act_start,
    "cancel": _act_cancel,
    "resume": _act_resume,
    "stop_training": _act_stop_training,
    "decide": _act_decide,
}
_PHASES = {
    "clips": LoraTrainings._phase_clips,
    "review": LoraTrainings._phase_review,
    "select": LoraTrainings._phase_select,
    "encode": LoraTrainings._phase_encode,
    "train": LoraTrainings._phase_train,
    "compare": LoraTrainings._phase_compare,
    "decide": LoraTrainings._phase_decide,
    "register": LoraTrainings._phase_register,
    "registered": LoraTrainings._phase_done,
    "discarded": LoraTrainings._phase_done,
}

__all__ = ["LoraTrainings"]
