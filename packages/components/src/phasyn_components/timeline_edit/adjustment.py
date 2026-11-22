"""Adjustment layers (the Python twin of the editor's ``adjustmentLayer.ts``).

An adjustment layer is a clip of a generated ``adjustment`` source (no file, the sequence size, a nominal length of the
whole sequence). It has no picture of its own: the export and the Program monitor give it the composite of the video
tracks below it within its frames, run its colour, effect stack, mask, fades (as its coverage) and opacity on that and
blend the result back with its blend mode. What would need a picture, a clock or a sound of its own (motion, speed,
holds, transitions, audio) is refused by the validator (``phasyn_components.timeline``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..timeline_limits import MAX_SEQUENCE_FRAMES, MAX_TRACKS
from .model import (
    AllocateId,
    Doc,
    default_motion,
    find_track,
    new_track,
    track_free,
    track_shows,
)
from .rejection import reject
from .text import seconds_to_frames


ADJUSTMENT_NAME = "調整圖層"
ADJUSTMENT_SECONDS = 5


def layer_track(timeline: Mapping[str, Any], start: int, end: int) -> Doc | None:
    """The video track a new layer takes in [start, end): the lowest unlocked one above the first video track and above every video track that shows something there, so the layer lies over everything that plays under it. None when every such track is locked or there is none (the editor's ``freeLayerTrack``)."""
    video = [track for track in timeline["tracks"] if track["kind"] == "video"]
    shown = [
        index + 1
        for index, track in enumerate(video)
        if track_shows(timeline, track["track_id"], start, end)
    ]
    return next(
        (track for track in video[max([1, *shown]) :] if not track["locked"]), None
    )


def add_adjustment_layer(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    timeline: Doc,
    at: int,
    duration: int | None,
    track_id: str | None,
    name: str | None,
    size: tuple[int, int],
    allocate: AllocateId,
) -> str:
    """Add an adjustment source and its clip at ``at``; the id of the clip.

    ``duration`` None is five seconds, or what is left of the sequence. Without ``track_id`` the layer goes on
    :func:`layer_track`, else on a new video track at the top (the new identifiers in this order: ``track`` when a
    track is added, ``adjust`` for the source, ``clip``).
    """
    if at < 0 or at >= MAX_SEQUENCE_FRAMES:
        reject("out_of_range", "調整圖層起點超出時間軸範圍")
    if duration is None:
        frames = min(
            MAX_SEQUENCE_FRAMES - at,
            seconds_to_frames(ADJUSTMENT_SECONDS, timeline["fps"]),
        )
    else:
        frames = duration
    if frames < 1:
        reject("out_of_range", "調整圖層長度必須至少 1 影格")
    track = _adjust_track(timeline, at, frames, track_id, allocate)
    source_id = allocate("adjust")
    timeline["sources"].append(
        {
            "source_id": source_id,
            "name": ADJUSTMENT_NAME,
            "kind": "adjustment",
            "file": None,
            "width": size[0],
            "height": size[1],
            "duration_frames": MAX_SEQUENCE_FRAMES,
            "has_audio": False,
        }
    )
    clip_id = allocate("clip")
    timeline["clips"].append(
        {
            "clip_id": clip_id,
            "name": name or ADJUSTMENT_NAME,
            "source_id": source_id,
            "track_id": track["track_id"],
            "start_frame": at,
            "in_frame": 0,
            "out_frame": frames,
            "motion": default_motion(),
        }
    )
    return clip_id


def _adjust_track(
    timeline: Doc, at: int, frames: int, track_id: str | None, allocate: AllocateId
) -> Doc:
    if track_id is not None:
        track = find_track(timeline, track_id)
        if track is None:
            reject("track_not_found", "找不到選取的軌道", track_id=track_id)
        if track["kind"] != "video":
            reject("track_kind", "調整圖層只能放在影像軌", track_id=track_id)
        if track["locked"]:
            reject("track_locked", "軌道已鎖定；請先解鎖再編輯", track_id=track_id)
        if not track_free(timeline, track, at, at + frames):
            reject(
                "overlap",
                "指定軌道在這段時間已有片段；請選擇其他軌道或時間",
                track_id=track_id,
            )
    else:
        found = layer_track(timeline, at, at + frames)
        if found is None and len(timeline["tracks"]) >= MAX_TRACKS:
            reject(
                "limit_exceeded",
                "請先在未鎖定的影像軌保留調整圖層空間，或移除不用的軌道",
                limit=MAX_TRACKS,
            )
        if found is None:
            found = new_track(allocate("track"), "video", ADJUSTMENT_NAME)
            timeline["tracks"].append(found)
        track = found
    return track


__all__ = ["ADJUSTMENT_NAME", "add_adjustment_layer", "layer_track"]
