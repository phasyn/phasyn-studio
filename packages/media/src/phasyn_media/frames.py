"""Sample video frames by their real PTS (``video.describe``).

The source FPS is never changed and nothing is interpolated: ffprobe reads the PTS of every video
packet (sorted PTS = presentation order), the real frame closest to each target time is chosen,
and a single decode with a ``select`` filter extracts exactly those frames. Endpoints are kept by
default. The sampling rate is a starting value; it does not promise to show every instant.

Every tool runs through :func:`phasyn_media.tools.run_tool` (own process group, timeout, cancel,
bounded output) with the protocol and demuxer whitelists and ``file:`` inputs, so an uploaded HLS
playlist or concat list can never make FFmpeg open another local file or a URL. Error messages
never echo local paths.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np

from .errors import MediaError
from .files import check_local_file
from .limits import DEFAULT_LIMITS, MediaLimits
from .probe import probe, run_ffprobe_json
from .tools import find_ffmpeg, input_url, redact, run_tool, summarize_stderr

_PACKET_ENTRIES = "stream=time_base,avg_frame_rate,r_frame_rate,width,height,duration:packet=pts,dts,flags"
MAX_SAMPLE_GRID = 1_000_000  # sampling grid points of one video (an hour at 60 fps is 216,000)
_JPEG_TIMEOUT_S = 60.0


@dataclass(frozen=True)
class FrameTime:
    index: int  # frame number in presentation order (0-based)
    pts: int
    time_base: Fraction
    seconds: float


def _time_base(value: Any) -> Fraction:
    num, _, den = str(value or "1/1").partition("/")
    try:
        tb = Fraction(int(num), int(den or 1))
    except (ValueError, ZeroDivisionError) as exc:
        raise MediaError("MEDIA_TOOL_FAILED", "ffprobe 回報的 time_base 無法解析") from exc
    if tb <= 0:
        raise MediaError("MEDIA_TOOL_FAILED", "ffprobe 回報的 time_base 無法解析")
    return tb


def frame_times(
    path: str | Path,
    *,
    limits: MediaLimits = DEFAULT_LIMITS,
    cancel: Any = None,
    timeout: float | None = None,
) -> tuple[list[FrameTime], dict[str, Any]]:
    """PTS of every frame of the first video stream, read from packets (no decoding).

    Returns ``(frames, stream_info)``; more frames than ``limits.max_frames`` is rejected.
    """
    local = check_local_file(path, limits=limits)
    doc = run_ffprobe_json(
        local.path,
        ["-select_streams", "V:0", "-show_entries", _PACKET_ENTRIES],
        limits=limits,
        cancel=cancel,
        timeout=timeout or limits.process_timeout_seconds,
        max_output_bytes=limits.max_tool_output_bytes,
    )
    streams = doc.get("streams") or []
    if not streams:
        raise MediaError("INVALID_ARGUMENT", "沒有影片軌")
    stream = streams[0]
    tb = _time_base(stream.get("time_base"))
    try:
        pts_values = sorted(int(p["pts"]) for p in doc.get("packets") or [] if p.get("pts") not in (None, "N/A"))
    except (TypeError, ValueError) as exc:
        raise MediaError("MEDIA_TOOL_FAILED", "ffprobe 回報的 packet PTS 無法解析") from exc
    if not pts_values:
        raise MediaError("INVALID_ARGUMENT", "影片軌沒有可用的 PTS")
    if len(pts_values) > limits.max_frames:
        raise MediaError(
            "INVALID_ARGUMENT",
            "影格數超過上限",
            expected=f"<= {limits.max_frames}",
            actual=str(len(pts_values)),
        )
    start = pts_values[0]
    # The time span is bounded like the frame count: two packets hours apart would otherwise ask for a
    # sampling grid of that length (plan_samples) from a file of a few bytes.
    span = (pts_values[-1] - start) * tb
    if span > limits.max_duration_seconds:
        raise MediaError(
            "INVALID_ARGUMENT",
            "影片長度超過上限",
            expected=f"<= {limits.max_duration_seconds:g} s",
            actual=f"{float(span):g} s",
        )
    frames = [FrameTime(i, pts, tb, float((pts - start) * tb)) for i, pts in enumerate(pts_values)]
    info = {
        "width": stream.get("width"),
        "height": stream.get("height"),
        "time_base": f"{tb.numerator}/{tb.denominator}",
        "avg_frame_rate": stream.get("avg_frame_rate"),
        "frame_count": len(frames),
        "start_pts": start,
    }
    return frames, info


def plan_samples(
    frames: list[FrameTime], *, sampling_fps: float, preserve_endpoints: bool = True, max_frames: int | None = None
) -> list[FrameTime]:
    """Real frames closest to a ``sampling_fps`` grid; keeps the endpoints; thins evenly to ``max_frames``."""
    if not frames:
        return []
    if sampling_fps <= 0:
        raise MediaError("INVALID_ARGUMENT", "sampling_fps 必須大於 0")
    last = frames[-1].seconds
    count = max(1, math.floor(last * sampling_fps) + 1)
    if count > MAX_SAMPLE_GRID:
        raise MediaError("INVALID_ARGUMENT", "取樣點數超過上限", expected=f"<= {MAX_SAMPLE_GRID}", actual=str(count))
    targets = [i / sampling_fps for i in range(count)]
    times = np.array([f.seconds for f in frames])
    chosen: dict[int, FrameTime] = {}
    for t in targets:
        idx = int(np.abs(times - t).argmin())
        chosen[idx] = frames[idx]
    if preserve_endpoints:
        chosen[0] = frames[0]
        chosen[len(frames) - 1] = frames[-1]
    ordered = [chosen[k] for k in sorted(chosen)]
    if max_frames is not None and len(ordered) > max_frames >= 2:
        keep = {0, len(ordered) - 1} if preserve_endpoints else set()
        slots = max_frames - len(keep)
        inner = [i for i in range(len(ordered)) if i not in keep]
        if slots > 0 and inner:
            step = len(inner) / slots
            keep.update(inner[int(j * step)] for j in range(slots))
        ordered = [ordered[i] for i in sorted(keep)][:max_frames]
    return ordered


def extract_frames(
    path: str | Path,
    samples: list[FrameTime],
    *,
    max_side: int = 768,
    limits: MediaLimits = DEFAULT_LIMITS,
    cancel: Any = None,
    timeout: float = 600.0,
) -> list[np.ndarray]:
    """Decode once and return the requested frames as RGB ``uint8 [H, W, 3]`` arrays.

    Frames are scaled (after RGB conversion) so the longer side is at most ``max_side``; a sample
    listed twice is returned twice.
    """
    if not samples:
        return []
    local = check_local_file(path, limits=limits)
    info = probe(local.path, limits=limits, count_frames=False, cancel=cancel)
    width, height = int(info.width or 0), int(info.height or 0)
    if info.kind != "video" or width <= 0 or height <= 0:
        raise MediaError("INVALID_ARGUMENT", "無法取得影片尺寸")
    scale = min(1.0, max_side / max(width, height))
    out_w = max(2, round(width * scale / 2) * 2)
    out_h = max(2, round(height * scale / 2) * 2)
    order = [s.index for s in samples]
    unique = sorted(set(order))  # select emits each frame once; duplicates are expanded below
    expr = "+".join(f"eq(n\\,{i})" for i in unique)
    argv = [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-v", "error",
        "-protocol_whitelist", "file", "-format_whitelist", limits.format_whitelist, *limits.decoder_flags,
        "-i", input_url(local.path),
        "-map", "0:V:0", "-vf", f"select='{expr}',scale={out_w}:{out_h}:flags=bicubic",
        "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]  # fmt: skip
    frame_bytes = out_w * out_h * 3
    result = run_tool(
        argv,
        timeout=min(timeout, limits.process_timeout_seconds),
        cancel=cancel,
        max_stdout_bytes=frame_bytes * (len(unique) + 1),
        max_stderr_bytes=limits.max_stderr_bytes,
        what="FFmpeg 取樣影格",
    )
    if result.returncode != 0:
        marks = {os.fspath(local.path): "<input>", input_url(local.path): "<input>"}
        detail = summarize_stderr(redact(result.stderr, marks), 600)
        raise MediaError("MEDIA_TOOL_FAILED", "FFmpeg 取樣影格失敗" + (f"：{detail}" if detail else ""))
    n = len(result.stdout) // frame_bytes
    if n != len(unique) or len(result.stdout) % frame_bytes:
        raise MediaError("MEDIA_INCOMPLETE", f"取樣影格數 {n} ≠ 要求 {len(unique)}")
    data = np.frombuffer(result.stdout, dtype=np.uint8).reshape(n, out_h, out_w, 3)
    by_index = {idx: data[k] for k, idx in enumerate(unique)}
    return [by_index[i].copy() for i in order]


def encode_jpeg(frame: np.ndarray, *, quality: int = 85, cancel: Any = None) -> bytes:
    """Encode one RGB frame as JPEG for evidence files (FFmpeg's mjpeg; no Pillow dependency)."""
    h, w, _ = frame.shape
    argv = [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-v", "error",
        "-protocol_whitelist", "pipe", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "pipe:0",
        "-frames:v", "1", "-q:v", str(max(2, min(31, round((100 - quality) / 3.3)))),
        "-f", "image2", "-c:v", "mjpeg", "pipe:1",
    ]  # fmt: skip
    raw = frame.tobytes()
    result = run_tool(
        argv,
        timeout=_JPEG_TIMEOUT_S,
        cancel=cancel,
        stdin_data=raw,
        max_stdout_bytes=len(raw) + (1 << 20),
        what="JPEG 編碼",
    )
    if result.returncode != 0 or not result.stdout:
        detail = summarize_stderr(result.stderr, 300)
        raise MediaError("MEDIA_TOOL_FAILED", "JPEG 編碼失敗" + (f"：{detail}" if detail else ""))
    return result.stdout


__all__ = ["FrameTime", "encode_jpeg", "extract_frames", "frame_times", "plan_samples"]
