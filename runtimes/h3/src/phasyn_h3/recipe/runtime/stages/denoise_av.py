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
from typing import Any

from phasyn_h3.recipe.abi.stage import StageResult

from .. import SGLANG_SOURCE_REVISION, dit_trace
from ..bundles import SafetensorsStreamWriter, TensorDecl, finalize_tensor_bundle, payload_metadata
from ..errors import InvalidStageInput, UnsupportedCombination
from ..lora_policy import LORA_ACCUMULATE, check_lora_schedule, specs_of
from ..measure import StepTimer, dit_flop
from ..pdd import check_pdd_schedule, verify_heads_installed
from ..sigmas import load_sigma_grid
from .assemble_inputs import load_conditioning, load_references
from .common import StageRun, requested, seed_of, task_of
from .layout import build_packed, check_layout, latent_dims, layout_digest, ordered_condition_blocks, tagged
from .normalization import normalization_digest
from .tensor_io import load_tensors, tensor_bytes


def _sdpa_guard(run: StageRun) -> Any:
    """Forbid the O(N²) MATH SDPA kernel when the profile says so.

    Also covers the approximate providers: their excluded/dense region and
    fallbacks run Torch SDPA (acceleration.SDPA_BACKED_PROVIDERS).
    """
    from ..acceleration import SDPA_BACKED_PROVIDERS

    if (
        run.policy.attention_provider_effective not in SDPA_BACKED_PROVIDERS
        or not run.policy.reject_quadratic_materialization
    ):
        return contextlib.nullcontext()
    from torch.nn.attention import SDPBackend, sdpa_kernel

    return sdpa_kernel([SDPBackend.FLASH_ATTENTION, SDPBackend.EFFICIENT_ATTENTION, SDPBackend.CUDNN_ATTENTION])


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
    return dit_trace.run_stage(run, _run)


def _run(run: StageRun) -> StageResult:
    import torch
    from sglang.multimodal_gen.runtime.managers.forward_context import set_forward_context
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.condition_noise import (
        minimax_h3_audio_cond_noise_aug_rows,
        minimax_h3_imgvid_cond_noise_aug_rows,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.denoise_loop import (
        MINIMAX_H3_AUDIO_REF_COND_TIMESTEP,
        MINIMAX_H3_IMGVID_COND_TIMESTEP,
        MiniMaxH3DenoiseBranch,
        minimax_h3_denoise_loop,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_tokens import (
        minimax_h3_patchify_video_latent,
        minimax_h3_unpatchify_video_tokens,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.stages.denoising import (
        _precompute_refined_prompt_embeds,
        _precompute_rope_cache,
    )

    with dit_trace.scope("input_read_validate"):
        task = task_of(run.plan)
        dims = latent_dims(run.geometry)
        seed = seed_of(run.plan)
        _condition_noise(run)
        packed_doc = run.read_json_input("packed")
        assert packed_doc is not None
        conditioning, cond_payload = load_conditioning(run)
        references, ref_payload, ref_meta = load_references(run)
        grid = load_sigma_grid(run.sigmas_input().path, run.plan.get("schedule") or {})
        for name, expected, actual in (
            ("conditioning_payload", packed_doc.get("conditioning_payload"), conditioning["payload"]["sha256"]),
            (
                "references_payload",
                packed_doc.get("references_payload"),
                None if references is None else references["payload"]["sha256"],
            ),
            ("sigmas_digest", packed_doc.get("sigmas_digest"), grid.sha256),
        ):
            if expected != actual:
                raise InvalidStageInput(
                    "PACKED_INPUT_DRIFT", f"packed.{name} 與實際輸入不符", expected=str(expected), actual=str(actual)
                )
        planned = grid.updates
        # LoRA steps/shifts are training contracts; PDD also needs its block boundaries (before any GPU work)
        check_lora_schedule(run.policy.lora, updates=planned, schedule=run.plan.get("schedule") or {})
        for spec in specs_of(run.policy.lora):
            check_pdd_schedule(grid.video, grid.audio, spec)

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
        run.cost(
            "denoise",
            work=dit_flop(seq_len, int(planned), ref_skip=ref_skip).total,
            unit="flop",
            seq_len=seq_len,
            used_rows=used_rows,
            steps=int(planned),
            risk_measure=used_rows,
            risk_unit="row",
            **({} if ref_skip is None else {"ref_kv_reduced_rows": ref_skip[0], "ref_kv_skipped_steps": ref_skip[1]}),
        )

        # -- condition rows (CPU fp32, upstream order) --------------------------------
        ref = load_tensors(ref_payload) if ref_payload is not None else {}
        visual_rows = [
            minimax_h3_patchify_video_latent(ref[name].to(torch.float32), patch_size=[1, 2, 2]).to(torch.float32)
            for name in blocks["visual_tensors"]
        ]
        audio_rows = [ref[name][0].reshape(-1, 32).to(torch.float32) for name in blocks["audio_tensors"]]
        cond_rows = torch.cat(visual_rows, dim=0) if visual_rows else None
        audio_ref_rows = torch.cat(audio_rows, dim=0) if audio_rows else None
        imgvid_aug = float(MINIMAX_H3_IMGVID_COND_TIMESTEP)
        audio_aug = float(MINIMAX_H3_AUDIO_REF_COND_TIMESTEP)
        if cond_rows is not None and imgvid_aug < 1.0:
            if task == "fl2va":
                shapes = [(1, int(b["latent_h"]), int(b["latent_w"])) for b in blocks["keyframes"]]
            else:
                shapes = [
                    (
                        int(b.get("latent_t", 1)) if b["kind"] in ("video", "video_audio") else 1,
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
            lengths = [int(b["ref_audio_t"]) for b in blocks["ref2va_blocks"] if int(b.get("ref_audio_t", 0)) > 0]
            audio_ref_rows = minimax_h3_audio_cond_noise_aug_rows(
                audio_ref_rows, condition_audio_t=lengths, seed=int(seed), noise_aug=audio_aug
            )

    # -- initial noise (latent_preparation.py:115-131) -----------------------------
    with dit_trace.scope("noise_cpu"):
        noise_started = time.perf_counter()
        gen_v = torch.Generator().manual_seed(int(seed))
        video_tensor = torch.randn(
            1, 24, dims.latent_t, dims.latent_h, dims.latent_w, generator=gen_v, dtype=torch.float32
        )
        video_noise = minimax_h3_patchify_video_latent(video_tensor, patch_size=[1, 2, 2]).to(torch.float32)
        gen_a = torch.Generator().manual_seed(int(seed))
        audio_noise = torch.randn(dims.audio_t * 2, 32, generator=gen_a, dtype=torch.float32)
        del video_tensor
        noise_seconds = time.perf_counter() - noise_started  # CPU generator on the render node

    evaluations = {"n": 0}
    with dit_trace.scope("component_use"), run.provider.use_component(run, "transformer") as model:
        device = run.provider.torch_device()
        if getattr(model, "training", False):
            model.eval()
        from ..accel_load import check_resident_dit
        from ..attention_runtime import prepare_dit_attention, subblock_video_query_indices

        with dit_trace.scope("request_prepare"):
            lease = run.provider.last_lease("transformer")
            check_resident_dit(getattr(getattr(lease, "handle", None), "facts", None), run.policy)
            # bind + verify the attention this run asked for (no silent fallback)
            attention = prepare_dit_attention(model, run.policy, device)
            lora_heads = verify_heads_installed(model, run.policy.lora, planned_updates=planned)
            lora_runtime = _prepare_lora_runtime(model, run.policy.lora)
            fp8_runtime = _prepare_fp8_runtime(model)
            positive = MiniMaxH3DenoiseBranch(
                packed=packed,
                text_embeddings=hidden,
                token_tags=tags,
                device=device,
                video_query_indices=subblock_video_query_indices(packed, cond["text_video_token_mask"])
                if subblock
                else None,
            )
            _precompute_refined_prompt_embeds(model, positive, device=device, shared_conditioning=None)
            _precompute_rope_cache(model, positive, device=device)
            ref_cache = _open_ref_kv_cache(run, model, positive, int(planned), device)
            initial_video = video_noise
            if cond_rows is not None:
                full = torch.zeros(int(positive.img_pos.shape[0]), video_noise.shape[1], dtype=torch.float32)
                full[positive.update_mask] = video_noise
                initial_video = full
            initial_audio = audio_noise
            if audio_ref_rows is not None:
                full_a = torch.zeros(int(positive.audio_pos.shape[0]), audio_noise.shape[1], dtype=torch.float32)
                full_a[positive.audio_update_mask] = audio_noise
                initial_audio = full_a

        def forward(model_: Any, kwargs: dict[str, Any], step: int) -> Any:
            evaluations["n"] += 1
            # a fresh sdpa_kernel context per forward (generator-based, not re-entrant)
            with (
                dit_trace.scope(f"forward/{step}"),
                set_forward_context(current_timestep=step, attn_metadata=None),
                _sdpa_guard(run),
            ):
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
            "denoise", "updates", 0, planned, completed_updates=0, planned_updates=planned, actual_dit_evaluations=0
        )
        attention.mark_loop_start()
        with dit_trace.scope("pre_loop_sync"):
            run.provider.backend.synchronize()
        with dit_trace.scope("loop"), contextlib.nullcontext() if ref_cache is None else ref_cache.active():
            wall_started = time.perf_counter()
            timer.mark()
            video_rows, audio_rows_out = minimax_h3_denoise_loop(
                model=model,
                model_forward=forward if ref_cache is None else ref_cache.wrap_forward(forward),
                positive=positive,
                initial_video_rows=initial_video,
                initial_audio_rows=initial_audio,
                keyframe_cond_rows=cond_rows,
                audio_ref_rows=audio_ref_rows,
                sigmas_video=list(grid.video),
                sigmas_audio=list(grid.audio),
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
        active_backend = getattr(model, "_resolved_attention_backend", None)
        attention_report = attention.report()
        for text in attention.warnings(planned):
            run.warn("ATTENTION_EFFECTIVE", text)
        ref_cache_report = None if ref_cache is None else ref_cache.report()
        for text in [] if ref_cache is None else ref_cache.warnings():
            run.warn("REF_KV_CACHE", text)
        load_acceleration = dict(getattr(getattr(lease, "handle", None), "facts", {}) or {}).get("acceleration")
        target_video = video_rows[positive.video_target_slice]
        target_audio = audio_rows_out[positive.audio_target_slice]
    with dit_trace.scope("latent_d2h"):
        video_latent = minimax_h3_unpatchify_video_tokens(
            target_video.float(),
            latent_shape=[dims.latent_t, dims.latent_h // 2, dims.latent_w // 2, 24],
            patch_size=[1, 2, 2],
        ).cpu()
        audio_latent = target_audio.float().reshape(1, 2, dims.audio_t, 32).cpu()
    for name, tensor in (("video_latent", video_latent), ("audio_latent", audio_latent)):
        if not bool(torch.isfinite(tensor).all()):
            raise InvalidStageInput("LATENT_NONFINITE", f"{name} 含 NaN/Inf；不輸出")
    decls = [
        TensorDecl("audio_latent", "F32", tuple(int(d) for d in audio_latent.shape), "B,C,T,D"),
        TensorDecl("video_latent", "F32", tuple(int(d) for d in video_latent.shape), "B,C,T,H,W"),
    ]
    if list(video_latent.shape) != list(run.geometry["video_latent_shape"]) or list(audio_latent.shape) != list(
        run.geometry["audio_latent_shape"]
    ):
        raise InvalidStageInput("LATENT_SHAPE_DRIFT", "輸出 latent 形狀與 plan geometry 不符")
    # effective approximate knobs + what SGLang built (accel_load), for provenance
    acceleration: dict[str, Any] = {
        "mode": run.policy.mode,
        "load": None
        if not load_acceleration
        else {k: load_acceleration.get(k) for k in ("effective", "signature", "built", "adaln_relaxation")},
    }
    if fp8_runtime is not None:
        acceleration["fp8_linear"] = fp8_runtime
    if ref_cache_report is not None:
        acceleration["ref_kv_cache"] = ref_cache_report
        run.fact("REF_KV_CACHE", ref_cache_report)
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
            "active_backend": None if active_backend is None else str(getattr(active_backend, "name", active_backend)),
            "math_kernel_disabled": run.policy.reject_quadratic_materialization,
        },
        "acceleration": acceleration,
        "layout_digest": packed_doc.get("layout_digest"),
        "sglang": SGLANG_SOURCE_REVISION,
        "lora_merge_mode": None if run.policy.lora is None else run.policy.lora.merge_mode,
        "lora": None
        if run.policy.lora is None
        else {**run.policy.lora.as_dict(), **lora_heads, **(lora_runtime or {})},
    }
    with dit_trace.scope("output_serialize_fsync_hash"):
        payload_path = run.output_dir / "target_latents.payload.safetensors"
        with SafetensorsStreamWriter(payload_path, decls, metadata=payload_metadata(metadata)) as writer:
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
            **{k: metadata[k] for k in ("completed_updates", "actual_dit_evaluations", "attention", "lora_merge_mode")},
            "lora_runtime": lora_runtime,
        },
    )
    run.fact("ACCELERATION_EFFECTIVE", acceleration)
    # timing stays out of the bundle metadata (the payload must not change between identical runs)
    dynamic = lora_runtime is not None and lora_runtime.get("accumulate") == LORA_ACCUMULATE
    lora_rank = max((spec.rank for spec in specs_of(run.policy.lora)), default=0) if dynamic else 0
    run.cost_seconds("denoise", sum(per_step_seconds) if per_step_seconds else loop_wall_seconds)
    run.measure(
        compute_seconds=sum(per_step_seconds) if per_step_seconds else loop_wall_seconds,
        per_step_seconds=per_step_seconds,
        flop=dit_flop(
            int(packed["seq_len"]),
            evaluations["n"],
            lora_rank=lora_rank or None,
            ref_skip=None if ref_cache is None else ref_cache.flop_skip(),
        ),
        loop_wall_seconds=round(loop_wall_seconds, 6),
        noise_seconds=round(noise_seconds, 6),
        step_timer="cuda_events" if per_step_seconds and getattr(device, "type", "") == "cuda" else "perf_counter",
    )
    return run.result()


def _planned_ref_skip(run: StageRun, packed: Any, planned: int) -> tuple[int, int] | None:
    """(reduced rows, skipped steps) of the planned ``ref_kv_cache`` run for the ETA work record; None when off."""
    if run.policy.ref_kv_cache is None:
        return None
    from ..ref_kv_cache import planned_skip

    return planned_skip(packed, run.policy.ref_kv_cache, planned)


def _open_ref_kv_cache(run: StageRun, model: Any, positive: Any, planned: int, device: Any) -> Any:
    """The reference-row K/V cache of this loop (``ref_kv_cache.RefKvSession``); None when the option is off.

    Built after ``prepare_dit_attention`` and both precomputes: it checks the bound backends and reads the
    branch's final static kwargs, and refuses (before step 0) what it cannot serve.
    """
    if run.policy.ref_kv_cache is None:
        return None
    from ..ref_kv_cache import RefKvSession

    return RefKvSession(model, positive, run.policy.ref_kv_cache, steps=planned, device=device)


def _prepare_lora_runtime(model: Any, policy: Any) -> dict[str, Any] | None:
    """Re-chunk the resident DiT's in-place LoRA wrappers for this plan (``lora_inplace``)."""
    if policy is None:
        return None
    if policy.merge_mode != "dynamic":
        return {"accumulate": "merged"}
    from ..lora_inplace import call_counts, set_chunk_tokens

    wrapped = set_chunk_tokens(model, policy.chunk_tokens)
    if wrapped == 0:
        raise UnsupportedCombination(
            "LORA_NOT_ATTACHED", "plan 有 dynamic LoRA，但常駐 DiT 沒有 in-place LoRA wrapper（元件身分與 plan 不符）"
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
    from ..fp8_linear import KERNEL_ID, call_counts

    return {"kernel": KERNEL_ID, "layers": layers, "_calls_before": call_counts(model)}


def _finish_fp8_runtime(model: Any, state: dict[str, Any] | None, evaluations: int) -> dict[str, Any] | None:
    if state is None:
        return None
    from ..fp8_linear import call_counts

    calls = call_counts(model) - int(state.pop("_calls_before"))
    if evaluations > 0 and calls == 0:
        raise UnsupportedCombination(
            "FP8_KERNEL_NOT_ENGAGED", f"DiT 有 {state['layers']} 個 FP8 層，但 forward 沒有經過 {state['kernel']}"
        )
    return {**state, "calls": calls}


def _finish_lora_runtime(model: Any, state: dict[str, Any] | None, evaluations: int) -> dict[str, Any] | None:
    if state is None or "_calls_before" not in state:
        return state
    from ..lora_inplace import call_counts

    calls = call_counts(model) - int(state.pop("_calls_before"))
    if evaluations > 0 and calls == 0:
        raise UnsupportedCombination("LORA_TERM_NOT_APPLIED", "DiT forward 沒有經過任何 in-place LoRA wrapper")
    return {**state, "inplace_calls": calls}


__all__ = ["run"]
