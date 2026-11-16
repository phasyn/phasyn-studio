"""Facts about shots that every client derives from the timeline the same way.

The film order of shots is the order of clips on the first video track, and the shot a ``previous_last``
continuity continues from is the one shown just before it there. ``contracts/examples/timeline-derived`` holds the
vectors for both; the browser runs them against its own helpers.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

from ..timeline import clip_enabled
from .model import Doc, clip_end, first_track, source_frame_at, track_clips
from .shots import H3_FPS, rate


def _shot_of(timeline: Mapping[str, Any]) -> dict[str, str]:
    """source_id -> shot_id for the sources that show a shot."""
    return {source["source_id"]: source["shot_id"] for source in timeline["sources"] if source.get("shot_id")}


def film_order(shot_ids: Sequence[str], timeline: Mapping[str, Any]) -> Doc:
    """The shots in film order, then the shots with no clip.

    ``placed`` is ordered by each shot's first clip on the first video track (a shot that only sits on other tracks
    by its first clip there; equal starts keep the order of ``shot_ids``). ``unplaced`` keeps the order of
    ``shot_ids``.
    """
    main = first_track(timeline, "video")
    shots = _shot_of(timeline)
    ordered = sorted(timeline["clips"], key=lambda clip: clip["start_frame"])
    starts: dict[str, int] = {}
    for prefer_main in (True, False):
        for clip in ordered:
            shot_id = shots.get(clip["source_id"])
            on_main = main is not None and clip["track_id"] == main["track_id"]
            if shot_id is not None and shot_id not in starts and (on_main or not prefer_main):
                starts[shot_id] = int(clip["start_frame"])
    placed = sorted((shot_id for shot_id in shot_ids if shot_id in starts), key=lambda shot_id: starts[shot_id])
    return {"placed": placed, "unplaced": [shot_id for shot_id in shot_ids if shot_id not in starts]}


def previous_shot(shot_ids: Sequence[str], timeline: Mapping[str, Any], shot_id: str) -> Doc:
    """The shot a ``previous_last`` continuity of ``shot_id`` continues from.

    It is the shot of the nearest earlier enabled clip on the first video track, counted from the shot's first clip
    there; clips of the shot itself, of media that is no shot and of shots that left the project do not count.
    ``last_source_frame`` is the last source frame that clip shows (in frames of the timeline's rate).
    Without one, ``reason`` says why: ``not_placed`` (the shot has no clip on the first video track) or ``first``.
    """
    main = first_track(timeline, "video")
    clips = track_clips(timeline, main["track_id"]) if main is not None else []
    shots = _shot_of(timeline)
    known = set(shot_ids)
    index = next((i for i, clip in enumerate(clips) if shots.get(clip["source_id"]) == shot_id), None)
    if index is None:
        return {"shot_id": None, "reason": "not_placed"}
    for clip in reversed(clips[:index]):
        other = shots.get(clip["source_id"])
        if other is None or other == shot_id or other not in known or not clip_enabled(clip):
            continue
        return {
            "shot_id": other,
            "clip_id": clip["clip_id"],
            "last_source_frame": source_frame_at(clip, clip_end(clip) - 1),
        }
    return {"shot_id": None, "reason": "first"}


def continuity_frame(
    last_source_frame: int, fps: Mapping[str, Any], take: Mapping[str, Any] | None, planned_frames: int
) -> int | None:
    """The frame of the previous shot's take to continue from, in the take's own frames.

    None means its last decodable frame (the clip shows the take to its end). ``take`` None is a take that is
    rendered in the same run, judged by the shot's planned frame count.
    """
    asset = take.get("asset") if take is not None and take["state"] == "succeeded" else None
    total = max(1, (asset["frame_count"] if asset else 0) or (take["frames"] if take else 0) or planned_frames)
    asset_fps = asset.get("fps") if asset else None
    take_rate = rate(asset_fps) if asset_fps else float(H3_FPS)
    index = math.floor((last_source_frame * take_rate * int(fps["den"])) / int(fps["num"]))
    return max(0, index) if index < total - 1 else None


__all__ = ["continuity_frame", "film_order", "previous_shot"]
