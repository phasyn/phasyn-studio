"""The resumable LoRA training loop (torch, lazily imported).

Every step draws a source uniformly, a sample of it, a window of ``k`` latent frames and a timestep bin; the
noise generator is seeded from (seed, step), so a resumed run continues the identical sequence of draws.

A checkpoint (LoRA factors, AdamW state, scheduler, Python and torch RNG, step, counters, loss history) is
written at least every ``checkpoint_seconds``, at the end of a chunk and whenever the run pauses; the newest
two are kept. A run resumes automatically from its state directory when the training identity
(:func:`args_digest`) matches, and refuses otherwise.

Stop rules: a non-finite loss or gradient norm stops the run as ``void``; a gradient norm above the limit on
several consecutive steps as ``diverged``; an AdaLN cache rebuild after the first step as ``void`` (it would
stream the projection again); low host memory, a long thermal pause, the call deadline or a cancel request
save a checkpoint and pause it (resumable).
"""

from __future__ import annotations

import json
import math
import random
import time
import types
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_h3.recipe.adapter import training_rules as rules

from . import (
    model as M,  # noqa: N812 - short module alias
    samples as S,  # noqa: N812 - short module alias
    thermal,
)


COMPLETE, PAUSED, VOID, DIVERGED = "complete", "paused", "void", "diverged"
HEARTBEAT_S = 60.0
KEEP_CHECKPOINTS = 2
DEADLINE_MARGIN_S = 240.0
HISTORY_BUCKET = 10


@dataclass
class Gates:
    """The non-training knobs of a run: thermal, memory, gradient and deadline rules."""

    thermal: rules.Thermal = field(default_factory=rules.Thermal)
    self_stop_gib: float = 12.0
    grad_clip: float = 1.0
    gnorm_limit: float = 20.0
    gnorm_run: int = 5
    audio_weight: float = 0.0


@dataclass
class Hooks:
    """Side effects the loop calls: logging, progress, cancel and deadline, temperature reading, sleep."""

    log: Callable[[str], None] = print
    progress: Callable[[dict[str, Any]], None] = lambda _rec: None
    # a sign of life outside optimizer steps (preparing text rows, waiting for cooling), at most every HEARTBEAT_S
    heartbeat: Callable[[str], None] = lambda _note: None
    cancelled: Callable[[], bool] = lambda: False
    remaining: Callable[[], float] = lambda: math.inf
    temps: Callable[[], tuple[float | None, float | None]] = lambda: (
        thermal.soc_celsius(),
        thermal.gpu_celsius(),
    )
    memory: Callable[[], float | None] = thermal.mem_available_gib
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], float] = time.time


class Trainer:
    """One job's training state on a loaded model; ``run(until)`` trains one chunk."""

    def __init__(  # noqa: PLR0913 - the loop's independent parts
        self,
        rt: types.SimpleNamespace,
        model: Any,
        sample_paths: Sequence[tuple[Path, str]],
        params: Mapping[str, Any],
        state_dir: Path,
        *,
        gates: Gates,
        hooks: Hooks,
        samples_digest: str,
    ) -> None:
        """``sample_paths`` is (sample file, source id) per training sample."""
        torch = rt.torch
        self.rt, self.model, self.params, self.dir = rt, model, dict(params), state_dir
        self.gates, self.hooks = gates, hooks
        self.samples: list[dict[str, Any]] = [
            {"path": p, "source": s, "meta": S.read_meta(p)} for p, s in sample_paths
        ]
        self.by_source: dict[str, list[int]] = {}
        for i, item in enumerate(self.samples):
            self.by_source.setdefault(item["source"], []).append(i)
        self.digest = rules.args_digest(self.params, samples_digest=samples_digest)
        self.grid = rules.timestep_grid(
            int(params["timestep_bins"]), sigma_min=float(params["sigma_min"])
        )
        self.lora = M.lora_parameters(model)
        self.opt = torch.optim.AdamW(
            self.lora,
            lr=float(params["learning_rate"]),
            betas=(0.9, 0.999),
            weight_decay=0.0,
            eps=1e-8,
            fused=True,
        )
        warmup = int(params["warmup_steps"])
        self.sched = torch.optim.lr_scheduler.LambdaLR(
            self.opt, lambda s: rules.lr_scale(s, warmup)
        )
        self.rng = random.Random(int(params["seed"]))  # noqa: S311 - reproducible draws, not security
        self.step = 0
        self.counters: dict[str, Any] = {"gnorm_run": 0, "adaln_rebuilds_first": None}
        self.history: list[dict[str, Any]] = []
        self.thermal_stats: dict[str, Any] = {
            "pauses": 0,
            "paused_s": 0.0,
            "max_soc_c": None,
            "max_gpu_c": None,
        }
        self.refined: dict[int, Path] = {}
        self.last_save = -math.inf
        (self.dir / "ckpt").mkdir(parents=True, exist_ok=True)

    # -- state ---------------------------------------------------------------------------------------------------
    def _state(self) -> dict[str, Any]:
        torch = self.rt.torch
        return {
            "schema": rules.CKPT_SCHEMA,
            "step": self.step,
            "lora": M.lora_state(self.model),
            "opt": self.opt.state_dict(),
            "sched": self.sched.state_dict(),
            "py_rng": self.rng.getstate(),
            "torch_rng": torch.get_rng_state(),
            "counters": dict(self.counters),
            "digest": self.digest,
            "history": self.history,
            "thermal": dict(self.thermal_stats),
        }

    def resume(self) -> bool:
        """Load the newest checkpoint of this state directory; False when there is none."""
        latest = self.dir / "ckpt" / "latest.json"
        if not latest.exists():
            return False
        name = json.loads(latest.read_text())["file"]
        st = self.rt.torch.load(
            self.dir / "ckpt" / name, map_location="cpu", weights_only=False
        )
        if st.get("schema") != rules.CKPT_SCHEMA or st.get("digest") != self.digest:
            raise RuntimeError(
                "the checkpoint was written for other training settings or data; not resuming"
            )
        M.load_lora_state(self.model, st["lora"])
        self.opt.load_state_dict(st["opt"])
        self.sched.load_state_dict(st["sched"])
        self.rng.setstate(st["py_rng"])
        self.rt.torch.set_rng_state(st["torch_rng"])
        self.step, self.counters, self.history = (
            int(st["step"]),
            dict(st["counters"]),
            list(st["history"]),
        )
        self.thermal_stats.update(st.get("thermal") or {})
        self.hooks.log(f"resumed from {name} at step {self.step}")
        return True

    def save(self, tag: str) -> Path:
        """Write a checkpoint atomically, point ``latest.json`` at it and keep the newest two."""
        d = self.dir / "ckpt"
        path = d / f"step{self.step:05d}.pt"
        tmp = path.with_suffix(".pt.part")
        self.rt.torch.save(self._state(), tmp)
        tmp.replace(path)
        pointer = d / "latest.json.part"
        pointer.write_text(
            json.dumps({"step": self.step, "file": path.name, "tag": tag})
        )
        pointer.replace(d / "latest.json")
        for old in sorted(d.glob("step*.pt"))[:-KEEP_CHECKPOINTS]:
            old.unlink(missing_ok=True)
        self.last_save = self.hooks.now()
        return path

    # -- data -----------------------------------------------------------------------------------------------------
    def _sample(self, i: int) -> dict[str, Any]:
        return S.load(self.samples[i]["path"])

    def precompute_refined(self) -> None:
        """Refined text rows of every sample (text is never cropped), cached on disk next to the checkpoints."""
        rdir = self.dir / "refined"
        rdir.mkdir(parents=True, exist_ok=True)
        torch = self.rt.torch
        k = int(self.params["window_latent_frames"])
        beat = self.hooks.now()
        for i, item in enumerate(self.samples):
            f = rdir / f"{item['path'].stem}.pt"
            if not f.exists():
                prep = S.prepare(self.rt, self._sample(i), self.model, w0=0, k=k)
                tmp = f.with_suffix(".part")
                torch.save(
                    prep.branch.static_kwargs["prompt_embeds"].detach().cpu(), tmp
                )
                tmp.replace(f)
                if self.hooks.now() - beat >= HEARTBEAT_S:
                    beat = self.hooks.now()
                    self.hooks.heartbeat(
                        f"準備文字條件 {i + 1}/{len(self.samples)}"  # i18n-ignore: preview note
                    )
            self.refined[i] = f

    # -- one step -----------------------------------------------------------------------------------------------
    def _draw(self) -> tuple[int, int, int]:
        si = rules.draw_source(self.rng, self.by_source)
        k = int(self.params["window_latent_frames"])
        w0 = rules.draw_window(
            self.rng, int(self.samples[si]["meta"]["latent"]["t"]), k
        )
        gi = self.rng.randrange(len(self.grid))
        return si, w0, gi

    def one_step(self) -> dict[str, Any]:
        """One optimizer step; returns its record."""
        torch = self.rt.torch
        si, w0, gi = self._draw()
        refined = torch.load(
            self.refined[si], map_location=self.rt.device, weights_only=True
        )
        prep = S.prepare(
            self.rt,
            self._sample(si),
            self.model,
            w0=w0,
            k=int(self.params["window_latent_frames"]),
            refined_prompt=refined,
        )
        plans = S.timestep_plans(prep, self.grid)
        slots = (
            self.model.prepare_adaln_plans([p[0] for p in plans])
            if getattr(self.model, "adaln_cache", None)
            else None
        )
        rebuilds = getattr(getattr(self.model, "adaln_cache", None), "rebuilds", None)
        if self.counters["adaln_rebuilds_first"] is None:
            self.counters["adaln_rebuilds_first"] = rebuilds
        gen = torch.Generator(device=self.rt.device).manual_seed(
            int(self.params["seed"]) * 1000 + self.step
        )
        started = time.time()
        g = self.grid[gi]
        with self.rt.set_forward_context(current_timestep=0, attn_metadata=None):
            loss, st = S.flow_loss(
                self.rt,
                self.model,
                prep,
                plans[gi],
                None if slots is None else slots[gi],
                (g["sigma_v"], g["sigma_a"]),
                gen,
                self.gates.audio_weight,
            )
            loss.backward()
        gnorm = float(torch.nn.utils.clip_grad_norm_(self.lora, self.gates.grad_clip))
        value = float(loss.detach())
        finite = math.isfinite(value) and math.isfinite(gnorm)
        if finite:
            self.opt.step()
            self.sched.step()
        self.opt.zero_grad(set_to_none=True)
        torch.cuda.synchronize()
        rec = {
            "step": self.step,
            "sample": prep.name,
            "w0": w0,
            "gi": gi,
            "u": round(g["u"], 4),
            "loss": value,
            **st,
            "grad_norm": gnorm,
            "lr": self.opt.param_groups[0]["lr"],
            "seconds": round(time.time() - started, 3),
            "adaln_rebuilds": rebuilds,
            "finite": finite,
            **M.cuda_memory(),
        }
        self.step += 1
        self.counters["gnorm_run"] = (
            self.counters["gnorm_run"] + 1 if gnorm > self.gates.gnorm_limit else 0
        )
        self.history.append({"step": rec["step"], "gi": gi, "loss": value})
        return rec

    # -- gates --------------------------------------------------------------------------------------------------
    def _note_temps(self, soc: float | None, gpu: float | None) -> None:
        for key, v in (("max_soc_c", soc), ("max_gpu_c", gpu)):
            if v is not None:
                self.thermal_stats[key] = max(self.thermal_stats[key] or v, v)

    def thermal_gate(self) -> str | None:
        """Wait while the SoC is too hot to start a step; a reason string ends the chunk."""
        t = self.gates.thermal
        soc, gpu = self.hooks.temps()
        self._note_temps(soc, gpu)
        if not t.hot(soc):
            return None
        if self.hooks.now() - self.last_save >= t.save_every_seconds:
            self.save("thermal pause")
        self.hooks.log(f"thermal pause at step {self.step}: soc {soc} gpu {gpu}")
        t0 = beat = self.hooks.now()
        self.thermal_stats["pauses"] += 1
        reason: str | None = None
        while True:
            if self.hooks.cancelled():
                reason = "cancelled"
                break
            if self.hooks.now() - t0 >= t.max_pause_seconds:
                reason = "thermal timeout"
                break
            self.hooks.sleep(t.poll_seconds)
            soc, gpu = self.hooks.temps()
            self._note_temps(soc, gpu)
            if self.hooks.now() - beat >= HEARTBEAT_S:
                beat = self.hooks.now()
                self.hooks.heartbeat(
                    f"等待降溫（SoC {soc} °C）"  # i18n-ignore: preview note
                )
            if t.cool(soc, gpu):
                reason = None
                break
        waited = self.hooks.now() - t0
        self.thermal_stats["paused_s"] += waited
        self.hooks.log(
            f"thermal resume after {waited:.0f} s (soc {soc} gpu {gpu})"
            if reason is None
            else reason
        )
        return reason

    def _stop_reason(self, rec: dict[str, Any]) -> tuple[str, str] | None:
        if not rec["finite"]:
            return VOID, f"non-finite loss or gradient at step {rec['step']}"
        if self.counters["gnorm_run"] >= self.gates.gnorm_run:
            return (
                DIVERGED,
                f"gradient norm above {self.gates.gnorm_limit} on {self.gates.gnorm_run} steps",
            )
        first = self.counters["adaln_rebuilds_first"]
        if (
            first is not None
            and rec["adaln_rebuilds"] is not None
            and rec["adaln_rebuilds"] != first
        ):
            return VOID, "the AdaLN cache was rebuilt after the first step"
        memory = self.hooks.memory()
        if memory is not None and memory < self.gates.self_stop_gib:
            return PAUSED, f"host memory low ({memory:.1f} GiB available)"
        return None

    def _pre_step(self) -> str | None:
        if self.hooks.cancelled():
            return "cancelled"
        if self.hooks.remaining() < DEADLINE_MARGIN_S:
            return "call deadline"
        return self.thermal_gate()

    # -- loop ---------------------------------------------------------------------------------------------------
    def run(self, until: int) -> dict[str, Any]:
        """Train to step ``until`` (or until a gate stops the chunk) and save a checkpoint."""
        status, reason = COMPLETE, "chunk end"
        started = self.hooks.now()
        with (self.dir / "steps.jsonl").open("a", buffering=1) as steps:
            while self.step < until:
                why = self._pre_step()
                if why is not None:
                    status, reason = PAUSED, why
                    break
                rec = self.one_step()
                steps.write(json.dumps(rec) + "\n")
                self.hooks.progress(rec)
                stop = self._stop_reason(rec)
                if stop is not None:
                    status, reason = stop
                    break
                if self.hooks.now() - self.last_save >= float(
                    self.params["checkpoint_seconds"]
                ):
                    self.save("cadence")
        if status in (COMPLETE, PAUSED):
            self.save(reason)
        return {
            "status": status,
            "reason": reason,
            "step": self.step,
            "seconds": round(self.hooks.now() - started, 1),
            "thermal": {
                k: (round(v, 1) if isinstance(v, float) else v)
                for k, v in self.thermal_stats.items()
            },
            "drift": rules.drift_report(
                self.history, window=min(150, max(1, self.step // 2))
            ),
        }

    def loss_curve(self) -> list[dict[str, float]]:
        """Mean loss per bucket of :data:`HISTORY_BUCKET` steps (what a chart needs)."""
        out = []
        for start in range(0, len(self.history), HISTORY_BUCKET):
            part = self.history[start : start + HISTORY_BUCKET]
            out.append(
                {
                    "step": part[-1]["step"] + 1,
                    "loss": round(sum(h["loss"] for h in part) / len(part), 5),
                }
            )
        return out


__all__ = ["COMPLETE", "DIVERGED", "PAUSED", "VOID", "Gates", "Hooks", "Trainer"]
