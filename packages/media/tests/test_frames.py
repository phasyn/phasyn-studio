"""PTS frame sampling: pure planning, and real FFmpeg runs that must refuse playlist-style inputs."""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import pytest

from phasyn_media.errors import MediaError
from phasyn_media.frames import (
    MAX_SAMPLE_GRID,
    FrameTime,
    extract_frames,
    frame_times,
    plan_samples,
)
from phasyn_media.testing import ffmpeg_unavailable, synthetic_clip


TB = Fraction(1, 24)


@pytest.fixture
def clip(tmp_path: Path) -> Path:
    reason = ffmpeg_unavailable("libx264", "mjpeg")
    if reason:
        pytest.skip(reason)
    return synthetic_clip(
        tmp_path / "synthetic.mp4", seconds=1.0, width=64, height=48, fps=24
    )


def test_playlists_pointing_at_other_files_or_urls_are_refused(
    clip: Path, tmp_path: Path
) -> None:
    hls = (
        tmp_path / "upload-a.mp4"
    )  # an "uploaded video" whose bytes are an HLS playlist
    hls.write_text(
        f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n{clip}\n#EXTINF:1.0,\nhttp://192.0.2.10/x.ts\n#EXT-X-ENDLIST\n",
        encoding="utf-8",
    )
    ffconcat = tmp_path / "upload-b.mp4"
    ffconcat.write_text(f"ffconcat version 1.0\nfile '{clip}'\n", encoding="utf-8")
    one = [FrameTime(0, 0, TB, 0.0)]
    for bad in (hls, ffconcat):
        with pytest.raises(MediaError) as probed:
            frame_times(bad)
        with pytest.raises(MediaError) as extracted:
            extract_frames(bad, one)
        for err in (probed, extracted):
            assert err.value.code == "INVALID_ARGUMENT", bad.name
            assert (
                str(tmp_path) not in err.value.message
            )  # failures never echo local paths


def test_a_sampling_grid_is_bounded() -> None:
    """Two packets far apart must not turn into a grid of that length (memory and CPU of the caller)."""
    far = float(
        MAX_SAMPLE_GRID
    )  # seconds: one grid point per second at 1 fps is already over the bound
    frames = [FrameTime(0, 0, TB, 0.0), FrameTime(1, int(far * 24), TB, far)]
    with pytest.raises(MediaError) as refused:
        plan_samples(frames, sampling_fps=1.0)
    assert refused.value.code == "INVALID_ARGUMENT"
    assert [f.index for f in plan_samples(frames[:1], sampling_fps=60.0)] == [0]
