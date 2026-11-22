"""Validated request-scoped DBCache policy for the pinned SGLang H3 block adapter (torch free)."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from .errors import UnsupportedCombination


_MAX_CONFIG_STEPS = 200


def reject(reason: str, message: str) -> UnsupportedCombination:
    """Attach the approximation field path to a Cache-DiT rejection."""
    return UnsupportedCombination(reason, message, field_path="approximation")


def approximation(raw: Any) -> dict[str, Any] | None:
    """Normalize the optional Cache-DiT settings and check their numeric limits."""
    if raw is None or (isinstance(raw, Mapping) and not raw):
        return None
    if not isinstance(raw, Mapping) or raw.get("algorithm") not in (
        "none",
        "cache_dit",
    ):
        raise reject(
            "APPROXIMATION_NOT_WIRED",
            "Only none and the pinned Cache-DiT adapter are supported.",
        )
    if raw["algorithm"] == "none":
        return None
    if set(raw) - {"algorithm", "threshold", "warmup_steps", "max_reuse_steps"}:
        raise reject("CACHE_DIT_PARAMETERS", "Unknown Cache-DiT settings.")
    threshold = raw.get("threshold")
    warmup = raw.get("warmup_steps")
    limit = raw.get("max_reuse_steps")
    if (
        isinstance(threshold, bool)
        or not isinstance(threshold, (int, float))
        or not math.isfinite(threshold)
        or not 0 < threshold <= 1
    ):
        raise reject(
            "CACHE_DIT_THRESHOLD",
            "Cache-DiT requires an explicit residual difference threshold in (0, 1].",
        )
    if (
        type(warmup) is not int
        or not 1 <= warmup <= _MAX_CONFIG_STEPS
        or type(limit) is not int
        or not 1 <= limit <= _MAX_CONFIG_STEPS
    ):
        raise reject(
            "CACHE_DIT_STEPS",
            "Cache-DiT requires warmup_steps and max_reuse_steps between 1 and 200.",
        )
    return {
        "algorithm": "cache_dit",
        "threshold": float(threshold),
        "warmup_steps": warmup,
        "max_reuse_steps": limit,
    }


def validate(profile: Mapping[str, Any]) -> dict[str, Any] | None:
    """Resolve Cache-DiT only for a compatible H3 profile."""
    option = approximation(profile.get("approximation"))
    if option is None:
        return None
    if profile.get("mode") not in ("approximate", "experimental"):
        raise reject(
            "CACHE_DIT_EXACT_MODE",
            "Choose an approximate or experimental H3 profile to enable Cache-DiT.",
        )
    if profile.get("lora") or any(
        isinstance(e, Mapping) and e.get("namespace") == "phasyn.sglang_h3.ref_kv_cache"
        for e in profile.get("extensions", ())
    ):
        raise reject(
            "CACHE_DIT_OTHER_ADAPTER",
            "Run Cache-DiT without LoRA, dynamic adapters or reference K/V reuse.",
        )
    if (profile.get("attention") or {}).get("provider", "auto_exact") not in (
        "auto_exact",
        "pytorch_sdpa",
    ):
        raise reject(
            "CACHE_DIT_ATTENTION",
            "This H3 Cache-DiT profile requires the verified Torch SDPA path.",
        )
    transformer = (profile.get("components") or {}).get("transformer") or {}
    if (transformer.get("quantization") or {}).get("scheme", "none") != "none":
        raise reject(
            "CACHE_DIT_QUANTIZATION",
            "This H3 Cache-DiT profile requires native BF16 transformer weights.",
        )
    return option


def step_budget(option: Mapping[str, Any] | None, *, steps: int, nag: bool) -> None:
    """Check that the selected denoising schedule permits a cache hit."""
    if option is None:
        return
    if nag:
        raise reject(
            "CACHE_DIT_NAG", "NAG and Cache-DiT both replace the H3 block stack."
        )
    if steps <= option["warmup_steps"]:
        raise reject(
            "CACHE_DIT_NO_REUSE_WINDOW",
            "The denoising suffix must contain at least one step after warmup.",
        )
