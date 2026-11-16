"""FP32 video-VAE decode acceleration that keeps FP32 math (decode_video, compute_dtype=fp32).

At 1344x768 and 124 frames (latent [1,24,37,48,84]) the FP32 decode is 196 decoder calls (7 temporal
clips x 28 spatial tiles of 7x16x16 latent tokens + 5 suffix tokens = 1797 tokens), dominated by FP32
GEMMs and FP32 attention.

``tile_batch`` (bit-identical with ``w2_per_tile=True``)
    Decode ``tile_batch`` spatial tiles of a clip in one decoder call instead of one
    per call: upstream ``_run_tile_tasks(stack_tiling=True)`` applied to groups of
    tiles (``klvae.py:371-390``; upstream's own ``stack_tiling`` stacks all 28 tiles,
    which does not fit next to the 9.7 GB FP32 decoder on a 16 GB GPU).  Every op of the
    decoder is row-wise or per (batch, head), so stacking only changes GEMM M from
    1797 to 4*1797.  cuBLAS keeps the k-order for the K=2048 GEMMs (qkv/out/w1/proj,
    bit-identical rows) but picks a different reduction for the K=8192 ``w2`` GEMM;
    ``w2_per_tile`` therefore keeps that one GEMM at M=1797 per tile
    (``base_module._unfused_bias_linear``), which makes the decode bit-identical to
    the unbatched path (full 124-frame decode: same SHA-256 of the FP32 output and of
    the u8 frames; 76.86 s -> 73.97 s).  Peak VRAM grows by ~0.18 GiB per extra tile
    (+0.59 GiB at 4).  Without ``w2_per_tile``: 72.91 s, max |delta| 2e-5, +-1 on
    0.0025 % of u8 values (94 dB).
``strict_fp32_conv`` (changes output; no time cost)
    PyTorch's default ``torch.backends.cudnn.allow_tf32=True`` runs ``post_quant_conv``
    (Conv3d 24->24, 1x1x1) as a TF32 implicit GEMM
    (``sm80_xmma_fprop_implicit_gemm_tf32f32...``).  ``True`` disables cuDNN TF32 for
    the decode only, i.e. true FP32 for that conv.  Output moves by up to 3 u8 levels
    on 2.0 % of values (65.2 dB, full 124-frame decode) relative to today's
    default-TF32 conv.  ``torch.backends.cudnn.allow_tf32`` is process-global: only
    enable it while no other stage of the same actor process runs cuDNN concurrently.

Both wrappers are bound to the pinned SGLang source (sha256 of the wrapped
functions); a different SGLang build fails closed instead of running them.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

from .. import pins
from ..errors import UnsupportedCombination

DEFAULT_TILE_BATCH = 4
# Bit identity of the batched K=2048 GEMMs is a property of cuBLAS's kernel choice; it was
# verified on sm_120 (cuBLAS 13.1) only.  Other GPUs keep one tile per call.
VALIDATED_CAPABILITIES = frozenset({(12, 0)})
# False keeps today's numerics (PyTorch default: post_quant_conv in TF32); True = strict FP32 conv
STRICT_FP32_CONV = False
# measured peak growth per extra stacked FP32 tile (1797 tokens, dim 2048): 0.18-0.20 GiB
TILE_ACTIVATION_BYTES = int(0.25 * 2**30)
VRAM_MARGIN_BYTES = int(1.0 * 2**30)  # caching-allocator slack seen in production (reserved - allocated)


def check_sources() -> None:
    """The wrapped SGLang functions are the pinned ones (``pins.py``), else UPSTREAM_PATCH_SOURCE_MISMATCH."""
    pins.check("vae_fp32_tile_batch", what="FP32 tile batching ")


def choose_tile_batch(torch: Any, device: Any, *, requested: int, output_bytes: int) -> int:
    """Largest tile batch <= ``requested`` whose extra activations fit the free VRAM.

    ``output_bytes`` is the FP32 frame buffer ``_decode_temporal_streaming`` allocates
    after the first clip (klvae.py:695-698), which is not yet allocated here.  The
    tile batch never changes the decoded values (``w2_per_tile``), only speed/VRAM.
    """
    if requested <= 1 or getattr(device, "type", None) != "cuda":
        return 1
    if tuple(torch.cuda.get_device_capability(device)) not in VALIDATED_CAPABILITIES:
        return 1
    free, _total = torch.cuda.mem_get_info(device)
    free += torch.cuda.memory_reserved(device) - torch.cuda.memory_allocated(device)
    budget = free - output_bytes - VRAM_MARGIN_BYTES
    fit = 1 + max(0, budget) // TILE_ACTIVATION_BYTES
    return int(max(1, min(requested, fit)))


@contextlib.contextmanager
def fp32_decode_scope(
    vae: Any, *, tile_batch: int, w2_per_tile: bool = True, strict_fp32_conv: bool = False
) -> Iterator[dict[str, Any]]:
    """Scope one FP32 decode: grouped tile batching and the cuDNN TF32 switch; always restores."""
    import torch
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae import base_module

    if torch.backends.cuda.matmul.allow_tf32:
        raise UnsupportedCombination(
            "VAE_FP32_MATMUL_TF32",
            "FP32 解碼要求 torch.backends.cuda.matmul.allow_tf32=False（TF32 GEMM 會改變數值）",
            field_path="components.video_vae.compute_dtype",
        )
    if tile_batch > 1:
        check_sources()
    saved_cudnn_tf32 = torch.backends.cudnn.allow_tf32
    saved_ubl = base_module._unfused_bias_linear
    wrapped = False
    facts = {
        "tile_batch": int(tile_batch),
        "w2_per_tile": bool(w2_per_tile and tile_batch > 1),
        "cudnn_allow_tf32": bool(saved_cudnn_tf32 and not strict_fp32_conv),
        "strict_fp32_conv": bool(strict_fp32_conv),
    }
    try:
        if strict_fp32_conv:
            torch.backends.cudnn.allow_tf32 = False
        if tile_batch > 1:
            run_tile_tasks = vae._run_tile_tasks  # bound upstream method

            def grouped(tiles, tile_indices, forward_fn, stack_tiling, cls_agg=None):
                out = []
                for start in range(0, len(tile_indices), tile_batch):
                    out.extend(
                        run_tile_tasks(tiles, tile_indices[start : start + tile_batch], forward_fn, True, cls_agg)
                    )
                return out

            vae._run_tile_tasks = grouped
            wrapped = True
            if w2_per_tile:

                def per_tile(linear, hidden_states):
                    if hidden_states.dim() == 3 and hidden_states.shape[0] > 1:
                        return torch.cat(
                            [saved_ubl(linear, hidden_states[i : i + 1]) for i in range(hidden_states.shape[0])], dim=0
                        )
                    return saved_ubl(linear, hidden_states)

                base_module._unfused_bias_linear = per_tile
        yield facts
    finally:
        base_module._unfused_bias_linear = saved_ubl
        if wrapped:
            del vae._run_tile_tasks
        torch.backends.cudnn.allow_tf32 = saved_cudnn_tf32


__all__ = [
    "DEFAULT_TILE_BATCH",
    "STRICT_FP32_CONV",
    "VALIDATED_CAPABILITIES",
    "check_sources",
    "choose_tile_batch",
    "fp32_decode_scope",
]
