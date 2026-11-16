"""``H3Adapter``: resolves an H3 job request into geometry, sigma schedule and material plan (torch-free)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from phasyn_h3.recipe.abi.errors import SemanticError
from phasyn_h3.recipe.abi.execution_target import execution_target_diagnostics
from phasyn_h3.recipe.abi.resolve import ModelInputPlan, ResolveContext
from phasyn_h3.recipe.abi.values import get_path

from . import constants as C
from ._diag import UNSUPPORTED, err, errors, non_errors, prefixed
from .geometry import RUNTIME_BOUNDS, align_up, build_geometry, latent_frame_rows, token_counts
from .job_rules import context_diagnostics, validate_job_semantics
from .lora_rules import lora_plan_facts, validate_lora_bindings
from .loras import bindings_pdd_blocks
from .materials import (
    MAX_REFERENCE_IMAGE_ROWS,
    condition_noise_plan,
    generated_seconds_of,
    normalize_materials,
    reference_clip_diagnostics,
)
from .profile_rules import facts_by_kind, validate_profile
from .schedule import build_schedule

# Qwen3-VL image processor (H3:FL2VA/processor/preprocessor_config.json): patch 16, merge 2,
# 65,536..16,777,216 pixels.  A 32-aligned canvas inside that range keeps its size, so an image
# contributes (H/32)*(W/32) pads; smaller canvases are upscaled to >= 65,536 px, which with
# ratio <= 4 and ceil-to-32 rounding is at most 64 + 20 + 1 = 85 pads.
_MIN_IMAGE_PADS_BOUND = 85


def _text_token_bound(
    request: Mapping[str, Any], materials: Sequence[Mapping[str, Any]], geometry: Mapping[str, Any], limit: int
) -> int:
    """Tight, still-safe bound of the Qwen sequence S used by the estimates.

    Verbatim prompts only: Qwen's byte-level BPE never yields more tokens than UTF-8 bytes
    (SG:presentation.py:30-31,109-131); labels ``<Picture i>: ``/``<Audio j>: `` are text, an image
    adds vision_start + pads + vision_end.  Video presentations (timestamped blocks) and rewritten
    contexts are not bounded here -> ``encoder_max_tokens``.
    """
    if get_path(request, "prompt.context_mode", "verbatim") != "verbatim":
        return limit
    total = len(str(get_path(request, "prompt.text", "") or "").encode("utf-8"))
    canvas_pads = max(_MIN_IMAGE_PADS_BOUND, latent_frame_rows(int(geometry["width"]), int(geometry["height"])))
    for material in materials:
        for item in material.get("presentation") or []:
            total += len(f"{item['label']}: ".encode())
            if item["modality"] == "video":
                return limit
            if item["modality"] == "image":
                if material.get("condition_role") == "keyframe":
                    pads = canvas_pads
                else:
                    known = (material.get("token_rows") or {}).get("visual")
                    pads = max(_MIN_IMAGE_PADS_BOUND, known) if known else MAX_REFERENCE_IMAGE_ROWS
                total += 2 + pads
    return max(1, min(limit, total))


class H3Adapter:
    """Plan resolution for MiniMax H3 (pure Python; every rule error is a :class:`SemanticError`)."""

    def resolve(self, ctx: ResolveContext) -> ModelInputPlan:
        request, model, profile = ctx.request, ctx.model, ctx.profile
        config = ctx.config or {}
        variant = model.get("variant")
        runtime = profile.get("runtime_provider")
        task = request.get("task")
        model_facts = getattr(ctx, "model_facts", None) or {}

        diags: list[dict[str, Any]] = execution_target_diagnostics(request, str(model.get("family", C.FAMILY)))
        if model.get("family", C.FAMILY) != C.FAMILY:
            diags.append(err(UNSUPPORTED, f"模型 family {model.get('family')} 不是 MiniMax H3", "model_id"))
        supported = model.get("supported_tasks") or C.VARIANT_TASKS.get(str(variant), ())
        if (
            isinstance(task, str)
            and task in C.TASK_VARIANT
            and C.TASK_VARIANT[task] == variant
            and task not in supported
        ):
            diags.append(err(UNSUPPORTED, f"此模型未宣告支援 task {task}", "task", "model_id"))
        diags.extend(validate_job_semantics(request, variant, config=config, runtime_provider=runtime))
        diags.extend(prefixed(validate_profile(profile, model=model, model_facts=model_facts), "profile"))
        lora_bindings = list(getattr(ctx, "lora_bindings", None) or [])
        diags.extend(
            validate_lora_bindings(profile, lora_bindings, request=request, model=model, model_facts=model_facts)
        )
        materials = list(request.get("materials") or [])
        noise, noise_diags = condition_noise_plan(materials)
        diags.extend(noise_diags)
        if task == "ref2va":
            diags.extend(
                reference_clip_diagnostics(
                    materials,
                    ctx.material_metadata or {},
                    generated_seconds=generated_seconds_of(request.get("output") or {}),
                )
            )

        sampling = request.get("sampling") or {}
        schedule = payload = sigma_facts = None
        if not errors(diags):
            try:
                schedule, payload, sigma_facts = build_schedule(
                    steps=int(sampling["steps"]),
                    video_shift=sampling["video_shift"],
                    audio_shift=sampling["audio_shift"],
                    # a PDD manifest's non-uniform pdd.blocks: the grid is its block boundaries (None = uniform)
                    pdd_blocks=bindings_pdd_blocks(lora_bindings),
                )
            except (ValueError, KeyError) as exc:
                diags.append(
                    err(
                        UNSUPPORTED,
                        f"sigma grid 不符合釘版契約（RULE-017）：{exc}",
                        "sampling.steps",
                        "sampling.video_shift",
                        "sampling.audio_shift",
                    )
                )
        if errors(diags):
            raise SemanticError(errors(diags) + non_errors(diags))

        output = request["output"]
        latent_dtype = "BF16" if (profile.get("vae") or {}).get("transfer_dtype") == "bf16" else C.LATENT_WIRE_DTYPE
        geometry, _ = build_geometry(
            requested_seconds=output["requested_seconds"],
            width=output["width"],
            height=output["height"],
            duration_policy=output["duration_policy"],
            runtime_provider=runtime,
            fps=output.get("fps", C.FPS),
            latent_dtype=latent_dtype,
        )
        assert geometry is not None and schedule is not None and payload is not None
        from .geometry import reference_image_short_edge

        image_edge = reference_image_short_edge(config.get("reference_image_short_edge"))
        if image_edge is not None:
            if task != "ref2va" or not any(m.get("role") == "reference_image" for m in materials):
                raise ValueError("reference_image_short_edge=1024 requires Ref2VA reference_image")
            geometry["reference_image_short_edge"] = image_edge
        material_plan, material_facts, material_warnings = normalize_materials(
            str(task), materials, geometry=geometry, metadata=ctx.material_metadata
        )
        for entry in material_plan:
            cls = "audio" if entry["role"] == "reference_audio" else "imgvid"
            entry["condition_noise"] = noise[cls]
            entry["condition_noise_source"] = noise[f"{cls}_source"]
        _, context = context_diagnostics(request, config)

        counts = token_counts(geometry)
        limit = int(get_path(profile, "limits.encoder_max_tokens", 32768))
        text_bound = _text_token_bound(request, material_plan, geometry, limit)
        refs_used = (
            material_facts["N_references_estimate"]
            if material_facts["N_references_estimate"] is not None
            else material_facts["N_references_upper_bound"]
        )
        bounds = RUNTIME_BOUNDS[str(runtime)]
        facts: dict[str, Any] = {
            "task": task,
            "model_variant": variant,
            "runtime_provider": runtime,
            "seed": sampling.get("seed"),
            **counts,
            "N_text": limit,
            "N_text_estimate_bound": text_bound,
            **material_facts,
            "N_packed": align_up(
                limit
                + material_facts["N_keyframe_cond"]
                + material_facts["N_references_upper_bound"]
                + counts["N_audio"]
                + counts["N_video"]
            ),
            "N_packed_estimate_bound": align_up(
                text_bound + material_facts["N_keyframe_cond"] + refs_used + counts["N_audio"] + counts["N_video"]
            ),
            "packed_alignment": C.PACKED_ALIGNMENT,
            "latent_bytes": {
                "video": C.VIDEO_LATENT_CHANNELS
                * geometry["video_latent_shape"][2]
                * geometry["video_latent_shape"][3]
                * geometry["video_latent_shape"][4]
                * 4,
                "audio": C.AUDIO_CHANNELS * geometry["audio_latent_shape"][2] * C.AUDIO_LATENT_CHANNELS * 4,
            },
            "condition_noise": noise,
            "context": context,
            "sigma": sigma_facts,
            "rng": {
                "policy_id": C.RNG_POLICY_ID,
                "video_noise": "CPU torch.Generator().manual_seed(seed); randn [1,24,T,H/16,W/16] fp32, drawn first",
                "audio_noise": "independent CPU generator re-seeded with seed; randn [2*T_audio,32] fp32",
                "condition_noise_seeds": {"imgvid": "seed", "audio": "seed+1"},
                "source": "SG:stages/latent_preparation.py:69-131; SG:condition_noise.py:100,177",
                "cross_sm_bitwise": False,
            },
            "duration_bounds": {
                "official_requested": [C.MIN_DURATION_SECONDS, C.MAX_DURATION_SECONDS],
                "runtime": {
                    "runtime_provider": bounds.runtime_provider,
                    "requested_seconds": list(bounds.requested_seconds),
                    "generated_frames": list(bounds.generated_frames),
                    "generated_seconds": list(bounds.generated_seconds),
                    "source": bounds.source,
                },
            },
            "model_facts_applied": sorted(f["component_id"] for f in facts_by_kind(model_facts, model).values()),
            "lora": lora_plan_facts(profile, lora_bindings),
            "upstream": {
                "sglang_revision": C.SGLANG_REVISION,
                "h3_git_revision": C.H3_GIT_REVISION,
                "hf_snapshot": C.SOURCE_REVISION,
            },
        }
        return ModelInputPlan(
            geometry=geometry,
            schedule=schedule,
            sigma_payload=payload,
            materials=material_plan,
            diagnostics=non_errors(diags) + material_warnings,
            facts=facts,
        )


__all__ = ["H3Adapter"]
