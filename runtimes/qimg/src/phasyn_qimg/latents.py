# SPDX-License-Identifier: Apache-2.0
# Portions adapted from diffusers 578c9b2 (src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py,
# _pack_latents and _unpack_latents), Copyright 2026 Qwen-Image Team, The HuggingFace Team; modified by the
# Phasyn Studio authors (shared by the VAE, the DiT and the previews).
"""Packed latent layout of Qwen-Image 2.1.

Qwen-Image 2.1 does not patchify latents; it only flattens space, so the packed shape is (B, h·w, z) where (h, w) is
the latent grid of the output (16× VAE compression, both sides floored to whole 2×2 VLM slots = 32 px).
Torch-free at import time: the functions only call tensor methods.
"""

from __future__ import annotations

from typing import Any

from . import SIZE_MULTIPLE, VAE_SCALE_FACTOR


def latent_hw(width: int, height: int) -> tuple[int, int]:
    """Latent grid (h, w) of a ``width``×``height`` output, floored to whole 32-px slots as in the pipeline."""
    slots = SIZE_MULTIPLE // VAE_SCALE_FACTOR
    return slots * (int(height) // SIZE_MULTIPLE), slots * (int(width) // SIZE_MULTIPLE)


def pack_latents(latents: Any) -> Any:
    """(1, z, 1, h, w) → (1, h·w, z)."""
    batch, channels, _frames, height, width = latents.shape
    return latents.view(batch, channels, height * width).transpose(1, 2)


def unpack_latents(packed: Any, *, width: int, height: int) -> Any:
    """(B, h·w, z) → (B, z, 1, h, w) for a ``width``×``height`` output."""
    batch, _tokens, channels = packed.shape
    h, w = latent_hw(width, height)
    return packed.transpose(1, 2).reshape(batch, channels, 1, h, w)


__all__ = ["latent_hw", "pack_latents", "unpack_latents"]
