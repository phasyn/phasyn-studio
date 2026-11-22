# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/denoise_loop.py (MiniMaxH3DenoiseBranch._expand_step_timesteps and the condition timesteps) and
# python/sglang/multimodal_gen/runtime/models/dits/minimax_h3_adaln_cache.py (_plan_key)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: numpy port that runs before a DiT is loaded.
"""Plan sigma grids and AdaLN step plans (numpy only, no torch).

The plan-owned sigma artifact is authoritative: the runtime never
recomputes schedules, it only validates them and derives the per-step
unique timestep sets exactly the way the pinned denoise loop does
(``S/denoise_loop.py:359-443``), so AdaLN sidecar coverage can be checked on the
CPU before a 60 GiB DiT is loaded.
"""

from __future__ import annotations

import itertools
import math
import struct
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict, Unpack

import numpy as np

from phasyn_h3.recipe.abi.tensors import file_sha256, read_header_from_file

from ._arguments import validate_keywords
from .errors import AdalnCacheMiss, IntegrityMismatch, InvalidStageInput


class _StepTimings(TypedDict, total=False):
    has_dense_rows: bool
    has_visual_condition: bool
    has_audio_reference: bool
    imgvid_noise_aug: float
    audio_noise_aug: float


_MIN_SIGMAS = 2
_PLAN_RANK = 2


IMGVID_COND_TIMESTEP = 0.999  # S/denoise_loop.py:30
AUDIO_REF_COND_TIMESTEP = 1.0  # S/denoise_loop.py:32
_NP_DTYPES = {
    "F32": np.float32,
    "F64": np.float64,
    "I64": np.int64,
    "I32": np.int32,
    "U8": np.uint8,
    "BOOL": np.bool_,
}


def read_tensor(path: Path, name: str) -> np.ndarray:
    """Read the named tensor used by the sampling schedule."""
    header = read_header_from_file(path)
    info = header.tensors.get(name)
    if info is None:
        raise InvalidStageInput(
            "TENSOR_MISSING", f"{Path(path).name} 缺少 tensor {name}"
        )
    if info.dtype not in _NP_DTYPES:
        raise InvalidStageInput(
            "TENSOR_DTYPE", f"{name}: dtype {info.dtype} 不支援 numpy 讀取"
        )
    with Path(path).open("rb") as fh:
        fh.seek(header.data_offset + info.start)
        raw = fh.read(info.byte_length)
    if len(raw) != info.byte_length:
        raise InvalidStageInput("TENSOR_TRUNCATED", f"{name}: 讀取長度不足")
    return np.frombuffer(raw, dtype=_NP_DTYPES[info.dtype]).reshape(info.shape)


@dataclass(frozen=True)
class SigmaGrid:
    """Hold the schedule and update boundaries used by sampling."""

    video: tuple[float, ...]
    audio: tuple[float, ...]
    sha256: str

    @property
    def updates(self) -> int:
        """Return the number of transitions on the sigma grid."""
        return len(self.video) - 1


def load_sigma_grid(path: Path, schedule: Mapping[str, object]) -> SigmaGrid:
    """Load the sigma values for this sampling schedule."""
    digest, _ = file_sha256(path)
    expected = schedule.get("sigmas_digest")
    if expected is not None and digest != expected:
        raise IntegrityMismatch(
            "SIGMAS_DIGEST_MISMATCH",
            "sigma grid artifact 與 plan.schedule.sigmas_digest 不符",
            expected=expected,
            actual=digest,
        )
    video = read_tensor(path, "video_sigmas")
    audio = read_tensor(path, "audio_sigmas")
    for name, arr in (("video_sigmas", video), ("audio_sigmas", audio)):
        if arr.ndim != 1:
            raise InvalidStageInput("SIGMAS_RANK", f"{name} 必須是一維")
        if arr.dtype not in (np.float32, np.float64):
            raise InvalidStageInput("SIGMAS_DTYPE", f"{name} 必須是浮點")
    # exact fp32 values as Python floats (mirrors the upstream float32 tensor .tolist)
    v = tuple(float(x) for x in video.astype(np.float32).tolist())
    a = tuple(float(x) for x in audio.astype(np.float32).tolist())
    validate_grids(v, a, schedule)
    return SigmaGrid(video=v, audio=a, sha256=digest)


def validate_grids(
    video: Sequence[float], audio: Sequence[float], schedule: Mapping[str, object]
) -> None:
    """: equal lengths = steps + 1, terminal 0, finite, non-increasing."""
    planned = schedule.get("planned_updates")
    points = schedule.get("sigma_grid_points")
    if len(video) != len(audio):
        raise InvalidStageInput(
            "SIGMA_LENGTH_MISMATCH",
            f"video {len(video)} 與 audio {len(audio)} sigma 長度不同",
        )
    if len(video) < _MIN_SIGMAS:
        raise InvalidStageInput("SIGMA_TOO_SHORT", "sigma grid 至少需要 2 點")
    for key, value in (("planned_updates", planned), ("sigma_grid_points", points)):
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int)
        ):
            raise InvalidStageInput(
                "SCHEDULE_FIELD_INVALID", f"schedule.{key} 必須是整數，收到 {value!r}"
            )
    if isinstance(planned, int) and len(video) != planned + 1:
        raise InvalidStageInput(
            "SIGMA_STEPS_MISMATCH",
            f"sigma 點數 {len(video)} ≠ planned_updates+1 ({planned}+1)",
        )
    if isinstance(points, int) and len(video) != points:
        raise InvalidStageInput(
            "SIGMA_POINTS_MISMATCH",
            f"sigma 點數 {len(video)} ≠ sigma_grid_points {points}",
        )
    _check_sigma_ranges(video, audio)


def step_unique_timesteps(
    grid: SigmaGrid, **arguments: Unpack[_StepTimings]
) -> list[np.ndarray]:
    """Per-step sorted unique fp32 timesteps (``MiniMaxH3DenoiseBranch._expand_step_timesteps``)."""
    validate_keywords(arguments, _StepTimings)
    has_dense_rows = arguments.get("has_dense_rows", True)
    has_visual_condition = arguments.get("has_visual_condition", False)
    has_audio_reference = arguments.get("has_audio_reference", False)
    imgvid_noise_aug = arguments.get("imgvid_noise_aug", IMGVID_COND_TIMESTEP)
    audio_noise_aug = arguments.get("audio_noise_aug", AUDIO_REF_COND_TIMESTEP)
    plans = []
    for s_v, s_a in zip(grid.video[:-1], grid.audio[:-1], strict=True):
        t_video = 1.0 - s_v
        t_audio = 1.0 - s_a
        candidates: list[float] = []
        if has_dense_rows:
            candidates.append(t_video)
        if has_visual_condition:
            candidates.append(max(t_video, imgvid_noise_aug))
        candidates.append(t_audio)
        if has_audio_reference:
            candidates.append(max(t_audio, audio_noise_aug))
        plans.append(np.unique(np.asarray(candidates, dtype=np.float32)))
    return plans


def plan_key(values: np.ndarray) -> tuple[int, ...]:
    """fp32 bit patterns (``minimax_h3_adaln_cache._plan_key``)."""
    return tuple(
        struct.unpack("<I", struct.pack("<f", float(v)))[0]
        for v in values.astype(np.float32).tolist()
    )


def sidecar_keys(
    plan_timesteps: np.ndarray, plan_lengths: np.ndarray
) -> set[tuple[int, ...]]:
    """Identify the AdaLN entries required by the schedule."""
    if (
        plan_timesteps.ndim != _PLAN_RANK
        or plan_lengths.ndim != 1
        or plan_lengths.shape[0] != plan_timesteps.shape[0]
    ):
        raise IntegrityMismatch(
            "ADALN_SIDECAR_SHAPE",
            "AdaLN sidecar plan_timesteps/plan_lengths 形狀不合法",
        )
    keys = set()
    for row, length in zip(plan_timesteps, plan_lengths.tolist(), strict=True):
        if not 1 <= int(length) <= plan_timesteps.shape[1]:
            raise IntegrityMismatch(
                "ADALN_SIDECAR_LENGTH", "AdaLN sidecar plan_lengths 越界"
            )
        keys.add(plan_key(row[: int(length)]))
    return keys


def check_sidecar_coverage(
    plans: Sequence[np.ndarray], available: set[tuple[int, ...]]
) -> None:
    """Validate that the sidecar covers all required steps."""
    missing = [i for i, plan in enumerate(plans) if plan_key(plan) not in available]
    if missing:
        raise AdalnCacheMiss(
            f"固定 AdaLN cache 未涵蓋 {len(missing)}/{len(plans)} 個 step plan（首個缺 step {missing[0]}）；"
            "需新 plan 或重建 sidecar，不插值、不假設原始 linears 存在",
            expected="all step plans cached",
            actual=f"missing steps {missing[:8]}",
        )


__all__ = [
    "AUDIO_REF_COND_TIMESTEP",
    "IMGVID_COND_TIMESTEP",
    "SigmaGrid",
    "check_sidecar_coverage",
    "load_sigma_grid",
    "plan_key",
    "read_tensor",
    "sidecar_keys",
    "step_unique_timesteps",
    "validate_grids",
]


def _check_sigma_ranges(video: Sequence[float], audio: Sequence[float]) -> None:
    for name, grid in (("video", video), ("audio", audio)):
        if any(not math.isfinite(x) for x in grid):
            raise InvalidStageInput("SIGMA_NOT_FINITE", f"{name} sigma 含非有限值")
        if grid[-1] != 0.0:
            raise InvalidStageInput(
                "SIGMA_TERMINAL_NONZERO", f"{name} sigma 終點必須為 0"
            )
        if any(x < 0.0 or x > 1.0 for x in grid):
            raise InvalidStageInput("SIGMA_RANGE", f"{name} sigma 必須落在 [0,1]")
        if any(b > a for a, b in itertools.pairwise(grid)):
            raise InvalidStageInput("SIGMA_NOT_MONOTONIC", f"{name} sigma 必須非遞增")
