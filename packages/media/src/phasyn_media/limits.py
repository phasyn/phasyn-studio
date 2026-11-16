"""Bounds for decoding and probing media.

The defaults are product limits, not hardware measurements: ``max_frames`` matches the largest
sequence the Studio contracts accept (100000 frames), ``max_duration_seconds`` is one hour and
``max_file_bytes`` (10 GiB) sits above the default upload limit, so a file that could be uploaded
can always be probed. Callers may pass tighter limits; nothing here widens what the contracts allow.

Which bound applies to what in a multitrack export:

- a *source* of a timeline may be long (``TIMELINE_SOURCE_LIMITS``: the bounds of
  ``TimelineSource.duration_frames``, 24 hours, generated from the schema into
  ``phasyn_components.timeline_limits``); an export seeks to what its clips use and never decodes the rest;
- one *clip* (its complete processed duration) and the *sequence* keep ``max_frames`` and
  ``max_duration_seconds`` of ``DEFAULT_LIMITS``;
- the file size, picture size and stream bounds of ``DEFAULT_LIMITS`` apply to every file.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from typing import Any

from phasyn_components.timeline_limits import MAX_SOURCE_FRAMES, MAX_SOURCE_SECONDS

# Demuxers allowed for uploaded materials and internal tracks.  Playlist /
# meta demuxers (hls, dash, concat, image2 sequences, tee, lavfi, ...) are
# never allowed: they can open other files or URLs.
DEFAULT_ALLOWED_DEMUXERS: tuple[str, ...] = (
    "mov",  # mp4 / mov / m4a (ffmpeg name "mov,mp4,m4a,3gp,3g2,mj2")
    "matroska",  # mkv / webm (ffmpeg name "matroska,webm")
    "wav",
    "w64",
    "mp3",
    "flac",
    "ogg",
    "aac",
    "png_pipe",
    "jpeg_pipe",
    "webp_pipe",
    "bmp_pipe",
    "tiff_pipe",
)


@dataclass(frozen=True)
class MediaLimits:
    max_file_bytes: int = 10 * 1024**3
    max_duration_seconds: float = 3600.0
    max_width: int = 8192
    max_height: int = 8192
    max_pixels: int = 40_000_000
    max_frames: int = 100_000
    max_audio_channels: int = 8
    max_sample_rate: int = 192_000
    probe_timeout_seconds: float = 30.0
    process_timeout_seconds: float = 900.0
    # extra bounds (not part of the minimal contract, all have safe defaults)
    max_streams: int = 16
    max_stderr_bytes: int = 64 * 1024
    max_tool_output_bytes: int = 64 * 1024 * 1024
    max_scan_packets: int = 2_000_000
    allowed_demuxers: tuple[str, ...] = DEFAULT_ALLOWED_DEMUXERS

    def __post_init__(self) -> None:
        positive = {
            "max_file_bytes": self.max_file_bytes,
            "max_duration_seconds": self.max_duration_seconds,
            "max_width": self.max_width,
            "max_height": self.max_height,
            "max_pixels": self.max_pixels,
            "max_frames": self.max_frames,
            "max_audio_channels": self.max_audio_channels,
            "max_sample_rate": self.max_sample_rate,
            "probe_timeout_seconds": self.probe_timeout_seconds,
            "process_timeout_seconds": self.process_timeout_seconds,
            "max_streams": self.max_streams,
            "max_stderr_bytes": self.max_stderr_bytes,
            "max_tool_output_bytes": self.max_tool_output_bytes,
            "max_scan_packets": self.max_scan_packets,
        }
        for name, value in positive.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not value > 0:
                raise ValueError(f"MediaLimits.{name} 必須是正數")
        if not self.allowed_demuxers or not all(
            isinstance(d, str) and d and all(c.isalnum() or c == "_" for c in d) for d in self.allowed_demuxers
        ):
            raise ValueError("MediaLimits.allowed_demuxers 必須是非空的 demuxer 名稱清單")

    @property
    def format_whitelist(self) -> str:
        return ",".join(self.allowed_demuxers)

    @property
    def decoder_flags(self) -> list[str]:
        """Input options that cap every decoder of the file at ``max_pixels``.

        The header a probe reads is not a bound on what a decoder allocates: a stream may switch to a larger
        picture later, and a cover-art stream is not part of the probed geometry. FFmpeg refuses such a frame.
        """
        return ["-max_pixels", str(self.max_pixels)]

    def as_dict(self) -> dict[str, Any]:
        doc = asdict(self)
        doc["allowed_demuxers"] = list(self.allowed_demuxers)
        return doc


DEFAULT_LIMITS = MediaLimits()

# A long source is only probed by its header and by bounded packet windows, so the packet bound stays.
TIMELINE_SOURCE_LIMITS = replace(
    DEFAULT_LIMITS, max_duration_seconds=float(MAX_SOURCE_SECONDS), max_frames=MAX_SOURCE_FRAMES
)
