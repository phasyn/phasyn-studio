"""Inspect single-view local media and retain presentation coordinates across tools."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from fractions import Fraction
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError
from phasyn_media.files import check_local_file
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.probe import probe, run_ffprobe_json
from phasyn_media.providers._analysis_video import read_clock
from phasyn_media.tools import find_ffmpeg, find_ffprobe, input_url, run_tool


if TYPE_CHECKING:
    from pathlib import Path

    from phasyn_components.provider import RunContext
    from phasyn_media.files import LocalFile


ROLES = ("source", "mask", "depth", "pose")
_FORMATS = {
    "png_pipe": ("png", "image/png"),
    "jpeg_pipe": ("jpg", "image/jpeg"),
    "bmp_pipe": ("bmp", "image/bmp"),
    "webp_pipe": ("webp", "image/webp"),
    "tiff_pipe": ("tif", "image/tiff"),
    "matroska": ("mkv", "video/x-matroska"),
    "mov": ("mp4", "video/mp4"),
}


@dataclass(frozen=True)
class Material:
    """The file verified against a Node reference and its media edit contract."""

    local: LocalFile
    record: dict[str, Any]


def alpha_formats(ctx: RunContext) -> dict[str, bool]:
    """Read this installed FFmpeg build's pixel-format alpha flags."""
    result = run_tool(
        [
            find_ffprobe(),
            "-v",
            "error",
            "-show_pixel_formats",
            "-show_entries",
            "pixel_format=name:pixel_format_flags=alpha",
            "-of",
            "json",
        ],
        timeout=min(ctx.remaining_seconds(), DEFAULT_LIMITS.probe_timeout_seconds),
        cancel=ctx.cancel_token,
        max_stdout_bytes=2 * 1024**2,
    )
    if result.returncode:
        raise ComponentError(
            "MEDIA_TOOL_FAILED", "Could not inspect pixel format alpha flags"
        )
    entries = json.loads(result.stdout).get("pixel_formats", [])
    return {
        row["name"]: bool(row["flags"]["alpha"])
        for row in entries
        if row.get("flags", {}).get("alpha") in (0, 1)
    }


def _rate(value: Fraction) -> dict[str, int]:
    return {"num": value.numerator, "den": value.denominator}


def _clock(ctx: RunContext, path: Path) -> dict[str, Any]:
    clock = read_clock(path, ctx)
    digest = hashlib.sha256()
    for tick in clock.ticks:
        instant = (clock.first_pts + tick) * clock.time_base
        digest.update(f"{instant.numerator}/{instant.denominator}\n".encode("ascii"))
    return {
        "time_base": _rate(clock.time_base),
        "first_pts": clock.first_pts,
        "end_pts_exclusive": clock.first_pts + clock.ticks[-1],
        "frame_count": clock.count,
        "presentation_sha256": digest.hexdigest(),
    }


def _aspect(stream: dict[str, Any]) -> str | None:
    raw = stream.get("sample_aspect_ratio")
    if not raw or raw in ("N/A", "0:1"):
        return None
    try:
        ratio = Fraction(str(raw).replace(":", "/"))
    except (ValueError, ZeroDivisionError) as exc:
        raise ComponentError("INVALID_ARGUMENT", "Invalid sample aspect ratio") from exc
    if ratio <= 0:
        raise ComponentError("INVALID_ARGUMENT", "Sample aspect ratio must be positive")
    return f"{ratio.numerator}:{ratio.denominator}"


def _encoding(format_name: str, media_type: str) -> tuple[str, str]:
    demux = format_name.partition(",")[0]
    if demux == "matroska" and media_type == "video/webm":
        return "webm", media_type
    if demux == "mov" and media_type == "video/quicktime":
        return "mov", media_type
    if demux not in _FORMATS:
        raise ComponentError(
            "UNSUPPORTED_SETTING", "Unsupported art exchange container"
        )
    return _FORMATS[demux]


def inspect(
    ctx: RunContext,
    port: str,
    role: str,
    kind: str,
    alpha: dict[str, bool],
) -> Material:
    """Inspect one ordinary image or one video, recording exact times for moving plates."""
    item = ctx.input(port)
    if item.file is None:
        raise ComponentError(
            "INVALID_ARGUMENT", "Art material requires a published file reference"
        )
    local = check_local_file(item.require_path(port))
    info = probe(local.path, count_frames=False, cancel=ctx.cancel_token)
    if (
        info.kind != kind
        or info.video_streams != 1
        or not info.width
        or not info.height
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", f"Expected a single {kind} canvas for {role}"
        )
    counts = ["-count_frames"] if kind == "image" else []
    doc = run_ffprobe_json(
        local.path,
        [
            "-select_streams",
            "V:0",
            *counts,
            "-show_entries",
            "stream=sample_aspect_ratio,nb_read_frames:stream_tags=alpha_mode",
        ],
        limits=DEFAULT_LIMITS,
        cancel=ctx.cancel_token,
        timeout=min(ctx.remaining_seconds(), DEFAULT_LIMITS.process_timeout_seconds),
    )
    stream = doc["streams"][0]
    if kind == "image" and str(stream.get("nb_read_frames")) != "1":
        raise ComponentError("INVALID_ARGUMENT", "Animated images need a video input")
    has_alpha = alpha.get(info.pixel_format or "")
    if str(stream.get("tags", {}).get("alpha_mode")) == "1":
        has_alpha = True
    if has_alpha is None:
        raise ComponentError("UNSUPPORTED_SETTING", f"Cannot verify alpha for {role}")
    suffix, media_type = _encoding(info.format_name, item.file["media_type"])
    clock = _clock(ctx, local.path) if kind == "video" else None
    fps = (
        _rate(Fraction(info.fps_num, info.fps_den))
        if kind == "video" and info.fps_num and info.fps_den
        else None
    )
    fields = ("node_id", "file_id", "size_bytes", "sha256", "media_type")
    return Material(
        local,
        {
            "role": role,
            "kind": kind,
            "file": {key: item.file[key] for key in fields},
            "member": f"media/{role}.{suffix}",
            "media_type": media_type,
            "width": info.width,
            "height": info.height,
            "sample_aspect_ratio": _aspect(stream),
            "rotation_degrees": info.rotation_degrees or 0,
            "pixel_format": info.pixel_format,
            "alpha_channel": has_alpha,
            "color": {
                "primaries": info.color_primaries,
                "transfer": info.color_transfer,
                "matrix": info.color_space,
                "range": info.color_range,
            },
            "fps": fps,
            "clock": clock,
            "has_audio": info.has_audio,
            "audio_sample_rate": info.audio_sample_rate,
            "audio_channels": info.audio_channels,
        },
    )


def reference_png(ctx: RunContext, path: Path) -> bytes:
    """Give paint tools a bounded PNG preview of the first visible frame."""
    result = run_tool(
        [
            find_ffmpeg(),
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            DEFAULT_LIMITS.format_whitelist,
            *DEFAULT_LIMITS.decoder_flags,
            "-i",
            input_url(path),
            "-map",
            "0:V:0",
            "-frames:v",
            "1",
            "-an",
            "-vf",
            "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
            "-threads",
            "1",
            "-c:v",
            "png",
            "-f",
            "image2pipe",
            "pipe:1",
        ],
        timeout=min(ctx.remaining_seconds(), DEFAULT_LIMITS.process_timeout_seconds),
        cancel=ctx.cancel_token,
        max_stdout_bytes=12 * 1024**2,
    )
    if result.returncode or not result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ComponentError(
            "MEDIA_TOOL_FAILED", "Could not create the art reference PNG"
        )
    return result.stdout
