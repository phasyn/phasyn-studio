# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/time_request.py (minimax_h3_time_shift_sigmas)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: numpy port with the same float32 arithmetic.
"""Shifted rectified-flow sigma grids, emulating the pinned SGLang function in numpy.

Upstream (SG:time_request.py:32-69, ``minimax_h3_time_shift_sigmas``)::

    base = torch.linspace(1.0, 0.0, num_steps + 1, dtype=torch.float32)  # CPU
    shifted = float(shift) * base / (1 + (float(shift) - 1) * base)  # float32 ops
    shifted, _ = torch.unique_consecutive(shifted, return_counts=True)
    if shifted[-1] > 0:
        shifted = cat([shifted, [0.0]])

``torch.linspace`` on CPU evaluates ``start + step * i`` for ``i < n // 2`` and
``end - step * (n - 1 - i)`` otherwise (ATen RangeFactoriesKernel).  Whether the
first half is evaluated with a fused multiply-add depends on the ATen CPU
capability of the process that built the grid: measured on torch 2.14.1
(the version pinned by SGLang ``python/pyproject.toml:6``) the AVX2 kernel
matches the FMA form bit-for-bit and the DEFAULT kernel matches the
two-rounding form bit-for-bit (they disagree in 175 of the 200 grids for
steps 1..200).  The plan freezes the grid as a binary artifact, so
the runtime never recomputes it; ``LINSPACE_ROUNDING`` records which form was
used.  The second half needs no FMA distinction because ``end == 0``.

Consumers: SG:stages/timestep_preparation.py:121-140 and SG:denoise_loop.py:477-480
require equal-length video/audio lists with >= 2 points and run
``len(grid) - 1`` DiT updates; values are float32 (SG:denoise_loop.py:551-552).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

from phasyn_h3.recipe.abi.tensors import (
    read_header_from_bytes,
    tensor_bytes,
    write_safetensors,
)

from . import constants


_MIN_POINTS = 2


LINSPACE_ROUNDING_FMA = (
    "fma"  # torch CPU AVX2/AVX-512 capability (x86-64 hosts that build the plans)
)
LINSPACE_ROUNDING_SEPARATE = "separate"  # torch CPU DEFAULT capability (no FMA)
LINSPACE_ROUNDING = LINSPACE_ROUNDING_FMA
_MAX_EXACT_POINTS = 1 << 21  # float64 evaluation of 1 + step*i is exact up to here


def torch_cpu_linspace_f32(
    num_points: int, *, rounding: str = LINSPACE_ROUNDING
) -> np.ndarray:
    """Bit-exact emulation of ``torch.linspace(1.0, 0.0, num_points, dtype=float32)`` on CPU."""
    n = int(num_points)
    if not _MIN_POINTS <= n <= _MAX_EXACT_POINTS:
        raise ValueError(f"num_points must be within 2..{_MAX_EXACT_POINTS}")
    if rounding not in (LINSPACE_ROUNDING_FMA, LINSPACE_ROUNDING_SEPARATE):
        raise ValueError(f"unknown linspace rounding {rounding!r}")
    start = np.float32(1.0)
    end = np.float32(0.0)
    step = np.float32(
        np.float32(end - start) / np.float32(n - 1)
    )  # float32 division, as ATen
    half = n // 2
    out = np.empty(n, dtype=np.float32)
    first = np.arange(half, dtype=np.int64)
    if rounding == LINSPACE_ROUNDING_FMA:
        # |step| >= 2**-21 and i < 2**21 => start + step*i is exact in float64; one rounding to f32 == fmaf.
        out[:half] = (
            np.float64(start) + np.float64(step) * first.astype(np.float64)
        ).astype(np.float32)
    else:
        out[:half] = start + step * first.astype(np.float32)
    k = (n - 1 - np.arange(half, n, dtype=np.int64)).astype(np.float64)
    out[half:] = (np.float64(end) - np.float64(step) * k).astype(np.float32)
    return out


def time_shift_sigmas(
    num_steps: int, shift: float, *, rounding: str = LINSPACE_ROUNDING
) -> np.ndarray:
    """Numpy float32 emulation of ``minimax_h3_time_shift_sigmas`` (non-DMD branch)."""
    if isinstance(num_steps, bool) or int(num_steps) != num_steps or num_steps <= 0:
        raise ValueError("MiniMax H3 num_steps must be > 0")
    shift_value = float(shift)
    if not np.isfinite(shift_value) or shift_value <= 0:
        raise ValueError("MiniMax H3 shift_scale must be > 0")
    base = torch_cpu_linspace_f32(int(num_steps) + 1, rounding=rounding)
    s = np.float32(shift_value)  # python scalar -> tensor dtype (float32)
    s_minus_one = np.float32(
        shift_value - 1.0
    )  # (float(shift) - 1) evaluated in Python double first
    shifted = (s * base) / (np.float32(1.0) + s_minus_one * base)
    keep = np.ones(shifted.shape[0], dtype=bool)
    keep[1:] = (
        shifted[1:] != shifted[:-1]
    )  # torch.unique_consecutive (exact equality, -0.0 == 0.0)
    shifted = shifted[keep]
    if float(shifted[-1]) > 0.0:
        shifted = np.concatenate([shifted, np.zeros(1, dtype=np.float32)])
    return shifted.astype(np.float32, copy=False)


def grid_bytes(grid: np.ndarray) -> bytes:
    """Serialize the sigma grid for identity checks."""
    return np.ascontiguousarray(grid, dtype="<f4").tobytes()


def grid_digest(grid: np.ndarray) -> str:
    """Hash the canonical sigma grid."""
    return hashlib.sha256(grid_bytes(grid)).hexdigest()


def _scalar_text(value: Any) -> str:
    return repr(float(value))


def sigma_payload(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    video: np.ndarray,
    audio: np.ndarray,
    *,
    steps: int,
    video_shift: float,
    audio_shift: float,
    rounding: str = LINSPACE_ROUNDING,
    pdd_blocks: Sequence[int] | None = None,
) -> bytes:
    """Safetensors payload (tensors ``video_sigmas``/``audio_sigmas``, F32, layout S).

    ``pdd_blocks`` (non-uniform PDD grouping) adds ``pdd_blocks``／``pdd_num_steps`` to the metadata and names the
    block-boundary source; without it the payload is the uniform one, byte for byte.
    """
    metadata = {
        "audio_shift": _scalar_text(audio_shift),
        "dtype": "F32",
        "layout": "S",
        "linspace_rounding": rounding,
        "semantics": constants.SCHEDULE_SEMANTICS,
        "source": f"sglang@{constants.SGLANG_REVISION}:minimax_h3/time_request.py:minimax_h3_time_shift_sigmas",
        "steps": str(int(steps)),
        "video_shift": _scalar_text(video_shift),
    }
    if pdd_blocks is not None:
        metadata["pdd_blocks"] = ",".join(str(int(b)) for b in pdd_blocks)
        metadata["pdd_num_steps"] = str(sum(int(b) for b in pdd_blocks))
        metadata["source"] += "(pdd_num_steps) at the PDD block boundaries"
    return write_safetensors(
        [
            ("audio_sigmas", "F32", [int(audio.shape[0])], grid_bytes(audio)),
            ("video_sigmas", "F32", [int(video.shape[0])], grid_bytes(video)),
        ],
        metadata=dict(sorted(metadata.items())),
    )


def pdd_block_bounds(blocks: Sequence[int]) -> list[int]:
    """Interval indices of the block boundaries on the PDD grid: ``[0, b1, b1+b2, …, sum]``."""
    out = [0]
    for block in blocks:
        out.append(out[-1] + int(block))
    return out


def block_boundary_sigmas(
    blocks: Sequence[int], shift: float, *, rounding: str = LINSPACE_ROUNDING
) -> np.ndarray:
    """The plan grid of a non-uniform PDD grouping: the ``sum(blocks)``-interval grid at the block boundaries.

    Same float32 emulation as :func:`time_shift_sigmas`; a boundary of a block is a point of the full PDD grid, so
    a grouping whose boundaries are a subset of another's reuses that grouping's AdaLN timestep plans.
    """
    if not blocks or any(isinstance(b, bool) or int(b) < 1 for b in blocks):
        raise ValueError(f"PDD blocks {list(blocks)} must be positive integers")
    total = sum(int(b) for b in blocks)
    full = time_shift_sigmas(total, shift, rounding=rounding)
    if int(full.shape[0]) != total + 1:
        raise ValueError(
            f"the {total}-interval PDD grid collapsed to {int(full.shape[0])} points"
        )
    return full[pdd_block_bounds(blocks)].copy()


def build_schedule(
    *,
    steps: int,
    video_shift: float,
    audio_shift: float,
    rounding: str = LINSPACE_ROUNDING,
    pdd_blocks: Sequence[int] | None = None,
) -> tuple[dict[str, Any], bytes, dict[str, Any]]:
    """Return ``(schedule_doc, sigma_payload, facts)``; raises ValueError on an illegal grid.

    both grids must have exactly ``steps + 1`` points and end in 0,
    otherwise the number of DiT updates would silently differ from the request.

    ``pdd_blocks`` (a PDD LoRA manifest's non-uniform ``pdd.blocks``): the grids are the block boundaries of the
    PDD grid (:func:`block_boundary_sigmas`) and ``steps`` must equal ``len(pdd_blocks)``; None keeps the uniform
    schedule unchanged.
    """
    if pdd_blocks is not None:
        if isinstance(steps, bool) or int(steps) != len(pdd_blocks):
            raise ValueError(
                f"PDD blocks {list(pdd_blocks)} give {len(pdd_blocks)} steps, the plan asks for {steps}"
            )
        video = block_boundary_sigmas(pdd_blocks, video_shift, rounding=rounding)
        audio = block_boundary_sigmas(pdd_blocks, audio_shift, rounding=rounding)
    else:
        video = time_shift_sigmas(steps, video_shift, rounding=rounding)
        audio = time_shift_sigmas(steps, audio_shift, rounding=rounding)
    expected = int(steps) + 1
    for name, grid in (("video", video), ("audio", audio)):
        if grid.shape[0] != expected:
            raise ValueError(
                f"{name} sigma grid has {grid.shape[0]} points, expected steps+1={expected} "
                "(unique_consecutive collapsed or a terminal 0 was appended)"
            )
        if float(grid[-1]) != 0.0:
            raise ValueError(f"{name} sigma grid must end at 0")
        if not np.all(np.diff(grid) < 0):
            raise ValueError(f"{name} sigma grid must be strictly decreasing")
    payload = sigma_payload(
        video,
        audio,
        steps=steps,
        video_shift=video_shift,
        audio_shift=audio_shift,
        rounding=rounding,
        pdd_blocks=pdd_blocks,
    )
    schedule = {
        "planned_updates": int(video.shape[0]) - 1,
        "sigma_grid_points": int(video.shape[0]),
        "video_shift": video_shift,
        "audio_shift": audio_shift,
        "sigmas_digest": hashlib.sha256(payload).hexdigest(),
        "semantics_version": constants.SCHEDULE_SEMANTICS,
        "rng_policy_id": constants.RNG_POLICY_ID,
    }
    facts = {
        "video_sigmas_sha256": grid_digest(video),
        "audio_sigmas_sha256": grid_digest(audio),
        "linspace_rounding": rounding,
        "scheduler": constants.SCHEDULER_ID,
        "dit_forwards": int(video.shape[0]) - 1,
    }
    if pdd_blocks is not None:
        facts["pdd_blocks"] = [int(b) for b in pdd_blocks]
    return schedule, payload, facts


def read_sigma_payload(payload: bytes) -> Mapping[str, np.ndarray]:
    """Decode a payload produced by :func:`sigma_payload` (bounded reader, no torch)."""
    header = read_header_from_bytes(payload)
    out = {}
    for name in ("video_sigmas", "audio_sigmas"):
        info = header.tensors[name]
        if info.dtype != "F32" or len(info.shape) != 1:
            raise ValueError(f"{name} must be F32 [S]")
        out[name] = np.frombuffer(
            tensor_bytes(payload, header, name), dtype="<f4"
        ).astype(np.float32)
    return out
