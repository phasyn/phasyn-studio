"""Prepare bounded reference media and retain the original soundtrack through native generation."""

from __future__ import annotations

import hashlib
import math
import wave
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from phasyn_components.errors import ComponentError
from phasyn_media.limits import DEFAULT_LIMITS, MediaLimits
from phasyn_media.probe import probe
from phasyn_media.timeline import scan_timeline
from phasyn_media.tools import find_ffmpeg, input_url, run_tool


if TYPE_CHECKING:
    from pathlib import Path

    from phasyn_components.provider import RunContext
    from phasyn_media.probe import MediaInfo
    from phasyn_media.tools import ToolResult


DEFAULT_DURATION = 30
_RATE = 16000
_SPEECH_FPS = 16


def _input(path: Path) -> list[str]:
    return [
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        DEFAULT_LIMITS.format_whitelist,
        "-i",
        input_url(path),
    ]


def _ff(ctx: RunContext, arguments: list[str]) -> ToolResult:
    return run_tool(
        [find_ffmpeg(), "-v", "error", "-nostdin", *arguments],
        cancel=ctx.cancel_token,
        timeout=ctx.remaining_seconds(),
        what="Wan FFmpeg",
    )


@dataclass(frozen=True)
class Materials:
    """Input media validated before performing a CUDA call."""

    driving: Path
    audio: bool
    offset: float
    frames: int
    limits: MediaLimits


def _offset(ctx: RunContext, path: Path, limits: MediaLimits) -> float:
    timeline = scan_timeline(path, limits=limits, cancel=ctx.cancel_token)
    video, audio = timeline.of_type("video"), timeline.of_type("audio")
    return audio[0].start_seconds - video[0].start_seconds if video and audio else 0.0


def prepare(ctx: RunContext, workspace: Path, role: str) -> Materials:
    """Normalize only the conditioning input; keep the original media for final delivery."""
    reference = ctx.input("character").require_path("character")
    port = "audio" if role == "speech" else "driving"
    driving = ctx.input(port).require_path(port)
    seconds = (ctx.settings.get("load", {}).get("provider_options") or {}).get(
        "max_duration_seconds", DEFAULT_DURATION
    )
    limits = replace(DEFAULT_LIMITS, max_duration_seconds=seconds)
    ref = probe(reference, limits=limits, cancel=ctx.cancel_token)
    media = probe(driving, limits=limits, cancel=ctx.cancel_token)
    if (
        ref.kind != "image"
        or media.kind != ("audio" if role == "speech" else "video")
        or media.audio_streams > 1
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", "角色必須是靜態圖，驅動素材只能有一條選定音軌"
        )
    image = _ff(
        ctx,
        [
            *_input(reference),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            str(workspace / "reference.png"),
        ],
    )
    if image.returncode:
        raise ComponentError("MEDIA_TOOL_FAILED", "無法解碼角色參考圖")
    if role == "performance":
        return Materials(
            driving, media.has_audio, _offset(ctx, driving, limits), 0, limits
        )
    wav = workspace / "conditioning.wav"
    sound = _ff(
        ctx,
        [
            *_input(driving),
            "-map",
            "0:a:0",
            "-vn",
            "-ar",
            str(_RATE),
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(wav),
        ],
    )
    if sound.returncode:
        raise ComponentError("MEDIA_TOOL_FAILED", "無法解碼語音條件素材")
    with wave.open(str(wav)) as decoded:
        frames = math.ceil(decoded.getnframes() * _SPEECH_FPS / decoded.getframerate())
    if frames < 1:
        raise ComponentError("INVALID_ARGUMENT", "音訊沒有可用樣本")
    return Materials(
        driving=driving, audio=True, offset=0.0, frames=frames, limits=limits
    )


def _audio_hash(ctx: RunContext, path: Path) -> str:
    # Hash canonical interleaved samples as well as checking the rate/channels through probing.
    checksum = hashlib.sha256()
    argv = [
        find_ffmpeg(),
        "-v",
        "error",
        "-nostdin",
        *_input(path),
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "pcm_f64le",
        "-f",
        "f64le",
        "pipe:1",
    ]
    result = run_tool(
        argv,
        stdout_sink=checksum.update,
        cancel=ctx.cancel_token,
        timeout=ctx.remaining_seconds(),
        what="Wan audio verification",
    )
    if result.returncode:
        raise ComponentError("MEDIA_TOOL_FAILED", "無法驗證音軌樣本")
    return checksum.hexdigest()


def deliver(
    ctx: RunContext, workspace: Path, source: Materials, geometry: dict[str, int]
) -> tuple[Path, MediaInfo, str | None]:
    """Verify a complete native video, then stream-copy and check the original decoded audio samples."""
    generated = workspace / "generated.mp4"
    limits = replace(
        source.limits, max_duration_seconds=source.limits.max_duration_seconds + 1
    )
    actual = probe(generated, limits=limits, cancel=ctx.cancel_token)
    if (
        actual.kind != "video"
        or actual.video_streams != 1
        or actual.has_audio
        or actual.frame_count != geometry["frames"]
        or actual.fps_den != 1
        or actual.fps_num != geometry["fps"]
        or not actual.frame_count_exact
    ):
        raise ComponentError(
            "INTEGRITY_MISMATCH", "原生輸出幀數或幀率與實際探測結果不符"
        )
    if not source.audio:
        return generated, actual, None
    before = probe(source.driving, limits=source.limits, cancel=ctx.cancel_token)
    expected = _audio_hash(ctx, source.driving)
    for suffix in (".mp4", ".mkv"):
        output = workspace / ("finished" + suffix)
        result = _ff(
            ctx,
            [
                *_input(generated),
                *_input(source.driving),
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-map_metadata",
                "-1",
                "-c",
                "copy",
                str(output),
            ],
        )
        if result.returncode:
            continue
        media = probe(output, limits=limits, cancel=ctx.cancel_token)
        if (
            media.audio_streams == 1
            and media.video_streams == 1
            and media.frame_count == actual.frame_count
            and (media.width, media.height, media.fps_num, media.fps_den)
            == (actual.width, actual.height, actual.fps_num, actual.fps_den)
            and (before.audio_channels, before.audio_sample_rate)
            == (media.audio_channels, media.audio_sample_rate)
            and abs(_offset(ctx, output, limits) - source.offset) <= 1 / geometry["fps"]
            and expected == _audio_hash(ctx, output)
        ):
            return output, media, expected
    raise ComponentError("INTEGRITY_MISMATCH", "無法完整保留原音樣本或音畫時間差")
