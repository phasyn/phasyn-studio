"""Admission rules for the optional, shape-specialized H3 feed-forward activation."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .errors import UnsupportedCombination


DEFAULT_BYTES = 64 * 1024**2
MAX_BYTES = 256 * 1024**2


def settings(raw: Any) -> dict[str, Any] | None:
    """Normalize the optional regional compile and cache settings."""
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise _reject("COMPILE_PARAMETERS", "compile must be an object.")
    mode = raw.get("mode")
    if mode not in ("off", "regional"):
        raise _reject(
            "COMPILE_NOT_WIRED",
            "Only eager or regional H3 MLP gate compilation is supported.",
        )
    if mode == "off":
        return None
    if set(raw) - {
        "mode",
        "max_cache_bytes",
        "warmup_policy",
        "warmup_iterations",
        "shape_buckets",
    }:
        raise _reject("COMPILE_PARAMETERS", "Unknown regional compile option.")
    if (
        raw.get("shape_buckets")
        or raw.get("warmup_policy", "explicit_only") != "explicit_only"
        or raw.get("warmup_iterations", 0) != 0
    ):
        raise _reject(
            "COMPILE_WARMUP",
            "Real inputs specialize on first use. Use explicit_only, zero extra iterations and no buckets.",
        )
    budget = raw.get("max_cache_bytes", DEFAULT_BYTES)
    if type(budget) is not int or not 1 <= budget <= MAX_BYTES:
        raise _reject(
            "COMPILE_BUDGET",
            "The retained regional compiler cache must have a budget of 1 through 268435456 bytes.",
        )
    return {
        "mode": mode,
        "max_cache_bytes": budget,
        "warmup_policy": "explicit_only",
        "warmup_iterations": 0,
    }


def _reject(code: str, message: str) -> UnsupportedCombination:
    return UnsupportedCombination(code, message, field_path="compile")


def validate(profile: Mapping[str, Any]) -> dict[str, Any] | None:
    """Accept regional activation fusion only for a compatible H3 profile."""
    option = settings(profile.get("compile"))
    if option is None:
        return None
    if profile.get("mode") not in ("approximate", "experimental"):
        raise _reject(
            "COMPILE_EXACT_MODE",
            "Regional fusion requires an approximate or experimental profile.",
        )
    quant = ((profile.get("components") or {}).get("transformer") or {}).get(
        "quantization"
    ) or {}
    if (
        quant.get("scheme", "none") != "none"
        or profile.get("lora")
        or (profile.get("approximation") or {}).get("algorithm", "none") != "none"
    ):
        raise _reject(
            "COMPILE_ADAPTER",
            "Regional compilation currently requires native weights without LoRA or denoising approximation.",
        )
    if (profile.get("attention") or {}).get("provider", "auto_exact") not in (
        "auto_exact",
        "pytorch_sdpa",
    ):
        raise _reject(
            "COMPILE_ATTENTION",
            "Regional compilation currently requires the native Torch SDPA path.",
        )
    return option
