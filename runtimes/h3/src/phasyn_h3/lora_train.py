"""``h3.lora_train``: train a style or motion LoRA on the plain H3 Ref2VA DiT, one resumable chunk per call.

Load: the Ref2VA transformer from ``<model_path>`` with its block linears stored as W8 (see
:mod:`.recipe.runtime.training.model`), the allocator cap, the SDPA probe, gradient checkpointing per block.
Nothing is loaded from the network; the weights stay resident across calls and jobs.

Invoke: ``encodings`` (``lora.encodings.v1``) names, per training clip, the clip video, its h3.conditioning
bundle and its video-reference partial, plus one audio partial of silence. The first call of a job turns them
into training samples (the clip's latents come from the pinned video VAE encoder) in the job's state
directory ``<data_dir>/lora-training/<job_key>/``; every call trains from the newest checkpoint there to
``until_step`` and outputs the LoRA of that step (PEFT, diffusers names) and a report. A call that stops early
(cancel, deadline, heat, memory) has saved a checkpoint; the next call with the same job continues it, also
after a Node restart. Different settings or data for an existing job are refused instead of resumed.

Host services that must be active before training (an installation's clock or core limits) are listed in
``provider_options.required_units``; the trainer refuses to start while one is inactive.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import re
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any, override

from phasyn_components.errors import Cancelled, ComponentError
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Port,
    RunContext,
    UnloadContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording

from . import references
from .recipe.adapter import training_rules as rules


ENCODINGS = "lora.encodings.v1"
LORA_FILE = "h3.lora.peft.v1"
REPORT = "lora.training_report.v1"
JOB_KEY = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
CLIP_FRAMES = 22
AUDIO_LATENT_HZ = 40
MAX_CLIPS = 4000
PREVIEW_W, PREVIEW_H = 960, 360
_INT = {"type": "integer"}
PARAMS: dict[str, dict[str, Any]] = {
    "job_key": {"type": "string", "pattern": JOB_KEY.pattern},
    "steps": {**_INT, "minimum": 1, "maximum": 20000},
    "until_step": {**_INT, "minimum": 1, "maximum": 20000},
    "rank": {**_INT, "minimum": 1, "maximum": 128, "default": 16},
    "alpha": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1024,
        "default": 16.0,
    },
    "learning_rate": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 0.01,
        "default": 1e-4,
    },
    "warmup_steps": {**_INT, "minimum": 0, "maximum": 2000, "default": 20},
    "window_latent_frames": {**_INT, "minimum": 1, "maximum": 6, "default": 3},
    "timestep_bins": {**_INT, "minimum": 1, "maximum": 64, "default": 16},
    "sigma_min": {"type": "number", "minimum": 0, "maximum": 0.99, "default": 0.0},
    "seed": {**_INT, "minimum": 0, "default": 20261121},
    "checkpoint_seconds": {
        "type": "number",
        "minimum": 60,
        "maximum": 3600,
        "default": 600,
    },
}
OPTIONS: dict[str, Any] = {
    "transformer_dir": {"type": "string", "default": "MiniMax-H3/Ref2VA/transformer"},
    "vae_dir": {"type": "string", "default": "MiniMax-H3/Ref2VA/video_vae"},
    "w8_group": {**_INT, "minimum": 0, "maximum": 4096, "default": 128},
    "cuda_cap_gib": {"type": "number", "minimum": 8, "maximum": 1024, "default": 40},
    "adaln_max_plans": {**_INT, "minimum": 1, "maximum": 64, "default": 16},
    "self_stop_gib": {"type": "number", "minimum": 0, "maximum": 256, "default": 12},
    "required_units": {
        "type": "array",
        "items": {"type": "string", "pattern": r"^[A-Za-z0-9@_.-]{1,128}$"},
        "maxItems": 8,
        "default": [],
    },
    "thermal": {
        "type": "object",
        "properties": {
            k: {"type": "number", "minimum": 0}
            for k in (
                "start_soc",
                "resume_soc",
                "resume_gpu",
                "poll_seconds",
                "max_pause_seconds",
                "save_every_seconds",
            )
        },
        "additionalProperties": False,
    },
}
TARGETS = ("qkv", "out", "fc1", "fc2")


def _missing_runtime() -> str | None:
    missing = [
        m
        for m in ("torch", "sglang", "safetensors", "PIL")
        if importlib.util.find_spec(m) is None
    ]
    return f"此 runtime 沒有安裝 {', '.join(missing)}" if missing else None


def _options(load: Mapping[str, Any]) -> dict[str, Any]:
    raw = dict(load.get("provider_options") or {})
    return {k: raw.get(k, spec.get("default")) for k, spec in OPTIONS.items()}


def _under(root: Path, rel: str) -> Path:
    path = (root / rel).resolve()
    if root.resolve() not in path.parents:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED", "模型子目錄必須在 load.model_path 之內"
        )
    return path


def _model_problem(load: Mapping[str, Any]) -> str | None:
    root = Path(str(load.get("model_path") or ""))
    if not root.is_absolute() or not root.is_dir():
        return "load.model_path 必須是存在的模型目錄"
    opts = _options(load)
    if not (_under(root, opts["transformer_dir"]) / "config.json").is_file():
        return "找不到 Ref2VA transformer（provider_options.transformer_dir）"
    if not (_under(root, opts["vae_dir"]) / "source" / "model.safetensors").is_file():
        return "找不到 video VAE（provider_options.vae_dir）"
    return None


def _params(ctx: RunContext) -> dict[str, Any]:
    unknown = set(ctx.parameters) - PARAMS.keys()
    if unknown:
        raise ComponentError(
            "INVALID_ARGUMENT", f"不支援的參數：{', '.join(sorted(unknown))}"
        )
    out = {k: ctx.parameters.get(k, spec.get("default")) for k, spec in PARAMS.items()}
    for key in ("job_key", "steps", "until_step"):
        if out[key] is None:
            raise ComponentError("INVALID_ARGUMENT", f"缺少參數 {key}")
    if not JOB_KEY.fullmatch(str(out["job_key"])) or int(str(out["until_step"])) > int(
        str(out["steps"])
    ):
        raise ComponentError("INVALID_ARGUMENT", "job_key 無效或 until_step 大於 steps")
    out["targets"] = ",".join(TARGETS)
    return out


def _decode_clip(path: Path, width: int, height: int) -> Any:
    import numpy as np  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

    exe = shutil.which("ffmpeg")
    if exe is None:
        raise ComponentError("PROVIDER_NOT_INSTALLED", "找不到 ffmpeg")
    size = width * height * 3
    run = subprocess.run(  # noqa: S603 - fixed argv; the input is a resolved local file
        [
            exe,
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(path),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        capture_output=True,
        timeout=600,
        check=False,
    )
    if run.returncode or len(run.stdout) != CLIP_FRAMES * size:
        raise ComponentError("INVALID_ARGUMENT", "訓練片段影片無法解碼成 22 格")
    return np.frombuffer(run.stdout, np.uint8).reshape(CLIP_FRAMES, height, width, 3)


def _bundle_paths(ctx: RunContext, ref: Mapping[str, Any]) -> tuple[Path, Path]:
    link = ((ref.get("metadata") or {}).get("links") or {}).get("payload")
    if not isinstance(link, Mapping):
        raise ComponentError("INVALID_ARGUMENT", "bundle 缺少 payload 附檔")
    return ctx.resolve_file(ref), ctx.resolve_file(link)


def _chart(curve: list[dict[str, float]], note: str) -> bytes:
    """A small dark loss chart (PNG) for the call's preview."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (PREVIEW_W, PREVIEW_H), (12, 16, 28))
    draw = ImageDraw.Draw(img)
    if len(curve) >= 2:  # noqa: PLR2004 - a line needs two points
        losses = [p["loss"] for p in curve]
        lo, hi = min(losses), max(losses)
        span = (hi - lo) or 1.0
        pts = [
            (
                24 + i * (PREVIEW_W - 48) / (len(curve) - 1),
                PREVIEW_H - 40 - (v - lo) / span * (PREVIEW_H - 90),
            )
            for i, v in enumerate(losses)
        ]
        draw.line(pts, fill=(64, 220, 255), width=3)
    draw.text((24, 16), note, fill=(230, 236, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _hooks(
    loop: Any, ctx: RunContext, trainer_ref: dict[str, Any], total: int, steps: int
) -> Any:
    """The loop's side effects: log lines, a preview per step and a sign of life outside steps."""

    def preview(step: int, note: str) -> None:
        if not ctx.preview_enabled:
            return
        ctx.publish_preview(
            step=min(step, total),
            total=total,
            data=_chart(trainer_ref["t"].loss_curve(), note),
            media_type="image/png",
            width=PREVIEW_W,
            height=PREVIEW_H,
            note=note,
        )

    def progress(rec: Mapping[str, Any]) -> None:
        note = f"第 {rec['step'] + 1}/{steps} 步・loss {rec['loss']:.4f}・{rec['seconds']:.0f} 秒/步"
        preview(rec["step"] + 1, note)

    return loop.Hooks(
        log=lambda msg: ctx.recorder.log("info", msg),
        progress=progress,
        heartbeat=lambda note: preview(trainer_ref["t"].step, note),
        cancelled=ctx.cancelled,
        remaining=ctx.remaining_seconds,
    )


class LoraTrainProvider(BaseProvider):
    """Resumable LoRA training chunks on a resident W8 H3 Ref2VA DiT."""

    provider_id = "h3.lora_train"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Ports and settings; the model files are checked without loading anything."""
        reason = _missing_runtime()
        code = "PROVIDER_NOT_INSTALLED" if reason else None
        if reason is None and settings is not None:
            reason = _model_problem(settings.get("load") or {})
            code = "COMPONENT_NOT_CONFIGURED" if reason else None
        return Description(
            provider_id=cls.provider_id,
            kind="lora.train",
            label="H3 LoRA 訓練（Ref2VA 原始權重、W8 凍結底模、可續訓）",
            inputs=[
                Port(
                    "encodings",
                    ENCODINGS,
                    required=True,
                    transport="file",
                    description="lora.encodings.v1：每段的影片、文字條件與參考編碼",
                )
            ],
            outputs=[
                Port(
                    "lora",
                    LORA_FILE,
                    required=True,
                    transport="file",
                    description="這一段結束時的 LoRA（PEFT、diffusers 名稱）",
                ),
                Port(
                    "report",
                    REPORT,
                    required=True,
                    transport="inline",
                    description="訓練報告：步數、loss 曲線、熱暫停與停止原因",
                ),
            ],
            settings_schema=settings_schema(
                invoke_properties=PARAMS,
                provider_options=OPTIONS,
                require_model_path=True,
                device_kinds=("cuda",),
            ),
            parameters_schema={
                "type": "object",
                "properties": PARAMS,
                "required": ["job_key", "steps", "until_step"],
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "model_path": "<models-dir>",
                    "device": {
                        "kind": "cuda",
                        "id": "GPU-REPLACE",
                        "resource_group": "gpu",
                    },
                    "provider_options": {},
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "summary"}),
            },
            available=reason is None
            or (settings is None and code != "PROVIDER_NOT_INSTALLED"),
            unavailable_code=code,
            unavailable_reason=reason,
        )

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Load the frozen W8 DiT once; LoRA layers are added per job."""
        from .recipe.runtime.training import model as m  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        load = ctx.load
        problem = _model_problem(load)
        if problem:
            raise ComponentError("COMPONENT_NOT_CONFIGURED", problem)
        self.opts = _options(load)
        self.root = Path(str(load["model_path"]))
        observed: dict[str, Any] = {
            "cuda_cap": m.set_cuda_cap(float(self.opts["cuda_cap_gib"]))
        }
        observed["sdpa"] = m.configure_cuda_sdpa()
        with ctx.recorder.phase("load"):
            self.rt = m.init_runtime(Path(self.host.work_dir) / "rt")
            m.patch_autograd_safe(self.rt)
            self.model, stats = m.load_w8_model(
                self.rt,
                _under(self.root, self.opts["transformer_dir"]),
                w8_group=int(self.opts["w8_group"]),
                adaln_max_plans=int(self.opts["adaln_max_plans"]),
                log=lambda msg: ctx.recorder.log("info", msg),
            )
            m.bind_sdpa(self.rt, self.model)
            m.enable_checkpointing(self.model, range(len(self.model.blocks)))
        observed["load"] = stats
        self.active: tuple[Any, ...] | None = None
        return LoadResult(
            effective_load=load, observed=observed, expanded_parts=ctx.expanded_parts
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Drop the model and free device memory."""
        import torch

        del ctx
        self.model = None
        torch.cuda.empty_cache()

    # -- invoke ---------------------------------------------------------------------------------------------------
    def _encodings(self, ctx: RunContext) -> dict[str, Any]:
        doc = json.loads(
            ctx.input("encodings").require_path("encodings").read_text(encoding="utf-8")
        )
        if not isinstance(doc, Mapping) or doc.get("schema") != ENCODINGS:
            raise ComponentError(
                "INVALID_ARGUMENT", "encodings 必須是 lora.encodings.v1"
            )
        clips = doc.get("clips") or []
        if not 0 < len(clips) <= MAX_CLIPS or not doc.get("silence_audio"):
            raise ComponentError("INVALID_ARGUMENT", "encodings 需要訓練片段與靜音參考")
        return dict(doc)

    def _silence(self, ctx: RunContext, doc: Mapping[str, Any]) -> Any:
        from safetensors import safe_open

        manifest, payload = _bundle_paths(ctx, doc["silence_audio"])
        part = references.load_partial(manifest, payload, scope="audio")
        if part.payload is None:
            raise ComponentError("INVALID_ARGUMENT", "靜音參考沒有 audio latent")
        with safe_open(str(part.payload), framework="pt", device="cpu") as h:
            names = list(h.keys())
            if len(names) != 1:
                raise ComponentError(
                    "INVALID_ARGUMENT", "靜音參考應只有一個 audio tensor"
                )
            audio = h.get_tensor(names[0]).float()
        keep = -(-CLIP_FRAMES * AUDIO_LATENT_HZ // 24)
        if audio.dim() != 4 or audio.shape[2] < keep:  # noqa: PLR2004 - [1, 2, T, 32]
            raise ComponentError("INVALID_ARGUMENT", "靜音參考的 audio latent 形狀不符")
        return audio[:, :, :keep].contiguous()

    def _samples(
        self, ctx: RunContext, doc: Mapping[str, Any], state: Path
    ) -> list[tuple[Path, str]]:
        """Build missing sample files (target latents encoded once) and return (path, source) per clip."""
        from .recipe.runtime.training import samples as s, target  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        out_dir = state / "samples"
        out_dir.mkdir(parents=True, exist_ok=True)
        todo = [
            c
            for c in doc["clips"]
            if not (out_dir / f"{c['clip_id']}.safetensors").exists()
        ]
        if todo:
            silence = self._silence(ctx, doc)
            encoder = target.TargetEncoder(
                _under(self.root, self.opts["vae_dir"]), self.rt.device
            )
            try:
                for n, clip in enumerate(todo):
                    ctx.check_cancelled()
                    frames = _decode_clip(
                        ctx.resolve_file(clip["video"]),
                        int(doc["width"]),
                        int(doc["height"]),
                    )
                    latents = encoder.encode(frames)
                    vman, vpay = _bundle_paths(ctx, clip["video_references"])
                    video = references.load_partial(vman, vpay, scope="visual")
                    merged = references.merge_partials(
                        video, None, out_dir=state / "merge", task="ref2va"
                    )
                    s.assemble(
                        name=str(clip["clip_id"]),
                        conditioning=_bundle_paths(ctx, clip["conditioning"]),
                        references=(
                            merged.manifest_path,
                            merged.payload_path,
                            merged.artifact_id,
                        ),
                        target_video=latents,
                        target_audio=silence,
                        loss_masks=clip.get("loss_masks") or [],
                        out=out_dir / f"{clip['clip_id']}.safetensors",
                    )
                    if ctx.preview_enabled:
                        note = f"準備訓練資料 {n + 1}/{len(todo)}"
                        ctx.publish_preview(
                            step=n + 1,
                            total=len(todo),
                            data=_chart([], note),
                            media_type="image/png",
                            width=PREVIEW_W,
                            height=PREVIEW_H,
                            note=note,
                        )
            finally:
                encoder.close()
        return [
            (out_dir / f"{c['clip_id']}.safetensors", str(c["source_id"]))
            for c in doc["clips"]
        ]

    def _adapter(self, params: Mapping[str, Any]) -> None:
        from .recipe.runtime.training import model as m  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        key = (params["job_key"], int(params["rank"]), float(params["alpha"]))
        if self.active == key:
            return
        m.remove_lora(self.model)
        self.rt.torch.manual_seed(int(params["seed"]))
        m.inject_lora(
            self.model,
            rank=int(params["rank"]),
            alpha=float(params["alpha"]),
            targets=TARGETS,
            blocks=range(len(self.model.blocks)),
        )
        self.active = key

    def invoke(self, ctx: RunContext) -> None:
        """Train one chunk of a job and publish its LoRA and report."""
        from .recipe.runtime.training import export, loop, model as m, thermal  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        params = _params(ctx)
        if int(params["timestep_bins"]) > int(self.opts["adaln_max_plans"]):
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "timestep_bins 超過此元件的 adaln_max_plans",
                status=422,
            )
        inactive = thermal.inactive_units(list(self.opts["required_units"]))
        if inactive:
            raise ComponentError(
                "COMPONENT_NOT_READY",
                f"訓練前需要的主機服務沒有啟動：{', '.join(inactive)}",
            )
        doc = self._encodings(ctx)
        state = Path(self.host.data_dir) / "lora-training" / str(params["job_key"])
        state.mkdir(parents=True, exist_ok=True)
        sample_paths = self._samples(ctx, doc, state)
        digest = hashlib.sha256(
            json.dumps(
                sorted(
                    (c["clip_id"], c["video"]["sha256"], c["conditioning"]["sha256"])
                    for c in doc["clips"]
                )
            ).encode()
        ).hexdigest()
        params["w8_group"] = int(self.opts["w8_group"])
        self._adapter(params)
        th = rules.Thermal(**(self.opts.get("thermal") or {}))
        gates = loop.Gates(thermal=th, self_stop_gib=float(self.opts["self_stop_gib"]))
        total = int(params["until_step"])
        trainer_ref: dict[str, Any] = {}
        hooks = _hooks(loop, ctx, trainer_ref, total, int(params["steps"]))
        trainer = loop.Trainer(
            self.rt,
            self.model,
            sample_paths,
            params,
            state,
            gates=gates,
            hooks=hooks,
            samples_digest=digest,
        )
        trainer_ref["t"] = trainer
        if not trainer.resume():
            m.reset_lora(self.model, int(params["seed"]))
        trainer.precompute_refined()
        result = (
            trainer.run(total)
            if trainer.step < total
            else {
                "status": loop.COMPLETE,
                "reason": "already trained",
                "step": trainer.step,
            }
        )
        if result["status"] in (loop.VOID, loop.DIVERGED):
            raise ComponentError(
                "RUNTIME_ERROR",
                f"訓練停止：{result['reason']}",
                details={"status": result["status"], "step": result["step"]},
            )
        if result["reason"] == "cancelled":
            raise Cancelled("取消要求（已存檔，可續訓）")
        peft = state / f"lora_step{trainer.step:05d}.safetensors"
        export.write_peft(
            m.lora_state(self.model),
            peft,
            rank=int(params["rank"]),
            alpha=float(params["alpha"]),
            notes={
                "phasyn_training": json.dumps(
                    {"job": params["job_key"], "step": trainer.step}
                )
            },
        )
        out = ctx.new_file(
            "lora",
            "application/octet-stream",
            {
                "step": trainer.step,
                "rank": int(params["rank"]),
                "alpha": float(params["alpha"]),
            },
        )
        with peft.open("rb") as handle:
            while block := handle.read(1 << 20):
                out.write(block)
        ctx.set_file_output("lora", out)
        ctx.set_output(
            "report",
            {
                "schema": REPORT,
                **result,
                "total_steps": int(params["steps"]),
                "train_samples": len(sample_paths),
                "loss_curve": trainer.loss_curve(),
                "parameters": {k: params[k] for k in PARAMS if k != "job_key"},
            },
        )


__all__ = ["LoraTrainProvider"]
