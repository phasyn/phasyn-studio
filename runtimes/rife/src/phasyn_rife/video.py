"""Stream a selected part of a CFR take through RIFE and publish a verified MP4."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import numpy as np
from numpy.typing import NDArray
from phasyn_captioner.upscale.video import (
    FrameReader,
    SourceVideo,
    attach_audio,
    inspect_source,
)
from phasyn_components.errors import ComponentError
from phasyn_media.encode import StreamingVideoEncoder
from phasyn_media.errors import raise_if_canceled
from phasyn_media.files import (
    check_local_file,
    check_output_path,
    fsync_dir,
    unchanged_since,
)
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.scenes import SceneDetection, detect_scene_cuts


Frame = NDArray[np.uint8]
Interpolator = Callable[[Frame, Frame, float], Frame]
Interval = tuple[int, int]
MAX_SOURCE_FRAMES = 7200
MAX_RANGES = 256
LIMITS = replace(DEFAULT_LIMITS, max_pixels=2048 * 1088, max_frames=28_800)


def _invalid(key: str) -> ComponentError:
    return ComponentError(
        "INVALID_ARGUMENT",
        f"補幀參數 {key} 不合法",
        details={"field_paths": [f"parameters.{key}"]},
    )


def _integer(value: Any, low: int, high: int) -> bool:
    return (
        isinstance(value, int) and not isinstance(value, bool) and low <= value <= high
    )


def _intervals(value: Any, key: str, count: int) -> list[Interval]:
    if not isinstance(value, list) or len(value) > MAX_RANGES:
        raise _invalid(key)
    intervals: list[Interval] = []
    for item in value:
        if not isinstance(item, Mapping) or set(item) != {"start_frame", "end_frame"}:
            raise _invalid(key)
        start, end = item["start_frame"], item["end_frame"]
        if not _integer(start, 0, count - 1) or not _integer(end, start + 1, count):
            raise _invalid(key)
        intervals.append((start, end))
    result: list[Interval] = []
    for start, end in sorted(intervals):
        if result and start < result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], end))
        else:
            # Adjacent selected ranges retain their editorial boundary.
            result.append((start, end))
    return result


@dataclass(frozen=True)
class Plan:
    """Resolved source-frame intervals and output timebase."""

    multiplier: int
    mode: str
    selected: list[Interval]
    holds: list[Interval]
    threshold: float
    crf: int
    audio_policy: str
    fps: Fraction
    frames: int


def _audio_mode(source: SourceVideo, params: Mapping[str, Any]) -> tuple[str, str]:
    mode = params.get("mode", "smooth")
    if mode not in ("smooth", "slow"):
        raise _invalid("mode")
    audio = params.get("audio_policy", "preserve")
    if audio not in ("preserve", "drop") or (mode == "smooth" and audio == "drop"):
        raise _invalid("audio_policy")
    if mode == "slow" and source.audio and audio != "drop":
        raise ComponentError(
            "UNSUPPORTED_SETTING", "來源有音訊，慢動作須明確選擇捨棄音軌"
        )
    return mode, audio


def _plan(source: SourceVideo, params: Mapping[str, Any]) -> Plan:
    keys = {
        "mode",
        "multiplier",
        "ranges",
        "holds",
        "scene_threshold",
        "crf",
        "audio_policy",
    }
    if unknown := params.keys() - keys:
        raise _invalid(min(unknown))
    count = source.frames
    if not 1 <= count <= MAX_SOURCE_FRAMES:
        raise ComponentError("INPUT_TOO_LARGE", "補幀來源須為 1 到 7200 幀")
    multiplier = params.get("multiplier", 2)
    if not _integer(multiplier, 2, 4):
        raise _invalid("multiplier")
    crf = params.get("crf", 16)
    if not _integer(crf, 1, 51):
        raise _invalid("crf")
    threshold = params.get("scene_threshold", 0.3)
    if (
        isinstance(threshold, bool)
        or not isinstance(threshold, int | float)
        or not 0 <= threshold <= 1
    ):
        raise _invalid("scene_threshold")
    mode, audio = _audio_mode(source, params)
    ranges = _intervals(params.get("ranges", []), "ranges", count) or [(0, count)]
    holds = _intervals(params.get("holds", []), "holds", count)
    if mode == "smooth":
        fps, frames = source.fps * multiplier, count * multiplier
    else:
        fps = source.fps
        frames = count + sum(end - start for start, end in ranges) * (multiplier - 1)
    if frames / fps > LIMITS.max_duration_seconds:
        raise ComponentError("INPUT_TOO_LARGE", "補幀結果超過允許時長")
    return Plan(
        multiplier, mode, ranges, holds, float(threshold), crf, audio, fps, frames
    )


def _cuts(source: SourceVideo, plan: Plan, cancel: Any) -> set[int]:
    if plan.threshold == 1 or source.frames == 1:
        return set()
    result = detect_scene_cuts(
        source.path,
        SceneDetection(threshold=plan.threshold, min_gap_seconds=0),
        duration_seconds=float(source.frames / source.fps),
        cancel=cancel,
        limits=LIMITS,
    )
    if result.untimed_frames:
        raise ComponentError("MEDIA_INCOMPLETE", "切鏡候選影格缺少時間資訊")
    # The detector returns presentation time relative to the first decoded frame.
    return {
        round(Fraction(str(seconds)) * source.fps) for seconds in result.cuts_seconds
    }


def _timing(
    source: SourceVideo, plan: Plan
) -> tuple[list[int], bytearray, list[dict[str, int]]]:
    """Build per-source-frame output counts, eligible edges and a compact piecewise time map."""
    counts = [plan.multiplier if plan.mode == "smooth" else 1] * source.frames
    edges = bytearray(source.frames)
    for start, end in plan.selected:
        counts[start:end] = [plan.multiplier] * (end - start)
        edges[start : end - 1] = bytes([1]) * (end - start - 1)
    for start, end in plan.holds:
        first = max(0, start - 1)
        edges[first:end] = bytes(end - first)
    mapping = []
    start = offset = 0
    for end in range(1, source.frames + 1):
        stride = counts[start]
        if end == source.frames or counts[end] != stride:
            next_offset = offset + (end - start) * stride
            mapping.append(
                {
                    "source_start_frame": start,
                    "source_end_frame": end,
                    "output_start_frame": offset,
                    "output_end_frame": next_offset,
                    "output_frames_per_source_frame": stride,
                }
            )
            start, offset = end, next_offset
    return counts, edges, mapping


def _encode(
    track: Path,
    source: SourceVideo,
    plan: Plan,
    *,
    interpolate: Interpolator,
    cancel: Any,
) -> tuple[int, set[int], list[dict[str, int]]]:
    cuts = _cuts(source, plan, cancel)
    counts, edges, mapping = _timing(source, plan)
    for cut in cuts:
        if not 0 < cut < source.frames:
            raise ComponentError("INTEGRITY_MISMATCH", "切鏡時間超出影片範圍")
        edges[cut - 1] = 0
    synthesized = 0
    with (
        StreamingVideoEncoder(
            track,
            width=source.width,
            height=source.height,
            fps_num=plan.fps.numerator,
            fps_den=plan.fps.denominator,
            quality=plan.crf,
            expected_frames=plan.frames,
            max_queue_chunks=2,
            cancel=cancel,
            limits=LIMITS,
        ) as encoder,
        FrameReader(source, cancel=cancel, limits=LIMITS) as reader,
    ):
        frames = reader.frames()
        current = next(frames)
        for index, ticks in enumerate(counts):
            following = next(frames, None)
            encoder.write_chunk(current[None, ...])
            for tick in range(1, ticks):
                raise_if_canceled(cancel)
                frame = current
                if edges[index] and following is not None:
                    frame = interpolate(current, following, tick / ticks)
                    synthesized += 1
                encoder.write_chunk(frame[None, ...])
            if following is not None:
                current = following
        encoder.finish()
    return synthesized, cuts, mapping


def _rate(fps: Fraction) -> dict[str, int]:
    return {"num": fps.numerator, "den": fps.denominator}


def render(
    source_path: Path,
    output: Path,
    *,
    parameters: Mapping[str, Any],
    interpolate: Interpolator,
    cancel: Any,
) -> dict[str, Any]:
    """Retain the original frame at every mapped source boundary, including the last one."""
    local = check_local_file(source_path, limits=LIMITS)
    final = check_output_path(output, inputs=(local.path,))
    if final.suffix.lower() != ".mp4" or os.path.lexists(final):
        raise ComponentError("INVALID_ARGUMENT", "補幀輸出必須是尚未使用的 MP4 檔名")
    source = inspect_source(
        local.path, cancel=cancel, limits=replace(LIMITS, max_frames=MAX_SOURCE_FRAMES)
    )
    plan = _plan(source, parameters)
    with TemporaryDirectory(dir=final.parent, prefix=".rife-") as work:
        track = Path(work) / "video.mp4"
        synthesized, cuts, mapping = _encode(
            track,
            source,
            plan,
            interpolate=interpolate,
            cancel=cancel,
        )
        result = track
        if source.audio and plan.audio_policy == "preserve":
            result = Path(work) / "muxed.mp4"
            attach_audio(
                track,
                replace(source, fps=plan.fps),
                result,
                frames=plan.frames,
                cancel=cancel,
                limits=LIMITS,
            )
        if not unchanged_since(local):
            raise ComponentError("INTEGRITY_MISMATCH", "補幀期間來源影片被修改")
        raise_if_canceled(cancel)
        # Both names are on the same filesystem. Concurrent writers cannot replace a verified result.
        os.link(result, final)
        fsync_dir(final.parent)
    return {
        "frames": plan.frames,
        "fps": _rate(plan.fps),
        "width": source.width,
        "height": source.height,
        "source_frames": source.frames,
        "source_fps": _rate(source.fps),
        "interpolated_frames": synthesized,
        "held_frames": plan.frames - source.frames - synthesized,
        "detected_cut_frames": sorted(cuts),
        "time_mapping": mapping,
        "multiplier": plan.multiplier,
        "mode": plan.mode,
        "scene_threshold": plan.threshold,
        "ranges": [
            {"start_frame": start, "end_frame": end} for start, end in plan.selected
        ],
        "holds": [
            {"start_frame": start, "end_frame": end} for start, end in plan.holds
        ],
        "crf": plan.crf,
        "audio_policy": plan.audio_policy,
        "has_audio": bool(source.audio and plan.audio_policy == "preserve"),
    }
