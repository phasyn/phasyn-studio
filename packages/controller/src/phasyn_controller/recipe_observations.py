"""Public, versioned runtime observations accepted from any component recording."""

from __future__ import annotations

import math
import re
from typing import TYPE_CHECKING, Any

from phasyn_components.canonical import digest
from phasyn_components.inference_recipe import inference_recipe


if TYPE_CHECKING:
    from phasyn_components.inference_recipe import RecordingEvidence


EVENT_CODE = "INFERENCE_OBSERVATION_V1"
_IDENTIFIERS = frozenset(
    {
        "execution_backend",
        "active_attention_backend",
        "attention_implementation",
        "jit_compile_mode",
    }
)
_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,47}")
_PRECISIONS = frozenset(
    {"accumulation_dtype", "kernel_compute_dtype", "vae_weight_dtype"}
)
_DTYPES = frozenset(
    {
        "bool",
        "int4",
        "int8",
        "uint8",
        "int16",
        "int32",
        "int64",
        "float4_e2m1fn_x2",
        "float8_e4m3fn",
        "float8_e4m3fnuz",
        "float8_e5m2",
        "float8_e5m2fnuz",
        "float16",
        "bfloat16",
        "float32",
        "float64",
        "complex64",
        "complex128",
    }
)
_CENSUSES = frozenset({"parameter_dtypes", "quantized_weight_dtypes"})
_CACHES = frozenset({"encoding_cache", "denoising_step_cache", "prefix_kv_cache"})
_CACHE_STATES = frozenset({"hit", "miss", "bypass", "disabled", "active", "partial"})
_COUNTS = frozenset(
    {"cached_bytes", "verified_input_bytes", "full_steps", "reused_steps"}
)
_TIMINGS = frozenset({"lookup_ms", "restore_ms", "compute_ms", "store_ms"})
_CACHE_KEYS = _COUNTS | _TIMINGS | {"status"}
_MAX_NUMBER = (1 << 53) - 1


def _count(value: object) -> bool:
    return type(value) is int and 0 <= value <= _MAX_NUMBER


def _time_ms(value: object) -> bool:
    if isinstance(value, float):
        return math.isfinite(value) and 0 <= value <= _MAX_NUMBER
    return _count(value)


def _census(value: object) -> bool:
    return (
        isinstance(value, dict)
        and 0 < len(value) <= len(_DTYPES)
        and all(key in _DTYPES and _count(count) for key, count in value.items())
    )


def _cache(value: object) -> bool:
    if not isinstance(value, dict) or len(value) > len(_CACHE_KEYS):
        return False
    status = value.get("status")
    return (
        isinstance(status, str)
        and status in _CACHE_STATES
        and value.keys() <= _CACHE_KEYS
        and all(_count(value[key]) for key in value.keys() & _COUNTS)
        and all(_time_ms(value[key]) for key in value.keys() & _TIMINGS)
    )


def _valid(name: str, value: object) -> bool:
    if name in _IDENTIFIERS:
        return isinstance(value, str) and _IDENTIFIER.fullmatch(value) is not None
    if name in _PRECISIONS:
        return isinstance(value, str) and value in _DTYPES
    if name in _CENSUSES:
        return _census(value)
    return name in _CACHES and _cache(value)


def public_observation(fields: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Select one verified observation. Unrecognized fields and unsupported values stay private."""
    if fields.keys() != {"code", "name", "value"}:
        return None
    if fields["code"] != EVENT_CODE:
        return None
    name, value = fields["name"], fields["value"]
    if not isinstance(name, str) or not _valid(name, value):
        return None
    return f"{EVENT_CODE}:{name}", {"name": name, "value": value}


def export_recipe(
    run: dict[str, Any], recordings: dict[str, RecordingEvidence]
) -> dict[str, Any]:
    """Include reported facts in the existing recipe and comparison's observed settings."""
    result = inference_recipe(run, recordings)
    changed = False
    for sid, evidence in recordings.items():
        for key, event in evidence.events.items():
            if key.startswith(EVENT_CODE + ":"):
                fields = event["fields"]
                result["recipe"]["steps"][sid]["observed"][fields["name"]] = {
                    "status": "recorded",
                    "value": fields["value"],
                    "source": f"runtime.{key}",
                }
                changed = True
    if changed:
        result["recipe_sha256"] = digest(result["recipe"])
        del result["document_sha256"]
        result["document_sha256"] = digest(result)
    return result
