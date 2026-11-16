"""Clip and track arithmetic shared by every edit (the Python twin of the editor's ``model.ts``).

Documents are plain JSON objects. Functions here never mutate what they are given: an edit works on
its own deep copy of the timeline and replaces clips with new objects.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any

from ..timeline import clip_duration, clip_output_window, processed_clip_duration
from ..timeline_limits import EFFECT_BOUNDS

Doc = dict[str, Any]
AllocateId = Callable[[str], str]

MOTION_CHANNELS = ("x", "y", "scale", "rotation", "opacity", "gain_db", "pan")
# Every numeric parameter of an effect kind has a keyframe channel (the contract's bounds name them all).
EFFECT_CHANNELS: Mapping[str, tuple[str, ...]] = {kind: tuple(bounds) for kind, bounds in EFFECT_BOUNDS.items()}
MASK_CHANNELS = ("x", "y", "width", "height", "feather")
# Transitions that move or uncover the pictures: where they go, how the movement eases, how soft a wipe's edge is.
EDGE_DIRECTIONS = ("left", "right", "up", "down")
ZOOM_DIRECTIONS = ("in", "out")
TRANSITION_EASINGS = ("linear", "ease_in", "ease_out", "ease_in_out")
TRANSITION_DIRECTIONS: Mapping[str, tuple[str, ...]] = {
    "push": EDGE_DIRECTIONS,
    "slide": EDGE_DIRECTIONS,
    "whip": EDGE_DIRECTIONS,
    "wipe": EDGE_DIRECTIONS,
    "zoom": ZOOM_DIRECTIONS,
}
WIPE_SOFTNESS_MAX = 0.5
DEFAULT_TRACKS = (
    ("video-1", "video", "V1"),
    ("video-2", "video", "V2"),
    ("audio-1", "audio", "A1"),
    ("audio-2", "audio", "A2"),
)


def default_motion() -> Doc:
    return {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1, "gain_db": 0, "pan": 0, "keyframes": {}}


def new_track(track_id: str, kind: str, name: str) -> Doc:
    return {
        "track_id": track_id,
        "kind": kind,
        "name": name,
        "locked": False,
        "muted": False,
        "solo": False,
        "sync_lock": True,
        "gain_db": 0,
        "pan": 0,
    }


def empty_timeline(fps: Mapping[str, Any]) -> Doc:
    """A timeline with the four default tracks and nothing on them."""
    return {
        "version": 2,
        "fps": {"num": fps["num"], "den": fps["den"]},
        "sources": [],
        "tracks": [new_track(track_id, kind, name) for track_id, kind, name in DEFAULT_TRACKS],
        "clips": [],
        "captions": [],
        "markers": [],
        "master_gain_db": 0,
        "placed_shot_ids": [],
    }


def clip_end(clip: Mapping[str, Any]) -> int:
    return int(clip["start_frame"]) + clip_duration(clip)


def to_processing_frame(clip: Mapping[str, Any], local_frame: int) -> int:
    return clip_output_window(clip)[0] + local_frame


def timeline_duration(timeline: Mapping[str, Any]) -> int:
    ends = [clip_end(clip) for clip in timeline["clips"]]
    ends += [int(caption["end_frame"]) for caption in timeline["captions"]]
    return max(ends, default=0)


def retimed_frames(frames: int, speed_percent: int = 100) -> int:
    """Frames of a trimmed range after retiming: max(1, floor(frames x 100 / speed))."""
    return 0 if frames <= 0 else max(1, frames * 100 // speed_percent)


def clip_source_frame(effects: Mapping[str, Any] | None, source_frames: int, processed_frame: int) -> int:
    """The trimmed-source frame a processed frame shows (holds repeat an end, frame_step repeats a drawing)."""
    fx = effects or {}
    speed = int(fx.get("speed_percent", 100))
    local = max(
        0, min(retimed_frames(source_frames, speed) - 1, processed_frame - int((fx.get("hold") or {}).get("start", 0)))
    )
    step = int(fx.get("frame_step", 1))
    return local // step * step * speed // 100


def source_frame_at(clip: Mapping[str, Any], timeline_frame: int) -> int:
    """The source frame (sequence rate) a clip shows at a sequence frame inside it."""
    processed = to_processing_frame(clip, timeline_frame - int(clip["start_frame"]))
    return int(clip["in_frame"]) + clip_source_frame(
        clip.get("effects"), int(clip["out_frame"]) - int(clip["in_frame"]), processed
    )


def track_clips(timeline: Mapping[str, Any], track_id: str) -> list[Doc]:
    """The clips of one track by start; equal starts keep document order."""
    return sorted(
        (clip for clip in timeline["clips"] if clip["track_id"] == track_id), key=lambda clip: clip["start_frame"]
    )


def select_clips(timeline: Mapping[str, Any], ids: Iterable[str], linked: bool = True) -> list[Doc]:
    """The named clips and, with ``linked``, every clip that shares a link with one of them (document order)."""
    selected = set(ids)
    links = {clip["linked_id"] for clip in timeline["clips"] if clip["clip_id"] in selected and clip.get("linked_id")}
    return [
        clip
        for clip in timeline["clips"]
        if clip["clip_id"] in selected or (linked and clip.get("linked_id") is not None and clip["linked_id"] in links)
    ]


def active_transition(effects: Mapping[str, Any] | None) -> Doc | None:
    """The outgoing transition that applies; a cut or a missing one is None."""
    transition = (effects or {}).get("transition_out")
    return transition if transition and transition.get("kind") != "cut" else None


def transition_frames(clip: Mapping[str, Any]) -> int:
    transition = active_transition(clip.get("effects"))
    return int(transition["frames"]) if transition else 0


def transition_value(kind: str, frames: int, hints: Mapping[str, Any] | None = None) -> Doc:
    """A complete ``transition_out`` of ``kind`` (not cut) and ``frames``.

    A kind that moves the pictures takes its direction, easing and (a wipe) softness from ``hints`` where a hint is one
    of its values, so a push changed into a slide keeps its direction; otherwise it goes left (a zoom: in). A missing
    easing means ease-in-out and a missing softness 0.05, as the contract reads them.
    """
    value: Doc = {"kind": kind, "frames": frames}
    directions = TRANSITION_DIRECTIONS.get(kind)
    if directions is None:
        return value
    given = hints or {}
    value["direction"] = given["direction"] if given.get("direction") in directions else directions[0]
    if given.get("easing") in TRANSITION_EASINGS:
        value["easing"] = given["easing"]
    softness = given.get("softness")
    if (
        kind == "wipe"
        and isinstance(softness, int | float)
        and not isinstance(softness, bool)
        and 0 <= softness <= WIPE_SOFTNESS_MAX
    ):
        value["softness"] = softness
    return value


def find_track(timeline: Mapping[str, Any], track_id: str) -> Doc | None:
    return next((track for track in timeline["tracks"] if track["track_id"] == track_id), None)


def find_source(timeline: Mapping[str, Any], source_id: str) -> Doc | None:
    return next((source for source in timeline["sources"] if source["source_id"] == source_id), None)


def first_track(timeline: Mapping[str, Any], kind: str) -> Doc | None:
    return next((track for track in timeline["tracks"] if track["kind"] == kind), None)


def is_adjustment(timeline: Mapping[str, Any], clip: Mapping[str, Any]) -> bool:
    """The clip is an adjustment layer: it changes the composite of the tracks below it and has no picture of its own."""
    source = find_source(timeline, clip["source_id"])
    return source is not None and source["kind"] == "adjustment"


def track_shows(timeline: Mapping[str, Any], track_id: str, start: int, end: int) -> bool:
    """A clip of the track lies in [start, end) (a switched-off clip too: it keeps its place)."""
    return any(
        clip["track_id"] == track_id and clip["start_frame"] < end and clip_end(clip) > start
        for clip in timeline["clips"]
    )


def track_free(timeline: Mapping[str, Any], track: Mapping[str, Any], start: int, end: int) -> bool:
    """The track is unlocked and shows nothing in [start, end)."""
    return not track["locked"] and not track_shows(timeline, track["track_id"], start, end)


def tracks_end(timeline: Mapping[str, Any], track_ids: Sequence[str]) -> int:
    """The end of the last clip on the given tracks (0 when they are empty)."""
    wanted = set(track_ids)
    return max((clip_end(clip) for clip in timeline["clips"] if clip["track_id"] in wanted), default=0)


def used_ids(timeline: Mapping[str, Any]) -> set[str]:
    """Every identifier a new object must not repeat (clips, links, tracks, sources, captions, markers)."""
    ids = {clip["clip_id"] for clip in timeline["clips"]}
    ids |= {clip["linked_id"] for clip in timeline["clips"] if clip.get("linked_id")}
    ids |= {track["track_id"] for track in timeline["tracks"]}
    ids |= {source["source_id"] for source in timeline["sources"]}
    ids |= {caption["caption_id"] for caption in timeline["captions"]}
    ids |= {marker["marker_id"] for marker in timeline["markers"]}
    return ids


__all__ = [
    "DEFAULT_TRACKS",
    "EDGE_DIRECTIONS",
    "EFFECT_CHANNELS",
    "MASK_CHANNELS",
    "MOTION_CHANNELS",
    "TRANSITION_DIRECTIONS",
    "TRANSITION_EASINGS",
    "WIPE_SOFTNESS_MAX",
    "ZOOM_DIRECTIONS",
    "AllocateId",
    "Doc",
    "active_transition",
    "clip_duration",
    "clip_end",
    "clip_output_window",
    "clip_source_frame",
    "default_motion",
    "empty_timeline",
    "find_source",
    "find_track",
    "first_track",
    "is_adjustment",
    "new_track",
    "processed_clip_duration",
    "retimed_frames",
    "select_clips",
    "source_frame_at",
    "timeline_duration",
    "to_processing_frame",
    "track_clips",
    "track_free",
    "track_shows",
    "tracks_end",
    "transition_frames",
    "transition_value",
    "used_ids",
]
