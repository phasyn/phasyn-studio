"""``qimg.dit`` (kind dit.denoise): the Qwen-Image 2.1 DiT; the whole denoise loop runs inside one invoke.

``conditioning`` (qimg.conditioning.v1) + optional ``ref_latents`` (qimg.ref_latents.v1) + parameters → ``latent``
(qimg.latent.v1, packed latents in the normalized space, BF16). describe() lives in ``dit.describe`` and never imports
torch/diffusers; heavy imports happen in load()/invoke(). One component = one variant (bf16 or gguf_q4km) + one
explicit placement; no strategy is chosen automatically.
"""

from __future__ import annotations

import contextlib
import threading
import time
from collections.abc import Mapping
from typing import Any

from phasyn_components import upstream
from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    RunContext,
    UnloadContext,
)
from phasyn_components.weights import WeightPlan

from ..config import diffusers_problem
from ..instrument import CallMemory
from ..memory import process_rss_bytes
from . import admission
from .describe import describe_dit, dit_parts
from .inputs import check_inputs
from .meta import dit_identity, latent_meta
from .options import (
    CONDITIONING_KIND,
    LATENT_KIND,
    PROVIDER_ID,
    REF_LATENTS_KIND,
    DitParams,
    configuration_problem,
    parse_options,
    parse_params,
    read_config,
    unsupported,
)
from .preview import PACKAGED_COEFFICIENTS, PreviewUnavailable

LIBRARIES = ("torch", "diffusers", "accelerate", "peft", "gguf", "safetensors", "numpy", "pillow")


class QimgDitProvider(BaseProvider):
    """``qimg.dit``: Qwen-Image 2.1 denoising.

    ETA work (``cost.stages``): ``denoise`` in ``pixel`` = steps x output width x height (shape: steps, width,
    height, ref_tokens, cfg, placement). Cost profiles are keyed by stage, so this never mixes with the VAE's
    per-image ``pixel``.
    """

    provider_id = PROVIDER_ID
    # allocator reading at the start of the current call's GPU work (None: no GPU work yet in this call)
    _call_memory: CallMemory | None = None

    # ------------------------------------------------------------------ describe
    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return describe_dit(settings)

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """The pinned Qwen-Image 2.1 directory the DiT reads; GGUF files and adapters stay user-supplied."""
        from ..weights import image_plan

        return image_plan("dit", settings)

    # ------------------------------------------------------------------ load
    def load(self, ctx: LoadContext) -> LoadResult:
        import torch
        from phasyn_components.recorder.gpu import AllocatorWindow, runtime_identity, torch_backend_flags

        from .loading import (
            checkpoint_bytes,
            load_adapters,
            load_transformer,
            model_identity,
            parameter_dtypes,
            tensor_storage_bytes,
        )
        from .placement import apply_load_placement
        from .preview import load_coefficients, load_preview_vae
        from .schedule import ScheduleError, scheduler_spec

        rec = ctx.recorder
        load = ctx.load
        opts = parse_options(load)
        mismatch = diffusers_problem()
        if mismatch is not None:
            raise ComponentError("PROVIDER_NOT_INSTALLED", mismatch)
        problem = configuration_problem(opts)
        if problem is not None:
            raise ComponentError(problem[0], problem[1])
        try:
            self.scheduler = scheduler_spec(read_config(opts.scheduler_config_path, opts.model_root))
        except ScheduleError as exc:
            raise unsupported(f"scheduler_config 不被支援：{exc}") from exc
        device = torch.device("cuda", 0) if opts.device_kind == "cuda" else torch.device("cpu")
        if device.type == "cuda" and not torch.cuda.is_available():
            raise ComponentError("RUNTIME_UNAVAILABLE", "CUDA 無法使用；請檢查 PyTorch 與驅動")
        file_bytes = checkpoint_bytes(opts)
        preload = admission.preload_ram_estimate(opts.placement, file_bytes=file_bytes)
        preload.available = admission.available_ram_bytes()
        if preload.available is None:
            preload.reason = "無法讀取 /proc/meminfo；未做主記憶體准入"
            rec.note(preload.reason)
        else:
            admission.require(preload)  # too little host memory → HOST_MEMORY_INSUFFICIENT
        self.opts = opts
        self.device = device
        self.dtype = torch.bfloat16
        allocator = AllocatorWindow(0) if device.type == "cuda" else None
        if allocator is not None:
            allocator.start()
        observed: dict[str, Any] = {"ram_preload_admission": preload.to_dict()}
        with rec.phase("load"):
            with rec.span("qimg.dit.load_transformer", part="transformer"):
                transformer = load_transformer(opts, dtype=self.dtype)
            with rec.span("qimg.dit.load_adapters", part="transformer"):
                adapters = load_adapters(transformer, opts)
            with rec.span("qimg.dit.placement", part="transformer"):
                self.placement = apply_load_placement(
                    transformer,
                    mode=opts.placement,
                    device=device,
                    pin_memory=opts.pin_memory,
                    rec=rec,
                    memory_model=opts.memory_model,
                    unified_reserve_bytes=opts.unified_reserve_bytes,
                )
            self.transformer = transformer
            self.preview_vae: Any = None
            if opts.preview_vae:
                rss_before = process_rss_bytes()
                with rec.span("qimg.dit.load_preview_vae", part="preview"):
                    self.preview_vae = load_preview_vae(opts.vae_dir)
                vae_bytes = tensor_storage_bytes(self.preview_vae)
                rss_after = process_rss_bytes()
                observed["preview_vae"] = {
                    "loaded": True,
                    "device": "cpu",
                    "dtype": "float32",
                    "tensor_bytes": vae_bytes,
                    "rss_delta_bytes": None if rss_before is None or rss_after is None else rss_after - rss_before,
                }
                rec.set_metric(
                    "qimg.dit.preview_vae_host_bytes",
                    vae_bytes,
                    unit="bytes",
                    quality="derived",
                    scope="process",
                    method="tensor_storage_bytes（CPU FP32 VAE 參數＋buffer）",
                )
            else:
                observed["preview_vae"] = {"loaded": False}
        if allocator is not None:
            allocator.finish(rec, scope="load")
        self._preview_lock = threading.Lock()
        self.coefficients: Any = None
        self.coefficients_reason: str | None = None
        try:
            self.coefficients = load_coefficients(
                opts.coefficients_path(PACKAGED_COEFFICIENTS),
                channels=int(transformer.config.in_channels),
                root=opts.model_root,
            )
        except PreviewUnavailable as exc:
            self.coefficients_reason = str(exc)
        facts = dict(self.placement.facts)
        weight = int(facts["transformer_weight_bytes"])
        resident_device = weight if opts.placement == "none" else 0
        pinned = sum(self.placement.layout["block_bytes"]) if opts.pin_memory == "static" else 0
        rec.set_metric("owned_weight_device_bytes", resident_device, scope="component_instance")
        rec.set_metric("owned_pinned_host_bytes", pinned, scope="component_instance")
        rec.set_metric(
            "owned_weight_host_bytes", 0 if opts.placement == "none" else weight - pinned, scope="component_instance"
        )
        processors = sorted({type(b.attn.processor).__name__ for b in transformer.transformer_blocks})
        observed.update(
            {
                "placement": facts,
                "parameter_dtypes": parameter_dtypes(transformer),
                "adapters": adapters,
                "kv_cache": bool(transformer.config.causal_condition),
                "attention_processors": processors,
                "scheduler": self.scheduler.to_dict(),
                "linear_fit": self.coefficients.identity()
                if self.coefficients
                else {"available": False, "reason": self.coefficients_reason},
                "libraries": upstream.library_versions(LIBRARIES, vcs=("diffusers",)),
                "accumulation_dtype": None,
                "accumulation_dtype_reason": "kernel 累加精度無法由此 backend 觀測；未知不等於 FP32",
            }
        )
        if device.type == "cuda":
            observed["backend_flags"] = torch_backend_flags()
        self.calls = 0
        effective = dict(load)
        effective["precision"] = {"compute_dtype": "bf16"}
        effective["offload"] = {"mode": opts.placement, **({"pin_memory": opts.pin_memory} if opts.pin_memory else {})}
        effective["provider_options"] = opts.to_effective()
        identity = model_identity(opts)
        self.dit_identity = dit_identity(
            provider_id=self.provider_id,
            component_id=self.host.component_id,
            opts=opts,
            identity=identity,
            scheduler=self.scheduler.to_dict(),
            libraries=observed["libraries"],
        )
        return LoadResult(
            effective_load=effective,
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity=identity,
            runtime_identity={**runtime_identity(), "libraries": observed["libraries"]},
            parts=dit_parts(len(transformer.transformer_blocks)),
        )

    def unload(self, ctx: UnloadContext) -> None:
        with contextlib.suppress(Exception):
            import torch

            self.transformer = None
            self.preview_vae = None
            import gc

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def after_failure(self, code: str) -> dict[str, Any] | None:
        """Runs after the host has cleared the failed call's frames: drop the block groups a failed forward left on
        the GPU and report whether the process is back at its allocation before the call."""
        self._discard_call_state()
        memory, self._call_memory = self._call_memory, None
        if memory is not None:
            return memory.settle(code)
        if code == "GPU_OOM":
            with contextlib.suppress(Exception):
                import torch

                torch.cuda.synchronize()
                torch.cuda.empty_cache()
        return None

    def _discard_call_state(self) -> None:
        """group_stream: offload every block group a failed forward left on the GPU.

        diffusers onloads a group in its ``pre_forward`` (and prefetches the next one) and offloads it in
        ``post_forward``; after a failure in between, the current group, the prefetched one and the top-level group
        keep their weights on the GPU until the next call. ``offload_()`` only points the parameters back at their
        host copies, which is the state between calls, so the numbers of later calls do not change. phase and
        gguf_phase move the transformer back in ``invoke_placement``; none keeps it resident by design.
        """
        placement = getattr(self, "placement", None)
        for group in getattr(placement, "groups", None) or ():
            with contextlib.suppress(Exception):
                group.offload_()

    # ------------------------------------------------------------------ invoke
    def invoke(self, ctx: RunContext) -> None:
        import torch
        from phasyn_components.recorder.gpu import AllocatorWindow

        from ..bundle import read_bundle, write_bundle
        from ..instrument import drop_frame_locals, record_after_release, release_cuda_cache
        from .driver import DenoiseRequest, denoise
        from .instrument import DitObserver
        from .placement import invoke_placement
        from .preview import preview_due

        self._call_memory = None
        rec = ctx.recorder
        params = parse_params(ctx.parameters)
        rec.log("info", "QIMG_DIT_PARAMS", code="QIMG_DIT_PARAMS", effective=params.to_dict(), cfg=params.cfg)
        transformer = self.transformer
        config = transformer.config
        with rec.span("qimg.dit.read_inputs", phase="input_transfer"):
            cond_meta, cond = read_bundle(ctx, "conditioning", kind=CONDITIONING_KIND)
            ref_item = ctx.optional_input("ref_latents")
            ref_meta: dict[str, Any] | None = None
            ref_tensors: dict[str, Any] | None = None
            if ref_item is not None and ref_item.file is not None:
                ref_meta, ref_tensors = read_bundle(ctx, "ref_latents", kind=REF_LATENTS_KIND)
        inputs = check_inputs(
            params,
            cond_meta,
            cond,
            ref_meta,
            ref_tensors,
            context_dim=int(config.context_in_dim),
            channels=int(config.in_channels),
        )
        schedule = self._schedule(rec, params)
        worker, preview_state = self._preview_worker(ctx, params)
        try:
            self._admit(rec, params, inputs)
        except BaseException:
            if worker is not None:
                worker.close(discard=True)
            raise

        device = self.device
        allocator = AllocatorWindow(0) if device.type == "cuda" else None
        if allocator is not None:
            allocator.start()
        self._call_memory = CallMemory.start(device, allocator)
        observer = DitObserver(
            rec,
            check_cancelled=ctx.check_cancelled,
            sigmas=schedule.sigmas_with_terminal(),
            cfg=params.cfg,
            device=device,
            preview_due=(lambda step: preview_due(step, params.preview.every, params.steps)) if worker else None,
            preview_submit=worker.submit if worker else None,
        )
        self.calls += 1
        rec.set_metric(
            "qimg.dit.warm_call", 1 if self.calls > 1 else 0, unit="bool", scope="process", method="runtime_hook"
        )
        completed = False
        # device tensors to drop at the end of the call (bound first so the finally block can always clear them)
        request: Any = None
        result: Any = None
        summary: dict[str, Any] = {}
        try:
            with rec.span("qimg.dit.stage_inputs"):
                request = DenoiseRequest(
                    width=params.width,
                    height=params.height,
                    seed=params.seed,
                    guidance=params.guidance,
                    schedule=schedule,
                    ref_shapes=inputs["ref_shapes"],
                    **self._stage_branches(inputs, cfg=params.cfg),
                )
            with (
                invoke_placement(self.placement, transformer, rec=rec, pairs=observer.pairs),
                observer.attach(transformer, self.placement.groups),
                rec.span("qimg.dit.denoise", part="transformer", phase="denoise"),
            ):
                started = time.perf_counter()
                result = denoise(transformer, request, device=device, observer=observer)
                if device.type == "cuda":
                    torch.cuda.synchronize(device)  # compute time of the loop itself, without the weight moves
                compute_ms = (time.perf_counter() - started) * 1000
            completed = True
            with rec.span("qimg.dit.readback", part="transformer"):
                latent = result.latents.detach().to("cpu").contiguous()
            # ETA data: work = output pixels per step × steps (unit "pixel"; the shape carries width/height/steps)
            rec.record_cost(
                "denoise",
                work=float(params.steps * params.width * params.height),
                unit="pixel",
                compute_ms=compute_ms,
                steps=params.steps,
                width=params.width,
                height=params.height,
                ref_tokens=sum(h * w for h, w in inputs["ref_shapes"]),
                cfg=params.cfg,
                placement=self.opts.placement,
            )
        except BaseException as exc:
            drop_frame_locals(exc)  # a failed call's frames hold latents, the KV cache and activations
            self._discard_call_state()  # and group_stream may have left block groups on the GPU
            raise
        finally:
            summary = self._finish_call(rec, worker, preview_state, observer, allocator, completed=completed)
            if device.type == "cuda":
                # return idle blocks to the driver after every call: phase releases once when moving back to the
                # CPU (conditioning and latents still hold memory afterwards) and group_stream/none would never
                # release, leaving GiBs reserved so the next VAE decode or TE call on the same GPU can OOM.
                # The latent was already read back to the CPU; _latent_meta only uses non-tensor fields of result
                if result is not None:
                    result.latents = None
                request = None
                release_cuda_cache(device)
                record_after_release(rec, device)
        rec.log("info", "QIMG_DIT_PREVIEW", code="QIMG_DIT_PREVIEW", **preview_state)
        ctx.check_cancelled()
        if not bool(torch.isfinite(latent.float()).all()):
            raise ComponentError("RUNTIME_ERROR", "去噪結果含非有限數值（NaN／Inf）；不輸出", details=summary)
        ref_item = ctx.optional_input("ref_latents")
        meta = latent_meta(
            params=params,
            schedule=schedule,
            result=result,
            latent_shape=list(latent.shape),
            inputs=inputs,
            conditioning_sha256=(ctx.input("conditioning").file or {}).get("sha256"),
            ref_latents_sha256=(
                (ref_item.file or {}).get("sha256") if ref_item is not None and ref_item.file else None
            ),
            identity=self.dit_identity,
        )
        with rec.span("qimg.dit.write_output", phase="output_publish"):
            write_bundle(ctx, "latent", kind=LATENT_KIND, meta=meta, tensors={"latent": latent})

    def _schedule(self, rec: Any, params: DitParams) -> Any:
        from .schedule import ScheduleError, build_schedule

        try:
            schedule = build_schedule(
                self.scheduler,
                steps=params.steps,
                image_seq_len=params.target_tokens,
                sigma_schedule=params.sigma_schedule,
                flow_shift_mu=params.flow_shift_mu,
            )
        except ScheduleError as exc:
            raise ComponentError("INVALID_ARGUMENT", str(exc)) from exc
        if params.sigma_schedule != "native" or params.flow_shift_mu is not None:
            rec.note("已套用自訂噪聲排程（非原生屬實驗選項，品質不保證較好）")
        return schedule

    def _preview_worker(self, ctx: RunContext, params: DitParams) -> tuple[Any, dict[str, Any]]:
        """An unavailable preview mode is a 422; a call without a preview channel turns previews off with a note."""
        from .preview import PREVIEW_NOTE, PreviewWorker, render_linear, render_vae_thumbnail

        render = self._preview_renderer(params, render_vae_thumbnail, render_linear)
        state: dict[str, Any] = {"requested": params.preview.to_dict(), "effective": "off", "reason": None}
        if render is None:
            return None, state
        if not ctx.preview_enabled:
            state["reason"] = "這次呼叫沒有平台預覽通道（ctx.preview_enabled=False）；預覽關閉"
            ctx.recorder.note(str(state["reason"]))
            return None, state
        note = PREVIEW_NOTE + (
            "；合成係數" if params.preview.mode == "linear_fit" and self.coefficients.synthetic else ""
        )
        worker = PreviewWorker(
            render=render, publish=ctx.publish_preview, total=params.steps, note=note, lock=self._preview_lock
        )
        state["effective"] = params.preview.mode
        return worker, state

    def _admit(self, rec: Any, params: DitParams, inputs: Mapping[str, Any]) -> None:
        """VRAM admission per placement (phase/gguf_phase/group_stream/none estimates); too little free GPU memory →
        GPU_MEMORY_INSUFFICIENT before the transformer moves."""
        from .loading import largest_quantized_matrix
        from .placement import invoke_admission

        transformer = self.transformer
        config = transformer.config
        dims = admission.ModelDims(
            num_layers=len(transformer.transformer_blocks),
            hidden=int(config.num_attention_heads) * int(config.attention_head_dim),
            element_size=2,
        )
        branches = [admission.BranchShape(inputs["pos_len"], inputs["pos_slots"], params.target_tokens)]
        if params.cfg:
            branches.append(admission.BranchShape(inputs["neg_len"], inputs["neg_slots"], params.target_tokens))
        dequant = (
            largest_quantized_matrix(transformer) * admission.GGUF_DEQUANT_FACTOR
            if self.opts.placement == "gguf_phase"
            else 0
        )
        estimate = invoke_admission(self.placement, dims=dims, branches=branches, dequant_bytes=dequant)
        rec.log("info", "QIMG_DIT_ADMISSION", code="QIMG_DIT_ADMISSION", **estimate.to_dict())
        rec.set_metric(
            "qimg.dit.vram_required_estimate_bytes",
            estimate.required,
            unit="bytes",
            quality="derived",
            scope="component_call",
            method="admission_estimate（權重＋activation reserve＋prefix KV；見 QIMG_DIT_ADMISSION）",
        )

    def _stage_branches(self, inputs: Mapping[str, Any], *, cfg: bool) -> dict[str, Any]:
        """Move the conditioning branches and reference latents to the device (``DenoiseRequest`` keyword arguments)."""
        from .driver import Branch

        device = self.device

        def branch(prefix: str) -> Branch:
            mask = inputs[f"{prefix}_mask"]
            return Branch(
                embeds=inputs[f"{prefix}_embeds"].to(device),
                image_pad_mask=inputs[f"{prefix}_pad"].to(device),
                mask=None if mask is None else mask.to(device),
            )

        ref = inputs["ref_latents"]
        return {
            "positive": branch("pos"),
            "negative": branch("neg") if cfg else None,
            "ref_latents": None if ref is None else ref.to(device),
        }

    def _finish_call(
        self,
        rec: Any,
        worker: Any,
        preview_state: dict[str, Any],
        observer: Any,
        allocator: Any,
        *,
        completed: bool,
    ) -> dict[str, Any]:
        """Close the preview worker and the step observer and record their statistics (never masks the outcome)."""
        if worker is not None:
            worker.close(discard=True)
            stats = worker.statistics()
            preview_state["stats"] = stats
            for key in ("submitted", "published", "replaced", "dropped_by_platform"):
                rec.set_metric(
                    f"qimg.dit.preview_{key}", stats[key], unit="count", scope="component_call", method="runtime_hook"
                )
            if stats["error"]:
                rec.note(f"預覽停用（生成繼續）：{stats['error']}")
        summary: dict[str, Any] = {}
        try:
            summary = observer.finish(completed=completed)
        except Exception as exc:  # a measurement failure only degrades the record; it never replaces the outcome
            rec.measurement_error(f"DiT step 紀錄：{type(exc).__name__}: {exc}"[:300])
        if allocator is not None:
            allocator.finish(rec, scope="invoke")
        return summary

    # ------------------------------------------------------------------ helpers
    def _preview_renderer(self, params: DitParams, vae_render: Any, linear_render: Any) -> Any:
        mode = params.preview.mode
        if mode == "off":
            return None
        width, height, side = params.width, params.height, params.preview.max_side
        if mode == "vae_thumbnail":
            if self.preview_vae is None:
                raise unsupported(
                    "preview.mode=vae_thumbnail 需要此元件以 provider_options.preview_vae=true 載入（不自動載入）"
                )
            vae = self.preview_vae
            return lambda packed: vae_render(vae, packed, width=width, height=height, max_side=side)
        if self.coefficients is None:
            raise unsupported(f"preview.mode=linear_fit 不可用：{self.coefficients_reason}")
        coeffs = self.coefficients
        return lambda packed: linear_render(coeffs, packed, width=width, height=height, max_side=side)


__all__ = ["LIBRARIES", "QimgDitProvider"]
