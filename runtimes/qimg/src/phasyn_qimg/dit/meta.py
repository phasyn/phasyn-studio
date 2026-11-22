"""Metadata of the ``qimg.latent.v1`` bundle written by ``qimg.dit`` (pure functions; no tensors are kept)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .options import DitOptions, DitParams


LATENT_LAYOUT = "packed (B, H·W, C)：H=height/16、W=width/16，列優先；正規化空間（VAE mean/std 之前）"


def dit_identity(  # noqa: PLR0913 - Keep the published runtime API.
    *,
    provider_id: str,
    component_id: str,
    opts: DitOptions,
    identity: Mapping[str, Any],
    scheduler: Mapping[str, Any],
    libraries: Mapping[str, Any],
) -> dict[str, Any]:
    """What produced the latent: variant, placement and the path-free transformer/adapter identity."""
    components = identity.get("components") or {}
    return {
        "provider_id": provider_id,
        "component_id": component_id,
        "variant": opts.variant,
        "placement": opts.placement,
        "pin_memory": opts.pin_memory,
        "path_base": identity.get("path_base"),
        "transformer": {
            "dir": components.get("transformer"),
            "override": opts.transformer_override,
            "gguf": components.get("gguf"),
        },
        "adapters": identity.get("adapters"),
        "scheduler": dict(scheduler),
        "libraries": dict(libraries),
    }


def latent_meta(  # noqa: PLR0913 - Keep the published runtime API.
    *,
    params: DitParams,
    schedule: Any,
    result: Any,
    latent_shape: Sequence[int],
    inputs: Mapping[str, Any],
    conditioning_sha256: str | None,
    ref_latents_sha256: str | None,
    identity: Mapping[str, Any],
) -> dict[str, Any]:
    """Bundle meta: sampling parameters, schedule, latent layout, noise recipe, input digests and the DiT identity."""
    h, w = params.latent_hw
    cond_meta = inputs["cond_meta"]
    return {
        "schema": "qimg.latent.v1",
        "width": params.width,
        "height": params.height,
        "steps": params.steps,
        "seed": params.seed,
        "guidance": params.guidance,
        "cfg": params.cfg,
        **schedule.to_meta(),
        "latent": {
            "shape": [int(x) for x in latent_shape],
            "dtype": "bfloat16",
            "layout": LATENT_LAYOUT,
            "latent_hw": [h, w],
        },
        "img_shapes": [list(s) for s in result.img_shapes],
        "kv_cache": result.kv_cache,
        "denoiser_forwards": result.forwards,
        "noise": {
            "generator": "torch.Generator('cpu').manual_seed(seed)",
            "dtype": result.noise_dtype,
            "shape": [1, 1, int(latent_shape[-1]), h, w],
        },
        "inputs": {
            "conditioning": {
                "sha256": conditioning_sha256,
                "prompt_sha256": cond_meta.get("prompt_sha256"),
                "negative_sha256": cond_meta.get("negative_sha256"),
                "te_identity": cond_meta.get("te_identity"),
            },
            "ref_latents": None
            if ref_latents_sha256 is None
            else {
                "sha256": ref_latents_sha256,
                "shapes": [list(s) for s in inputs["ref_shapes"]],
            },
        },
        "dit_identity": dict(identity),
    }


__all__ = ["LATENT_LAYOUT", "dit_identity", "latent_meta"]
