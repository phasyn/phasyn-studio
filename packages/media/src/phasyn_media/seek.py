"""Frame- and sample-accurate input seeking for timeline clips (pure arithmetic, no subprocess).

A clip reads only its own part of a source: FFmpeg seeks the input (``-ss`` before ``-i``, accurate
seek on, ``-copyts`` so frames keep their container timestamps) and the graph then selects frames on
the same grid a decode from the first frame would produce:

- video: ``settb`` and ``setpts=PTS-start_pts`` restore time since the first video frame, ``fps``
  converts to the sequence rate with its nearest rounding, ``trim`` cuts by frame number. The
  seek time is the timestamp of a real packet at or before the first frame needed (read from a
  bounded packet window), so a variable frame rate cannot make the grid start late.
- audio: the cut is a presentation timestamp of the source stream. Streams whose time base
  resolves single samples are cut on the sample; an anchor on the common grid of the source rate
  and 48 kHz keeps the resampler in the phase a decode from the start would have. Such a stream
  is also *placed* by its timestamps (``AudioCut.first_pts``): a gap between them is silence and
  an overlap is dropped, as a player does, so a sample has one position whether the decode began
  at the first sample or at a seek point. Other streams (Matroska's millisecond clock) are read
  from their start and their samples are counted.

All values are exact integers or fractions; nothing here rounds through floating point.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from .errors import MediaError

MICROSECONDS = 1_000_000
# FFmpeg drops what lies before the seek time: stay this far before the packet that must survive.
SEEK_GUARD = Fraction(1, 1000)
# Decoded audio before the cut: more than the pre-roll of AAC, MP3 and Opus and the resampler's filter.
AUDIO_PREROLL_SECONDS = Fraction(1, 2)


@dataclass(frozen=True)
class StreamClock:
    """Timing of one stream as its container declares it."""

    index: int
    time_base: Fraction
    start_pts: int

    @property
    def start_seconds(self) -> Fraction:
        return self.start_pts * self.time_base


@dataclass(frozen=True)
class SourceTiming:
    """Header facts of one source file: enough to address frames and samples without decoding it."""

    container_start: Fraction  # seconds; ``-ss`` counts from here
    video: StreamClock | None
    audio: StreamClock | None
    audio_rate: int | None

    @property
    def origin_seconds(self) -> Fraction:
        """Zero of the clip coordinates: the first video frame, or the first sample of an audio file."""
        clock = self.video or self.audio
        if clock is None:
            raise MediaError("INVALID_ARGUMENT", "原始素材沒有可定位的影音串流")
        return clock.start_seconds


def near(value: Fraction) -> int:
    """Nearest integer, halves away from zero (``AV_ROUND_NEAR_INF``, the rounding of ``av_rescale_q``)."""
    doubled = 2 * abs(value)
    magnitude = int((doubled + 1) // 2)
    return magnitude if value >= 0 else -magnitude


def _fraction(value: Any) -> Fraction | None:
    try:
        return Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        return None


def _clock(stream: Mapping[str, Any], first_packets: Mapping[int, int]) -> StreamClock:
    index, start = stream.get("index"), stream.get("start_pts")
    base = _fraction(stream.get("time_base"))
    if isinstance(index, int) and not isinstance(start, int):
        start = first_packets.get(index)  # no start in the header: the stream starts at its first packet
    if not isinstance(index, int) or not isinstance(start, int) or base is None or base <= 0:
        raise MediaError("INVALID_ARGUMENT", "原始素材缺少串流時間基準或起始時間")
    return StreamClock(index, base, start)


def _timed_streams(document: Mapping[str, Any]) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    """The video streams that are a picture (cover art is not) and the audio streams of a header."""
    streams = [item for item in document.get("streams") or [] if isinstance(item, Mapping)]
    videos = [
        s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")
    ]
    return videos, [s for s in streams if s.get("codec_type") == "audio"]


def lacks_start(document: Mapping[str, Any]) -> bool:
    """True when the header states no start for a stream the clips address (WAV, Wave64 and raw AAC do not).

    :func:`source_timing` then needs the timestamp of the first packet of such a stream.
    """
    videos, audios = _timed_streams(document)
    return any(not isinstance(stream.get("start_pts"), int) for stream in (*videos[:1], *audios[:1]))


def source_timing(document: Mapping[str, Any], first_packets: Mapping[int, int] | None = None) -> SourceTiming:
    """Read ``format=start_time`` and ``stream=index,codec_type,time_base,start_pts,sample_rate,disposition``.

    ``first_packets`` maps a stream index to the timestamp of its first packet; it stands in for a
    ``start_pts`` the header does not have (see :func:`lacks_start`).
    """
    videos, audios = _timed_streams(document)
    firsts = first_packets or {}
    start = _fraction((document.get("format") or {}).get("start_time"))
    rate = _fraction(audios[0].get("sample_rate")) if audios else None
    if rate is not None and (rate.denominator != 1 or rate <= 0):
        raise MediaError("INVALID_ARGUMENT", "原始素材的音訊取樣率無效")
    return SourceTiming(
        container_start=start if start is not None else Fraction(0),
        video=_clock(videos[0], firsts) if videos else None,
        audio=_clock(audios[0], firsts) if audios else None,
        audio_rate=int(rate) if rate is not None else None,
    )


def frame_tick(pts: int, clock: StreamClock, fps: Fraction) -> int:
    """Where the ``fps`` filter puts a source frame on the sequence grid (time since the first frame)."""
    return near((pts - clock.start_pts) * clock.time_base * fps)


def tick_seconds(tick: int, clock: StreamClock, fps: Fraction) -> Fraction:
    """Container timestamp of a grid position."""
    return clock.start_seconds + Fraction(tick) / fps


def seek_text(seconds: Fraction) -> str:
    """A ``-ss``/``-t`` argument: decimal seconds, rounded down to the microsecond FFmpeg parses."""
    micro = max(0, math.floor(seconds * MICROSECONDS))
    return f"{micro // MICROSECONDS}.{micro % MICROSECONDS:06d}"


def parse_packets(text: str, *, limit: int) -> dict[int, list[tuple[int, int]]]:
    """``(pts, duration)`` per stream from ``ffprobe -show_entries packet=stream_index,pts,duration -of compact``."""
    packets: dict[int, list[tuple[int, int]]] = {}
    count = 0
    for line in text.splitlines():
        fields = dict(part.partition("=")[::2] for part in line.strip().split("|") if "=" in part)
        try:
            stream, pts = int(fields["stream_index"]), int(fields["pts"])
        except (KeyError, ValueError):
            continue  # a packet without a timestamp cannot place a frame
        duration = fields.get("duration", "")
        count += 1
        if count > limit:
            raise MediaError("RESOURCE_EXHAUSTED", "片段範圍的 packet 數量超過掃描上限")
        packets.setdefault(stream, []).append((pts, int(duration) if duration.lstrip("-").isdigit() else 0))
    return packets


def video_seek(packet_pts: int, clock: StreamClock, timing: SourceTiming) -> Fraction | None:
    """``-ss`` seconds that keep the packet ``packet_pts`` and everything after it; ``None`` reads from the start."""
    seconds = packet_pts * clock.time_base - timing.container_start - SEEK_GUARD
    return seconds if seconds > 0 else None


@dataclass(frozen=True)
class AudioCut:
    """Where an audio clip's decode is cut and how its 48 kHz samples line up with the clip origin."""

    seek: Fraction | None  # ``-ss`` seconds, or ``None`` to read from the start
    start_pts: int | None  # first source sample kept, as a stream timestamp; ``None`` keeps the whole decode
    lead_samples: int  # 48 kHz samples between the kept start and the first sample the clip uses (>= 0)
    silence_samples: int  # 48 kHz samples of silence before the stream starts (the clip begins earlier)
    # Streams whose timestamps count samples: the timestamp of the first sample of the kept decode and the
    # source rate. The graph places the decode by its timestamps from there. ``None``: samples are counted.
    first_pts: int | None = None
    rate: int | None = None


def sample_exact(timing: SourceTiming) -> bool:
    """True when stream timestamps count samples (MP4/MOV); Matroska's millisecond clock does not."""
    clock, rate = timing.audio, timing.audio_rate
    return clock is not None and rate is not None and clock.time_base == Fraction(1, rate)


def audio_cut(timing: SourceTiming, first_sample: int, *, output_rate: int = 48000) -> AudioCut:
    """Plan the decode of the 48 kHz samples from ``first_sample`` on (counted from the clip origin).

    The 48 kHz grid of a source starts at its first audio sample, as when the whole stream is resampled.
    ``first_sample`` may lie before the stream (a video that starts before its sound): that part is silence.
    """
    clock, rate = timing.audio, timing.audio_rate
    if clock is None or rate is None:
        raise MediaError("INVALID_ARGUMENT", "原始素材沒有音訊")
    offset = near((clock.start_seconds - timing.origin_seconds) * output_rate)  # stream start on the clip grid
    wanted = first_sample - offset  # index on the stream's own 48 kHz grid
    silence = max(0, -wanted)
    wanted = max(0, wanted)
    if not sample_exact(timing):
        return AudioCut(None, None, wanted, silence)
    period = output_rate // math.gcd(rate, output_rate)  # 48 kHz samples per common grid step
    preroll = math.ceil(AUDIO_PREROLL_SECONDS * output_rate)
    anchor = max(0, (wanted - preroll) // period * period)
    if anchor == 0:
        return AudioCut(None, None, wanted, silence, clock.start_pts, rate)
    start_pts = clock.start_pts + anchor * rate // output_rate  # exact: anchor is on the common grid
    seconds = start_pts * clock.time_base - timing.container_start - AUDIO_PREROLL_SECONDS
    return AudioCut(seconds if seconds > 0 else None, start_pts, wanted - anchor, silence, start_pts, rate)


__all__ = [
    "AUDIO_PREROLL_SECONDS",
    "AudioCut",
    "SourceTiming",
    "StreamClock",
    "audio_cut",
    "frame_tick",
    "lacks_start",
    "near",
    "parse_packets",
    "sample_exact",
    "seek_text",
    "source_timing",
    "tick_seconds",
    "video_seek",
]
