"""Decode one selected track onto the presentation timeline of its source media."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from math import isfinite
from typing import TYPE_CHECKING

from phasyn_components.errors import ComponentError
from phasyn_media.errors import MediaError
from phasyn_media.files import check_local_file, unchanged_since
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.probe import probe_source_timing, run_ffprobe_json
from phasyn_media.providers._failure import media_failure
from phasyn_media.tools import find_ffmpeg, input_url, run_tool


if TYPE_CHECKING:
    from pathlib import Path

    from phasyn_components.provider import RunContext


SAMPLE_RATE = 16_000
_SAMPLE_BYTES = 4
_LIMIT = DEFAULT_LIMITS


@dataclass(frozen=True)
class AudioTrack:
    """A selected stream's location in the original container."""

    ordinal: int
    index: int
    channel_count: int
    source_start_time: str | None
    stream_start_time: str | None
    clip_origin_offset: Fraction


def _track(
    ctx: RunContext, path: Path, ordinal: int, channel: int | None
) -> AudioTrack:
    fields = "format=start_time,duration:stream=index,start_time,sample_rate,channels"
    report = run_ffprobe_json(
        path,
        ["-select_streams", "a", "-show_entries", fields],
        limits=_LIMIT,
        timeout=min(_LIMIT.probe_timeout_seconds, ctx.remaining_seconds()),
        cancel=ctx.cancel_token,
    )
    streams = report.get("streams", [])
    if not 0 <= ordinal < min(len(streams), _LIMIT.max_streams):
        raise ComponentError("INVALID_ARGUMENT", "Selected audio track does not exist")
    stream = streams[ordinal]
    channels = int(stream.get("channels", 0))
    if not 1 <= channels <= _LIMIT.max_audio_channels:
        raise ComponentError("INVALID_ARGUMENT", "Unsupported audio channel count")
    if channel is not None and not 0 <= channel < channels:
        raise ComponentError(
            "INVALID_ARGUMENT", "Selected audio channel does not exist"
        )
    if not 0 < int(stream.get("sample_rate", 0)) <= _LIMIT.max_sample_rate:
        raise ComponentError("INVALID_ARGUMENT", "Unsupported source sample rate")
    fmt = report.get("format", {})
    if fmt.get("duration") not in (None, "N/A"):
        duration = float(fmt["duration"])
        if not isfinite(duration) or duration > _LIMIT.max_duration_seconds:
            raise ComponentError(
                "INPUT_TOO_LARGE", "Source exceeds the ASR duration limit"
            )
    timing = probe_source_timing(path, limits=_LIMIT, cancel=ctx.cancel_token)
    return AudioTrack(
        ordinal,
        int(stream["index"]),
        channels,
        fmt.get("start_time"),
        stream.get("start_time"),
        timing.origin_seconds - timing.container_start,
    )


def unpack_audio(ctx: RunContext, path: Path, pcm: Path) -> tuple[AudioTrack, int]:
    """Bound FFmpeg's output and preserve inter-stream delays and timestamp gaps."""
    ordinal = ctx.parameters.get("audio_stream", 0)
    channel = ctx.parameters.get("channel")
    try:
        local = check_local_file(path, limits=_LIMIT)
        track = _track(ctx, path, ordinal, channel)
        filters = [] if channel is None else [f"pan=mono|c0=c{channel}"]
        filters.append(f"aresample={SAMPLE_RATE}:async=1:first_pts=0")
        result = run_tool(
            [
                find_ffmpeg(),
                "-nostdin",
                "-hide_banner",
                "-v",
                "error",
                "-copyts",
                "-start_at_zero",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                _LIMIT.format_whitelist,
                *_LIMIT.decoder_flags,
                "-i",
                input_url(path),
                "-map",
                f"0:{track.index}",
                "-vn",
                "-sn",
                "-dn",
                "-af",
                ",".join(filters),
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "1",
                "-t",
                str(_LIMIT.max_duration_seconds + 1),
                "-c:a",
                "pcm_f32le",
                "-f",
                "f32le",
                input_url(pcm),
            ],
            cancel=ctx.cancel_token,
            timeout=min(_LIMIT.process_timeout_seconds, ctx.remaining_seconds()),
        )
        if result.returncode != 0:
            raise ComponentError(
                "MEDIA_TOOL_FAILED", "Could not decode the selected audio track"
            )
        if not unchanged_since(local):
            raise ComponentError(
                "MEDIA_INCOMPLETE", "Source media changed during decoding"
            )
    except MediaError as exc:
        raise media_failure(ctx, exc, what="ASR 音軌解碼") from exc
    size = pcm.stat().st_size
    if size % _SAMPLE_BYTES:
        raise ComponentError("MEDIA_INCOMPLETE", "Decoded PCM output is incomplete")
    count = size // _SAMPLE_BYTES
    if count > SAMPLE_RATE * _LIMIT.max_duration_seconds:
        raise ComponentError(
            "INPUT_TOO_LARGE", "Decoded source exceeds the ASR duration limit"
        )
    return track, count
