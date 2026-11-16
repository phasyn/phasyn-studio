"""``normalize_project``: the rules that keep a Studio project's timeline consistent with its shots and takes.

The timeline is the single edit state. Normalization runs on every read and before every save and is idempotent:

1. A project with shots and no timeline gets one, built from its enabled shots in order with their trims and
   effects (what the shot sequence showed before the timeline existed).
2. Every enabled shot that never had a place gets one after the last clip; ``placed_shot_ids`` remembers it, so a
   shot whose clips the user removed is not placed again.
3. Sources follow their shot: the planned length while they wait for media, the active take when it covers every
   clip that was cut from the source; clips that show the whole take follow its length, and a take that is too
   short for an edited clip waits in ``pending_take_id`` (:mod:`.binding`).
4. A shot's own trim and effects are reset: only clips carry edits. ``enabled`` mirrors "a clip shows this shot".

Nothing here deletes, moves or shortens a clip that carries an edit, a caption or a marker. What could not be
carried over exactly, or could not follow, is written down in ``timeline.migration_notes``.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from fractions import Fraction
from typing import Any

from ..timeline_limits import MAX_CLIPS, MAX_FPS, MAX_SOURCES, MAX_TRACKS, MIN_FPS
from .binding import bind_sources
from .legacy import (
    ORIGINAL_AUDIO_UNUSABLE,
    PlacedShot,
    bounded_notes,
    has_legacy_edit,
    lay_out,
    original_audio_clip,
    shot_clips,
)
from .model import Doc, empty_timeline, first_track, new_track, tracks_end, used_ids
from .shots import library_source, original_audio, shot_name, unique_id

TIMELINE_VERSION = 2


def representable(fps: Mapping[str, Any]) -> bool:
    """A frame rate a timeline can have."""
    return MIN_FPS <= Fraction(int(fps["num"]), int(fps["den"])) <= MAX_FPS


def shown_shot_ids(timeline: Mapping[str, Any]) -> set[str]:
    """The shots at least one clip shows."""
    shots = {source["source_id"]: source.get("shot_id") for source in timeline["sources"]}
    return {str(shots[clip["source_id"]]) for clip in timeline["clips"] if shots.get(clip["source_id"])}


def _main_tracks(timeline: Doc, taken: set[str]) -> tuple[str, str] | None:
    """The first video and the first audio track, added when missing; None when there is no room for them."""
    missing = [kind for kind in ("video", "audio") if first_track(timeline, kind) is None]
    if len(timeline["tracks"]) + len(missing) > MAX_TRACKS:
        return None
    for kind in missing:
        name = "V1" if kind == "video" else "A1"
        timeline["tracks"].append(new_track(unique_id(f"{kind}-1", taken), kind, name))
    video, audio = first_track(timeline, "video"), first_track(timeline, "audio")
    if video is None or audio is None:
        return None
    return str(video["track_id"]), str(audio["track_id"])


def _append(
    project: Mapping[str, Any],
    timeline: Doc,
    shots: Sequence[Mapping[str, Any]],
    tracks: tuple[str, str | None],
    start: int,
    reserve: int,
    notes: list[str],
) -> list[str]:
    """Put ``shots`` back to back from ``start`` on ``tracks``; the ids of the shots that got a place."""
    taken = used_ids(timeline)
    per_shot = 1 if tracks[1] is None else 2
    room = min(
        MAX_SOURCES - len(timeline["sources"]) - reserve, (MAX_CLIPS - len(timeline["clips"]) - reserve) // per_shot
    )
    items: list[PlacedShot] = []
    for shot in shots:
        if len(items) >= room:
            notes.append(f"時間軸的片段數已達上限，「{shot_name(shot)}」未放入時間軸。")
            continue
        known = next((source for source in timeline["sources"] if source.get("shot_id") == shot["shot_id"]), None)
        items.append(shot_clips(project, shot, timeline["fps"], tracks, taken, notes, known))
    placed = lay_out(items, timeline["fps"], start, notes)
    sources = {source["source_id"] for source in timeline["sources"]}
    for item in placed:
        if item.source["source_id"] not in sources:
            timeline["sources"].append(item.source)
        timeline["clips"].extend(item.clips)
    return [item.shot_id for item in placed]


def place_shots(
    project: Mapping[str, Any], timeline: Doc, shots: Sequence[Mapping[str, Any]], notes: list[str]
) -> list[str]:
    """Give ``shots`` their place after the last clip of the first video and audio tracks of the draft ``timeline``.

    Each shot becomes a video clip and its linked audio clip on a source bound to its active take (a placeholder
    until it has one). Returns the ids of the shots that were placed; a shot that does not fit stays out.
    """
    if not shots:
        return []
    tracks = _main_tracks(timeline, used_ids(timeline))
    if tracks is None:
        notes.append(f"時間軸的軌道數已達上限，{len(shots)} 個鏡頭未放入時間軸。")
        return []
    return _append(project, timeline, shots, tracks, tracks_end(timeline, tracks), 0, notes)


def _migrated(project: Mapping[str, Any], notes: list[str]) -> Doc:
    """The timeline of a project saved without one: its enabled shots in order, as the shot sequence showed them."""
    fps = project["format"]["fps"]
    timeline = empty_timeline(fps)
    swap = original_audio(project)
    if swap is not None:
        sound = library_source(swap[1], fps)
        if sound is None or not sound["has_audio"]:
            notes.append(ORIGINAL_AUDIO_UNUSABLE)
            swap = None
    enabled = [shot for shot in project["shots"] if shot["enabled"]]
    tracks = ("video-1", None if swap is not None else "audio-1")
    timeline["placed_shot_ids"] = _append(project, timeline, enabled, tracks, 0, 1 if swap is not None else 0, notes)
    if swap is not None:
        original = original_audio_clip(swap[0], swap[1], timeline, "audio-1", notes)
        if original is not None:
            timeline["sources"].append(original[0])
            timeline["clips"].append(original[1])
    return timeline


def _place_new_shots(project: Mapping[str, Any], timeline: Doc, notes: list[str]) -> list[str]:
    """List every shot a source names and place the enabled shots that never had a place; the ids placed now."""
    listed = list(dict.fromkeys(timeline.get("placed_shot_ids") or []))
    listed += [
        shot_id
        for shot_id in dict.fromkeys(source.get("shot_id") for source in timeline["sources"])
        if shot_id and shot_id not in listed
    ]
    waiting = [shot for shot in project["shots"] if shot["enabled"] and shot["shot_id"] not in listed]
    placed = place_shots(project, timeline, waiting, notes)
    timeline["placed_shot_ids"] = [*listed, *placed]
    return placed


def _reset_shots(
    project: Doc, timeline: Mapping[str, Any], carried: set[str], migrated: bool, notes: list[str]
) -> None:
    """Only clips carry edits: reset each shot's own trim and effects, and mirror ``enabled``."""
    shown = shown_shot_ids(timeline)
    dropped = [shot for shot in project["shots"] if has_legacy_edit(shot) and shot["shot_id"] not in carried]
    if migrated:
        notes += [f"「{shot_name(shot)}」不在時間軸上，它的裁切與效果設定沒有帶入時間軸。" for shot in dropped]
    elif dropped:
        notes.append(f"{len(dropped)} 個鏡頭帶有鏡頭層的裁切或效果設定；時間軸已是唯一的剪輯狀態，這些設定沒有套用。")
    for shot in project["shots"]:
        shot["in_frame"] = 0
        shot["out_frame"] = None
        shot.pop("effects", None)
        shot["enabled"] = shot["shot_id"] in shown


def normalize_project(document: Mapping[str, Any]) -> Doc:
    """A copy of a (schema-valid) Studio project with its timeline brought in line with its shots and takes.

    Idempotent, and the input is never modified. A project without shots, or with a frame rate a timeline cannot
    have, is returned as it is when it has no timeline.
    """
    project: Doc = copy.deepcopy(dict(document))
    timeline = project.get("timeline")
    migrated = timeline is None
    notes: list[str] = []
    if timeline is None:
        if not project["shots"] or not representable(project["format"]["fps"]):
            return project
        timeline = _migrated(project, notes)
        project["timeline"] = timeline
        carried = set(timeline["placed_shot_ids"])
    else:
        notes += timeline.get("migration_notes") or []
        carried = set(_place_new_shots(project, timeline, notes))
    bind_sources(project, timeline, notes)
    _reset_shots(project, timeline, carried, migrated, notes)
    known = {shot["shot_id"] for shot in project["shots"]}
    timeline["placed_shot_ids"] = [shot_id for shot_id in timeline["placed_shot_ids"] if shot_id in known]
    timeline["version"] = TIMELINE_VERSION
    timeline.pop("migration_notes", None)
    if notes:
        timeline["migration_notes"] = bounded_notes(notes)
    return project


__all__ = ["TIMELINE_VERSION", "normalize_project", "place_shots", "representable", "shown_shot_ids"]
