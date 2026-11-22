"""Wan 2.1 VACE GPU providers with a single model call per submitted invocation."""

from __future__ import annotations

import time
from collections.abc import Mapping
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any, ClassVar, override

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import BaseProvider, Description, LoadResult
from phasyn_components.upstream import distribution_problem, library_versions
from phasyn_media.errors import MediaError
from phasyn_media.providers._failure import media_failure

from .conditioning import Conditioning, prepare
from .join import Joined, delivery, join
from .media import encode, inspect, rate
from .schema import DIFFUSERS_COMMIT, EDIT, GENERATE, describe, load_path
from .vram import check_free, measure_free, residency_of
from .weights import MODEL, plan, verified_snapshot


if TYPE_CHECKING:
    from phasyn_components.provider import LoadContext, RunContext, UnloadContext
    from phasyn_components.weights import WeightPlan
    from PIL import Image


class WanEditProvider(BaseProvider):
    """Edit a source interval or generate a control-driven shot in an isolated CUDA worker."""

    provider_id: ClassVar[str] = EDIT
    pipe: Any = None
    residency = "model_offload"
    options: Mapping[str, Any] | None = None

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Discover this provider without importing CUDA dependencies."""
        del settings
        return describe(cls.provider_id)

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """Expose the locally installable 17-file weight plan."""
        return plan(load_path(settings))

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Verify the exact local snapshot and load only official safetensors components."""
        path = load_path(ctx.settings)
        if path is None or ctx.load.get("model_revision") not in (None, MODEL.revision):
            raise ComponentError(
                "INVALID_ARGUMENT", "Configure the pinned Wan VACE Diffusers snapshot"
            )
        mismatch = distribution_problem("diffusers", vcs_commit=DIFFUSERS_COMMIT)
        if mismatch is not None:
            raise ComponentError("UPSTREAM_PATCH_SOURCE_MISMATCH", mismatch)
        torch = import_module("torch")
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise ComponentError(
                "RUNTIME_UNAVAILABLE", "Wan VACE requires a CUDA GPU with BF16 support"
            )
        diffusers = import_module("diffusers")
        self.options = dict(ctx.load.get("provider_options") or {})
        self.residency = residency_of(self.options)
        # Nothing of this process is on the card yet: refuse a load that cannot run next to the residents
        check = check_free(
            measure_free(torch), self.residency, self.options, when="載入"
        )
        ctx.recorder.log("info", "Wan VACE free-VRAM check", **check)
        with (
            ctx.recorder.phase("load"),
            verified_snapshot(Path(path), ctx.work_dir) as snapshot,
        ):
            vae = diffusers.AutoencoderKLWan.from_pretrained(
                snapshot,
                subfolder="vae",
                torch_dtype=torch.float32,
                local_files_only=True,
                use_safetensors=True,
            )
            pipe = diffusers.WanVACEPipeline.from_pretrained(
                snapshot,
                vae=vae,
                torch_dtype=torch.bfloat16,
                local_files_only=True,
                use_safetensors=True,
            )
            pipe.scheduler = diffusers.UniPCMultistepScheduler.from_config(
                pipe.scheduler.config, flow_shift=3.0
            )
            pipe.vae.enable_tiling()
            if self.residency == "model_offload":
                pipe.enable_model_cpu_offload(gpu_id=0)
            elif self.residency == "sequential_offload":
                pipe.enable_sequential_cpu_offload(gpu_id=0, device="cuda")
            else:
                pipe.to("cuda:0")
            self.pipe = pipe
        return LoadResult(
            effective_load=ctx.load,
            expanded_parts=ctx.expanded_parts,
            model_identity={"repo": MODEL.repo, "revision": MODEL.revision},
            runtime_identity={
                **library_versions(
                    ("torch", "diffusers", "transformers", "accelerate")
                ),
                "diffusers_commit": DIFFUSERS_COMMIT,
                "cuda": torch.version.cuda,
            },
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the instance's model and any CPU offload hooks."""
        with ctx.recorder.phase("unload"):
            if self.pipe is not None:
                self.pipe.remove_all_hooks()
            self.pipe = None

    def _generate(
        self, ctx: RunContext, job: Conditioning, settings: dict[str, Any]
    ) -> list[Image.Image]:
        prompt = ctx.input("prompt").value
        if not isinstance(prompt, str) or not prompt.strip():
            raise ComponentError(
                "INVALID_ARGUMENT", "Wan VACE requires a nonempty prompt"
            )
        torch = import_module("torch")
        last = time.monotonic()

        def step_end(
            _pipe: Any, step: int, _timestep: Any, callback_kwargs: dict[str, Any]
        ) -> dict[str, Any]:
            nonlocal last
            ctx.check_cancelled()
            now = time.monotonic()
            ctx.recorder.step(
                step, host_ms=(now - last) * 1000, scheduler_update_index=step
            )
            last = now
            return callback_kwargs

        ctx.check_cancelled()
        if self.residency != "gpu":
            # Offloaded weights are back on the host between calls, so free memory is what this call can use
            check = check_free(
                measure_free(torch), self.residency, self.options, when="生成"
            )
            ctx.recorder.log("info", "Wan VACE free-VRAM check", **check)
        completed = False
        try:
            with torch.inference_mode():
                frames = self.pipe(
                    prompt=prompt,
                    negative_prompt=settings["negative_prompt"],
                    video=job.frames,
                    mask=job.masks,
                    reference_images=[job.reference]
                    if job.reference is not None
                    else None,
                    height=job.canvas[1],
                    width=job.canvas[0],
                    num_frames=len(job.frames),
                    num_inference_steps=settings["steps"],
                    guidance_scale=settings["guidance"],
                    conditioning_scale=settings["conditioning_scale"],
                    output_type="pil",
                    generator=torch.Generator(device="cpu").manual_seed(
                        settings["seed"]
                    ),
                    callback_on_step_end=step_end,
                    callback_on_step_end_tensor_inputs=[],
                ).frames[0]
                completed = True
        finally:
            # Upstream releases hooks only on its success path. Cancellation must also offload the current stage.
            if not completed:
                if self.residency == "model_offload":
                    self.pipe.maybe_free_model_hooks()
                elif self.residency == "sequential_offload":
                    # A failed submodule forward can skip Accelerate's post-forward offload.
                    self.pipe.enable_sequential_cpu_offload(gpu_id=0, device="cuda")
        ctx.check_cancelled()
        if len(frames) != len(job.frames) or any(
            frame.size != job.canvas for frame in frames
        ):
            raise ComponentError(
                "INTEGRITY_MISMATCH",
                "VACE output differs from the planned geometry or padded length",
            )
        result: list[Image.Image] = frames[job.output.start : job.output.stop]
        if job.first_anchor is not None:
            result[0] = job.first_anchor
        if job.spatial_mask is not None:
            job.spatial_mask.composite(ctx, result)
        return result

    def _deliver(
        self, ctx: RunContext, work: Path, job: Conditioning, frames: list[Image.Image]
    ) -> Joined:
        """Encode the new footage alone, or the whole extended take (``deliver = joined``)."""
        if delivery(job.operation, dict(ctx.parameters)) == "joined":
            return join(
                ctx, work, inspect(ctx, "source"), frames, operation=job.operation
            )
        track = encode(ctx, work / "patch.mp4", frames, job.fps)
        return Joined(
            track.path,
            track.frames,
            track.width,
            track.height,
            track.sha256,
            track.size_bytes,
            has_audio=False,
            record={"deliver": "patch"},
        )

    def invoke(self, ctx: RunContext) -> None:
        """Publish the new footage (or the joined extended take) and its verified source-to-output mapping."""
        if self.pipe is None:
            raise ComponentError("COMPONENT_NOT_READY", "Load the Wan VACE model first")
        settings = {
            key: ctx.parameters.get(key, default)
            for key, default in {
                "steps": 30,
                "guidance": 5.0,
                "conditioning_scale": 1.0,
                "seed": 42,
                "negative_prompt": "",
            }.items()
        }
        ctx.work_dir.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=ctx.work_dir, prefix="wan-call-") as tmp:
            try:
                with ctx.recorder.phase("prepare"):
                    job = prepare(ctx, self.provider_id)
                    delivery(
                        job.operation, dict(ctx.parameters)
                    )  # refuse before the GPU work
                with ctx.recorder.phase("denoise"):
                    frames = self._generate(ctx, job, settings)
                with ctx.recorder.phase("encode"):
                    track = self._deliver(ctx, Path(tmp), job, frames)
            except MediaError as exc:
                raise media_failure(ctx, exc, what="Wan VACE 影片處理失敗") from exc
            ctx.check_cancelled()
            out = ctx.new_file(
                None,
                "video/mp4",
                {"role": "wan_vace", "operation": job.operation},
                type_id="media.video.v1",
            )
            out.adopt_file(track.path, sha256=track.sha256, size=track.size_bytes)
            actual = {
                **job.record(),
                **settings,
                "model": MODEL.repo,
                "revision": MODEL.revision,
                "diffusers_commit": DIFFUSERS_COMMIT,
                "scheduler": "UniPCMultistepScheduler",
                "flow_shift": 3.0,
                "residency": self.residency,
                "transformer_dtype": "bfloat16",
                "vae_dtype": "float32",
                "delivery": track.record,
            }
            if track.has_audio:
                actual["audio"] = "source_audio_kept_silence_for_new_frames"
            asset = {
                "asset_id": new_id(),
                "kind": "final",
                "file": ctx.file_ref(out),
                "source_latent": None,
                "complete": True,
                "frame_count": track.frames,
                "width": track.width,
                "height": track.height,
                "fps": rate(job.fps),
                "has_audio": track.has_audio,
                "actual_settings": {"wan_vace": actual},
            }
            contracts.validate(
                "Asset", asset, code="RUNTIME_ERROR", what="Wan VACE output"
            )
            ctx.check_cancelled()
            ctx.set_output("asset", asset)
            ctx.set_file_output("video_file", out)


class WanGenerateProvider(WanEditProvider):
    """Use the same offline model for Studio text-to-video and first-frame shots."""

    provider_id: ClassVar[str] = GENERATE
