"""Extend as one take: the original clip and the new frames joined, the original audio kept, silence for the new part.

Needs Pillow (the Wan runtime environment); the control-plane environment skips it. Real FFmpeg on tiny files.
"""

from __future__ import annotations

import threading
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from phasyn_components.errors import ComponentError
from phasyn_media.files import check_local_file
from phasyn_media.probe import probe
from phasyn_media.testing import ffmpeg_unavailable
from phasyn_media.tools import find_ffmpeg, run_tool


Image = pytest.importorskip("PIL.Image")

from phasyn_wan_edit.join import delivery, join  # noqa: E402 - after the Pillow skip
from phasyn_wan_edit.media import Source  # noqa: E402


SIZE = (64, 48)


@pytest.fixture(autouse=True)
def _ffmpeg() -> None:
    reason = ffmpeg_unavailable("libx264", "aac")
    if reason:
        pytest.skip(reason)


class _Ctx:
    """The slice of RunContext that decoding and encoding use."""

    def __init__(self) -> None:
        self.cancel_token = threading.Event()

    def check_cancelled(self) -> None:
        return None

    def remaining_seconds(self) -> float:
        return 120.0


def _tool(*args: str) -> bytes:
    result = run_tool(
        [find_ffmpeg(), "-hide_banner", "-nostdin", "-v", "error", "-y", *args],
        timeout=120,
        max_stdout_bytes=64 << 20,
    )
    assert result.returncode == 0, result.stderr[-500:]
    return result.stdout


def _source(path: Path, frames: int, *, audio: bool) -> Source:
    sound = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5", "-c:a", "aac", "-ac", "2", "-shortest"] if audio else []  # fmt: skip
    _tool("-f", "lavfi", "-i", f"color=c=white:size={SIZE[0]}x{SIZE[1]}:rate=24", *sound, "-frames:v", str(frames),
          "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-pix_fmt", "yuv420p", str(path))  # fmt: skip
    return Source(
        check_local_file(path), {}, SIZE[0], SIZE[1], frames, Fraction(24), audio, 0.0
    )


def _new(count: int) -> list[Any]:
    return [Image.new("RGB", SIZE, (0, 0, 0)) for _ in range(count)]


def _luma(path: Path) -> np.ndarray:
    raw = _tool(
        "-i", str(path), "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
    )
    return np.frombuffer(raw, np.uint8).reshape(-1, SIZE[1], SIZE[0]).mean(axis=(1, 2))


def _loudness(path: Path) -> np.ndarray:
    """Mean absolute sample per 1/24 s."""
    raw = _tool(
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "48000",
        "pipe:1",
    )
    samples = np.abs(np.frombuffer(raw, np.float32))
    return samples[: len(samples) // 2000 * 2000].reshape(-1, 2000).mean(axis=1)


@pytest.mark.parametrize("operation", ["extend_after", "extend_before"])
def test_joined_extension_is_one_take_with_the_original_audio(
    tmp_path: Path, operation: str
) -> None:
    source = _source(tmp_path / "take.mp4", 48, audio=True)
    joined = join(_Ctx(), tmp_path, source, _new(24), operation=operation)  # type: ignore[arg-type]
    info = probe(joined.path, count_frames=True)
    assert joined.frames == 72 and info.frame_count == 72 and joined.has_audio
    luma = _luma(joined.path)
    loud = _loudness(joined.path)
    if operation == "extend_after":
        assert luma[:48].min() > 200 and luma[48:].max() < 50
        assert loud[2:46].min() > 0.05 and loud[50:70].max() < 0.01
        assert joined.record["new_range"] == [48, 72]
    else:
        assert luma[:24].max() < 50 and luma[24:].min() > 200
        assert loud[2:22].max() < 0.01 and loud[26:70].min() > 0.05
        assert joined.record["new_range"] == [0, 24]


def test_a_silent_source_gives_a_silent_joined_take(tmp_path: Path) -> None:
    source = _source(tmp_path / "take.mp4", 12, audio=False)
    joined = join(_Ctx(), tmp_path, source, _new(6), operation="extend_after")  # type: ignore[arg-type]
    assert joined.frames == 18 and not joined.has_audio
    assert not probe(joined.path, count_frames=False).has_audio


def test_joined_delivery_exists_only_for_extensions() -> None:
    assert delivery("extend_after", {}) == "patch"
    assert delivery("extend_before", {"deliver": "joined"}) == "joined"
    with pytest.raises(ComponentError):
        delivery("retake", {"deliver": "joined"})
    with pytest.raises(ComponentError):
        delivery("extend_after", {"deliver": "both"})
