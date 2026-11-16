"""Ref2VA reference image short edge: an explicit opt-in that changes only the pixels of the reference images.

1024 is recommended for reference images whose short edge is at most 1024 px: Qwen and the VAE get the same, smaller
pixels, and each image costs the DiT a quarter of the rows it costs at 2048. Omitted, null or 2048 keeps the pinned path
and its bytes. Larger images are scaled down at 1024, which has not been compared with 2048.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components.errors import ComponentError

from .recipe.adapter.geometry import reference_image_short_edge

PARAM = "reference_image_short_edge"
PARAMETER_SCHEMA: dict[str, Any] = {
    "type": ["integer", "null"],
    "enum": [None, 1024, 2048],
    "default": 2048,
    "description": "Ref2VA reference_image short edge. 1024 is recommended for reference images whose short edge is at "
    "most 1024 px: Qwen and the VAE get the same smaller pixels and each image costs the DiT a quarter of the rows. "
    "Omitted/null/2048 keeps the pinned path; larger images are scaled down at 1024, which has not been compared.",
}


def requested(params: Mapping[str, Any]) -> int | None:
    try:
        return reference_image_short_edge(params.get(PARAM))
    except ValueError as exc:
        raise ComponentError("INVALID_ARGUMENT", str(exc), details={"field_path": PARAM}) from exc


def of_job(job: Mapping[str, Any]) -> int | None:
    edge = requested(job)
    if edge is not None and (
        job.get("task") != "ref2va" or not any(m.get("role") == "reference_image" for m in job.get("materials") or [])
    ):
        raise ComponentError("INVALID_ARGUMENT", "reference_image_short_edge=1024 requires Ref2VA reference_image")
    return edge


def check(job: Mapping[str, Any], prepared: Mapping[str, Any]) -> None:
    """Reject cross-resolution prepared reuse; legacy omitted image shapes stay valid."""
    edge = of_job(job)
    if requested(prepared) != edge:
        raise ComponentError("LATENT_SOURCE_MISMATCH", "job/prepared reference_image_short_edge differs")
    for material in prepared.get("materials") or []:
        if material.get("role") != "reference_image":
            continue
        shape = material.get("resolved_shape") or {}
        if shape.get("base_short_edge", 2048) != (edge or 2048):
            raise ComponentError("LATENT_SOURCE_MISMATCH", "prepared reference image shape differs from job")
