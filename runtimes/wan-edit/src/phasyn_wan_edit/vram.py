"""Free-VRAM pre-check before Wan VACE loads or denoises next to other components on one card.

Each residency has a planning floor of free device memory below which the call is refused with
``GPU_MEMORY_INSUFFICIENT`` before anything runs, instead of dying with an out-of-memory error halfway through.
The floors are planning estimates, not measurements: ``model_offload`` and ``gpu`` can run out of memory on a 16 GB card;
``sequential_offload`` keeps
only the active submodule on the card and has no measured floor, so it is checked only when the definition sets
``provider_options.min_free_vram_gib``. That option overrides the floor of every residency (0 turns it off).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components.errors import ComponentError, gpu_memory_insufficient


GIB = 1024**3
RESIDENCIES = ("model_offload", "sequential_offload", "gpu")
# Planning floors in GiB (see the module docstring); None = no default check.
FLOOR_GIB: dict[str, float | None] = {
    "model_offload": 13.0,
    "gpu": 13.0,
    "sequential_offload": None,
}


def residency_of(options: Mapping[str, Any] | None) -> str:
    """The configured residency; an unknown value is refused, never replaced."""
    value = (options or {}).get("residency", "model_offload")
    if value not in RESIDENCIES:
        raise ComponentError("INVALID_ARGUMENT", "Unknown Wan load residency")
    return str(value)


def floor_bytes(residency: str, options: Mapping[str, Any] | None) -> int | None:
    """Free device memory this residency needs before a load or a call; None = not checked."""
    override = (options or {}).get("min_free_vram_gib")
    if override is not None:
        if isinstance(override, bool) or not isinstance(override, int | float):
            raise ComponentError(
                "INVALID_ARGUMENT", "min_free_vram_gib must be a number or null"
            )
        if not 0 <= override <= 1024:  # noqa: PLR2004 - schema bound
            raise ComponentError(
                "INVALID_ARGUMENT", "min_free_vram_gib must be within 0..1024"
            )
        return int(override * GIB) if override > 0 else None
    floor = FLOOR_GIB[residency]
    return None if floor is None else int(floor * GIB)


def check_free(
    free_bytes: int | None,
    residency: str,
    options: Mapping[str, Any] | None,
    *,
    when: str,
) -> dict[str, Any]:
    """Refuse before the work starts when free memory is below the floor; return the check for the record.

    ``free_bytes`` is the device's free memory (``torch.cuda.mem_get_info``) or None when it could not be read:
    an unknown reading never refuses, it is recorded as unknown.
    """
    need = floor_bytes(residency, options)
    record: dict[str, Any] = {
        "when": when,
        "residency": residency,
        "required_free_bytes": need,
        "free_bytes": free_bytes,
        "basis": "planning floor, not a measurement",
    }
    if need is None:
        record["result"] = "not_checked"
        return record
    if free_bytes is None:
        record["result"] = "unknown"
        return record
    if free_bytes < need:
        raise gpu_memory_insufficient(
            f"Wan VACE（{residency}）{when}前需要至少 {need / GIB:.1f} GiB 可用 GPU 記憶體，"
            f"目前只有 {free_bytes / GIB:.1f} GiB；可改用 sequential_offload",
            details={**record, "result": "refused"},
        )
    record["result"] = "passed"
    return record


def measure_free(torch: Any) -> int | None:
    """Free bytes of the process's CUDA device 0 after returning cached blocks; None when unreadable."""
    try:
        torch.cuda.empty_cache()
        free, _total = torch.cuda.mem_get_info(0)
    except (RuntimeError, AttributeError):
        return None
    return int(free)
