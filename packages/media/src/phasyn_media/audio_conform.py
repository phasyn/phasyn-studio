"""Conform a chosen soundtrack to what ``mux`` needs: float32 stereo WAV of exactly the video's length.

A replacement soundtrack (a finished mix, a TTS dub, a recording) can be any audio FFmpeg reads: mono or
multichannel, any sample rate, integer or float samples, WAV/FLAC/MP3/AAC… This step decodes the first audio stream,
remixes it to stereo (mono is copied to both channels at full level, more channels are downmixed), resamples it to
``SAMPLE_RATE`` and cuts or pads it with silence at the end so it is exactly ``frames / fps`` long. What it changed
is returned for the record: nothing is hidden.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from .audio import read_wav_header
from .errors import MediaError, raise_if_canceled
from .files import (
    check_local_file,
    check_output_path,
    partial_path,
    publish,
    remove_quietly,
)
from .limits import DEFAULT_LIMITS, MediaLimits
from .probe import probe
from .tools import find_ffmpeg, input_url, redact, run_tool, summarize_stderr


SAMPLE_RATE = 48_000


@dataclass(frozen=True)
class ConformedAudio:
    """The conformed WAV and what was done to the source to get it."""

    path: Path
    sample_rate: int
    samples: int
    seconds: float
    source_codec: str | None
    source_sample_rate: int | None
    source_channels: int | None
    source_seconds: float | None
    lead_seconds: float
    padded_seconds: float
    trimmed_seconds: float

    def as_dict(self) -> dict[str, Any]:
        """The record without the local path."""
        out = asdict(self)
        out.pop("path")
        return out


def target_samples(frames: int, fps: Fraction, sample_rate: int = SAMPLE_RATE) -> int:
    """Samples of ``frames`` video frames at ``fps``, rounded half up."""
    if frames < 1 or fps <= 0:
        raise MediaError("INVALID_ARGUMENT", "影片長度未知，無法對齊聲軌")
    exact = Fraction(frames) / fps * sample_rate
    return int(exact + Fraction(1, 2))


def conform_audio(  # noqa: PLR0913 - keyword-only options, like mux()
    source: str | os.PathLike[str],
    output: str | os.PathLike[str],
    *,
    frames: int,
    fps: Fraction,
    lead_seconds: Fraction = Fraction(0),
    cancel: Any = None,
    limits: MediaLimits = DEFAULT_LIMITS,
) -> ConformedAudio:
    """Write ``output`` as float32 stereo WAV at ``SAMPLE_RATE`` and exactly ``frames / fps`` seconds long.

    ``lead_seconds`` of silence come before the source (an extension placed in front of a clip).
    """
    raise_if_canceled(cancel, "聲軌轉換")
    local = check_local_file(source, limits=limits, field_path="inputs.audio")
    final = check_output_path(output, inputs=[local.path])
    info = probe(local.path, count_frames=False, cancel=cancel)
    if not info.has_audio:
        raise MediaError("INVALID_ARGUMENT", "選擇的檔案沒有聲音")
    samples = target_samples(frames, fps)
    if samples / SAMPLE_RATE > limits.max_duration_seconds:
        raise MediaError("INVALID_ARGUMENT", "影片長度超過聲軌上限")
    lead = int(lead_seconds * SAMPLE_RATE + Fraction(1, 2))
    if not 0 <= lead < samples:
        raise MediaError("INVALID_ARGUMENT", "聲軌前面補的靜音不能比影片長")
    delay = f"adelay=delays={lead}S:all=1," if lead else ""
    # Mono goes to both channels at full level (the default upmix would lower it by 3 dB)
    mono = "pan=stereo|c0=c0|c1=c0," if info.audio_channels == 1 else ""
    temp = partial_path(final)
    argv = [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
        "-protocol_whitelist", "file", "-format_whitelist", limits.format_whitelist, *limits.decoder_flags,
        "-i", input_url(local.path),
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
        "-af", f"{mono}aresample={SAMPLE_RATE},{delay}apad=whole_len={samples},atrim=end_sample={samples}",
        "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_f32le",
        "-f", "wav", "-n", input_url(temp),
    ]  # fmt: skip
    marks = {
        str(local.path): "<audio>",
        input_url(local.path): "<audio>",
        str(temp): "<output>",
        input_url(temp): "<output>",
    }
    try:
        result = run_tool(
            argv,
            timeout=limits.process_timeout_seconds,
            cancel=cancel,
            max_stdout_bytes=1 << 20,
            max_stderr_bytes=limits.max_stderr_bytes,
            what="FFmpeg audio conform",
        )
        _check_result(result.returncode, result.stderr, marks)
        _check_length(temp, samples, limits)
        raise_if_canceled(cancel, "聲軌轉換")
        publish(temp, final)
    except BaseException:
        remove_quietly(temp)
        raise
    seconds = samples / SAMPLE_RATE
    source_seconds = info.duration_seconds
    room = seconds - lead / SAMPLE_RATE
    return ConformedAudio(
        path=final,
        sample_rate=SAMPLE_RATE,
        samples=samples,
        seconds=seconds,
        source_codec=info.audio_codec,
        source_sample_rate=info.audio_sample_rate,
        source_channels=info.audio_channels,
        source_seconds=source_seconds,
        lead_seconds=lead / SAMPLE_RATE,
        padded_seconds=max(0.0, room - source_seconds)
        if source_seconds is not None
        else 0.0,
        trimmed_seconds=max(0.0, source_seconds - room)
        if source_seconds is not None
        else 0.0,
    )


def _check_result(returncode: int, stderr: str, marks: dict[str, str]) -> None:
    if returncode != 0:
        detail = summarize_stderr(redact(stderr, marks), 800)
        raise MediaError(
            "MEDIA_TOOL_FAILED",
            "聲軌轉換失敗" + (f"：{detail}" if detail else ""),
        )


def _check_length(path: Path, samples: int, limits: MediaLimits) -> None:
    header = read_wav_header(path, limits=limits)
    if header.frames != samples or header.sample_rate != SAMPLE_RATE:
        raise MediaError(
            "INTEGRITY_MISMATCH",
            "轉換後的聲軌長度與影片不符",
            expected=f"{samples} samples @ {SAMPLE_RATE} Hz",
            actual=f"{header.frames} samples @ {header.sample_rate} Hz",
        )
