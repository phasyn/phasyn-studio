"""Sources follow their shot, and never shorten an edit by themselves.

A source with ``shot_id`` follows the shot: it is named after the shot (and so are its clips that were not renamed
in the editor), a placeholder (no media yet) is as long as the shot's planned length, and a source whose shot uses
another take is bound to it when the take covers every clip that was cut from the source.

A clip that shows the whole take with nothing timed against its length (no trim, retime, hold, fade, title,
animation, effect stack or mask) is not an edit: it follows the take's length, re-fitted as a ripple trim with its
linked partners (:func:`follows_take`). The re-fit only ever moves clips: when it is refused, or would cut a
caption or move a marker, nothing changes. Every other clip is an edit and never changes by itself: a take that is
too short for one changes nothing; the source keeps its media and names the take in ``pending_take_id`` until the
owner applies it (:func:`apply_pending`, the ``reconcile`` command), which ripple-trims the clips that reach beyond
the new media. A clip of another track that began before such an edit (a music bed, a title over several clips)
stays where it is. The editor's undo relies on the same rule: a restored step comes back with the binding it had.
"""

from __future__ import annotations

import copy
from collections.abc import Collection, Mapping, Sequence
from typing import Any

from .core import replace, required_clip, resize_for_edit, selection, without_transition
from .curves import curve_slice, map_clip_keyframes
from .edits import clip_ids_of, remove, ripple_trim, validated
from .legacy import fitted_fades
from .model import (
    Doc,
    clip_end,
    clip_output_window,
    find_source,
    processed_clip_duration,
    retimed_frames,
)
from .rejection import TimelineRejected, reject
from .shots import PROXY_FIELDS, bound_take, shot_name, shot_source


BOUND_FIELDS = ("file", "take_id", "duration_frames", "width", "height", "has_audio")


def _rebound(source: Mapping[str, Any], resolved: Mapping[str, Any]) -> Doc:
    """``source`` showing the media of ``resolved``. A proxy belongs to the media it was made from."""
    value = {
        key: item
        for key, item in source.items()
        if key not in PROXY_FIELDS and key != "pending_take_id"
    }
    value.update({key: resolved[key] for key in BOUND_FIELDS})
    return value


# Effects that are not timed against the clip's length: a clip that carries only these still shows "the whole take".
UNTIMED_EFFECTS = frozenset({"transition_out", "color", "mute", "volume_db"})
# Groups of frame counts: one whose counts are all 0 (or that is empty) changes nothing and is no edit either. The
# editor's panels can leave such a group behind when a value is set back.
FRAME_GROUPS = ("fade", "hold")


def _timed_effects(effects: Mapping[str, Any]) -> set[str]:
    """The effects of a clip that are timed against its length."""
    timed = set(effects) - UNTIMED_EFFECTS
    for name in FRAME_GROUPS:
        group = effects.get(name)
        if isinstance(group, Mapping) and not any(group.values()):
            timed.discard(name)
    return timed


def follows_take(clip: Mapping[str, Any], source: Mapping[str, Any]) -> bool:
    """A clip that shows the whole of ``source`` with nothing timed against its length: its length is the take's."""
    if (
        clip["source_id"] != source["source_id"]
        or clip.get("output_window") is not None
    ):
        return False
    if clip["in_frame"] != 0 or clip["out_frame"] != source["duration_frames"]:
        return False
    if (
        any((clip["motion"].get("keyframes") or {}).values())
        or clip.get("effect_stack")
        or clip.get("mask")
    ):
        return False
    return not _timed_effects(clip.get("effects") or {})


def _metadata_stays(timeline: Mapping[str, Any], old_end: int, new_end: int) -> bool:
    """Whether moving an edit point from ``old_end`` to ``new_end`` only shifts captions and markers.

    A ripple removes or cuts a caption that lies in removed frames, piles the markers of those frames up on the edit
    point and stretches a caption that lies across inserted frames. None of that may happen without the user's edit.
    """
    captions = timeline["captions"]
    if new_end >= old_end:
        return not any(
            caption["start_frame"] < old_end < caption["end_frame"]
            for caption in captions
        )
    if any(new_end < marker["frame"] < old_end for marker in timeline["markers"]):
        return False
    return not any(
        caption["start_frame"] < old_end and caption["end_frame"] > new_end
        for caption in captions
    )


def _refitted(
    timeline: Mapping[str, Any], source: Mapping[str, Any], frames: int
) -> Doc | None:
    """``timeline`` with the clips that show the whole of ``source`` re-fitted to ``frames``.

    Each is trimmed at its end with its linked partners as a ripple edit, so the clips after it keep their distance;
    a clip of another track that began before the edit (a music bed, a title over several clips) stays where it is.
    None when the edit is refused or would do more than that (a locked track, a clip that starts inside removed
    frames, a transition that no longer fits, a linked partner that carries an edit of its own, a caption or marker
    in the way): the caller then leaves the clips as they are.
    """
    draft: Doc = copy.deepcopy(dict(timeline))
    # The length changes with the media: a proxy of the old media goes, as it does when the source is bound
    draft["sources"] = [
        {key: value for key, value in item.items() if key not in PROXY_FIELDS}
        if item["source_id"] == source["source_id"]
        else item
        for item in draft["sources"]
    ]
    delta = frames - int(source["duration_frames"])
    done: set[str] = set()
    try:
        # Latest first: a ripple only moves what lies after it.
        for clip in sorted(
            (item for item in draft["clips"] if follows_take(item, source)),
            key=clip_end,
            reverse=True,
        ):
            if clip["clip_id"] in done:
                continue
            group = selection(draft, [clip["clip_id"]], linked=True)
            if any(not follows_take(member, source) for member in group):
                return None
            primary = required_clip(draft, clip["clip_id"])
            if not _metadata_stays(draft, clip_end(primary), clip_end(primary) + delta):
                return None
            ordered = [
                primary,
                *(member for member in group if member["clip_id"] != clip["clip_id"]),
            ]
            resized = [{**member, "out_frame": frames} for member in ordered]
            ripple_trim(draft, ordered, resized, "out", delta, keep_spanning=True)
            done.update(clip_ids_of(group))
        draft["sources"] = [
            {**item, "duration_frames": frames}
            if item["source_id"] == source["source_id"]
            else item
            for item in draft["sources"]
        ]
        return validated(draft)
    except TimelineRejected:
        return None


def _pin_cut_clips(
    timeline: Doc, source_id: str, clip_ids: Collection[str], frames: int
) -> None:
    """Keep clips that were cut from the source an edit when the new length happens to equal their out point.

    "Shows the whole take" is read from the clip, so such a clip would start to follow the next take. A visible
    range that names its whole length says that the length was chosen.
    """
    whole = {"source_id": source_id, "duration_frames": frames}
    timeline["clips"] = [
        {
            **clip,
            "output_window": {
                "start_frame": 0,
                "end_frame": processed_clip_duration(clip),
            },
        }
        if clip["clip_id"] in clip_ids and follows_take(clip, whole)
        else clip
        for clip in timeline["clips"]
    ]


def _follow(
    project: Mapping[str, Any], timeline: Doc, source_id: str, notes: list[str]
) -> None:
    """Bring one source of the draft ``timeline`` in line with its shot (see the module docstring)."""
    source = find_source(timeline, source_id)
    if source is None:
        return
    source.pop("pending_take_id", None)
    shot = next(
        (item for item in project["shots"] if item["shot_id"] == source.get("shot_id")),
        None,
    )
    if shot is None:
        return
    take = bound_take(shot)
    waiting = source["file"] is None and "take_id" not in source
    if take is None and not waiting:
        return
    if (
        take is not None
        and source["file"] is not None
        and source.get("take_id") == take["take_id"]
    ):
        return
    resolved = shot_source(project, shot, timeline["fps"])
    frames = int(resolved["duration_frames"])
    clips = [clip for clip in timeline["clips"] if clip["source_id"] == source_id]
    cut = {clip["clip_id"] for clip in clips if not follows_take(clip, source)}
    used = max(
        (int(clip["out_frame"]) for clip in clips if clip["clip_id"] in cut), default=0
    )
    fitted = (
        timeline
        if frames == source["duration_frames"]
        else _refitted(timeline, source, frames)
    )
    if take is None:
        # Waiting for media: as long as the plan when its clips can follow; otherwise the placeholder stays as it is
        if fitted is not None and frames >= used:
            _adopt(timeline, fitted)
            _pin_cut_clips(timeline, source_id, cut, frames)
        return
    if frames < used or (fitted is None and frames < source["duration_frames"]):
        source["pending_take_id"] = take["take_id"]
        return
    if fitted is None:
        if len(cut) < len(clips):
            notes.append(
                f"「{shot_name(shot)}」的新 take 比較長，但顯示整段的片段無法自動跟著變長"
                "（軌道鎖定，或有字幕、其他片段擋住）；片段維持原本的長度。"
            )
    else:
        _adopt(timeline, fitted)
    _pin_cut_clips(timeline, source_id, cut, frames)
    timeline["sources"] = [
        _rebound(item, resolved) if item["source_id"] == source_id else item
        for item in timeline["sources"]
    ]


def _adopt(timeline: Doc, fitted: Mapping[str, Any]) -> None:
    """Make the draft ``timeline`` the re-fitted document (the same object stays the caller's draft)."""
    if fitted is timeline:
        return
    timeline.clear()
    timeline.update(fitted)


def _follow_titles(project: Mapping[str, Any], timeline: Doc) -> None:
    """A shot renamed since its source was named: the source takes the new title, and so do the clips that still carry the old one (a clip renamed in the editor keeps its own name)."""
    titles = {shot["shot_id"]: shot["title"] for shot in project["shots"]}
    renamed: dict[str, tuple[str, str]] = {}
    for source in timeline["sources"]:
        title = titles.get(source.get("shot_id"))
        if title is not None and source["name"] != title:
            renamed[str(source["source_id"])] = (source["name"], title)
            source["name"] = title
    for clip in timeline["clips"]:
        names = renamed.get(str(clip["source_id"]))
        if names is not None and clip["name"] == names[0]:
            clip["name"] = names[1]


def bind_sources(project: Mapping[str, Any], timeline: Doc, notes: list[str]) -> None:
    """Bring every shot source of the draft ``timeline`` in line with its shot: its title, its planned length while it waits for media, its active take afterwards, with the clips that show the whole take following its length. What the owner should know and cannot see on the timeline is added to ``notes``."""
    _follow_titles(project, timeline)
    for source_id in [str(source["source_id"]) for source in timeline["sources"]]:
        _follow(project, timeline, source_id, notes)


def _cut_keys(clip: Mapping[str, Any], edge: int, resume: int) -> Doc:
    """The clip's curves with the clock frames [edge, resume) removed; later keys move up."""
    cut = resume - edge

    def transform(keys: list[Doc], fallback: float) -> list[Doc]:
        if all(key["frame"] <= edge for key in keys):
            return keys
        head = curve_slice(keys, 0, edge, fallback)
        return [
            *head,
            *(
                {**key, "frame": key["frame"] - cut}
                for key in keys
                if key["frame"] > resume
            ),
        ]

    return map_clip_keyframes(clip, transform)


def _cut_title(
    title: Mapping[str, Any], edge: int, resume: int, frames: int
) -> Doc | None:
    """A title on a clock of ``frames`` that lost the frames [edge, resume); None when it only showed on those."""

    def moved(frame: int) -> int:
        return frame if frame <= edge else max(edge, frame - (resume - edge))

    start = moved(title["start_frame"])
    end = None if title["end_frame"] is None else moved(title["end_frame"])
    if start >= (frames if end is None else end):
        return None
    return {**title, "start_frame": start, "end_frame": end}


def _fitted_effects(
    clip: Mapping[str, Any], edge: int, resume: int, frames: int
) -> Doc | None:
    """The clip's effects on the shortened clock of ``frames``."""
    if clip.get("effects") is None:
        return None
    effects = dict(clip["effects"])
    if effects.get("fade"):
        effects["fade"] = fitted_fades(str(clip["name"]), effects["fade"], frames, [])
    impact = effects.get("impact")
    if impact and impact["frames"] > frames:
        effects["impact"] = {**impact, "frames": frames}
    if effects.get("title"):
        title = _cut_title(effects["title"], edge, resume, frames)
        if title is None:
            del effects["title"]
        else:
            effects["title"] = title
    return effects


def shortened(clip: Mapping[str, Any], length: int) -> tuple[Doc | None, int]:
    """(the clip limited to the first ``length`` source frames, the visible frames it lost).

    What the clip still shows stays exactly what it showed; None when nothing of it is left.
    """
    effects = clip.get("effects") or {}
    lead = int((effects.get("hold") or {}).get("start", 0))
    speed = int(effects.get("speed_percent", 100))
    kept = length - int(clip["in_frame"])
    start, end = clip_output_window(clip)
    if kept <= 0:
        return None, end - start
    old_core = retimed_frames(int(clip["out_frame"]) - int(clip["in_frame"]), speed)
    new_core = retimed_frames(kept, speed)
    edge, resume = lead + new_core, lead + old_core
    if start >= edge:
        return None, end - start
    # A window that ended in the trailing hold keeps as many held frames as it showed.
    new_end = min(end, edge) if end <= resume else end - (resume - edge)
    value = _cut_keys(clip, edge, resume)
    value["out_frame"] = length
    value.pop("output_window", None)
    complete = processed_clip_duration(value)
    fitted = _fitted_effects(value, edge, resume, complete)
    if fitted is not None:
        value["effects"] = fitted
    if (start, new_end) != (0, complete):
        value["output_window"] = {"start_frame": start, "end_frame": new_end}
    return value, end - new_end


def pending_sources(
    timeline: Mapping[str, Any], source_id: str | None, shot_id: str | None
) -> list[Doc]:
    """The sources a ``reconcile`` names that wait for a shorter take."""
    if source_id is not None:
        source = find_source(timeline, source_id)
        if source is None:
            reject("source_not_found", "找不到指定的素材", source_id=source_id)
        named = [source]
    else:
        named = [
            source for source in timeline["sources"] if source.get("shot_id") == shot_id
        ]
    pending = [source for source in named if source.get("pending_take_id")]
    if not pending:
        reject("nothing_pending", "這個素材沒有等待套用的較短 take")
    return pending


def _trim_group(
    timeline: Doc, clip_id: str, source_id: str, length: int
) -> tuple[list[str], int]:
    """Cut one clip and its linked partners back to ``length`` source frames: (ids trimmed, clips removed)."""
    group = selection(timeline, [clip_id], linked=True)
    cuts = {
        member["clip_id"]: shortened(member, length)
        for member in group
        if member["source_id"] == source_id and member["out_frame"] > length
    }
    if any(value is None for value, _ in cuts.values()):
        remove(timeline, [clip_id], True, True)
        return [], len(group)
    lost = max(frames for _, frames in cuts.values())
    resized: list[Doc] = []
    for member in group:
        value, frames = cuts.get(member["clip_id"], (member, 0))
        if value is None:
            continue
        resized.append(
            resize_for_edit(value, "out", frames - lost)
            if frames != lost
            else without_transition(value)
        )
    if lost == 0:
        replace(timeline, resized)
    else:
        primary = required_clip(timeline, clip_id)
        ordered = [
            primary,
            *(member for member in group if member["clip_id"] != clip_id),
        ]
        ripple_trim(timeline, ordered, resized, "out", -lost, keep_spanning=True)
    return clip_ids_of(group), 0


def apply_pending(
    timeline: Doc, project: Mapping[str, Any], sources: Sequence[Mapping[str, Any]]
) -> tuple[list[str], int]:
    """Apply the pending take of each source to the draft ``timeline``: (ids of trimmed clips, clips removed).

    Clips that reach beyond the new media are ripple-trimmed to it (with their linked partners, and what follows on
    sync-locked tracks moves up); a clip with nothing left is ripple-deleted. Then the source is bound to the take.
    """
    trimmed: list[str] = []
    removed = 0
    for source in sources:
        shot = next(
            (
                item
                for item in project["shots"]
                if item["shot_id"] == source.get("shot_id")
            ),
            None,
        )
        take = bound_take(shot) if shot is not None else None
        if (
            shot is None
            or take is None
            or take["take_id"] != source.get("pending_take_id")
        ):
            reject(
                "nothing_pending",
                "使用中的 take 已經改變，請重新讀取專案後再套用",
                source_id=source["source_id"],
            )
        resolved = shot_source(project, shot, timeline["fps"])
        length = int(resolved["duration_frames"])
        affected = [
            clip
            for clip in timeline["clips"]
            if clip["source_id"] == source["source_id"] and clip["out_frame"] > length
        ]
        done: set[str] = set()
        # Latest first: a ripple only moves what lies after it.
        for clip in sorted(affected, key=clip_end, reverse=True):
            if clip["clip_id"] in done:
                continue
            members = clip_ids_of(selection(timeline, [clip["clip_id"]], linked=True))
            ids, gone = _trim_group(
                timeline, clip["clip_id"], source["source_id"], length
            )
            done.update(members)
            trimmed += ids
            removed += gone
        timeline["sources"] = [
            _rebound(item, resolved)
            if item["source_id"] == source["source_id"]
            else item
            for item in timeline["sources"]
        ]
    return trimmed, removed


__all__ = [
    "apply_pending",
    "bind_sources",
    "follows_take",
    "pending_sources",
    "shortened",
]
