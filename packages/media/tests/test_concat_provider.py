"""media.concat: frame-exact trims, silence padding, frame verification, and hostile or failing inputs."""

from __future__ import annotations

import threading
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.provider import InputValue, ProviderHost, RunContext
from phasyn_components.recorder import Recorder
from phasyn_components.testing.ids import NODE_A_ID, uid

from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.probe import run_ffprobe_json
from phasyn_media.providers import concat
from phasyn_media.providers.concat import ConcatProvider
from phasyn_media.testing import ffmpeg_unavailable, synthetic_clip


NODE = NODE_A_ID


def _asset(store: FileStore, path: Path, frames: int) -> dict[str, Any]:
    writer = store.new_writer("video/mp4", {})
    writer.write(path.read_bytes())
    ref = writer.commit()
    return {
        "asset_id": uid(frames),
        "kind": "final",
        "file": ref,
        "source_latent": None,
        "frame_count": frames,
        "fps": {"num": 24, "den": 1},
        "width": 64,
        "height": 32,
        "complete": True,
        "actual_settings": {},
    }


def _run(tmp_path: Path, store: FileStore, clips: list[dict[str, Any]]) -> RunContext:
    rec = Recorder(
        recordings_root=tmp_path / "recordings",
        recording_id=uid(1),
        stream_id="runtime",
        node_id=NODE,
        component_id="concat",
        provider_id="media.concat",
        process_instance_id=uid(2),
        operation="invoke",
    )
    ctx = RunContext(
        call_id=uid(3),
        run_id=uid(4),
        step_id=None,
        parameters={"preset": "ultrafast"},
        inputs={
            "sequence": InputValue(type_id="media.sequence.v1", value={"clips": clips})
        },
        store=store,
        deadline_ns=time.monotonic_ns() + 120 * 10**9,
        cancel_event=threading.Event(),
        output_types={"asset": "media.asset.v1"},
        recorder=rec,
        device={"kind": "cpu"},
        work_dir=tmp_path,
        settings={},
        resolver=lambda ref, _remaining: str(store.payload_path(ref["file_id"])),
    )
    host = ProviderHost(node_id=NODE, component_id="concat", data_dir=tmp_path, work_dir=tmp_path, device={},
                        process_instance_id="x")  # fmt: skip
    ConcatProvider(host).invoke(ctx)
    return ctx


@pytest.fixture
def sources(tmp_path: Path) -> tuple[Path, Path]:
    reason = ffmpeg_unavailable("libx264", "aac")
    if reason:
        pytest.skip(reason)
    src = tmp_path / "src"
    src.mkdir()
    with_audio = synthetic_clip(
        src / "a.mp4", seconds=1, width=64, height=32, tone_hz=440
    )
    silent = synthetic_clip(src / "b.mp4", seconds=1, width=64, height=32)
    return with_audio, silent


def test_every_ffmpeg_input_is_a_whitelisted_file_url(tmp_path: Path) -> None:
    args = concat._input_args(tmp_path / "clip.mp4", DEFAULT_LIMITS)
    assert args[:4] == [
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        DEFAULT_LIMITS.format_whitelist,
    ]
    assert args[4:6] == [
        "-max_pixels",
        str(DEFAULT_LIMITS.max_pixels),
    ]  # no decoder may exceed the probed bound
    assert args[-2:] == ["-i", f"file:{tmp_path / 'clip.mp4'}"]
    assert concat._input_args(tmp_path / "t.png", DEFAULT_LIMITS, demuxer="png_pipe")[
        6:8
    ] == ["-f", "png_pipe"]


def test_a_sequence_outside_the_media_limits_is_refused_before_any_work() -> None:
    cases: tuple[tuple[dict[str, Any], str], ...] = (
        (
            {"width": 16384, "height": 16384},
            "INPUT_TOO_LARGE",
        ),  # the contract allows it, the encoder must not
        (
            {"width": 64, "height": 32, "fps": {"num": 1, "den": 1_000_000}},
            "INVALID_ARGUMENT",
        ),
        (
            {"width": 64, "height": 32, "fps": {"num": 100_000, "den": 1}},
            "INVALID_ARGUMENT",
        ),
    )
    for sequence, code in cases:
        with pytest.raises(ComponentError) as refused:
            concat._geometry(sequence, {})
        assert refused.value.code == code, sequence
    assert concat._geometry({"width": 64, "height": 32}, {}) == (64, 32, Fraction(24))
    with pytest.raises(ComponentError) as long:
        concat._check_output_size(DEFAULT_LIMITS.max_frames + 1, Fraction(24))
    assert long.value.code == "INPUT_TOO_LARGE"
    concat._check_output_size(DEFAULT_LIMITS.max_frames, Fraction(30))


def test_an_export_carries_no_tags_of_its_materials(tmp_path: Path) -> None:
    """A camera file's title, comment or position must not travel into the video people publish."""
    tagged = synthetic_clip(
        tmp_path / "tagged.mp4",
        seconds=1,
        width=64,
        height=32,
        tone_hz=440,
        tags={
            "title": "private title",
            "comment": "private comment",
            "location": "+00.0000+000.0000/",
        },
    )
    assert "private title" in str(
        run_ffprobe_json(
            tagged, ["-show_entries", "format_tags"], limits=DEFAULT_LIMITS
        )
    )
    store = FileStore(tmp_path / "data", NODE)
    ctx = _run(
        tmp_path,
        store,
        [{"asset": _asset(store, tagged, 24), "in_frame": 0, "out_frame": None}],
    )
    exported = ctx.pending_files()[0].path  # written, not yet published by a Node
    tags = str(
        run_ffprobe_json(
            exported, ["-show_entries", "format_tags"], limits=DEFAULT_LIMITS
        )
    )
    for leaked in ("private title", "private comment", "location"):
        assert leaked not in tags, tags


def test_a_clip_that_is_really_a_playlist_is_refused(
    tmp_path: Path, sources: tuple[Path, Path]
) -> None:
    playlist = tmp_path / "playlist.mp4"
    playlist.write_text(
        f"ffconcat version 1.0\nfile '{sources[0]}'\n", encoding="utf-8"
    )
    store = FileStore(tmp_path / "data", NODE)
    with pytest.raises(ComponentError) as err:
        _run(
            tmp_path,
            store,
            [{"asset": _asset(store, playlist, 24), "in_frame": 0, "out_frame": None}],
        )
    assert (
        err.value.code == "INVALID_ARGUMENT" and str(tmp_path) not in err.value.message
    )
