# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/stages/latent_preparation.py (initial noise) and stages/denoising.py (target-noise scatter)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: reproduced for numerical parity inside the stage-split denoise.
"""denoise_av: the joint audio-video Omni-Transformer loop on the resident DiT.

Re-creates, inside the actor that holds the DiT, exactly the state the pinned
monolith builds (-§6, §11):

* initial noise — ``S/stages/latent_preparation.py:115-131`` (CPU generator, FP32,
  video drawn first on ``[1,24,T,H/16,W/16]`` then patchified; audio from an
  independent generator re-seeded with the same seed, ``[2·T_audio, 32]``);
* condition rows from the reference bundle, condition noise augmentation
  (``S/stages/denoising.py:1187-1245``), packed layout (verified against the
  ``assemble_inputs`` digest), refined prompt + rope cache precompute
  (``:385-442``), target-noise scatter (``:1248-1270``);
* ``minimax_h3_denoise_loop`` (``S/denoise_loop.py:446-653``) with the plan's two
  sigma grids (never recomputed), single CFG-distilled positive branch, and an
  ``on_step`` hook that reports progress and honours cancel between updates.

Output: one ``video_latent`` tensor bundle with ``video_latent``
``[1,24,T,H/16,W/16]`` and ``audio_latent`` ``[1,2,T,32]`` (F32, normalized).

With the ``nag`` option (Normalized Attention Guidance, ``recipe/runtime/nag_rules.py``) the loop's forward goes
through a ``nag.NagSession``: the negative text of the ``nag_conditioning`` input is appended to the packed
sequence and every block's attention guides the target video rows away from it. Off (the default) builds no
session and the payload metadata has no ``nag`` key.

With ``ref_kv_cache`` (Ref2VA, approximate; ``recipe/adapter/ref_kv_rules.py``) the loop's forward goes through a
``ref_kv_cache.RefKvSession``: skipped steps run the DiT on the packed sequence without the reference rows and
attend over the reference K/V cached on the last full step. Off (the default) builds no session.

When the loop ends the DiT follows its between-use policy
(``phasyn.sglang_h3.residency``, provider ``_apply_after_use``): ``host`` releases
the device copy (layerwise: every layer plus the parked non-layer weights) so
``decode_video`` on the same GPU starts from an empty device, ``drop`` evicts,
``device`` keeps it (only the streamed window is released).
"""

from __future__ import annotations

import contextlib
import time
from importlib import import_module
from pathlib import Path
from typing import Any, NamedTuple, TypedDict, Unpack, cast

from phasyn_h3.recipe.abi.stage import StageResult
from phasyn_h3.recipe.abi.tensors import verify_conditioning_bundle

from .. import (
    SGLANG_SOURCE_REVISION,
    attention_probe,
    denoise_cache,
    denoise_cache_rules,
    dit_trace,
    nag_rules,
    refine,
)
from .._arguments import validate_keywords
from ..accel_load import check_resident_dit
from ..acceleration import SDPA_BACKED_PROVIDERS
from ..attention_runtime import prepare_dit_attention, subblock_video_query_indices
from ..bundles import (
    SafetensorsStreamWriter,
    TensorDecl,
    finalize_tensor_bundle,
    load_bundle_manifest,
    payload_metadata,
    resolve_payload,
)
from ..errors import InvalidStageInput, UnsupportedCombination
from ..fp8_linear import KERNEL_ID, call_counts as fp8_linear_call_counts
from ..lora import ptd_hops
from ..lora_inplace import call_counts, set_chunk_tokens
from ..lora_policy import LORA_ACCUMULATE, check_lora_schedule, specs_of
from ..measure import StepTimer, dit_flop
from ..mlp_token_chunk import chunked_mlp
from ..nag import NagSession
from ..pdd import check_pdd_schedule, verify_heads_installed
from ..ref_kv_cache import RefKvSession, planned_skip
from ..sigmas import SigmaGrid, load_sigma_grid
from .assemble_inputs import load_conditioning, load_references
from .common import StageRun, requested, seed_of, task_of
from .layout import (
    LatentDims,
    build_packed,
    check_layout,
    latent_dims,
    layout_digest,
    ordered_condition_blocks,
    tagged,
)
from .normalization import normalization_digest
from .tensor_io import load_tensors, tensor_bytes


class _PromptRefinement(TypedDict):
    refine: Any


def _init_latents(run: StageRun) -> tuple[Any, Any, dict[str, Any]]:
    """The refinement's x0: (video_latent, audio_latent, provenance) of the ``init_latents`` bundle (CPU, FP32)."""
    item = run.require_input(refine.INPUT_ROLE)
    manifest = load_bundle_manifest(Path(item.path))
    if manifest.get("normalization_config_digest") != normalization_digest(run.plan):
        raise InvalidStageInput(
            "INIT_LATENT_NORMALIZATION",
            "init_latent 的 normalization_config_digest 與本環境不符（不同 latent 空間，不換算）",
            error_code=refine.LATENT_MISMATCH,
        )
    specs = {str(t.get("name")): t for t in manifest.get("tensors") or []}
    for name in ("video_latent", "audio_latent"):
        if name not in specs:
            raise InvalidStageInput(
                "INIT_LATENT_TENSOR",
                f"init_latent 缺少 {name}",
                error_code=refine.LATENT_MISMATCH,
            )
        refine.check_dtype(name, str(specs[name].get("dtype")))
    refine.check_shapes(
        specs["video_latent"].get("shape") or [],
        specs["audio_latent"].get("shape") or [],
        run.geometry,
    )
    payload = resolve_payload(manifest, run.ctx.attachments)
    tensors = load_tensors(payload, ["video_latent", "audio_latent"])
    video, audio = tensors["video_latent"], tensors["audio_latent"]
    refine.check_shapes(list(video.shape), list(audio.shape), run.geometry)
    return (
        video,
        audio,
        {"payload_sha256": (manifest.get("payload") or {}).get("sha256")},
    )


def _negative_conditioning(run: StageRun, positive: dict[str, Any]) -> dict[str, Any]:
    """The NAG negative text: the ``nag_conditioning`` bundle's tensors (verified like ``conditioning``)."""
    item = run.require_input(nag_rules.INPUT_ROLE)
    manifest = load_bundle_manifest(Path(item.path), conditioning=True)
    payload = resolve_payload(manifest, run.ctx.attachments)
    problems = verify_conditioning_bundle(
        manifest,
        payload.read_bytes(),
        max_tokens=int(run.policy.limits.get("encoder_max_tokens", 32768)),
    )
    if problems:
        raise InvalidStageInput(
            "NAG_CONDITIONING_REJECTED", "nag_conditioning：" + "; ".join(problems)
        )
    nag_rules.check_same_encoder(positive, manifest)
    tensors = load_tensors(payload, ["hidden_states", "text_token_tags"])
    return {
        **tensors,
        "payload_sha256": manifest["payload"]["sha256"],
        "text_len": int(manifest["text_len"]),
    }


def _sdpa_guard(run: StageRun) -> Any:
    """Forbid the O(N²) MATH SDPA kernel when the profile says so.

    Also covers the approximate providers: their excluded/dense region and
    fallbacks run Torch SDPA (acceleration.SDPA_BACKED_PROVIDERS).
    """
    if (
        run.policy.attention_provider_effective not in SDPA_BACKED_PROVIDERS
        or not run.policy.reject_quadratic_materialization
    ):
        return contextlib.nullcontext()
    from torch.nn.attention import SDPBackend, sdpa_kernel

    return sdpa_kernel(
        [
            SDPBackend.FLASH_ATTENTION,
            SDPBackend.EFFICIENT_ATTENTION,
            SDPBackend.CUDNN_ATTENTION,
        ]
    )


def _condition_noise(run: StageRun) -> None:
    for i, material in enumerate(requested(run.plan).get("materials") or []):
        if material.get("condition_noise") is not None:
            raise UnsupportedCombination(
                "PER_MATERIAL_CONDITION_NOISE",
                "釘版 SGLang 的條件 noise aug 是全域常數（imgvid 0.999 / audio 1.0，denoising.py:60-84），"
                "不支援逐素材設定",
                field_path=f"materials[{i}].condition_noise",
            )


def run(run: StageRun) -> StageResult:
    """Run the joint audio and video denoising loop."""
    return cast("StageResult", dit_trace.run_stage(run, _run))


def _run(run: StageRun) -> StageResult:
    import torch
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.denoise_loop import (  # type: ignore[import-untyped]
        minimax_h3_denoise_loop,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_tokens import (  # type: ignore[import-untyped]
        minimax_h3_unpatchify_video_tokens,
    )

    (
        task,
        dims,
        seed,
        packed_doc,
        conditioning,
        cond_payload,
        ref_payload,
        ref_meta,
        grid,
        refining,
        sigmas_video,
        sigmas_audio,
        nag,
        planned,
        negative,
        cache_policy,
    ) = _read_denoise_inputs(run)

    (
        cond,
        hidden,
        subblock,
        packed,
        tags,
        cond_rows,
        audio_ref_rows,
        imgvid_aug,
        audio_aug,
    ) = _prepare_denoise_condition(
        _PrepareDenoiseConditionInputs(
            cond_payload,
            task,
            ref_meta,
            run,
            conditioning,
            dims,
            packed_doc,
            planned,
            ref_payload,
            seed,
        ),
        cache_policy,
    )

    # -- initial noise (latent_preparation.py:115-131) -----------------------------
    video_noise, audio_noise, refine_facts, noise_seconds = _seed_denoise_noise(
        _SeedDenoiseNoiseInputs(
            seed, dims, refining, run, sigmas_video, sigmas_audio, grid, planned
        )
    )

    evaluations = {"n": 0}
    observe_attention = run.stage.get("observe_attention", False)
    if not isinstance(observe_attention, bool):
        raise InvalidStageInput(
            "ATTENTION_PROBE_INVALID",
            "observe_attention must be a boolean.",
            field_path="observe_attention",
        )
    observed: dict[str, Any] | None = {} if observe_attention else None
    with (
        dit_trace.scope("component_use"),
        run.provider.use_component(run, "transformer") as model,
    ):
        denoise_cache.check_clean(model)
        device = run.provider.torch_device()
        if getattr(model, "training", False):
            model.eval()

        (
            lease,
            attention,
            lora_heads,
            lora_runtime,
            fp8_runtime,
            positive,
            ptd,
            ptd_refined,
            ref_cache,
            nag_session,
            initial_video,
            initial_audio,
        ) = _prepare_transformer_request(
            _PrepareTransformerRequestInputs(
                run,
                model,
                device,
                planned,
                packed,
                hidden,
                tags,
                cond,
                subblock,
                nag,
                negative,
                video_noise,
                cond_rows,
                audio_noise,
                audio_ref_rows,
            )
        )

        forward, timer, on_step = _step_callbacks(
            _StepCallbacksInputs(
                evaluations, ptd, ptd_refined, run, attention, device, planned
            ),
            observed,
        )
        attention.mark_loop_start()
        with dit_trace.scope("pre_loop_sync"):
            run.provider.backend.synchronize()

        with (
            dit_trace.scope("loop"),
            contextlib.nullcontext() if ref_cache is None else ref_cache.active(),
            contextlib.nullcontext() if nag_session is None else nag_session.active(),
            _compile_context(run, model) as compiled,
            chunked_mlp(model, int(positive.seq_len)) as mlp_chunk,
            (
                contextlib.nullcontext(None)
                if cache_policy is None
                else denoise_cache.active(model, cache_policy, planned)
            ) as cached,
        ):
            wall_started = time.perf_counter()
            timer.mark()
            video_rows, audio_rows_out = minimax_h3_denoise_loop(
                model=model,
                model_forward=_loop_forward(forward, ref_cache, nag_session),
                positive=positive,
                initial_video_rows=initial_video,
                initial_audio_rows=initial_audio,
                keyframe_cond_rows=cond_rows,
                audio_ref_rows=audio_ref_rows,
                sigmas_video=sigmas_video,
                sigmas_audio=sigmas_audio,
                device=device,
                imgvid_cond_noise_aug_for_inference=imgvid_aug,
                audio_cond_noise_aug_for_inference=audio_aug,
                attn_metadata=None,
                on_step=on_step,
                step_profiler=dit_trace.step_profiler(),
            )
            with dit_trace.scope("final_event_wait"):
                per_step_seconds = timer.seconds()
            with dit_trace.scope("final_device_sync"):
                run.provider.backend.synchronize()
            loop_wall_seconds = time.perf_counter() - wall_started
        lora_runtime = _finish_lora_runtime(model, lora_runtime, evaluations["n"])
        fp8_runtime = _finish_fp8_runtime(model, fp8_runtime, evaluations["n"])
        (
            active_backend,
            attention_report,
            ref_cache_report,
            nag_report,
            load_acceleration,
        ) = _denoise_reports(
            _DenoiseReportsInputs(
                model, attention, planned, run, ref_cache, nag_session, negative, lease
            )
        )
        target_video = video_rows[positive.video_target_slice]
        target_audio = audio_rows_out[positive.audio_target_slice]
    with dit_trace.scope("latent_d2h"):
        video_latent = minimax_h3_unpatchify_video_tokens(
            target_video.float(),
            latent_shape=[dims.latent_t, dims.latent_h // 2, dims.latent_w // 2, 24],
            patch_size=[1, 2, 2],
        ).cpu()
        audio_latent = target_audio.float().reshape(1, 2, dims.audio_t, 32).cpu()
    decls = _check_latent_outputs(video_latent, audio_latent, torch, run)
    # effective approximate knobs + what SGLang built (accel_load), for provenance
    acceleration, metadata = _denoise_output_metadata(
        _DenoiseOutputMetadataInputs(
            run,
            load_acceleration,
            fp8_runtime,
            mlp_chunk,
            ref_cache_report,
            task,
            seed,
            grid,
            planned,
            evaluations,
            attention_report,
            active_backend,
            packed_doc,
            lora_heads,
            lora_runtime,
            nag_report,
            refine_facts,
        ),
        observed,
        compiled,
        cached,
    )
    _publish_denoised_latents(
        _PublishDenoisedLatentsInputs(
            run, decls, metadata, audio_latent, video_latent, lora_runtime, acceleration
        )
    )
    # timing stays out of the bundle metadata (the payload must not change between identical runs)
    _measure_denoise(
        _MeasureDenoiseInputs(
            lora_runtime,
            run,
            per_step_seconds,
            loop_wall_seconds,
            packed,
            evaluations,
            ref_cache,
            noise_seconds,
            device,
        ),
        cached,
        planned,
    )
    return run.result()


def _loop_forward(forward: Any, ref_cache: Any, nag_session: Any) -> Any:
    """The loop's ``model_forward``: Phasyn's forward, wrapped by the session that is on (never both)."""
    if ref_cache is not None:
        return ref_cache.wrap_forward(forward)
    if nag_session is not None:
        return nag_session.wrap_forward(forward)
    return forward


def _planned_ref_skip(
    run: StageRun, packed: Any, planned: int
) -> tuple[int, int] | None:
    """(reduced rows, skipped steps) of the planned ``ref_kv_cache`` run for the ETA work record; None when off."""
    if run.policy.ref_kv_cache is None:
        return None

    return planned_skip(packed, run.policy.ref_kv_cache, planned)


def _open_ref_kv_cache(
    run: StageRun, model: Any, positive: Any, planned: int, device: Any
) -> Any:
    """The reference-row K/V cache of this loop (``ref_kv_cache.RefKvSession``); None when the option is off.

    Built after ``prepare_dit_attention`` and both precomputes: it checks the bound backends and reads the
    branch's final static kwargs, and refuses (before step 0) what it cannot serve.
    """
    if run.policy.ref_kv_cache is None:
        return None

    return RefKvSession(
        model, positive, run.policy.ref_kv_cache, steps=planned, device=device
    )


def _ptd_prepare(
    model: Any,
    positive: Any,
    planned: int,
    device: Any,
    run: StageRun,
    **arguments: Unpack[_PromptRefinement],
) -> tuple[Any, list[Any]]:
    """PTD per-step adapters: (hops, the refined prompt of every hop); (None, []) for any other LoRA.

    The token refiner carries a per-hop adapter too, so the prompt is refined once per hop (2 refiner blocks
    over the text rows) instead of once per request.
    """
    validate_keywords(arguments, _PromptRefinement)
    refine = arguments["refine"]
    ptd = ptd_hops(model)
    if ptd is None:
        return None, []
    if ptd.count != planned:
        raise UnsupportedCombination(
            "LORA_PTD_STEPS",
            f"PTD 有 {ptd.count} 個 hop，這次規劃 {planned} 步；每步需要剛好一個 hop",
        )
    if run.policy.ref_kv_cache is not None:
        raise UnsupportedCombination(
            "LORA_PTD_REF_KV_UNSUPPORTED", "PTD 每步換 adapter，參考列 K/V 快取不能沿用"
        )
    static = positive.static_kwargs
    raw = static["prompt_embeds"]
    refined = []
    for hop in range(ptd.count):
        ptd.set_hop(hop)
        static["prompt_embeds"] = raw
        refine(model, positive, device=device, shared_conditioning=None)
        refined.append(static["prompt_embeds"])
    ptd.set_hop(0)
    static["prompt_embeds"] = refined[0]
    return ptd, refined


def _prepare_lora_runtime(model: Any, policy: Any) -> dict[str, Any] | None:
    """Re-chunk the resident DiT's in-place LoRA wrappers for this plan (``lora_inplace``)."""
    if policy is None:
        return None
    if policy.merge_mode != "dynamic":
        return {"accumulate": "merged"}

    wrapped = set_chunk_tokens(model, policy.chunk_tokens)
    if wrapped == 0:
        raise UnsupportedCombination(
            "LORA_NOT_ATTACHED",
            "plan 有 dynamic LoRA，但常駐 DiT 沒有 in-place LoRA wrapper（元件身分與 plan 不符）",
        )
    return {
        "accumulate": LORA_ACCUMULATE,
        "dynamic_chunk_tokens": policy.chunk_tokens,
        "wrapped_layers": wrapped,
        "_calls_before": call_counts(model),
    }


def _prepare_fp8_runtime(model: Any) -> dict[str, Any] | None:
    """FP8 layers the shim's GEMM serves (``fp8_linear``; None when the DiT has none)."""
    layers = sum(1 for sub in model.modules() if getattr(sub, "_phasyn_fp8_gemm", None))
    if layers == 0:
        return None
    call_counts = fp8_linear_call_counts

    return {"kernel": KERNEL_ID, "layers": layers, "_calls_before": call_counts(model)}


def _finish_fp8_runtime(
    model: Any, state: dict[str, Any] | None, evaluations: int
) -> dict[str, Any] | None:
    if state is None:
        return None
    call_counts = fp8_linear_call_counts

    calls = call_counts(model) - int(state.pop("_calls_before"))
    if evaluations > 0 and calls == 0:
        raise UnsupportedCombination(
            "FP8_KERNEL_NOT_ENGAGED",
            f"DiT 有 {state['layers']} 個 FP8 層，但 forward 沒有經過 {state['kernel']}",
        )
    return {**state, "calls": calls}


def _finish_lora_runtime(
    model: Any, state: dict[str, Any] | None, evaluations: int
) -> dict[str, Any] | None:
    if state is None or "_calls_before" not in state:
        return state

    calls = call_counts(model) - int(state.pop("_calls_before"))
    if evaluations > 0 and calls == 0:
        raise UnsupportedCombination(
            "LORA_TERM_NOT_APPLIED", "DiT forward 沒有經過任何 in-place LoRA wrapper"
        )
    return {**state, "inplace_calls": calls}


__all__ = ["run"]


class _DenoiseSources(NamedTuple):
    task: str
    dims: LatentDims
    seed: int
    packed_doc: dict[str, Any]
    conditioning: dict[str, Any]
    cond_payload: Path
    ref_payload: Path | None
    ref_meta: dict[str, Any] | None
    grid: SigmaGrid
    refining: refine.Refine | None
    sigmas_video: list[float]
    sigmas_audio: list[float]
    nag: nag_rules.Nag | None
    planned: int
    negative: dict[str, Any] | None
    cache_policy: dict[str, Any] | None


def _read_denoise_inputs(
    run: StageRun,
) -> _DenoiseSources:
    with dit_trace.scope("input_read_validate"):
        task = task_of(run.plan)
        dims = latent_dims(run.geometry)
        seed = seed_of(run.plan)
        _condition_noise(run)
        packed_doc = run.read_json_input("packed")
        if packed_doc is None:
            raise RuntimeError("packed_doc is unavailable in this stage")
        conditioning, cond_payload = load_conditioning(run)
        references, ref_payload, ref_meta = load_references(run)
        grid = load_sigma_grid(run.sigmas_input().path, run.plan.get("schedule") or {})
        # opt-in low-noise refinement from an existing latent (refine.py); None = the loop of today
        refining = refine.parse(
            run.stage,
            planned_updates=grid.updates,
            adaln_mode=run.policy.adaln_mode,
            has_lora=run.policy.lora is not None,
        )
        sigmas_video, sigmas_audio = refine.truncate(grid.video, grid.audio, refining)
        # opt-in Normalized Attention Guidance (nag_rules.py); None = the loop of today
        nag = nag_rules.parse(
            run.stage,
            mode=run.policy.mode,
            attention=run.policy.attention_provider_effective,
            ref_kv_cache=run.policy.ref_kv_cache is not None,
            ptd=any(spec.ptd_hops for spec in specs_of(run.policy.lora)),
        )
        for name, expected, actual in (
            (
                "conditioning_payload",
                packed_doc.get("conditioning_payload"),
                conditioning["payload"]["sha256"],
            ),
            (
                "references_payload",
                packed_doc.get("references_payload"),
                None if references is None else references["payload"]["sha256"],
            ),
            ("sigmas_digest", packed_doc.get("sigmas_digest"), grid.sha256),
        ):
            if expected != actual:
                raise InvalidStageInput(
                    "PACKED_INPUT_DRIFT",
                    f"packed.{name} 與實際輸入不符",
                    expected=str(expected),
                    actual=str(actual),
                )
        planned = len(sigmas_video) - 1  # == grid.updates unless refining
        cache_policy = denoise_cache_rules.validate(run.policy.effective_profile)
        denoise_cache_rules.step_budget(
            cache_policy, steps=planned, nag=nag is not None
        )
        # LoRA steps/shifts are training contracts; PDD also needs its block boundaries (before any GPU work)
        check_lora_schedule(
            run.policy.lora,
            updates=grid.updates,
            schedule=run.plan.get("schedule") or {},
        )
        for spec in specs_of(run.policy.lora):
            check_pdd_schedule(grid.video, grid.audio, spec)
        if nag is not None and nag.steps is not None and nag.steps > planned:
            raise InvalidStageInput(
                "NAG_PARAMETER_RANGE",
                f"nag_steps={nag.steps} 超過這次的 {planned} 步",
                field_path="nag_steps",
            )
        negative = None if nag is None else _negative_conditioning(run, conditioning)
    return _DenoiseSources(
        task,
        dims,
        seed,
        packed_doc,
        conditioning,
        cond_payload,
        ref_payload,
        ref_meta,
        grid,
        refining,
        sigmas_video,
        sigmas_audio,
        nag,
        planned,
        negative,
        cache_policy,
    )


class _SeedDenoiseNoiseInputs(NamedTuple):
    seed: int
    dims: LatentDims
    refining: refine.Refine | None
    run: StageRun
    sigmas_video: list[float]
    sigmas_audio: list[float]
    grid: SigmaGrid
    planned: int


def _seed_denoise_noise(
    inputs: _SeedDenoiseNoiseInputs,
) -> tuple[Any, Any, dict[str, Any] | None, Any]:
    import torch
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_tokens import (
        minimax_h3_patchify_video_latent,
    )

    seed, dims, refining, run, sigmas_video, sigmas_audio, grid, planned = inputs
    with dit_trace.scope("noise_cpu"):
        noise_started = time.perf_counter()
        gen_v = torch.Generator().manual_seed(int(seed))
        video_tensor = torch.randn(
            1,
            24,
            dims.latent_t,
            dims.latent_h,
            dims.latent_w,
            generator=gen_v,
            dtype=torch.float32,
        )
        video_noise = minimax_h3_patchify_video_latent(
            video_tensor, patch_size=[1, 2, 2]
        ).to(torch.float32)
        gen_a = torch.Generator().manual_seed(int(seed))
        audio_noise = torch.randn(
            dims.audio_t * 2, 32, generator=gen_a, dtype=torch.float32
        )
        del video_tensor
        refine_facts: dict[str, Any] | None = None
        if refining is not None:
            init_video, init_audio, refine_facts = _init_latents(run)
            init_rows = minimax_h3_patchify_video_latent(
                init_video.to(torch.float32), patch_size=[1, 2, 2]
            )
            video_noise = refine.noised_rows(
                video_noise, init_rows.to(torch.float32), sigmas_video[0]
            )
            audio_noise = refine.noised_rows(
                audio_noise,
                init_audio[0].reshape(-1, 32).to(torch.float32),
                sigmas_audio[0],
            )
            refine_facts = {
                **refining.as_dict(),
                **refine_facts,
                "sigma_video": sigmas_video[0],
                "sigma_audio": sigmas_audio[0],
                "plan_updates": grid.updates,
                "run_updates": planned,
            }
            del init_video, init_audio, init_rows
        noise_seconds = (
            time.perf_counter() - noise_started
        )  # CPU generator on the render node
    return video_noise, audio_noise, refine_facts, noise_seconds


def _check_latent_outputs(
    video_latent: Any, audio_latent: Any, torch: Any, run: StageRun
) -> Any:
    for name, tensor in (
        ("video_latent", video_latent),
        ("audio_latent", audio_latent),
    ):
        if not bool(torch.isfinite(tensor).all()):
            raise InvalidStageInput("LATENT_NONFINITE", f"{name} 含 NaN/Inf；不輸出")
    decls = [
        TensorDecl(
            "audio_latent", "F32", tuple(int(d) for d in audio_latent.shape), "B,C,T,D"
        ),
        TensorDecl(
            "video_latent",
            "F32",
            tuple(int(d) for d in video_latent.shape),
            "B,C,T,H,W",
        ),
    ]
    if list(video_latent.shape) != list(run.geometry["video_latent_shape"]) or list(
        audio_latent.shape
    ) != list(run.geometry["audio_latent_shape"]):
        raise InvalidStageInput(
            "LATENT_SHAPE_DRIFT", "輸出 latent 形狀與 plan geometry 不符"
        )
    return decls


class _MeasureDenoiseInputs(NamedTuple):
    lora_runtime: Any
    run: StageRun
    per_step_seconds: list[float]
    loop_wall_seconds: float
    packed: dict[str, Any]
    evaluations: dict[str, int]
    ref_cache: Any
    noise_seconds: float
    device: Any


def _measure_denoise(
    inputs: _MeasureDenoiseInputs, cached: dict[str, Any] | None, planned: int
) -> None:
    (
        lora_runtime,
        run,
        per_step_seconds,
        loop_wall_seconds,
        packed,
        evaluations,
        ref_cache,
        noise_seconds,
        device,
    ) = inputs
    dynamic = (
        lora_runtime is not None and lora_runtime.get("accumulate") == LORA_ACCUMULATE
    )
    lora_rank = (
        max((spec.rank for spec in specs_of(run.policy.lora)), default=0)
        if dynamic
        else 0
    )
    seq_len, used_rows = int(packed["seq_len"]), int(packed["cu_seqlens"][1])
    flop = dit_flop(
        seq_len,
        evaluations["n"],
        lora_rank=lora_rank or None,
        ref_skip=None if ref_cache is None else ref_cache.flop_skip(),
        cached=cached,
    )
    if cached is not None:
        # Residual thresholds choose the actual work at runtime. Record it only after the adapter reports.
        run.cost(
            "denoise",
            work=flop.total,
            unit="flop",
            seq_len=seq_len,
            used_rows=used_rows,
            steps=planned,
            risk_measure=used_rows,
            risk_unit="row",
            cache_dit_reused_steps=cached["reused_steps"],
        )
    run.cost_seconds(
        "denoise", sum(per_step_seconds) if per_step_seconds else loop_wall_seconds
    )
    run.measure(
        compute_seconds=sum(per_step_seconds)
        if per_step_seconds
        else loop_wall_seconds,
        per_step_seconds=per_step_seconds,
        flop=flop,
        loop_wall_seconds=round(loop_wall_seconds, 6),
        noise_seconds=round(noise_seconds, 6),
        step_timer="cuda_events"
        if per_step_seconds and getattr(device, "type", "") == "cuda"
        else "perf_counter",
    )


class _PrepareReferenceRowsInputs(NamedTuple):
    ref_payload: Path | None
    blocks: Any
    task: str
    dims: LatentDims
    seed: int


def _prepare_reference_rows(
    inputs: _PrepareReferenceRowsInputs,
) -> tuple[Any, Any, float, float]:
    import torch
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.condition_noise import (  # type: ignore[import-untyped]
        minimax_h3_audio_cond_noise_aug_rows,
        minimax_h3_imgvid_cond_noise_aug_rows,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.denoise_loop import (
        MINIMAX_H3_AUDIO_REF_COND_TIMESTEP,
        MINIMAX_H3_IMGVID_COND_TIMESTEP,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_tokens import (
        minimax_h3_patchify_video_latent,
    )

    ref_payload, blocks, task, dims, seed = inputs
    ref = load_tensors(ref_payload) if ref_payload is not None else {}
    visual_rows = [
        minimax_h3_patchify_video_latent(
            ref[name].to(torch.float32), patch_size=[1, 2, 2]
        ).to(torch.float32)
        for name in blocks["visual_tensors"]
    ]
    audio_rows = [
        ref[name][0].reshape(-1, 32).to(torch.float32)
        for name in blocks["audio_tensors"]
    ]
    cond_rows = torch.cat(visual_rows, dim=0) if visual_rows else None
    audio_ref_rows = torch.cat(audio_rows, dim=0) if audio_rows else None
    imgvid_aug = float(MINIMAX_H3_IMGVID_COND_TIMESTEP)
    audio_aug = float(MINIMAX_H3_AUDIO_REF_COND_TIMESTEP)
    if cond_rows is not None and imgvid_aug < 1.0:
        if task == "fl2va":
            shapes = [
                (1, int(b["latent_h"]), int(b["latent_w"])) for b in blocks["keyframes"]
            ]
        else:
            shapes = [
                (
                    int(b.get("latent_t", 1))
                    if b["kind"] in ("video", "video_audio")
                    else 1,
                    int(b["latent_h"]),
                    int(b["latent_w"]),
                )
                for b in blocks["ref2va_blocks"]
                if b["kind"] in ("image", "video", "video_audio")
            ]
        cond_rows = minimax_h3_imgvid_cond_noise_aug_rows(
            cond_rows,
            condition_shapes=shapes,
            target_latent_t=dims.latent_t,
            imgvid_cond_num_frames=len(shapes),
            seed=int(seed),
            noise_aug=imgvid_aug,
        )
    if audio_ref_rows is not None and audio_aug < 1.0:
        lengths = [
            int(b["ref_audio_t"])
            for b in blocks["ref2va_blocks"]
            if int(b.get("ref_audio_t", 0)) > 0
        ]
        audio_ref_rows = minimax_h3_audio_cond_noise_aug_rows(
            audio_ref_rows,
            condition_audio_t=lengths,
            seed=int(seed),
            noise_aug=audio_aug,
        )
    return cond_rows, audio_ref_rows, imgvid_aug, audio_aug


class _OpenNagInputs(NamedTuple):
    nag: nag_rules.Nag | None
    negative: dict[str, Any] | None
    model: Any
    positive: Any
    cond: dict[str, Any]
    planned: int
    device: Any


def _open_nag(inputs: _OpenNagInputs) -> Any:
    nag, negative, model, positive, cond, planned, device = inputs
    nag_session = None
    if nag is not None:
        if negative is None:
            raise RuntimeError("negative is unavailable in this stage")
        nag_session = NagSession(
            model,
            positive,
            nag,
            negative_hidden=negative["hidden_states"],
            negative_tags=negative["text_token_tags"],
            positive_text_tags=cond["text_token_tags"],
            steps=int(planned),
            device=device,
        )
    return nag_session


class _InitialTokensInputs(NamedTuple):
    video_noise: Any
    cond_rows: Any
    positive: Any
    audio_noise: Any
    audio_ref_rows: Any


def _initial_tokens(inputs: _InitialTokensInputs) -> tuple[Any, Any]:
    import torch

    video_noise, cond_rows, positive, audio_noise, audio_ref_rows = inputs
    initial_video = video_noise
    if cond_rows is not None:
        full = torch.zeros(
            int(positive.img_pos.shape[0]),
            video_noise.shape[1],
            dtype=torch.float32,
        )
        full[positive.update_mask] = video_noise
        initial_video = full
    initial_audio = audio_noise
    if audio_ref_rows is not None:
        full_a = torch.zeros(
            int(positive.audio_pos.shape[0]),
            audio_noise.shape[1],
            dtype=torch.float32,
        )
        full_a[positive.audio_update_mask] = audio_noise
        initial_audio = full_a
    return initial_video, initial_audio


class _PrepareDenoiseConditionInputs(NamedTuple):
    cond_payload: Path
    task: str
    ref_meta: dict[str, Any] | None
    run: StageRun
    conditioning: dict[str, Any]
    dims: LatentDims
    packed_doc: dict[str, Any]
    planned: int
    ref_payload: Path | None
    seed: int


class _DenoiseCondition(NamedTuple):
    cond: dict[str, Any]
    hidden: Any
    subblock: bool
    packed: dict[str, Any]
    tags: Any
    cond_rows: Any
    audio_ref_rows: Any
    imgvid_aug: float
    audio_aug: float


def _prepare_denoise_condition(
    inputs: _PrepareDenoiseConditionInputs,
    cache_policy: dict[str, Any] | None,
) -> _DenoiseCondition:
    (
        cond_payload,
        task,
        ref_meta,
        run,
        conditioning,
        dims,
        packed_doc,
        planned,
        ref_payload,
        seed,
    ) = inputs
    with dit_trace.scope("condition_prepare"):
        cond = load_tensors(cond_payload)
        hidden = cond["hidden_states"]
        blocks = ordered_condition_blocks(task, ref_meta)
        subblock = run.policy.attention_provider_effective == "subblock_sparse_attn"
        packed = build_packed(
            task,
            int(conditioning["text_len"]),
            dims,
            blocks,
            int(run.geometry["generated_frames"]),
            include_video_pos=subblock,  # SubBlock-eligible rows (S/stages/denoising.py:699-723)
        )
        tags = tagged(packed, cond["text_token_tags"])
        check_layout(str(packed_doc.get("layout_digest")), layout_digest(packed, tags))
        # ETA work before the loop, so an out-of-memory failure still reports its size; the memory risk
        # grows with the used rows (cu_seqlens = [0, used, seq_len]), the FLOPs with the padded seq_len
        seq_len, used_rows = int(packed["seq_len"]), int(packed["cu_seqlens"][1])
        ref_skip = _planned_ref_skip(run, packed, int(planned))
        if cache_policy is None:
            run.cost(
                "denoise",
                work=dit_flop(seq_len, int(planned), ref_skip=ref_skip).total,
                unit="flop",
                seq_len=seq_len,
                used_rows=used_rows,
                steps=int(planned),
                risk_measure=used_rows,
                risk_unit="row",
                **(
                    {}
                    if ref_skip is None
                    else {
                        "ref_kv_reduced_rows": ref_skip[0],
                        "ref_kv_skipped_steps": ref_skip[1],
                    }
                ),
            )

        # -- condition rows (CPU fp32, upstream order) --------------------------------
        cond_rows, audio_ref_rows, imgvid_aug, audio_aug = _prepare_reference_rows(
            _PrepareReferenceRowsInputs(ref_payload, blocks, task, dims, seed)
        )
    return _DenoiseCondition(
        cond,
        hidden,
        subblock,
        packed,
        tags,
        cond_rows,
        audio_ref_rows,
        imgvid_aug,
        audio_aug,
    )


class _DenoiseOutputMetadataInputs(NamedTuple):
    run: StageRun
    load_acceleration: Any
    fp8_runtime: Any
    mlp_chunk: Any
    ref_cache_report: dict[str, Any] | None
    task: str
    seed: int
    grid: SigmaGrid
    planned: int
    evaluations: dict[str, int]
    attention_report: dict[str, Any]
    active_backend: Any
    packed_doc: dict[str, Any]
    lora_heads: Any
    lora_runtime: Any
    nag_report: dict[str, Any] | None
    refine_facts: dict[str, Any] | None


def _denoise_output_metadata(
    inputs: _DenoiseOutputMetadataInputs,
    observed: dict[str, Any] | None,
    compiled: Any,
    cached: dict[str, Any] | None,
) -> tuple[dict[str, Any], Any]:
    (
        run,
        load_acceleration,
        fp8_runtime,
        mlp_chunk,
        ref_cache_report,
        task,
        seed,
        grid,
        planned,
        evaluations,
        attention_report,
        active_backend,
        packed_doc,
        lora_heads,
        lora_runtime,
        nag_report,
        refine_facts,
    ) = inputs
    acceleration: dict[str, Any] = {
        "mode": run.policy.mode,
        "load": None
        if not load_acceleration
        else {
            k: load_acceleration.get(k)
            for k in ("effective", "signature", "built", "adaln_relaxation")
        },
    }
    if fp8_runtime is not None:
        acceleration["fp8_linear"] = fp8_runtime
    if mlp_chunk["engaged"]:
        acceleration["mlp_token_chunk"] = mlp_chunk
        run.fact("MLP_TOKEN_CHUNK", mlp_chunk)
    if ref_cache_report is not None:
        acceleration["ref_kv_cache"] = ref_cache_report
        run.fact("REF_KV_CACHE", ref_cache_report)
    if observed is not None:
        run.fact("H3_ATTENTION_PROBE", observed)
    if compiled is not None:
        report = compiled.report()
        acceleration["regional_compile"] = {
            key: report[key]
            for key in (
                "requested",
                "effective",
                "region",
                "backend",
                "signatures",
                "fallbacks",
            )
        }
        run.fact("H3_REGIONAL_COMPILE", report)
        for sample in compiled.samples.values():
            run.fact("H3_COMPILE_SIGNATURE", sample)
    if cached is not None:
        acceleration["denoise_cache"] = cached
        run.fact("H3_DENOISE_CACHE", cached)
    metadata = {
        "task": task,
        "seed": str(seed),
        "rng": {
            "policy": "h3_native_fp32_draw_order_v1",
            "generator": "torch.Generator(cpu)",
            "order": ["video", "audio(reseeded)"],
        },
        "sigmas_digest": grid.sha256,
        "completed_updates": planned,
        "actual_dit_evaluations": evaluations["n"],
        "attention": {
            **attention_report,
            "requested": run.policy.attention_provider_requested,
            "effective": run.policy.attention_provider_effective,
            "active_backend": None
            if active_backend is None
            else str(getattr(active_backend, "name", active_backend)),
            "math_kernel_disabled": run.policy.reject_quadratic_materialization,
        },
        "acceleration": acceleration,
        "layout_digest": packed_doc.get("layout_digest"),
        "sglang": SGLANG_SOURCE_REVISION,
        "lora_merge_mode": None
        if run.policy.lora is None
        else run.policy.lora.merge_mode,
        "lora": None
        if run.policy.lora is None
        else {**run.policy.lora.as_dict(), **lora_heads, **(lora_runtime or {})},
    }
    if (
        nag_report is not None
    ):  # absent without NAG: the payload stays byte for byte the same
        metadata["nag"] = nag_report
        run.fact("NAG", nag_report)
    if (
        refine_facts is not None
    ):  # absent without refinement: the payload stays byte for byte the same
        metadata["refine"] = refine_facts
        run.fact("REFINE", refine_facts)
    return acceleration, metadata


class _PublishDenoisedLatentsInputs(NamedTuple):
    run: StageRun
    decls: Any
    metadata: dict[str, Any]
    audio_latent: Any
    video_latent: Any
    lora_runtime: Any
    acceleration: dict[str, Any]


def _publish_denoised_latents(inputs: _PublishDenoisedLatentsInputs) -> None:
    run, decls, metadata, audio_latent, video_latent, lora_runtime, acceleration = (
        inputs
    )
    with dit_trace.scope("output_serialize_fsync_hash"):
        payload_path = run.output_dir / "target_latents.payload.safetensors"
        with SafetensorsStreamWriter(
            payload_path, decls, metadata=payload_metadata(metadata)
        ) as writer:
            writer.write("audio_latent", tensor_bytes(audio_latent))
            writer.write("video_latent", tensor_bytes(video_latent))
        outputs, _ = finalize_tensor_bundle(
            run.output_dir,
            "target_latents",
            payload_path,
            decls,
            kind="video_latent",
            identity=run.bundle_identity(normalization_digest(run.plan)),
            metadata=metadata,
        )
    run.outputs.extend(outputs)
    run.fact(
        "DENOISE",
        {
            **{
                k: metadata[k]
                for k in (
                    "completed_updates",
                    "actual_dit_evaluations",
                    "attention",
                    "lora_merge_mode",
                )
            },
            "lora_runtime": lora_runtime,
        },
    )
    run.fact(
        "ACCELERATION_EFFECTIVE",
        {key: value for key, value in acceleration.items() if key != "denoise_cache"},
    )


class _PrepareTransformerRequestInputs(NamedTuple):
    run: StageRun
    model: Any
    device: Any
    planned: int
    packed: dict[str, Any]
    hidden: Any
    tags: Any
    cond: dict[str, Any]
    subblock: bool
    nag: nag_rules.Nag | None
    negative: dict[str, Any] | None
    video_noise: Any
    cond_rows: Any
    audio_noise: Any
    audio_ref_rows: Any


class _TransformerRequest(NamedTuple):
    lease: Any
    attention: Any
    lora_heads: Any
    lora_runtime: Any
    fp8_runtime: Any
    positive: Any
    ptd: Any
    ptd_refined: Any
    ref_cache: Any
    nag_session: Any
    initial_video: Any
    initial_audio: Any


def _prepare_transformer_request(
    inputs: _PrepareTransformerRequestInputs,
) -> _TransformerRequest:
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.denoise_loop import (
        MiniMaxH3DenoiseBranch,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.stages.denoising import (  # type: ignore[import-untyped]
        _precompute_refined_prompt_embeds,
        _precompute_rope_cache,
    )

    (
        run,
        model,
        device,
        planned,
        packed,
        hidden,
        tags,
        cond,
        subblock,
        nag,
        negative,
        video_noise,
        cond_rows,
        audio_noise,
        audio_ref_rows,
    ) = inputs
    with dit_trace.scope("request_prepare"):
        lease = run.provider.last_lease("transformer")
        check_resident_dit(
            getattr(getattr(lease, "handle", None), "facts", None), run.policy
        )
        # bind + verify the attention this run asked for (no silent fallback)
        attention = prepare_dit_attention(model, run.policy, device)
        lora_heads = verify_heads_installed(
            model, run.policy.lora, planned_updates=planned
        )
        lora_runtime = _prepare_lora_runtime(model, run.policy.lora)
        fp8_runtime = _prepare_fp8_runtime(model)
        positive = MiniMaxH3DenoiseBranch(
            packed=packed,
            text_embeddings=hidden,
            token_tags=tags,
            device=device,
            video_query_indices=subblock_video_query_indices(
                packed, cond["text_video_token_mask"]
            )
            if subblock
            else None,
        )
        ptd, ptd_refined = _ptd_prepare(
            model,
            positive,
            int(planned),
            device,
            run,
            refine=_precompute_refined_prompt_embeds,
        )
        if ptd is None:
            _precompute_refined_prompt_embeds(
                model, positive, device=device, shared_conditioning=None
            )
        _precompute_rope_cache(model, positive, device=device)
        ref_cache = _open_ref_kv_cache(run, model, positive, int(planned), device)
        nag_session = _open_nag(
            _OpenNagInputs(nag, negative, model, positive, cond, planned, device)
        )
        initial_video, initial_audio = _initial_tokens(
            _InitialTokensInputs(
                video_noise, cond_rows, positive, audio_noise, audio_ref_rows
            )
        )
    return _TransformerRequest(
        lease,
        attention,
        lora_heads,
        lora_runtime,
        fp8_runtime,
        positive,
        ptd,
        ptd_refined,
        ref_cache,
        nag_session,
        initial_video,
        initial_audio,
    )


class _StepCallbacksInputs(NamedTuple):
    evaluations: dict[str, int]
    ptd: Any
    ptd_refined: Any
    run: StageRun
    attention: Any
    device: Any
    planned: int


def _step_callbacks(
    inputs: _StepCallbacksInputs, observed: dict[str, Any] | None
) -> tuple[Any, Any, Any]:
    from sglang.multimodal_gen.runtime.managers.forward_context import (  # type: ignore[import-untyped]
        set_forward_context,
    )

    evaluations, ptd, ptd_refined, run, attention, device, planned = inputs

    def forward(model_: Any, kwargs: dict[str, Any], step: int) -> Any:
        evaluations["n"] += 1
        if ptd is not None:  # PTD: adapter k and its refined prompt at denoise step k
            ptd.set_hop(step)
            kwargs["prompt_embeds"] = ptd_refined[step]
        # a fresh sdpa_kernel context per forward (generator-based, not re-entrant)
        with (
            dit_trace.scope(f"forward/{step}"),
            set_forward_context(current_timestep=step, attn_metadata=None),
            _sdpa_guard(run),
        ):
            if observed is not None and evaluations["n"] == 1:
                with attention_probe.observe(kwargs, observed):
                    out = model_(**kwargs)
            else:
                out = model_(**kwargs)
        attention.after_forward(step)  # fp8_fa_sm120 must engage on the first forward
        return out

    timer = StepTimer(device)

    def on_step(step: int, _video: Any, _audio: Any) -> None:
        timer.mark()  # device-timeline end of this update (no synchronize inside the loop)
        run.progress(
            "denoise",
            "updates",
            step + 1,
            planned,
            completed_updates=step + 1,
            planned_updates=planned,
            actual_dit_evaluations=evaluations["n"],
        )
        run.check_cancel()  # safe boundary: between updates

    run.progress(
        "denoise",
        "updates",
        0,
        planned,
        completed_updates=0,
        planned_updates=planned,
        actual_dit_evaluations=0,
    )
    return forward, timer, on_step


class _DenoiseReportsInputs(NamedTuple):
    model: Any
    attention: Any
    planned: int
    run: StageRun
    ref_cache: Any
    nag_session: Any
    negative: dict[str, Any] | None
    lease: Any


def _denoise_reports(inputs: _DenoiseReportsInputs) -> tuple[Any, Any, Any, Any, Any]:
    model, attention, planned, run, ref_cache, nag_session, negative, lease = inputs
    active_backend = getattr(model, "_resolved_attention_backend", None)
    attention_report = attention.report()
    for text in attention.warnings(planned):
        run.warn("ATTENTION_EFFECTIVE", text)
    ref_cache_report = None if ref_cache is None else ref_cache.report()
    nag_report = None
    if nag_session is not None:
        if negative is None:
            raise RuntimeError("negative is unavailable in this stage")
        nag_report = {
            **nag_session.report(),
            "negative_payload_sha256": negative["payload_sha256"],
        }
    for text in [] if ref_cache is None else ref_cache.warnings():
        run.warn("REF_KV_CACHE", text)
    load_acceleration = dict(
        getattr(getattr(lease, "handle", None), "facts", {}) or {}
    ).get("acceleration")
    return (
        active_backend,
        attention_report,
        ref_cache_report,
        nag_report,
        load_acceleration,
    )


def _compile_context(run: StageRun, model: Any) -> Any:
    option = run.policy.effective_profile.get("compile") or {}
    if option.get("mode") == "regional":
        return import_module("..regional_compile", __package__).active(
            run, model, option
        )
    return contextlib.nullcontext(None)
