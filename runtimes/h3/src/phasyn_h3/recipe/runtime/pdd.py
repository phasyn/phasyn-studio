# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/tools/fuse_minimax_h3_pdd_heads.py (sigma_grid, fuse)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: numpy port of the sigma grid and the block weights, used to check a
# plan before SGLang's own function fuses the heads.
# "PAI:" in the citations below is the reference implementation published with alibaba-pai's
# MiniMax-H3-Acc-LoRAs (VideoX-Fun, https://github.com/aigc-apps/VideoX-Fun, Apache-2.0,
# examples/MiniMax-H3-Acc-LoRAs/); it is cited for the head layout and the grid, and no file of it is included.
"""PDD (Parallel Decoding Distillation) output heads for the stage-split DiT.

alibaba-pai's Acc-8Step checkpoints replace each final linear head with ``N`` (=32)
per-interval copies; one backbone forward advances a whole block of ``L`` (=4) intervals,
and because H3's Euler eta-0 update is linear in the velocity, the ``L`` heads of a block
fuse exactly into one head weighted by Δσ::

    W̃_b = Σ_{j∈b} (Δσ_j ／ Σ_{k∈b} Δσ_k) · W_j        (bias likewise)

on the ``N``-interval grid ``sigma(q) = s·q／(1+(s-1)·q)``, ``q = linspace(1, 0, N+1)``, with the
video shift for ``proj_out`` and the audio shift for ``audio_proj_out``
(``PAI:minimax_h3_pdd.py:33-48, 204-238``; ``SGR:tools/fuse_minimax_h3_pdd_heads.py:42-65``).
The fused heads are loaded with SGLang's own ``MiniMaxH3FinalLayer.load_pdd_fused_heads``
(``minimax_h3.py:1772-1798``), the same path ``SGLANG_DIFFUSION_MINIMAX_H3_PDD_HEADS`` uses,
from a content-addressed file in the actor workdir; the head is selected per step from
``forward_context.current_timestep`` (``:1800-1819``), which ``denoise_av`` sets to the step.

Differences from SGLang's offline tool: fusion runs in FP32 (the tool casts the weights and the
result back to the BF16 head dtype), the heads stay FP32 like the fp32 output-head island, and
the plan grid is checked against the training block boundaries before the loop (the tool's
check lives in ``TimestepPreparation``, ``S/stages/timestep_preparation.py:90-118``, which the
shim never builds).

Non-uniform grouping: a manifest may declare ``pdd.blocks`` (interval counts per fused head summing to
``num_steps``, e.g. [8, 16, 8] → 3 steps).  Each block is fused by the same ``fuse`` call on its own heads and
grid slice, the plan grid is the block-boundary subset of the ``num_steps``-interval grid
(``schedule.block_boundary_sigmas``) and the check compares against those boundaries.  Without ``pdd.blocks``
nothing changes.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, cast

import numpy as np

from .errors import UnsupportedCombination
from .lora_policy import LoraPolicy, LoraSpec


# same tolerance as S/stages/timestep_preparation.py:110-113
REL_TOL = 1e-6
ABS_TOL = 1e-7
HEAD_NAMES = {"proj_out": "video_out", "audio_proj_out": "audio_out"}


def sigma_grid(num_points: int, shift: float) -> np.ndarray:
    """float64 ``shift·q／(1+(shift-1)·q)``, ``q = linspace(1, 0, num_points)``."""
    q = np.linspace(1.0, 0.0, int(num_points), dtype=np.float64)
    return float(shift) * q / (1.0 + (float(shift) - 1.0) * q)


def block_weights(num_steps: int, block_size: int, shift: float) -> np.ndarray:
    """``[num_steps／block_size, block_size]`` Δσ weights; each row sums to 1."""
    if block_size < 1 or num_steps < 1 or num_steps % block_size:
        raise ValueError(
            f"PDD num_steps={num_steps} 不能被 block_size={block_size} 整除"
        )
    sigmas = sigma_grid(num_steps + 1, shift)
    dsigma = np.clip(sigmas[:-1] - sigmas[1:], 0.0, None).reshape(
        num_steps // block_size, block_size
    )
    totals = dsigma.sum(axis=1, keepdims=True)
    if np.any(totals <= 0):
        raise ValueError("PDD block 的 Δσ 全為 0")
    return cast("np.ndarray", dsigma / totals)


def block_boundaries(
    num_steps: int, block_size: int, shift: float, blocks: Sequence[int] | None = None
) -> np.ndarray:
    """The sigmas one backbone forward per block steps through: every ``block_size``-th point of the ``num_steps``-interval grid, or, with a non-uniform grouping ``blocks`` (manifest ``pdd.blocks``), the points at its block boundaries ``[0, b1, b1+b2, …, num_steps]``."""
    grid = sigma_grid(num_steps + 1, shift)
    if blocks is None:
        return grid[::block_size]
    if not blocks or min(blocks) < 1 or sum(blocks) != num_steps:
        raise ValueError(f"PDD blocks {list(blocks)} 不是 {num_steps} 個區間的分組")
    return cast("np.ndarray", grid[np.cumsum([0, *blocks])])


def check_pdd_schedule(
    video: Sequence[float], audio: Sequence[float], spec: LoraSpec
) -> None:
    """The plan's two grids must equal the PDD block boundaries (8 steps; shift 12／3)."""
    if not spec.is_pdd or spec.pdd_num_steps is None or spec.pdd_block_size is None:
        return
    for modality, grid, shift in (
        ("video", video, spec.video_shift),
        ("audio", audio, spec.audio_shift),
    ):
        expected = block_boundaries(
            spec.pdd_num_steps, spec.pdd_block_size, shift, spec.pdd_blocks
        )
        if len(grid) != len(expected) or any(
            not math.isclose(float(a), float(b), rel_tol=REL_TOL, abs_tol=ABS_TOL)
            for a, b in zip(grid, expected, strict=True)
        ):
            grouping = (
                f"訓練時 {spec.pdd_num_steps} 區間每 {spec.pdd_block_size} 個一組"
                if spec.pdd_blocks is None
                else f"{spec.pdd_num_steps} 區間依 {list(spec.pdd_blocks)} 分組"
            )
            raise UnsupportedCombination(
                "LORA_PDD_SCHEDULE_MISMATCH",
                f"PDD {spec.lora_id} 需要 {spec.pdd_steps} 步、{modality} shift {shift} 的 sigma 網格"
                f"（{grouping}）；plan 的 {modality} 網格不符",
                field_path="schedule",
                expected=[round(float(x), 6) for x in expected],
                actual=[round(float(x), 6) for x in grid],
            )


def _fuse_blocks(fuse: Any, heads: Any, sigmas: Any, blocks: Sequence[int]) -> Any:
    """Non-uniform grouping: SGLang's own ``fuse`` on each block's heads and its slice of the grid (one block per call, so each fused head is the same Δσ-weighted sum ``fuse`` computes for a uniform block)."""
    import torch

    if min(blocks) < 1 or sum(blocks) != int(heads.shape[0]):
        raise UnsupportedCombination(
            "LORA_PDD_HEADS",
            f"pdd.blocks {list(blocks)} 不是 {int(heads.shape[0])} 個輸出頭的分組",
        )
    out, start = [], 0
    for size in blocks:
        out.append(
            fuse(heads[start : start + size], sigmas[start : start + size + 1], size)
        )
        start += size
    return torch.cat(out)


def fuse_heads(raw: Mapping[str, Any], spec: LoraSpec) -> dict[str, Any]:
    """32 interval heads → one per block (FP32), with SGLang's ``fuse``／``sigma_grid``.

    A non-uniform grouping (``spec.pdd_blocks``) calls ``fuse`` once per block; a uniform one once per head tensor.
    """
    from sglang.multimodal_gen.tools.fuse_minimax_h3_pdd_heads import (  # type: ignore[import-untyped]
        fuse,
        sigma_grid as sg_sigma_grid,
    )

    n, block = spec.pdd_num_steps, spec.pdd_block_size
    if n is None or block is None:
        raise UnsupportedCombination(
            "LORA_PDD_FACTS_MISSING", f"{spec.lora_id} 不是 PDD LoRA"
        )
    out: dict[str, Any] = {}
    for source, target in HEAD_NAMES.items():
        shift = spec.video_shift if source == "proj_out" else spec.audio_shift
        sigmas = sg_sigma_grid(n + 1, shift)
        for suffix in ("weight", "bias"):
            heads = raw.get(f"{source}.{suffix}")
            if heads is None or int(heads.shape[0]) != n:
                raise UnsupportedCombination(
                    "LORA_PDD_HEADS",
                    f"{source}.{suffix} 必須有 {n} 個輸出頭，收到 {None if heads is None else list(heads.shape)}",
                )
            try:
                fused = (
                    fuse(heads.float(), sigmas, block)
                    if spec.pdd_blocks is None
                    else _fuse_blocks(fuse, heads.float(), sigmas, spec.pdd_blocks)
                )
                out[f"{target}.{suffix}"] = fused.contiguous()
            except (
                SystemExit
            ) as exc:  # the offline tool reports bad grids with SystemExit
                raise UnsupportedCombination(
                    "LORA_PDD_HEADS", f"PDD 輸出頭融合失敗：{exc}"
                ) from exc
    return out


def install_pdd_heads(
    module: Any, raw: Mapping[str, Any], spec: LoraSpec, *, workdir: Path
) -> dict[str, Any]:
    """Fuse, write a content-addressed file, load it through ``load_pdd_fused_heads``."""
    from safetensors.torch import save_file

    final_layer = module.final_layer
    if getattr(final_layer, "_pdd_heads", None) is not None:
        raise UnsupportedCombination(
            "PDD_HEADS_UNEXPECTED", "DiT 已帶有 PDD 輸出頭（不得由環境變數注入）"
        )
    fused = fuse_heads(raw, spec)
    h = hashlib.sha256()
    meta = {
        "lora_sha256": spec.sha256,
        "num_steps": spec.pdd_num_steps,
        "block_size": spec.pdd_block_size,
        "video_shift": spec.video_shift,
        "audio_shift": spec.audio_shift,
        "dtype": "fp32",
    }
    if spec.pdd_blocks is not None:  # uniform heads keep their digest and file name
        meta["pdd_blocks"] = ",".join(str(b) for b in spec.pdd_blocks)
    h.update(json.dumps(meta, sort_keys=True).encode())
    for name in sorted(fused):
        h.update(name.encode())
        h.update(fused[name].numpy().tobytes())
    digest = h.hexdigest()
    path = workdir / "pdd" / f"{digest}.safetensors"
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        save_file(fused, str(tmp), metadata={k: str(v) for k, v in meta.items()})
        tmp.replace(path)
    final_layer.load_pdd_fused_heads(str(path))
    loaded = final_layer._pdd_heads
    steps = int(loaded["video_out.weight"].shape[0])
    if steps != spec.pdd_steps:
        raise UnsupportedCombination(
            "LORA_PDD_HEADS", f"載入 {steps} 個融合頭，預期 {spec.pdd_steps}"
        )
    # the cache file relative to the runtime work directory: records never name local folders
    return {
        "heads_digest": digest,
        "fused_steps": steps,
        "dtype": "fp32",
        "path": f"pdd/{path.name}",
        **meta,
    }


def verify_heads_installed(
    model: Any, policy: LoraPolicy | None, *, planned_updates: int
) -> dict[str, Any]:
    """Right before the loop: PDD ⇔ fused heads present, one per planned update."""
    final_layer = getattr(model, "final_layer", None)
    heads = None if final_layer is None else getattr(final_layer, "_pdd_heads", None)
    pdd = [s for s in (policy.specs if policy else ()) if s.is_pdd]
    if not pdd:
        if heads is not None:
            raise UnsupportedCombination(
                "PDD_HEADS_UNEXPECTED", "DiT 帶有 PDD 輸出頭，但 plan 沒有 PDD LoRA"
            )
        return {"pdd_heads": None}
    if heads is None:
        raise UnsupportedCombination(
            "LORA_PDD_HEADS",
            "PDD LoRA 的融合輸出頭沒有安裝（只套 backbone 不是訓練時的模型）",
        )
    steps = int(heads["video_out.weight"].shape[0])
    if steps != planned_updates:
        raise UnsupportedCombination(
            "LORA_PDD_SCHEDULE_MISMATCH",
            f"融合頭 {steps} 個，plan 有 {planned_updates} 次更新",
            field_path="schedule",
        )
    return {"pdd_heads": steps}


__all__ = [
    "block_boundaries",
    "block_weights",
    "check_pdd_schedule",
    "fuse_heads",
    "install_pdd_heads",
    "sigma_grid",
    "verify_heads_installed",
]
