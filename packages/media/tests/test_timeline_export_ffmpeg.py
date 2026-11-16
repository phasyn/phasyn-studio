"""Real FFmpeg exports of small synthetic version-2 timelines: the integrity of what is published.

Marked ``slow`` (seconds each; ``pytest -m slow``). They check what fakes cannot: the exact frame and sample counts
of the published file, that a disabled clip leaves no picture and no sound while the enabled ones are all there, the
silence played where a take's sound ends early, frames of a clip far beyond frame 100,000 of a long source, text
drawn by the Node's engine (or a refusal that says why), that an adjustment layer changes the tracks under it in its
frames and mask only, and that a refused export publishes nothing.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.provider import InputValue, ProviderHost, RunContext
from phasyn_components.recorder import Recorder
from phasyn_components.testing.ids import NODE_A_ID, uid
from phasyn_media.providers.concat import ConcatProvider
from phasyn_media.testing import ffmpeg_unavailable
from phasyn_media.tools import find_ffmpeg, run_tool

pytestmark = pytest.mark.slow
PARAMS = {"preset": "ultrafast", "crf": 0, "audio_bitrate": 192000}
# One frame decoded as 8-bit Y, counting its 16x16 blocks as the bits of the source frame number.
COUNTER = "255*gt(bitand(N,pow(2,floor(Y/16)*6+floor(X/16))),0)"


@pytest.fixture(autouse=True)
def _ffmpeg() -> None:
    reason = ffmpeg_unavailable("libx264", "aac")
    if reason:
        pytest.skip(reason)


def _tool(*args: str) -> bytes:
    result = run_tool([find_ffmpeg(), "-hide_banner", "-nostdin", "-v", "error", "-y", *args], timeout=600,
                      max_stdout_bytes=256 << 20)  # fmt: skip
    assert result.returncode == 0, result.stderr[-500:]
    return result.stdout


def _media(path: Path, video: str, *, audio: str | None = None) -> Path:
    """An H.264 (+ AAC stereo) MP4 from lavfi graphs."""
    sound = ["-f", "lavfi", "-i", audio, "-c:a", "aac", "-ac", "2"] if audio else []
    _tool("-f", "lavfi", "-i", video, *sound, "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0",
          "-pix_fmt", "yuv420p", str(path))  # fmt: skip
    return path


def _luma(path: Path, width: int, height: int) -> np.ndarray:
    raw = _tool("-i", str(path), "-vf", "extractplanes=y", "-f", "rawvideo", "pipe:1")
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, height, width).astype(np.int32)


def _rgb(path: Path, width: int, height: int) -> np.ndarray:
    raw = _tool("-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, height, width, 3).astype(np.int32)


def _sound(path: Path) -> np.ndarray:
    raw = _tool("-i", str(path), "-vn", "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1")
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


class _Node:
    """The file store and the provider of one Node, invoked as a Node invokes it."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.store = FileStore(root / "data", NODE_A_ID)

    def add(self, path: Path) -> dict[str, Any]:
        writer = self.store.new_writer("video/mp4", {})
        writer.write(path.read_bytes())
        return dict(writer.commit())

    def export(self, timeline: dict[str, Any], width: int, height: int) -> RunContext:
        work = self.root / "work"
        work.mkdir(exist_ok=True)
        recorder = Recorder(recordings_root=self.root / "recordings", recording_id=uid(1), stream_id="runtime",
                            node_id=NODE_A_ID, component_id="concat", provider_id="media.concat",
                            process_instance_id=uid(2), operation="invoke")  # fmt: skip
        value = {"clips": [], "timeline": timeline, "width": width, "height": height, "fps": dict(timeline["fps"])}
        ctx = RunContext(call_id=uid(3), run_id=uid(4), step_id=None, parameters=PARAMS,
                         inputs={"sequence": InputValue(type_id="media.sequence.v1", value=value)}, store=self.store,
                         deadline_ns=time.monotonic_ns() + 600 * 10**9, cancel_event=threading.Event(),
                         output_types={"asset": "media.asset.v1"}, recorder=recorder, device={"kind": "cpu"},
                         work_dir=work, settings={},
                         resolver=lambda ref, _remaining: str(self.store.payload_path(ref["file_id"])))  # fmt: skip
        host = ProviderHost(node_id=NODE_A_ID, component_id="concat", data_dir=work, work_dir=work, device={},
                            process_instance_id="x")  # fmt: skip
        try:
            ConcatProvider(host).invoke(ctx)
        finally:
            assert not list(work.iterdir())  # every temporary file and directory is gone, also after a refusal
        return ctx


def _track(track_id: str, kind: str) -> dict[str, Any]:
    return {"track_id": track_id, "name": track_id, "kind": kind, "locked": False, "muted": False, "solo": False,
            "sync_lock": True, "gain_db": 0, "pan": 0}  # fmt: skip


def _source(
    source_id: str, file: dict[str, Any] | None, frames: int, size: tuple[int, int], **patch: Any
) -> dict[str, Any]:
    return {"source_id": source_id, "name": source_id, "kind": "video", "file": file, "duration_frames": frames,
            "width": size[0], "height": size[1], "has_audio": True, **patch}  # fmt: skip


def _clip(
    clip_id: str, source_id: str, track_id: str, start: int, span: tuple[int, int], **patch: Any
) -> dict[str, Any]:
    motion = {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1, "gain_db": 0, "pan": 0, "keyframes": {}}
    return {"clip_id": clip_id, "source_id": source_id, "track_id": track_id, "name": clip_id, "start_frame": start,
            "in_frame": span[0], "out_frame": span[1], "motion": motion, **patch}  # fmt: skip


def _timeline(fps: int, sources: list[Any], clips: list[Any], **patch: Any) -> dict[str, Any]:
    return {"version": 2, "fps": {"num": fps, "den": 1}, "master_gain_db": 0, "sources": sources,
            "tracks": [_track("v1", "video"), _track("v2", "video"), _track("a1", "audio")], "clips": clips,
            "captions": [], "markers": [], **patch}  # fmt: skip


def _published(ctx: RunContext) -> tuple[Path, dict[str, Any]]:
    asset = ctx.outputs["asset"]["value"]
    return ctx.pending_files()[0].path, asset["actual_settings"]["concat"]


def test_counts_are_exact_a_disabled_clip_leaves_nothing_and_early_sound_ends_in_stated_silence(tmp_path: Path) -> None:
    node, size = _Node(tmp_path), (64, 36)
    red = node.add(_media(tmp_path / "red.mp4", "color=c=0xd02020:s=64x36:r=24:d=1",
                          audio="sine=frequency=300:sample_rate=48000,atrim=end_sample=48000"))  # fmt: skip
    green = node.add(_media(tmp_path / "green.mp4", "color=c=0x20d020:s=64x36:r=24:d=1",
                            audio="sine=frequency=500:sample_rate=48000,atrim=end_sample=48000"))  # fmt: skip
    # An H3-like take: its sound stops 400 samples (a fifth of a frame) before its picture
    take = node.add(_media(tmp_path / "take.mp4", "testsrc2=s=64x36:r=24,trim=end_frame=24",
                           audio="sine=frequency=440:sample_rate=48000,atrim=end_sample=47600"))  # fmt: skip
    clips = []
    for kind, track in (("v", "v1"), ("a", "a1")):
        clips += [
            _clip(f"{kind}-red", "red", track, 0, (0, 24), linked_id="red"),
            _clip(f"{kind}-green", "green", track, 24, (0, 24), linked_id="green", enabled=False),
            _clip(f"{kind}-take", "take", track, 48, (0, 24), linked_id="take"),
        ]
    sources = [_source("red", red, 24, size), _source("green", green, 24, size), _source("take", take, 24, size)]
    path, record = _published(node.export(_timeline(24, sources, clips), *size))
    assert (record["frames"], record["audio_samples"]) == (72, 144_000)  # as verified in the published file
    assert sorted(item["clip_id"] for item in record["skipped_clips"]) == ["a-green", "v-green"]
    assert {item["source_id"]: item["audio_silence_samples"] for item in record["sources"]} == {"red": 0, "take": 400}
    luma = _luma(path, *size)
    assert len(luma) == 72
    assert luma[24:48].max() <= 16  # the disabled clip's place is black
    assert luma[:24].min() > 30 and luma[48:].mean() > 30  # and both enabled clips are there
    sound = _sound(path)
    assert np.sqrt(np.mean(sound[48_000 + 1024 : 96_000 - 1024] ** 2)) < 1e-4  # nor any of its sound
    tail, body = sound[143_600:144_000], sound[143_200:143_600]
    assert np.sqrt(np.mean(tail**2)) < 0.1 * np.sqrt(np.mean(body**2))


def test_a_clip_beyond_frame_100000_of_a_long_source_shows_exactly_its_own_frames(tmp_path: Path) -> None:
    """A 24 fps source of 10,104 frames is 101,040 frames on a 240 fps sequence: clips at 100,000 and near 0."""
    node, size = _Node(tmp_path), (96, 64)
    counter = f"color=c=black:s=96x64:r=24,format=gray,geq=lum='{COUNTER}',trim=end_frame=10104"
    source = node.add(_media(tmp_path / "long.mp4", counter))
    clips = [
        _clip("far", "long", "v1", 0, (100_000, 100_048)),
        _clip("near", "long", "v1", 48, (120, 168)),
    ]
    timeline = _timeline(240, [_source("long", source, 101_040, size, has_audio=False)], clips)
    path, record = _published(node.export(timeline, *size))
    luma = _luma(path, *size)
    bits = luma[:, 8::16, 8::16].reshape(len(luma), 24) > 125
    shown = [int(sum(1 << bit for bit in range(24) if row[bit])) for row in bits]
    assert record["frames"] == len(shown) == 96
    assert shown == [(100_000 + k) // 10 for k in range(48)] + [(120 + k) // 10 for k in range(48)]


def test_text_is_drawn_by_the_node_or_the_export_is_refused_with_why(tmp_path: Path) -> None:
    node, size = _Node(tmp_path), (160, 90)
    grey = node.add(_media(tmp_path / "grey.mp4", "color=c=0x404040:s=160x90:r=24:d=1",
                           audio="sine=frequency=300:sample_rate=48000,atrim=end_sample=48000"))  # fmt: skip
    style = {"font_family": "sans", "font_size": 160, "font_weight": 700, "color": "#ffffff", "align": "center",
             "x": 0.5, "y": 0.3}  # fmt: skip
    title = {"text": "EXPORT", "position": "center", "size": "medium", "start_frame": 0, "end_frame": None,
             "image": None, "style": style}  # fmt: skip
    caption = {"caption_id": "cap", "start_frame": 12, "end_frame": 24, "text": "CAPTION", "position": "bottom",
               "size": "large"}  # fmt: skip
    timeline = _timeline(
        24,
        [_source("grey", grey, 24, size), _source("text", None, 24, size, kind="text", has_audio=False)],
        [_clip("bg", "grey", "v1", 0, (0, 24)), _clip("layer", "text", "v2", 0, (0, 24), effects={"title": title})],
        captions=[caption],
    )
    try:
        ctx = node.export(timeline, *size)
    except ComponentError as refused:
        # A host without the text libraries or without any font draws nothing: it says so, and publishes nothing
        assert refused.details["reason"] in ("text_renderer_unavailable", "text_font_missing"), refused.details
        pytest.skip(f"text renderer unavailable here: {refused.details['reason']}")
    path, record = _published(ctx)
    assert record["frames"] == 24
    assert record["text"]["drawn"] == {"titles": 1, "captions": 1} and record["text"]["fonts"]
    assert "missing_glyphs" not in record["text"]  # every character of the text has a glyph
    luma = _luma(path, *size)
    title_band, caption_band = luma[:, 10:45], luma[:, 60:]
    assert all((frame > 200).sum() > 100 for frame in title_band)  # the text layer is drawn on every frame
    bright = [int((frame > 200).sum()) for frame in caption_band]
    assert max(bright[:12]) == 0 and min(bright[12:]) > 50  # the caption exactly on its frames


def test_an_adjustment_layer_changes_the_tracks_under_it_only_in_its_frames_and_its_mask(tmp_path: Path) -> None:
    """Two shots on V1 (red | blue, then green | yellow, a sharp edge at x = 16) and an adjustment layer on V2 across
    their cut (frames 12–36): black and white with a blur, eased in over two frames, masked to the left half."""
    node, size = _Node(tmp_path), (64, 36)
    split = "drawbox=x=16:y=0:w=48:h=36:color={}:t=fill"
    first = node.add(_media(tmp_path / "first.mp4", f"color=c=0xd02020:s=64x36:r=24:d=1,{split.format('0x2020d0')}"))
    second = node.add(_media(tmp_path / "second.mp4", f"color=c=0x20d020:s=64x36:r=24:d=1,{split.format('0xd0d020')}"))
    adjust = _source("adjust", None, 100000, size, kind="adjustment", has_audio=False)
    mask = {"kind": "rectangle", "x": 0, "y": 0, "width": 0.5, "height": 1, "feather": 0, "invert": False}
    layer = _clip(
        "layer", "adjust", "v2", 12, (0, 24), mask=mask,
        effects={"color": {"saturation": 0}, "fade": {"video_in": 2}},
        effect_stack=[{"effect_id": "blur", "kind": "blur", "enabled": True, "radius": 3}],
    )  # fmt: skip
    clips = [_clip("first", "first", "v1", 0, (0, 24)), _clip("second", "second", "v1", 24, (0, 24)), layer]
    sources = [_source("first", first, 24, size, has_audio=False), _source("second", second, 24, size, has_audio=False)]
    path, record = _published(node.export(_timeline(24, [*sources, adjust], clips), *size))
    rgb = _rgb(path, *size)
    assert record["frames"] == len(rgb) == 48
    assert [source["source_id"] for source in record["sources"]] == ["first", "second"]  # the layer reads no file

    def grey(pixel: np.ndarray) -> bool:
        return int(np.ptp(pixel)) <= 8

    row = 18
    for frame in (*range(12), *range(36, 48)):  # outside its frames the shots are as they are, edge and colours
        edge, inside = rgb[frame, row, 15], rgb[frame, row, 16]
        assert not grey(edge) and not grey(inside) and int(np.abs(edge - inside).max()) > 120, frame
    # Its fade eases the adjustment in over the shot (never the picture to black): none at frame 12, half at 13
    assert rgb[12, row, 8, 0] > 180 and rgb[12, row, 8, 1] < 60
    assert 110 < rgb[13, row, 8, 0] < 170 and not grey(rgb[13, row, 8])
    for frame in range(14, 36):
        left, near, far = rgb[frame, row, 8], rgb[frame, row, 15], rgb[frame, row, 16]
        assert grey(left) and grey(near) and grey(far), frame  # black and white in the mask, on both shots
        assert int(abs(near[1] - far[1])) < 16, frame  # the edge is blurred
        assert not grey(rgb[frame, row, 48]), frame  # beyond the mask the shot keeps its colour
    assert rgb[20, row, 48, 2] > 150 and rgb[30, row, 48, 2] < 80  # blue under the first shot, yellow under the second


def test_a_source_shorter_than_its_document_is_refused_and_nothing_is_published(tmp_path: Path) -> None:
    node, size = _Node(tmp_path), (64, 36)
    short = node.add(_media(tmp_path / "short.mp4", "testsrc2=s=64x36:r=24,trim=end_frame=24"))
    timeline = _timeline(
        24, [_source("short", short, 48, size, has_audio=False)], [_clip("v", "short", "v1", 0, (0, 48))]
    )
    with pytest.raises(ComponentError) as refused:
        node.export(timeline, *size)
    assert (refused.value.code, refused.value.details["reason"]) == ("MEDIA_INCOMPLETE", "source_missing_frames")
    assert str(tmp_path) not in refused.value.message
