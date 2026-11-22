"""prepare_adaln: AdaLN cache provisioning check (metadata only, no GPU).

Upstream fills AdaLN plans inside the resident DiT right before the loop
(``minimax_h3.py:1977-2006``, ``S/denoise_loop.py:544-547``), so nothing
transferable can be produced here.  This stage:

* re-validates mode compatibility (quant / pruned curve / LoRA,:
  an adaln-touching LoRA needs a sidecar whose metadata ``lora_signature`` equals the plan's,
  see ``adaln_sidecar``; LoRAs without adaln factors share the base cache);
* derives every step's unique fp32 timestep plan exactly like the loop
  (``S/denoise_loop.py:359-443``) from the authoritative plan sigma grid;
* computes the cache key (an AdaLN plan cache is not a generic layer cache);
* for ``fixed`` mode, checks on the CPU that the sidecar
  (``minimax_h3_adaln_cache.py:456-486`` header) covers every plan →
  ``ADALN_CACHE_MISS`` before any DiT load; never interpolates.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from phasyn_components.model_identity import display_path

from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.abi.stage import StageResult
from phasyn_h3.recipe.abi.tensors import read_header_from_file

from .. import PROVIDER_VERSION, SGLANG_SOURCE_REVISION
from ..bundles import write_metadata_output
from ..errors import IntegrityMismatch, ModelFilesMissing, UnsupportedCombination
from ..lora_policy import (
    LORA_ACCUMULATE as RUNTIME_LORA_ACCUMULATE,
    SIDECAR_LORA_ACCUMULATE_KEY,
    adaln_signature_of,
)
from ..model_root import model_root
from ..sigmas import (
    AUDIO_REF_COND_TIMESTEP,
    IMGVID_COND_TIMESTEP,
    check_sidecar_coverage,
    load_sigma_grid,
    plan_key,
    read_tensor,
    sidecar_keys,
    step_unique_timesteps,
)
from .common import StageRun, contributes_audio, task_of


_MAX_INLINE_SCALAR_WIDTH = 4


ADALN_CACHE_ROOT_ENV = "PHASYN_ADALN_CACHE_ROOT"
# extra sidecar metadata written by phasyn_h3.recipe.runtime.adaln_sidecar (upstream ignores it)
SIDECAR_LORA_SIGNATURE_KEY = "lora_signature"


def sidecar_path(cache_ref: str) -> Path:
    """``<PHASYN_ADALN_CACHE_ROOT or model root/adaln-cache>/<cache_ref>.safetensors`` (must exist)."""
    raw = os.environ.get(ADALN_CACHE_ROOT_ENV)
    models = model_root()
    if (
        not cache_ref
        or cache_ref in (".", "..")
        or "/" in cache_ref
        or "\\" in cache_ref
    ):
        raise ModelFilesMissing(
            "ADALN_SIDECAR_MISSING", "AdaLN sidecar 的 cache_ref 必須是名稱，不是路徑"
        )
    path = (Path(raw) if raw else models / "adaln-cache") / f"{cache_ref}.safetensors"
    if not path.is_file():
        raise ModelFilesMissing(
            "ADALN_SIDECAR_MISSING",
            f"AdaLN sidecar 不存在：{display_path(path, models)}（不自動建立或下載）",
        )
    return path


def condition_flags(prepared: dict[str, Any] | None, task: str) -> tuple[bool, bool]:
    """Determine the conditioning branches required by the job."""
    materials = (prepared or {}).get("materials") or []
    visual = any(m.get("material_chain") != "audio" for m in materials) and task in (
        "fl2va",
        "ref2va",
    )
    audio = any(contributes_audio(m) for m in materials) and task == "ref2va"
    return visual, audio


def run(run: StageRun) -> StageResult:
    """Prepare the AdaLN entries for the scheduled steps."""
    mode = run.policy.adaln_mode
    task = task_of(run.plan)
    prepared = run.read_json_input("prepared", required=False)
    grid = load_sigma_grid(run.sigmas_input().path, run.plan.get("schedule") or {})
    visual, audio = condition_flags(prepared, task)
    plans = step_unique_timesteps(
        grid, has_visual_condition=visual, has_audio_reference=audio
    )
    transformer: dict[str, Any] = next(
        (
            c
            for c in (run.plan.get("model") or {}).get("components", [])
            if c.get("kind") == "transformer"
        ),
        {},
    )
    lora_signature = adaln_signature_of(run.policy.lora)
    key = canonical_digest(
        {
            "checkpoint": {
                "component_id": transformer.get("component_id"),
                "revision": (run.plan.get("model") or {}).get("source_revision"),
                "file_manifest": transformer.get("file_manifest"),
                "config_digest": transformer.get("config_digest"),
            },
            "variant": (run.plan.get("model") or {}).get("variant"),
            "geometry": {
                k: run.geometry.get(k)
                for k in ("width", "height", "video_latent_shape", "audio_latent_shape")
            },
            "sigmas_digest": grid.sha256,
            "condition_noise": {
                "imgvid": IMGVID_COND_TIMESTEP if visual else None,
                "audio": AUDIO_REF_COND_TIMESTEP if audio else None,
            },
            "dtype": run.policy.components["transformer"].compute_dtype,
            "runtime": {
                "provider_version": PROVIDER_VERSION,
                "sglang": SGLANG_SOURCE_REVISION,
            },
            # only LoRAs that touch adaln_proj change AdaLN outputs (Turbo shares the base cache)
            "lora": lora_signature,
        }
    )
    document: dict[str, Any] = {
        "schema_version": "1.0",
        "kind": "h3_adaln_provision",
        "mode": mode,
        "cache_key": key,
        "steps": len(plans),
        "plan_width": max((len(p) for p in plans), default=0),
        "plan_keys_digest": canonical_digest([list(plan_key(p)) for p in plans]),
        "sigmas_digest": grid.sha256,
        "lora_signature": lora_signature,
    }
    if mode == "off":
        document["note"] = "profile AdaLN off；此 stage 應由 plan 省略"
    elif mode == "fixed":
        cache_ref = (run.policy.effective_profile.get("adaln") or {}).get("cache_ref")
        path = sidecar_path(str(cache_ref))
        header = read_header_from_file(path)
        variant = header.metadata.get("model_variant")
        expected_variant = str((run.plan.get("model") or {}).get("variant", "")).lower()
        if variant is not None and variant != expected_variant:
            raise IntegrityMismatch(
                "ADALN_SIDECAR_VARIANT",
                f"sidecar model_variant={variant} ≠ {expected_variant}",
                expected=expected_variant,
                actual=variant,
            )
        # an AdaLN-touching LoRA needs a sidecar built with it; a
        # base sidecar has no signature ("none") and serves base runs and Turbo alike
        sidecar_signature = header.metadata.get(SIDECAR_LORA_SIGNATURE_KEY, "none")
        if sidecar_signature != lora_signature:
            raise IntegrityMismatch(
                "ADALN_SIDECAR_LORA_MISMATCH",
                f"sidecar {cache_ref} 的 lora_signature 與 plan 不符（觸及 adaln_proj 的 LoRA 需以同一 LoRA 建置的 sidecar）",
                expected=lora_signature,
                actual=sidecar_signature,
            )
        available = sidecar_keys(
            read_tensor(path, "plan_timesteps"), read_tensor(path, "plan_lengths")
        )
        check_sidecar_coverage(plans, available)
        accumulate = header.metadata.get(SIDECAR_LORA_ACCUMULATE_KEY)
        if sidecar_signature != "none" and accumulate != RUNTIME_LORA_ACCUMULATE:
            run.warn(
                "ADALN_SIDECAR_LORA_ARITHMETIC",
                f"sidecar {cache_ref} 的 AdaLN LoRA 項以 {accumulate or '釘版 out-of-place 加法'} 建置；runtime 的 dynamic "
                f"路徑是 {RUNTIME_LORA_ACCUMULATE}，兩者只差 LoRA 項的 BF16 捨入。要逐位元等同 AdaLN off\N{FULLWIDTH PLUS SIGN}dynamic，"
                "請以目前的 phasyn_h3.recipe.runtime.adaln_sidecar 重建",
            )
        document.update(
            {
                "sidecar": {
                    "cache_ref": cache_ref,
                    "format_version": header.metadata.get("format_version"),
                    "plans": len(available),
                    "lora_signature": sidecar_signature,
                    "lora_accumulate": accumulate,
                },
                "coverage": "complete",
            }
        )
    elif mode == "online":
        width = max((len(p) for p in plans), default=0)
        if width > _MAX_INLINE_SCALAR_WIDTH:
            raise UnsupportedCombination(
                "ADALN_PLAN_WIDTH",
                f"step plan 寬 {width} 超過釘版上限 4（minimax_h3_adaln_cache.py:47-53）",
            )
        document["coverage"] = "built_online_in_denoise_av"
    run.outputs.append(write_metadata_output(run.output_dir, "adaln", document))
    return run.result()


__all__ = ["condition_flags", "run", "sidecar_path"]
