"""Helpers for test suites that run a real FFmpeg (no pytest dependency in this module).

:func:`ffmpeg_unavailable` explains why the local FFmpeg build cannot run a test (missing binary,
encoder or the ``lavfi`` device), so suites skip instead of failing on a minimal build.
:func:`synthetic_clip` makes small lavfi-generated media (never real footage).
"""

from __future__ import annotations

import functools
from collections.abc import Mapping
from pathlib import Path

from ..errors import MediaError
from ..tools import find_ffmpeg, list_encoders, run_tool

_TIMEOUT_S = 60.0


@functools.lru_cache(maxsize=4)
def _has_lavfi(ffmpeg: str) -> bool:
    result = run_tool([ffmpeg, "-hide_banner", "-nostdin", "-devices"], timeout=_TIMEOUT_S, max_stdout_bytes=1 << 20)
    names = (line.split()[1] for line in result.stdout.decode("utf-8", "replace").splitlines() if len(line.split()) > 1)
    return result.returncode == 0 and "lavfi" in names


def ffmpeg_unavailable(*encoders: str) -> str | None:
    """Why a test needing ``encoders`` (and lavfi inputs) cannot run here, or ``None`` when it can."""
    try:
        ffmpeg = find_ffmpeg()
        available = list_encoders(ffmpeg)
    except MediaError as exc:
        return f"ffmpeg unavailable: {exc.message}"
    missing = [name for name in encoders if name not in available]
    if missing:
        return f"ffmpeg lacks encoder(s): {', '.join(missing)}"
    if not _has_lavfi(ffmpeg):
        return "ffmpeg lacks the lavfi input device"
    return None


def synthetic_clip(
    path: Path,
    *,
    seconds: float = 1.0,
    width: int = 64,
    height: int = 48,
    fps: int = 24,
    color: str = "gray",
    tone_hz: int | None = None,
    tags: Mapping[str, str] | None = None,
) -> Path:
    """Write a solid-colour H.264 MP4 (plus a 48 kHz AAC sine tone when ``tone_hz`` is set).

    ``tags`` are written as container metadata, like the title or position a camera file carries.
    """
    argv = [find_ffmpeg(), "-hide_banner", "-nostdin", "-v", "error", "-y"]
    argv += ["-f", "lavfi", "-i", f"color=c={color}:s={width}x{height}:r={fps}:d={seconds}"]
    if tone_hz is not None:
        argv += ["-f", "lavfi", "-i", f"sine=frequency={tone_hz}:sample_rate=48000:duration={seconds}"]
    argv += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if tone_hz is not None:
        argv += ["-c:a", "aac"]
    for key, value in (tags or {}).items():
        argv += ["-metadata", f"{key}={value}"]
    result = run_tool([*argv, str(path)], timeout=_TIMEOUT_S, what="FFmpeg synthetic clip")
    if result.returncode != 0:
        raise MediaError("MEDIA_TOOL_FAILED", f"synthetic clip failed: {result.stderr[-300:]}")
    return path


__all__ = ["ffmpeg_unavailable", "synthetic_clip"]
