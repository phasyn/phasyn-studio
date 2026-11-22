"""Timeline export boundaries only: invalid inputs, original files, the plan, integrity and owned cleanup.

All decoders and encoders are fakes. Real FFmpeg composition is a separate bounded runtime
review; these tests never start a subprocess or contact a real controller/node.
"""

from __future__ import annotations

import copy
import re
import threading
from collections.abc import Callable
from contextlib import nullcontext
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace
from typing import Any, TypedDict, Unpack, cast
from unittest.mock import Mock, patch

import pytest
from phasyn_components.errors import ComponentError
from phasyn_components.provider import RunContext
from phasyn_components.testing.ids import NODE_A_ID, uid
from phasyn_components.timeline import validate_timeline
from phasyn_components.timeline_limits import MAX_SOURCE_FRAMES

from phasyn_media import composition
from phasyn_media._options import validate_keywords
from phasyn_media.composition import plan_composition, source_index
from phasyn_media.composition_video import source_range
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.probe import MediaInfo
from phasyn_media.providers import timeline_export as exporter
from phasyn_media.seek import (
    SourceTiming,
    StreamClock,
    audio_cut,
    frame_tick,
    near,
    seek_text,
    source_timing,
)


PARAMS = {"preset": "ultrafast", "crf": 18, "audio_bitrate": 192000}
ABSOLUTE_PATH = re.compile(r"(?<![\w.])/[\w.-]+/")
VIDEO_CLOCK = StreamClock(0, Fraction(1, 12288), 0)
TIMING = SourceTiming(
    Fraction(0), VIDEO_CLOCK, StreamClock(1, Fraction(1, 48000), 0), 48000
)


def _file(index: int, media_type: str = "video/mp4") -> dict[str, Any]:
    return {
        "node_id": NODE_A_ID,
        "file_id": uid(index),
        "size_bytes": 1,
        "sha256": "a" * 64,
        "media_type": media_type,
        "metadata": {},
    }


def _track(track_id: str, kind: str = "video", **patch: Any) -> dict[str, Any]:
    track = {
        "track_id": track_id,
        "name": track_id,
        "kind": kind,
        "locked": False,
        "muted": False,
        "solo": False,
        "sync_lock": True,
        "gain_db": 0,
        "pan": 0,
    }
    track.update(patch)
    return track


def _clip(
    clip_id: str,
    start: int,
    in_frame: int,
    out_frame: int,
    track: str = "video-a",
    **patch: Any,
) -> dict[str, Any]:
    clip = {
        "clip_id": clip_id,
        "source_id": "source-a",
        "track_id": track,
        "name": f"Synthetic {clip_id}",
        "start_frame": start,
        "in_frame": in_frame,
        "out_frame": out_frame,
        "motion": {
            "x": 0,
            "y": 0,
            "scale": 1,
            "rotation": 0,
            "opacity": 1,
            "gain_db": 0,
            "pan": 0,
            "keyframes": {},
        },
    }
    clip.update(patch)
    return clip


def _sequence() -> dict[str, Any]:
    timeline = {
        "version": 1,
        "fps": {"num": 24, "den": 1},
        "master_gain_db": 0,
        "sources": [
            {
                "source_id": "source-a",
                "name": "Synthetic source",
                "kind": "video",
                "file": _file(901),
                "duration_frames": 24,
                "width": 64,
                "height": 32,
                "has_audio": True,
            }
        ],
        "tracks": [_track("video-a")],
        "clips": [_clip("clip-a", 0, 0, 24)],
        "captions": [],
        "markers": [],
    }
    return {
        "clips": [],
        "timeline": timeline,
        "width": 64,
        "height": 32,
        "fps": {"num": 24, "den": 1},
    }


def _title(**patch: Any) -> dict[str, Any]:
    title = {
        "text": "Synthetic text",
        "position": "center",
        "size": "medium",
        "start_frame": 0,
        "end_frame": None,
        "image": None,
        "image_key": None,
    }
    title.update(patch)
    return title


def _info(**patch: Any) -> MediaInfo:
    values: dict[str, Any] = {
        "kind": "video",
        "format_name": "mov",
        "duration_seconds": 1.0,
        "width": 64,
        "height": 32,
        "fps_num": 24,
        "fps_den": 1,
        "frame_count": 24,
        "pixel_format": "yuv420p",
        "color_primaries": None,
        "color_transfer": None,
        "color_space": None,
        "color_range": None,
        "has_audio": False,
        "audio_sample_rate": None,
        "audio_channels": None,
        "audio_channel_layout": None,
        "video_codec": "h264",
        "audio_codec": None,
    }
    values.update(patch)
    return MediaInfo(**values)


def _context(
    tmp_path: Path, remaining: float = 60.0
) -> tuple[RunContext, SimpleNamespace, SimpleNamespace]:
    writer = SimpleNamespace(
        file_id=uid(910), path=tmp_path / "published.mp4", adopt_written=Mock()
    )
    fake = SimpleNamespace(
        work_dir=tmp_path,
        cancel_token=threading.Event(),
        remaining_seconds=lambda: remaining,
        check_cancelled=Mock(),
        resolve_file=Mock(return_value=tmp_path / "original.mp4"),
        recorder=SimpleNamespace(
            phase=lambda _name: nullcontext(), record_cost=Mock(), node_id=NODE_A_ID
        ),
        new_file=Mock(return_value=writer),
        set_output=Mock(),
    )
    return cast(RunContext, fake), fake, writer


def _refusal(sequence: dict[str, Any]) -> ComponentError:
    with pytest.raises(ComponentError) as refused:
        plan_composition(sequence)
    return refused.value


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "muted_missing",
        "handles",
        "mismatched_fps",
        "duplicate_effect",
        "pixels",
        "time_budget",
    ],
)
def test_timeline_invalid_export_is_rejected_before_materialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    sequence = _sequence()
    remaining = 60.0
    if case in ("missing", "muted_missing"):
        sequence["timeline"]["sources"][0]["file"] = None
        sequence["timeline"]["tracks"][0]["muted"] = case == "muted_missing"
    elif case == "handles":
        sequence["timeline"]["clips"][0]["out_frame"] = 25
    elif case == "mismatched_fps":
        sequence["fps"] = {"num": 30, "den": 1}
    elif case == "duplicate_effect":
        effect = {"effect_id": "effect-a", "enabled": True, "kind": "blur", "radius": 4}
        sequence["timeline"]["clips"][0]["effect_stack"] = [effect, dict(effect)]
    elif case == "pixels":
        sequence["width"] = 16384
        sequence["height"] = 16384
    else:
        remaining = 1e-9
    ctx, fake, _writer = _context(tmp_path, remaining)
    materialize = Mock(
        side_effect=AssertionError("invalid edit reached materialization")
    )
    monkeypatch.setattr(exporter, "_prepare", materialize)
    with pytest.raises(ComponentError) as refused:
        exporter.export_timeline(ctx, sequence, PARAMS)
    assert refused.value.code in ("INVALID_ARGUMENT", "INPUT_TOO_LARGE")
    assert refused.value.details["reason"]
    materialize.assert_not_called()
    fake.new_file.assert_not_called()
    fake.set_output.assert_not_called()
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    ("case", "reason"),
    [
        ("enabled_placeholder", "not_rendered"),
        ("muted_placeholder", "not_rendered"),
        ("disabled_placeholder", None),
        ("source_beyond_bound", "timeline_invalid"),
        ("source_beyond_a_day", "limit_exceeded"),
        ("long_source_short_clip", None),
        ("long_source_long_clip", "limit_exceeded"),
        ("right_to_left_title", "text_direction_unsupported"),
        ("right_to_left_caption", "text_direction_unsupported"),
        ("title_beyond_clip", "effect_range"),
        ("empty", "empty_timeline"),
    ],
)
def test_plan_refuses_by_stable_reason_and_names_the_clip(
    case: str, reason: str | None
) -> None:
    sequence = _refusal_case(case)
    if reason is None:
        plan = plan_composition(sequence)
        assert plan.frames == (24 if case == "disabled_placeholder" else 120)
        if case == "disabled_placeholder":
            assert plan.clips == ()
            assert [segment.slices for segment in plan.segments] == [()]
        else:
            assert source_range(plan.clips[0], plan.segments[0].slices[0]) == (
                1_500_000,
                1_500_119,
            )
        return
    refused = _refusal(sequence)
    assert (
        refused.details["reason"] == reason
    )  # the validator's own reason: the one the Controller reports
    if reason == "not_rendered":
        assert refused.details["source_id"] == "source-a"
    assert not ABSOLUTE_PATH.search(
        refused.message
    )  # a document path ("timeline/sources/0/...") is fine


def test_disabled_clip_is_skipped_for_picture_and_sound_but_keeps_its_place() -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["sources"][0]["duration_frames"] = 96
    document["tracks"].append(_track("audio-a", "audio"))
    document["clips"] = [
        _clip("video-1", 0, 0, 24),
        _clip("video-2", 24, 24, 48, enabled=False),
        _clip("video-3", 48, 48, 72, enabled=False),
        _clip("audio-1", 0, 0, 24, track="audio-a"),
        _clip("audio-2", 24, 24, 48, track="audio-a", enabled=False),
        _clip("audio-3", 48, 48, 72, track="audio-a", enabled=True),
    ]
    plan = plan_composition(sequence)
    assert (
        plan.frames == 72
    )  # a disabled last clip still ends the sequence where it stands
    assert [clip.document["clip_id"] for clip in plan.clips] == [
        "video-1",
        "audio-1",
        "audio-3",
    ]
    assert [
        (item.at, item.frames) for segment in plan.segments for item in segment.slices
    ] == [(0, 24)]
    assert [
        plan.clips[index].document["clip_id"] for index in plan.audio_chunks[0].clips
    ] == ["audio-1", "audio-3"]
    assert plan.clips[2].start == 48  # nothing moved
    # The record names every clip that gives no picture and no sound, with why
    assert [(clip.clip_id, clip.reason) for clip in plan.skipped] == [
        ("video-2", "disabled"),
        ("video-3", "disabled"),
        ("audio-2", "disabled"),
    ]
    document["tracks"][1].update(muted=True)
    reasons = [
        (clip.clip_id, clip.reason) for clip in plan_composition(sequence).skipped
    ]
    assert reasons[-3:] == [
        ("audio-1", "track_muted"),
        ("audio-2", "track_muted"),
        ("audio-3", "track_muted"),
    ]


def test_disabled_end_of_a_transition_stays_as_a_transparent_silent_stand_in() -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["sources"][0]["duration_frames"] = 96
    fade = {"transition_out": {"kind": "crossfade", "frames": 8}}
    document["clips"] = [
        _clip("out", 0, 0, 24, effects=fade),
        _clip("in", 16, 24, 48, enabled=False),
    ]
    plan = plan_composition(sequence)
    assert [(clip.document["clip_id"], clip.enabled) for clip in plan.clips] == [
        ("out", True),
        ("in", False),
    ]
    assert plan.groups == ((0, 1),)
    assert plan.frames == 40
    document["clips"][0]["enabled"] = (
        False  # nothing of the chain is exported: no stand-in is kept
    )
    assert plan_composition(sequence).clips == ()


@pytest.mark.parametrize(
    ("effects", "frames"),
    [
        (None, {0: 10, 5: 15, 23: 33}),
        ({"speed_percent": 200}, {0: 10, 1: 12, 11: 32}),
        ({"speed_percent": 50}, {0: 10, 1: 10, 2: 11, 47: 33}),
        ({"frame_step": 3}, {0: 10, 2: 10, 3: 13, 23: 31}),
        ({"hold": {"start": 4, "end": 6}}, {0: 10, 4: 10, 5: 11, 27: 33, 33: 33}),
        (
            {"speed_percent": 150, "frame_step": 2, "hold": {"start": 2, "end": 0}},
            {0: 10, 2: 10, 4: 13, 5: 13, 17: 31},
        ),
    ],
)
def test_processed_frames_read_the_planned_source_frames(
    effects: dict[str, Any] | None, frames: dict[int, int]
) -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["sources"][0]["duration_frames"] = 48
    document["clips"][0].update(
        in_frame=10, out_frame=34, **({"effects": effects} if effects else {})
    )
    clip = plan_composition(sequence).clips[0]
    assert {frame: source_index(clip, frame) for frame in frames} == frames
    assert max(source_index(clip, frame) for frame in range(clip.plan.frames)) < 34


@pytest.mark.parametrize(
    ("clips", "per_clip"), [(1, 24), (40, 24), (1000, 100), (150, 7)]
)
def test_segments_cover_the_range_once_within_the_input_bound(
    clips: int, per_clip: int
) -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["sources"][0]["duration_frames"] = 100000
    document["tracks"].append(_track("audio-a", "audio"))
    document["clips"] = [
        _clip(
            f"{kind}-{number}",
            number * per_clip,
            number,
            number + per_clip,
            track=f"{kind}-a",
        )
        for number in range(clips // 2 or 1)
        for kind in (("video", "audio") if clips > 1 else ("video",))
    ]
    plan = plan_composition(sequence)
    assert plan.segments[0].start == 0 and plan.segments[-1].end == plan.frames
    shown: dict[int, int] = {}
    for before, segment in zip([None, *plan.segments], plan.segments, strict=False):
        assert before is None or before.end == segment.start
        assert 0 < segment.frames <= composition.SEGMENT_MAX_FRAMES
        assert (
            sum(1 for item in segment.slices if plan.clips[item.clip].enabled)
            <= composition.SEGMENT_MAX_INPUTS
        )
        for item in segment.slices:
            clip = plan.clips[item.clip]
            assert (
                segment.start + item.at - clip.start == item.first - clip.window_start
            )
            shown[item.clip] = shown.get(item.clip, 0) + item.frames
    assert all(
        shown[index] == clip.visible_frames
        for index, clip in enumerate(plan.clips)
        if clip.is_video
    )
    samples = [
        composition.chunk_samples(plan, chunk.start, chunk.end)
        for chunk in plan.audio_chunks
    ]
    assert samples[0][0] == 0 and samples[-1][1] == plan.output_samples
    assert all(left[1] == right[0] for left, right in pairwise(samples))
    assert all(
        len(chunk.clips) <= composition.AUDIO_CHUNK_MAX_INPUTS
        for chunk in plan.audio_chunks
    )


@pytest.mark.parametrize(
    ("uploaded", "drawn", "refused"), [(0, 500, False), (62, 438, False), (70, 0, True)]
)
def test_captions_are_one_input_when_drawn_and_bounded_when_uploaded(
    uploaded: int, drawn: int, *, refused: bool
) -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["sources"][0].update(kind="text", file=None, has_audio=False)
    document["clips"][0]["effects"] = {
        "title": _title()
    }  # a text layer: one drawn raster, no media input
    key = composition.caption_image_key(
        {"text": "Text", "position": "bottom", "size": "medium"}, 64, 32
    )
    document["captions"] = [
        {
            "caption_id": f"caption-{number}",
            "start_frame": 0,
            "end_frame": 24,
            "text": "Text",
            "position": "bottom",
            "size": "medium",
            **(
                {"image": _file(950, "image/png"), "image_key": key}
                if number < uploaded
                else {}
            ),
        }
        for number in range(uploaded + drawn)
    ][:500]
    if refused:
        assert _refusal(sequence).details["reason"] == "too_many_layers"
        return
    plan = plan_composition(sequence)
    assert sum(caption.image is not None for caption in plan.captions) == uploaded
    assert sum(caption.spec is not None for caption in plan.captions) == min(
        drawn, 500 - uploaded
    )
    assert len(plan.segments) == 1


@pytest.mark.parametrize(
    ("image", "image_key", "drawn"),
    [
        (False, None, True),
        (True, None, False),
        (True, "fresh", False),
        (True, "stale", True),
    ],
)
def test_uploaded_title_is_used_only_while_it_belongs_to_the_text(
    *, image: bool, image_key: str | None, drawn: bool
) -> None:
    sequence = _sequence()
    title = _title(end_frame=12)
    if image_key == "fresh":
        image_key = composition.title_image_key(title, 64, 32)
    title.update(image=_file(950, "image/png") if image else None, image_key=image_key)
    sequence["timeline"]["clips"][0]["effects"] = {"title": title}
    planned = plan_composition(sequence).clips[0].title
    assert planned is not None and (planned.start_frame, planned.end_frame) == (0, 12)
    assert (planned.spec is not None, planned.image is None) == (drawn, drawn)
    assert (
        composition.title_image_key(_title(), 1280, 720)
        == '["title.v1","Synthetic text","center","medium",1280,720]'
    )


def test_seek_arithmetic_is_exact_and_never_late() -> None:
    assert [near(Fraction(value, 2)) for value in (1, 3, -1, -3, 5)] == [
        1,
        2,
        -1,
        -2,
        3,
    ]
    ntsc = Fraction(30000, 1001)
    clock = StreamClock(0, Fraction(1, 30000), 2002)
    assert [
        frame_tick(2002 + 1001 * index, clock, Fraction(24)) for index in range(6)
    ] == [0, 1, 2, 2, 3, 4]
    assert frame_tick(2002 + 1001 * 7, clock, ntsc) == 7
    assert (
        seek_text(Fraction(2, 3)) == "0.666666"
        and seek_text(Fraction(-1)) == "0.000000"
    )
    packets = exporter._Packets(video=[(index * 512, 512) for index in range(480)])
    assert (
        exporter._frame_before(packets, VIDEO_CLOCK, Fraction(24), 240, Fraction(4))
        == 240 * 512
    )
    assert (
        exporter._frame_before(packets, VIDEO_CLOCK, Fraction(24), 2000, Fraction(4))
        is None
    )  # outside its window
    assert exporter._has_frame(packets, VIDEO_CLOCK, Fraction(24), 479)
    assert not exporter._has_frame(packets, VIDEO_CLOCK, Fraction(24), 480)
    assert exporter.video_seek(240 * 512, VIDEO_CLOCK, TIMING) == Fraction(
        10
    ) - Fraction(1, 1000)
    assert exporter.video_seek(12, VIDEO_CLOCK, TIMING) is None


@pytest.mark.parametrize(
    ("rate", "first", "expected"),
    [
        (48000, 0, (None, None, 0, 0, 0)),
        (
            48000,
            480_000,
            (Fraction(9), 456_000, 24_000, 0, 456_000),
        ),  # cut at 9.5 s, decoded from 9 s
        (44100, 480_000, (Fraction(9), 418_950, 24_000, 0, 418_950)),
        (44100, 480_001, (Fraction(9), 418_950, 24_001, 0, 418_950)),
    ],
)
def test_audio_cut_keeps_the_resampler_on_the_grid_of_the_stream(
    rate: int, first: int, expected: tuple[Any, ...]
) -> None:
    timing = SourceTiming(
        Fraction(0), VIDEO_CLOCK, StreamClock(1, Fraction(1, rate), 0), rate
    )
    cut = audio_cut(timing, first)
    # Sample-exact timestamps place the decode from the first kept sample on, with or without a seek
    assert (
        cut.seek,
        cut.start_pts,
        cut.lead_samples,
        cut.silence_samples,
        cut.first_pts,
    ) == expected
    assert cut.rate == rate
    late = SourceTiming(
        Fraction(0), VIDEO_CLOCK, StreamClock(1, Fraction(1, 48000), 4800), 48000
    )
    assert (audio_cut(late, 0).silence_samples, audio_cut(late, 0).first_pts) == (
        4800,
        4800,
    )  # sound starts 0.1 s late
    coarse = SourceTiming(
        Fraction(0), VIDEO_CLOCK, StreamClock(1, Fraction(1, 1000), 0), 48000
    )
    counted = audio_cut(
        coarse, 480_000
    )  # a millisecond clock cannot address a sample: read from the start, count
    assert (
        counted.seek,
        counted.start_pts,
        counted.lead_samples,
        counted.first_pts,
    ) == (None, None, 480_000, None)


def test_timeline_audio_origin_ignores_attached_cover() -> None:
    cover = {
        "index": 0,
        "codec_type": "video",
        "time_base": "1/90000",
        "start_pts": 0,
        "disposition": {"attached_pic": 1},
    }
    video = {
        "index": 1,
        "codec_type": "video",
        "time_base": "1/12288",
        "start_pts": 12288,
        "disposition": {"attached_pic": 0},
    }
    audio = {
        "index": 2,
        "codec_type": "audio",
        "time_base": "1/48000",
        "start_pts": 48000,
        "sample_rate": "48000",
    }
    timing = source_timing(
        {"format": {"start_time": "0.000000"}, "streams": [cover, video, audio]}
    )
    assert timing.video is not None and timing.video.index == 1
    assert timing.origin_seconds == 1
    assert (
        audio_cut(timing, 0).silence_samples == 0
    )  # sound and picture start together, one second in


def test_timeline_materialization_never_substitutes_proxy_for_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = copy.deepcopy(_sequence()["timeline"]["sources"][0])
    source["proxy"] = {"file": _file(902)}
    ctx, fake, _writer = _context(tmp_path)
    monkeypatch.setattr(exporter, "probe", Mock(return_value=_info()))
    header = {
        "format": {"start_time": "0.000000"},
        "streams": [
            {"index": 0, "codec_type": "video", "time_base": "1/12288", "start_pts": 0}
        ],
    }
    with patch(
        "phasyn_media.probe.run_ffprobe_json", return_value=header
    ) as timing_probe:
        material = exporter._material(ctx, source)
    assert timing_probe.call_args.args[0] == fake.resolve_file.return_value
    fake.resolve_file.assert_called_once_with(source["file"])
    assert material.timing is not None and material.timing.video == VIDEO_CLOCK
    assert (
        material.declare == "colorspace=smpte170m:range=tv"
    )  # untagged and small: declared, never guessed later
    fake.resolve_file.reset_mock()
    source["file"] = None
    with pytest.raises(ComponentError, match="原始素材"):
        exporter._material(ctx, source)
    fake.resolve_file.assert_not_called()


class _SourceOptionsRequired(TypedDict):
    frames: int | None
    audio_end: int | None


class _SourceOptions(_SourceOptionsRequired, total=False):
    has_audio: bool


def _sources(
    tmp_path: Path,
    plan: Any,
    monkeypatch: pytest.MonkeyPatch,
    **options: Unpack[_SourceOptions],
) -> tuple[RunContext, SimpleNamespace, Callable[[], Any]]:
    """A source of ``frames`` picture frames (``None``: sound only) whose sound ends at ``audio_end`` samples."""
    validate_keywords(options, _SourceOptions)
    frames = options["frames"]
    audio_end = options["audio_end"]
    has_audio = options.get("has_audio", True)
    ctx, fake, _writer = _context(tmp_path)
    video = VIDEO_CLOCK if frames is not None else None
    timing = SourceTiming(
        Fraction(0),
        video,
        StreamClock(1, Fraction(1, 48000), 0) if has_audio else None,
        48000,
    )
    material = exporter.Material(
        tmp_path / "original.mp4", _info(has_audio=has_audio), timing
    )
    monkeypatch.setattr(exporter, "_material", Mock(return_value=material))

    def read(
        _ctx: Any, _material: Any, _intervals: Any, into: Any, **_options: Any
    ) -> None:
        into.video = [(index * 512, 512) for index in range(frames or 0)]
        into.audio_end = audio_end

    monkeypatch.setattr(exporter, "_read_packets", read)

    def check() -> Any:
        sources = exporter._Sources(ctx, plan, exporter._materials(ctx, plan))
        sources.read(*exporter._needs(plan))
        return exporter._check_extents(plan, sources)

    return ctx, fake, check


@pytest.mark.parametrize(
    "case",
    [
        ("video", 24, False, None, None),
        ("video", 23, False, None, "MEDIA_INCOMPLETE"),
        ("audio", 24, False, None, "INVALID_ARGUMENT"),
        ("audio", 24, True, 48000, None),
        # Sound that has no picture ends a whole frame (2,000 samples) before the clip does
        ("audio", None, True, 46000, "MEDIA_INCOMPLETE"),
        # The picture is shorter than the clip, however long the sound is
        ("audio", 23, True, 48000, "MEDIA_INCOMPLETE"),
    ],
)
def test_timeline_source_extent_must_match_actual_media(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    case: tuple[str, int | None, bool, int | None, str | None],
) -> None:
    kind, actual_frames, has_audio, audio_end, code = case
    sequence = _sequence()
    sequence["timeline"]["tracks"][0]["kind"] = kind
    plan = plan_composition(sequence)
    _ctx, fake, check = _sources(
        tmp_path,
        plan,
        monkeypatch,
        frames=actual_frames,
        audio_end=audio_end,
        has_audio=has_audio,
    )
    if code is None:
        check()
    else:
        with pytest.raises(ComponentError) as refused:
            check()
        assert refused.value.code == code
    fake.new_file.assert_not_called()


@pytest.mark.parametrize(
    ("actual_frames", "audio_end", "silence"),
    [
        # An H3 take: the sound stops 400 samples (a fifth of a frame) before the picture does
        (24, 47600, 400),
        # A file whose sound stops four frames before its picture: the clip may still run to the last picture frame
        (24, 40000, 8000),
        # Sound without a picture, rounded up to the frame grid: one sample short of a whole frame
        (None, 46001, 1999),
        (24, 48000, 0),
    ],
)
def test_timeline_sound_that_ends_early_is_followed_by_stated_silence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    actual_frames: int | None,
    audio_end: int,
    silence: int,
) -> None:
    sequence = _sequence()
    sequence["timeline"]["tracks"][0]["kind"] = "audio"
    plan = plan_composition(sequence)
    ctx, _fake, check = _sources(
        tmp_path, plan, monkeypatch, frames=actual_frames, audio_end=audio_end
    )
    assert check() == {"source-a": silence}
    monkeypatch.setattr(exporter, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        exporter, "graph_script_args", lambda path: ["-/filter_complex", str(path)]
    )
    job = exporter._prepare(ctx, plan, tmp_path)
    recorded = [
        (item["source_id"], item["file_id"], item["audio_silence_samples"])
        for item in job.sources
    ]
    assert recorded == [
        ("source-a", uid(901), silence)
    ]  # the record names the file and states the silence
    # The clip still has every sample of its range: what the source lacks is padded, never cut or shifted
    assert (
        "apad=whole_len=48000,atrim=end_sample=48000"
        in (tmp_path / "audio-00000.ffgraph").read_text()
    )


def test_timeline_clip_that_starts_after_the_sound_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sequence = _sequence()
    sequence["timeline"]["tracks"][0]["kind"] = "audio"
    sequence["timeline"]["clips"][0]["in_frame"] = 12
    plan = plan_composition(sequence)
    _ctx, fake, check = _sources(
        tmp_path, plan, monkeypatch, frames=24, audio_end=24000
    )
    with pytest.raises(ComponentError) as refused:
        check()
    assert (refused.value.code, refused.value.details["reason"]) == (
        "MEDIA_INCOMPLETE",
        "source_missing_audio",
    )
    fake.new_file.assert_not_called()


@pytest.mark.parametrize(("pictured", "refused"), [(True, False), (False, True)])
def test_sound_that_stopped_long_before_a_clip_ends_is_found_in_the_clip_range_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, pictured: bool, refused: bool
) -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["tracks"][0]["kind"] = "audio"
    document["sources"][0]["duration_frames"] = 2_073_600
    document["clips"] = [
        _clip("clip-a", 0, 240_000, 240_240)
    ]  # ten seconds, far inside a 24 hour source
    plan = plan_composition(sequence)
    _ctx, _fake, check = _sources(
        tmp_path,
        plan,
        monkeypatch,
        frames=2_073_600 if pictured else None,
        audio_end=None,
    )
    reads: list[tuple[list[str], dict[str, Any]]] = []

    def read(
        _ctx: Any, _material: Any, intervals: Any, into: Any, **options: Any
    ) -> None:
        reads.append((list(intervals), options))
        into.video = (
            [(index * 512, 512) for index in range(240_239, 240_241)]
            if pictured
            else []
        )
        # Windows around the end of the clip show no sound; the read of the clip's own range finds where it stopped
        into.audio_end = (10_000 + 2) * 48000 if options.get("whole_clip") else None

    monkeypatch.setattr(exporter, "_read_packets", read)
    if refused:
        with pytest.raises(ComponentError) as error:
            check()
        assert (
            error.value.details["reason"] == "source_missing_audio"
        )  # eight seconds past sound without a picture
    else:
        assert check() == {"source-a": 8 * 48000}
    whole = [intervals for intervals, options in reads if options.get("whole_clip")]
    assert whole == [
        ["10000.000000%10009.000000"]
    ]  # one read, of the clip only: never a scan of the source
    assert all(
        float(item.split("%")[0]) > 9_990
        for intervals, _options in reads
        for item in intervals
    )


def test_window_cannot_hide_missing_source_extent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sequence = _sequence()
    sequence["timeline"]["clips"][0]["output_window"] = {
        "start_frame": 0,
        "end_frame": 6,
    }
    plan = plan_composition(sequence)
    _ctx, fake, check = _sources(tmp_path, plan, monkeypatch, frames=12, audio_end=None)
    with pytest.raises(ComponentError) as refused:
        check()
    assert (refused.value.code, refused.value.details["reason"]) == (
        "MEDIA_INCOMPLETE",
        "source_missing_frames",
    )
    fake.new_file.assert_not_called()


def test_long_source_is_read_from_its_own_seek_point_with_bounded_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["sources"][0]["duration_frames"] = 2_073_600
    document["clips"] = [
        _clip("near", 0, 0, 24),
        _clip("far", 24, 1_500_000, 1_500_024),
    ]
    plan = plan_composition(sequence)
    ctx, _fake, _check = _sources(tmp_path, plan, monkeypatch, frames=0, audio_end=None)
    intervals: list[str] = []

    def read(
        _ctx: Any, _material: Any, wanted: Any, into: Any, **_options: Any
    ) -> None:
        intervals.extend(wanted)
        into.video = sorted(
            {
                *into.video,
                *(
                    (index * 512, 512)
                    for index in (*range(48), *range(1_499_900, 1_500_030))
                ),
            }
        )

    monkeypatch.setattr(exporter, "_read_packets", read)
    monkeypatch.setattr(exporter, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        exporter, "graph_script_args", lambda path: ["-/filter_complex", str(path)]
    )
    sources = exporter._Sources(ctx, plan, exporter._materials(ctx, plan))
    sources.read(*exporter._needs(plan))
    exporter._check_extents(plan, sources)
    assert len(intervals) == 2 and intervals[1].startswith(
        "62496."
    )  # two short windows, never a scan of the file
    job = exporter._Job(tmp_path)
    run = exporter._segment_run(
        ctx,
        plan,
        plan.segments[0],
        exporter._SegmentAssets(sources, {}, ({}, None)),
        job,
    )
    starts = [
        index for index, item in enumerate(run.argv) if item == "-protocol_whitelist"
    ]
    inputs = [index for index, item in enumerate(run.argv) if item == "-i"]
    first, second = (
        run.argv[starts[0] : inputs[0] + 2],
        run.argv[starts[1] : inputs[1] + 2],
    )
    assert "-ss" not in first and first[first.index("-t") + 1] == "2.041666"
    assert (
        second[second.index("-ss") + 1] == "62499.999000"
    )  # one millisecond before frame 1,500,000
    for arguments in (first, second):
        assert arguments[:4] == [
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            DEFAULT_LIMITS.format_whitelist,
        ]
        assert arguments[4:6] == ["-max_pixels", str(DEFAULT_LIMITS.max_pixels)]
    assert run.expected == 48 and "-copyts" in run.argv
    assert str(tmp_path) not in "".join(run.marks.values())


def _fake_video(
    _ctx: RunContext,
    _plan: Any,
    _job: Any,
    destination: exporter._VideoDestinations,
    _params: Any,
) -> None:
    destination.output.write_bytes(b"synthetic incomplete export")


def _stage(monkeypatch: pytest.MonkeyPatch, video: Any = _fake_video) -> None:
    def prepare(_ctx: Any, _plan: Any, directory: Path, *, audio_only: bool) -> Any:
        assert audio_only is False
        (directory / "video-00000.ffgraph").write_text(
            "synthetic graph", encoding="utf-8"
        )
        return exporter._Job(directory)

    monkeypatch.setattr(exporter, "_prepare", prepare)
    monkeypatch.setattr(
        exporter,
        "_render_audio",
        lambda _ctx, _job, pcm: pcm.write_bytes(b"synthetic samples"),
    )
    monkeypatch.setattr(exporter, "_render_video", video)


@pytest.mark.parametrize(
    "case",
    [
        "frames",
        "geometry",
        "fps",
        "audio_short",
        "audio_missing",
        "declared_short",
        "declared_missing",
        "declared_invalid",
    ],
)
def test_timeline_verification_failure_never_publishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    ctx, fake, writer = _context(tmp_path)
    _stage(monkeypatch)
    patch: dict[str, Any] = {}
    if case == "frames":
        patch["frame_count"] = 23
    elif case == "geometry":
        patch["width"] = 62
    elif case == "fps":
        patch["fps_num"] = 30
    monkeypatch.setattr(exporter, "probe", Mock(return_value=_info(**patch)))
    samples = 47900 if case == "audio_short" else 48000
    streams = (
        []
        if case == "audio_missing"
        else [SimpleNamespace(start_seconds=0, end_seconds=samples / 48000, packets=1)]
    )
    monkeypatch.setattr(
        exporter,
        "scan_timeline",
        Mock(return_value=SimpleNamespace(of_type=lambda _kind: streams)),
    )
    declared: dict[str, Any] = {
        "sample_rate": "48000",
        "start_pts": 0,
        "duration_ts": 48000,
        "time_base": "1/48000",
    }
    if case == "declared_short":
        declared["duration_ts"] = 47984
    elif case == "declared_invalid":
        declared["time_base"] = "1/0"
    monkeypatch.setattr(
        exporter,
        "run_ffprobe_json",
        Mock(
            return_value={"streams": [] if case == "declared_missing" else [declared]}
        ),
    )
    with pytest.raises(ComponentError) as refused:
        exporter.export_timeline(ctx, _sequence(), PARAMS)
    assert refused.value.code == "MEDIA_INCOMPLETE"
    writer.adopt_written.assert_not_called()
    fake.set_output.assert_not_called()
    assert not writer.path.exists()
    assert not list(
        tmp_path.iterdir()
    )  # the frame file, the sound file, the graphs and their directory are gone


@pytest.mark.parametrize("case", ["renderer_fails", "short_segment", "encoder_fails"])
def test_a_failed_or_short_segment_never_publishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    ctx, fake, writer = _context(tmp_path)

    def prepare(_ctx: Any, _plan: Any, directory: Path, *, audio_only: bool) -> Any:
        assert audio_only is False
        return exporter._Job(directory, video=[exporter._Run(["renderer"], {}, 24)])

    monkeypatch.setattr(exporter, "_prepare", prepare)
    monkeypatch.setattr(
        exporter, "_render_audio", lambda _ctx, _job, pcm: pcm.write_bytes(b"")
    )
    monkeypatch.setattr(exporter, "find_ffmpeg", lambda: "ffmpeg")
    encoder = SimpleNamespace(
        stdin=SimpleNamespace(fileno=lambda: 7, close=Mock()),
        poll=Mock(return_value=1 if case == "encoder_fails" else None),
        returncode=1,
        stderr_text=lambda: f"{tmp_path}/secret.mp4: No space left on device",
        kill_tree=Mock(),
        close=Mock(),
    )
    monkeypatch.setattr(exporter, "ManagedProcess", Mock(return_value=encoder))
    result = SimpleNamespace(
        returncode=1 if case == "renderer_fails" else 0,
        stderr="frame=23\nprogress=end\n",
    )
    monkeypatch.setattr(exporter, "run_tool", Mock(return_value=result))
    with pytest.raises(ComponentError) as refused:
        exporter.export_timeline(ctx, _sequence(), PARAMS)
    expected = {
        "renderer_fails": "segment_render_failed",
        "short_segment": "segment_incomplete",
        "encoder_fails": "encode_failed",
    }
    assert refused.value.details["reason"] == expected[case]
    assert str(tmp_path) not in refused.value.message
    encoder.kill_tree.assert_called()
    writer.adopt_written.assert_not_called()
    fake.set_output.assert_not_called()
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("target", ["frames", "directory"])
def test_timeline_cleanup_preserves_preexisting_temp_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str
) -> None:
    ctx, fake, writer = _context(tmp_path)
    monkeypatch.setattr(exporter, "new_id", lambda: uid(911))
    name = (
        f"{writer.file_id}.timeline.mp4"
        if target == "frames"
        else f"{uid(911)}.timeline.d"
    )
    sentinel = tmp_path / name
    sentinel.write_bytes(b"existing file must survive")
    encode = Mock(side_effect=AssertionError("existing path reached encoder"))
    _stage(monkeypatch, encode)
    with pytest.raises((FileExistsError, ComponentError)):
        exporter.export_timeline(ctx, _sequence(), PARAMS)
    assert sentinel.read_bytes() == b"existing file must survive"
    encode.assert_not_called()
    writer.adopt_written.assert_not_called()
    fake.set_output.assert_not_called()
    assert not writer.path.exists()
    assert list(tmp_path.iterdir()) == [sentinel]


def test_timeline_file_inputs_keep_protocol_demuxer_and_decoder_bounds(
    tmp_path: Path,
) -> None:
    args = exporter._input(
        tmp_path / "synthetic.mp4", DEFAULT_LIMITS, ["-ss", "1.000000", "-threads", "2"]
    )
    assert args[:4] == [
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        DEFAULT_LIMITS.format_whitelist,
    ]
    assert args[4:6] == ["-max_pixels", str(DEFAULT_LIMITS.max_pixels)]
    assert args[6:10] == ["-ss", "1.000000", "-threads", "2"]
    assert args[-2:] == ["-i", f"file:{tmp_path / 'synthetic.mp4'}"]


@pytest.mark.parametrize("bounds", [(8, 8), (16, 8), (0, 25), (-1, 12)])
def test_render_range_rejected_before_materialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bounds: tuple[int, int]
) -> None:
    sequence = _sequence()
    sequence["render_range"] = {"start_frame": bounds[0], "end_frame": bounds[1]}
    ctx, fake, _writer = _context(tmp_path)
    materialize = Mock(
        side_effect=AssertionError("invalid range reached materialization")
    )
    monkeypatch.setattr(exporter, "_prepare", materialize)
    with pytest.raises(ComponentError):
        exporter.export_timeline(ctx, sequence, PARAMS)
    materialize.assert_not_called()
    fake.new_file.assert_not_called()


def test_render_range_plans_only_its_frames_and_samples() -> None:
    sequence = _sequence()
    sequence["render_range"] = {"start_frame": 6, "end_frame": 18}
    plan = plan_composition(sequence)
    assert [(segment.start, segment.end) for segment in plan.segments] == [(6, 18)]
    assert [(item.first, item.end, item.at) for item in plan.segments[0].slices] == [
        (6, 18, 0)
    ]
    assert composition.chunk_samples(plan, 6, 18) == (12000, 36000)


def test_range_output_verifier_rejects_full_sequence_length(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sequence = _sequence()
    sequence["render_range"] = {"start_frame": 6, "end_frame": 18}
    plan = plan_composition(sequence)
    ctx, _fake, _writer = _context(tmp_path)
    monkeypatch.setattr(exporter, "probe", Mock(return_value=_info()))
    with pytest.raises(ComponentError, match="實際影格數"):
        exporter._verify(ctx, plan, tmp_path / "synthetic.mp4")


@pytest.mark.parametrize(
    "case",
    [
        "missing_controls",
        "invalid_controls",
        "unknown_channel",
        "outside_clip",
        "effect_value",
        "mask_zero",
    ],
)
def test_invalid_effect_automation_is_rejected_at_document_boundary(case: str) -> None:
    document = _sequence()["timeline"]
    clip = document["clips"][0]
    point = {"frame": 0, "value": 4, "interpolation": "linear"}
    effect: dict[str, Any] = {
        "kind": "blur",
        "effect_id": "blur-a",
        "enabled": True,
        "radius": 4,
        "keyframes": {"radius": [point]},
    }
    clip["effect_stack"] = [effect]
    if case == "missing_controls":
        point["interpolation"] = "bezier"
    elif case == "invalid_controls":
        point.update(interpolation="bezier", bezier=[0.2, -1, 0.8, 1])
    elif case == "unknown_channel":
        effect["keyframes"]["arbitrary"] = [point]
    elif case == "outside_clip":
        point["frame"] = 25
    elif case == "effect_value":
        point["value"] = 65
    else:
        clip["mask"] = {
            "kind": "ellipse",
            "x": 0,
            "y": 0,
            "width": 1,
            "height": 1,
            "feather": 0,
            "invert": False,
            "keyframes": {
                "width": [{"frame": 0, "value": 0, "interpolation": "linear"}]
            },
        }
    with pytest.raises(ComponentError):
        validate_timeline(document)


@pytest.mark.parametrize(
    "case",
    [
        "file",
        "audio",
        "missing_title",
        "partial_title",
        "linked_media",
        "nonfinite_style",
    ],
)
def test_generated_text_boundary_rejects_inconsistent_sources(case: str) -> None:
    document = _sequence()["timeline"]
    source = document["sources"][0]
    source.update(kind="text", file=None, has_audio=False)
    clip = document["clips"][0]
    title = _title()
    clip["effects"] = {"title": title}
    if case == "file":
        source["file"] = _file(901)
    elif case == "audio":
        source["has_audio"] = True
    elif case == "missing_title":
        del clip["effects"]
    elif case == "partial_title":
        title["start_frame"] = 1
    elif case == "linked_media":
        source["shot_id"] = "shot-a"
    else:
        title["style"] = {
            "font_family": "sans",
            "font_size": float("nan"),
            "font_weight": 700,
            "color": "#ffffff",
            "align": "center",
            "x": 0.5,
            "y": 0.5,
        }
    with pytest.raises(ComponentError):
        validate_timeline(document)


def test_text_layer_is_planned_as_drawn_text_without_a_media_input() -> None:
    sequence = _sequence()
    document = sequence["timeline"]
    document["sources"][0].update(kind="text", file=None, has_audio=False)
    document["clips"][0]["effects"] = {"title": _title()}
    plan = plan_composition(sequence)
    clip = plan.clips[0]
    assert clip.generated and clip.title is not None and clip.title.spec is not None
    assert (clip.title.start_frame, clip.title.end_frame) == (0, 24)
    request, by_clip, by_segment = exporter._text_request(plan)
    assert [job.spec.text for job in request.titles] == ["Synthetic text"]
    assert by_clip == {0: request.titles[0].job_id} and by_segment == {}


def _adjusted_sequence(**patch: Any) -> dict[str, Any]:
    """The synthetic clip on video-a and an adjustment layer over its frames 6-18 on video-b."""
    sequence = _sequence()
    document = sequence["timeline"]
    document["version"] = 2
    document["tracks"].append(_track("video-b"))
    document["sources"].append(
        {
            "source_id": "adjust",
            "name": "Synthetic adjustment",
            "kind": "adjustment",
            "file": None,
            "duration_frames": 100000,
            "width": 64,
            "height": 32,
            "has_audio": False,
        }
    )
    document["clips"].append(
        _clip("layer", 6, 0, 12, track="video-b", source_id="adjust", **patch)
    )
    return sequence


def test_adjustment_layer_reads_no_file_and_is_made_from_the_canvas_under_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sequence = _adjusted_sequence(
        blend_mode="screen",
        effects={"color": {"saturation": 0}, "fade": {"video_in": 3}},
        effect_stack=[
            {"effect_id": "blur-a", "kind": "blur", "enabled": True, "radius": 2}
        ],
    )
    plan = plan_composition(sequence)
    layer = next(clip for clip in plan.clips if clip.adjustment)
    assert not layer.media_file and layer.title is None and layer.enabled
    ctx, _fake, check = _sources(
        tmp_path, plan, monkeypatch, frames=24, audio_end=48000
    )
    check()
    assert {
        call.args[1]["source_id"]
        for call in cast(Mock, exporter._material).call_args_list
    } == {"source-a"}
    monkeypatch.setattr(exporter, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        exporter, "graph_script_args", lambda path: ["-/filter_complex", str(path)]
    )
    sources = exporter._Sources(ctx, plan, exporter._materials(ctx, plan))
    sources.read(*exporter._needs(plan))
    run = exporter._segment_run(
        ctx,
        plan,
        plan.segments[0],
        exporter._SegmentAssets(sources, {}, ({}, None)),
        exporter._Job(tmp_path),
    )
    assert run.argv.count("-i") == 1  # the clip's file only: the layer opens nothing
    graph = (tmp_path / "video-00000.ffgraph").read_text(encoding="utf-8")
    position = next(
        index
        for index, item in enumerate(plan.segments[0].slices)
        if plan.clips[item.clip].adjustment
    )
    label = f"adjust{position}"
    # The canvas so far (with the clip under the layer) is split; the layer's frames of it are its picture, on its
    # processed clock, through its own chain; its fade eases its coverage, never the picture to black
    assert f"[base1]split=2[{label}under][{label}source]" in graph
    assert (
        f"[{label}source]trim=start_frame=6:end_frame=18,setpts=N+0,format=gbrap[{label}picture]"
        in graph
    )
    assert (
        "eq=brightness=0:contrast=1:saturation=0" in graph and "gblur@effect" in graph
    )
    assert "fade=t=in:st=0:d=0.125000000:alpha=1" in graph
    # It starts transparent at the segment's first frame (the canvas never waits for it) and is blended back in its frames
    assert f"tpad=start_mode=add:start=6:color=black@0[{label}]" in graph
    assert (
        f"[{label}]format=gbrap[blend1aligned]" in graph
        and "blend=all_mode=screen" in graph
    )
    assert "enable='between(n,6,17)'" in graph
    assert f"probe{position}" not in graph


@pytest.mark.parametrize(
    "case", ["moved", "retimed", "held", "titled", "transition", "sound"]
)
def test_adjustment_layer_with_a_picture_clock_or_sound_of_its_own_is_refused_before_anything_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    motion = {
        "x": 0.5,
        "y": 0,
        "scale": 1,
        "rotation": 0,
        "opacity": 1,
        "gain_db": 0,
        "pan": 0,
        "keyframes": {},
    }
    options: dict[str, dict[str, Any]] = {
        "moved": {"motion": motion},
        "retimed": {"effects": {"speed_percent": 50}},
        "held": {"effects": {"hold": {"start": 2}}},
        "titled": {"effects": {"title": _title()}},
        "transition": {
            "effects": {"transition_out": {"kind": "crossfade", "frames": 4}}
        },
        "sound": {"effects": {"fade": {"audio_in": 2}}},
    }
    patch = options[case]
    sequence = _adjusted_sequence(**patch)
    ctx, fake, _writer = _context(tmp_path)
    materialize = Mock(
        side_effect=AssertionError(
            "an invalid adjustment layer reached materialization"
        )
    )
    monkeypatch.setattr(exporter, "_prepare", materialize)
    with pytest.raises(ComponentError) as refused:
        exporter.export_timeline(ctx, sequence, PARAMS)
    assert refused.value.details["reason"] == "adjustment_layer"
    materialize.assert_not_called()
    fake.new_file.assert_not_called()


@pytest.mark.parametrize(
    "case",
    [
        "empty",
        "reversed",
        "past_end",
        "negative",
        "fractional",
        "null",
        "extra",
        "processing_limit",
    ],
)
def test_output_window_rejected_before_materialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    sequence = _sequence()
    clip = sequence["timeline"]["clips"][0]
    window: Any = {"start_frame": 4, "end_frame": 20}
    if case == "empty":
        window["end_frame"] = 4
    elif case == "reversed":
        window["end_frame"] = 3
    elif case == "past_end":
        window["end_frame"] = 25
    elif case == "negative":
        window["start_frame"] = -1
    elif case == "fractional":
        window["start_frame"] = 0.5
    elif case == "null":
        window = None
    elif case == "extra":
        window["unsafe"] = True
    else:
        sequence["timeline"]["sources"][0]["duration_frames"] = 100000
        clip.update(out_frame=100000, effects={"speed_percent": 50})
        window = {"start_frame": 0, "end_frame": 1}
    clip["output_window"] = window
    original = copy.deepcopy(sequence)
    ctx, fake, _writer = _context(tmp_path)
    materialize = Mock(
        side_effect=AssertionError("invalid window reached materialization")
    )
    monkeypatch.setattr(exporter, "_prepare", materialize)
    with pytest.raises(ComponentError):
        exporter.export_timeline(ctx, sequence, PARAMS)
    assert sequence == original
    materialize.assert_not_called()
    fake.new_file.assert_not_called()
    fake.set_output.assert_not_called()


def test_output_window_keeps_complete_animation_and_effect_data() -> None:
    document = _sequence()["timeline"]
    clip = document["clips"][0]
    clip["output_window"] = {"start_frame": 6, "end_frame": 18}
    keys = [
        {
            "frame": 0,
            "value": 0,
            "interpolation": "bezier",
            "bezier": [0.2, 0.1, 0.8, 1],
        },
        {"frame": 24, "value": 1, "interpolation": "linear"},
    ]
    clip["motion"]["keyframes"]["opacity"] = keys
    clip["effects"] = {
        "fade": {"video_in": 8, "video_out": 8},
        "title": _title(end_frame=24),
    }
    clip["effect_stack"] = [
        {
            "effect_id": "color-a",
            "enabled": True,
            "kind": "color",
            "brightness": 0,
            "contrast": 1,
            "saturation": 1,
            "keyframes": {"brightness": copy.deepcopy(keys)},
        }
    ]
    original = copy.deepcopy(document)
    validate_timeline(document)
    assert document == original
    plan = plan_composition(
        {
            "clips": [],
            "timeline": document,
            "width": 64,
            "height": 32,
            "fps": {"num": 24, "den": 1},
        }
    )
    assert [(item.first, item.end, item.at) for item in plan.segments[0].slices] == [
        (6, 18, 0)
    ]  # the clock is not restarted


def _refusal_case(case: str) -> dict[str, Any]:
    sequence = _sequence()
    document = sequence["timeline"]
    source, clip = document["sources"][0], document["clips"][0]
    if case.endswith("_placeholder"):
        source.update(file=None, pending_take_id="take-b")
        clip["enabled"] = case != "disabled_placeholder"
        document["tracks"][0]["muted"] = case == "muted_placeholder"
        document["captions"] = [
            {
                "caption_id": "caption-a",
                "start_frame": 0,
                "end_frame": 24,
                "text": "Text",
                "position": "bottom",
                "size": "medium",
            }
        ]
    elif case == "source_beyond_bound":
        source["duration_frames"] = MAX_SOURCE_FRAMES + 1
    elif case == "source_beyond_a_day":
        source["duration_frames"] = 24 * 3600 * 24 + 1
    elif case.startswith("long_source"):
        source["duration_frames"] = 2_073_600
        length = 120 if case == "long_source_short_clip" else 100_001
        clip.update(in_frame=1_500_000, out_frame=1_500_000 + length)
    elif case == "right_to_left_title":
        clip["effects"] = {"title": _title(text="שלום")}
    elif case == "right_to_left_caption":
        document["captions"] = [
            {
                "caption_id": "caption-a",
                "start_frame": 0,
                "end_frame": 12,
                "text": "مرحبا",
                "position": "bottom",
                "size": "medium",
            }
        ]
    elif case == "title_beyond_clip":
        clip["effects"] = {"title": _title(end_frame=24)}
        clip.update(out_frame=20)
    else:
        document["clips"] = []
    return sequence
