"""Edits that change which clips there are and the order they play in: the rearrange edit, join through edits and
the enabled flag.

``rearrange`` is the twin of the editor's command of that name: only the tracks the moved clips are on re-flow, so
nothing is overwritten and other tracks, markers and captions stay where they are. ``join`` is the inverse of a
split. Both work on the edit's own draft like the edits in :mod:`.edits`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..timeline import clip_enabled
from .core import (
    TransitionPair,
    next_clip,
    replace,
    required_clip,
    restore_pair,
    selection,
    transition_pairs,
    without_transition,
)
from .curves import clip_curves
from .edits import clip_ids_of
from .model import (
    Doc,
    active_transition,
    clip_duration,
    clip_end,
    clip_output_window,
    processed_clip_duration,
    select_clips,
    track_clips,
)
from .rejection import TimelineRejected, reject
from .timing import FADE_EDGES, materialize_clip_window

NOT_JOINABLE = "兩個片段不是同一素材的連續範圍，或屬性不同，無法接合"


@dataclass
class _Flow:
    """A clip in the order of its track and the frames between the previous clip's end and its start."""

    clip: Doc
    lead: int


def _reflow(ordered: Sequence[Doc], moving: set[str], anchor_id: str | None, side: str) -> list[_Flow]:
    """One track after a rearrange: the block leaves, later clips close up, the block lands at the anchor."""
    items = [
        _Flow(clip, clip["start_frame"] - (clip_end(ordered[index - 1]) if index else 0))
        for index, clip in enumerate(ordered)
    ]
    rest: list[_Flow] = []
    block: list[_Flow] = []
    freed = 0
    lifted = False
    for index, item in enumerate(items):
        if item.clip["clip_id"] in moving:
            # Clips that travel together keep their distance; a clip joining the block from elsewhere is packed.
            together = index > 0 and items[index - 1].clip["clip_id"] in moving
            block.append(_Flow(item.clip, item.lead if together else 0))
            if not together:
                freed += max(0, item.lead)
            lifted = True
        else:
            # The gaps on both sides of a lifted clip merge; a transition into or out of it goes with it.
            rest.append(_Flow(item.clip, max(0, item.lead) + freed if lifted else item.lead))
            freed = 0
            lifted = False
    if not block:
        return rest
    if anchor_id is None:
        at = len(rest)
    else:
        found = next((index for index, item in enumerate(rest) if item.clip["clip_id"] == anchor_id), None)
        if found is None:
            reject("linked_mismatch", "連結軌道上找不到對應的目標片段；請取消連結選取後再調整順序")
        at = found + 1 if side == "after" else found
    following = rest[at] if at < len(rest) else None
    if following is not None and side == "before" and anchor_id is not None:
        # The block takes the anchor's place and the anchor follows it directly.
        block[0].lead = max(0, following.lead)
        following.lead = 0
    else:
        block[0].lead = 0
        if following is not None:
            following.lead = max(0, following.lead)
    return [*rest[:at], *block, *rest[at:]]


def _placed(flow: Sequence[_Flow], pairs: Mapping[str, TransitionPair]) -> tuple[list[Doc], list[TransitionPair]]:
    """The clips of one re-flowed track at their new starts, and the transitions whose clips came apart.

    A transition stays with its two clips while they stay neighbours in the same order (with its overlap) and
    goes when they are separated.
    """
    placed: list[Doc] = []
    apart: list[TransitionPair] = []
    cursor = 0
    overlap = 0
    for index, item in enumerate(flow):
        start = cursor - overlap if overlap else cursor + item.lead
        following = flow[index + 1].clip["clip_id"] if index + 1 < len(flow) else None
        pair = pairs.get(item.clip["clip_id"])
        kept = pair is not None and following == pair.right_id
        if pair is not None and not kept:
            apart.append(pair)
        placed.append({**(item.clip if kept else without_transition(item.clip)), "start_frame": start})
        cursor = start + clip_duration(item.clip)
        overlap = int(pair.transition["frames"]) if pair is not None and kept else 0
    return placed, apart


def rearrange(timeline: Doc, clip_ids: Sequence[str], target_id: str | None, side: str, linked: bool) -> list[str]:
    """Lift clips of one track (with their linked partners) and insert them before or after another clip of it.

    ``target_id`` None puts the block at the end of the track. Linked clips must stay aligned or the edit is
    refused.
    """
    if not clip_ids:
        reject("invalid_command", "請先選取片段")
    requested = [required_clip(timeline, clip_id) for clip_id in clip_ids]
    track_id = requested[0]["track_id"]
    if any(clip["track_id"] != track_id for clip in requested):
        reject("invalid_command", "調整順序的片段必須在同一軌道")
    group = selection(timeline, clip_ids, linked)
    moving = set(clip_ids_of(group))
    target = None if target_id is None else required_clip(timeline, target_id)
    if target is not None and (target["track_id"] != track_id or target["clip_id"] in moving):
        reject("invalid_command", "目標片段必須是同一軌道上的其他片段")
    anchors = select_clips(timeline, [target["clip_id"]], linked) if target is not None else []
    tracks = list(dict.fromkeys(clip["track_id"] for clip in group))

    def flowed() -> tuple[list[Doc], list[TransitionPair]]:
        pairs = {pair.left_id: pair for pair in transition_pairs(timeline)}
        updated: list[Doc] = []
        separated: list[TransitionPair] = []
        for track_id in tracks:
            anchor = None
            if target is not None:
                anchor = next((clip["clip_id"] for clip in anchors if clip["track_id"] == track_id), None)
                if anchor is None:
                    reject("linked_mismatch", "連結軌道上找不到對應的目標片段；請取消連結選取後再調整順序")
            placed, apart = _placed(_reflow(track_clips(timeline, track_id), moving, anchor, side), pairs)
            updated += placed
            separated += apart
        return updated, [pair for pair in separated if pair.transition.get("cut") is not None]

    updated, separated = flowed()
    if separated:
        # Transitions with a recorded cut that the new order separates go first: their clips are back at the cut,
        # so the clips that close up meet where the cuts are and the moved clips keep no borrowed frames.
        for pair in separated:
            restore_pair(timeline, pair, left=True, right=True)
        updated, _ = flowed()
    _require_aligned_links(timeline, updated, linked)
    replace(timeline, updated)
    return clip_ids_of(group)


def _require_aligned_links(timeline: Mapping[str, Any], updated: Sequence[Mapping[str, Any]], linked: bool) -> None:
    """Every clip of a link group must have moved by the same number of frames."""
    originals = {clip["clip_id"]: clip for clip in timeline["clips"]}
    shift: dict[str, int] = {}
    for clip in updated:
        link = clip.get("linked_id")
        if not link:
            continue
        delta = clip["start_frame"] - originals[clip["clip_id"]]["start_frame"]
        if shift.setdefault(link, delta) != delta:
            reject("linked_mismatch", "連結片段會錯開；請取消連結選取後再調整順序")
    if not linked:
        return
    reflowed = set(clip_ids_of(updated))
    for clip in timeline["clips"]:
        # A linked partner on a track that does not re-flow would be left behind.
        if clip.get("linked_id") and clip["clip_id"] not in reflowed and shift.get(clip["linked_id"], 0) != 0:
            reject("linked_mismatch", "連結片段會錯開；請取消連結選取後再調整順序")


def rearrange_target(
    timeline: Mapping[str, Any], clip_ids: Sequence[str], to_frame: int, linked: bool
) -> tuple[str | None, str]:
    """The (target clip, side) a sequence frame names for a rearrange of ``clip_ids``.

    The frame must be an edit point of the clips that stay on the track: the start of one (the block goes before
    it), the end of one (after it), or any frame from the end of the last one on (the end of the track).
    """
    if not clip_ids:
        reject("invalid_command", "請先選取片段")
    primary = required_clip(timeline, clip_ids[0])
    moving = set(clip_ids_of(select_clips(timeline, clip_ids, linked)))
    staying = [clip for clip in track_clips(timeline, primary["track_id"]) if clip["clip_id"] not in moving]
    for clip in staying:
        if clip["start_frame"] == to_frame:
            return str(clip["clip_id"]), "before"
    for clip in staying:
        if clip_end(clip) == to_frame:
            return str(clip["clip_id"]), "after"
    if to_frame >= max((clip_end(clip) for clip in staying), default=0):
        return None, "after"
    reject("not_edit_point", "目標位置必須是同軌其他片段的起點或終點", frame=to_frame)


def _properties(clip: Mapping[str, Any]) -> Doc:
    """What two clips must share to be one clip (everything but identity, place, range and transition)."""
    effects = dict(clip.get("effects") or {})
    effects.pop("transition_out", None)
    return {
        "source_id": clip["source_id"],
        "motion": clip["motion"],
        "effects": effects,
        "effect_stack": clip.get("effect_stack") or [],
        "mask": clip.get("mask"),
        "blend_mode": clip.get("blend_mode", "normal"),
        "enabled": clip_enabled(clip),
    }


def _anchored(clip: Mapping[str, Any]) -> bool:
    """The clip has something tied to its own clock (keys, holds, fades, impact, shake or a title)."""
    effects = clip.get("effects") or {}
    hold = effects.get("hold") or {}
    fade = effects.get("fade") or {}
    camera = effects.get("camera") or {}
    return bool(
        any(clip_curves(clip))
        or hold.get("start")
        or hold.get("end")
        or any(fade.get(edge) for edge in FADE_EDGES)
        or effects.get("impact")
        or effects.get("title")
        or (camera.get("shake_px") and camera.get("shake_frames"))
    )


def _with_transition_of(joined: Doc, tail: Mapping[str, Any]) -> Doc:
    """``joined`` leaving into the next clip the way ``tail`` did."""
    transition = active_transition(tail.get("effects"))
    if transition is None:
        return joined
    return {**joined, "effects": {**(joined.get("effects") or {}), "transition_out": dict(transition)}}


def _joined_windows(head: Mapping[str, Any], tail: Mapping[str, Any]) -> Doc | None:
    """Two parts of one clip (the same complete range, as a split leaves them) as that clip again."""
    if head["in_frame"] != tail["in_frame"] or head["out_frame"] != tail["out_frame"]:
        return None
    start, cut = clip_output_window(head)
    resumed, end = clip_output_window(tail)
    if cut != resumed:
        return None
    joined: Doc = {key: value for key, value in head.items() if key != "output_window"}
    if (start, end) != (0, processed_clip_duration(head)):
        joined["output_window"] = {"start_frame": start, "end_frame": end}
    return joined


def _joined_ranges(head: Mapping[str, Any], tail: Mapping[str, Any]) -> Doc | None:
    """Two clips showing consecutive source ranges as one clip; only when nothing is tied to either clip's clock."""
    try:
        first, second = materialize_clip_window(head), materialize_clip_window(tail)
    except TimelineRejected:
        return None
    if first["out_frame"] != second["in_frame"] or _anchored(first) or _anchored(second):
        return None
    effects = first.get("effects") or {}
    speed, step = int(effects.get("speed_percent", 100)), int(effects.get("frame_step", 1))
    frames = processed_clip_duration(first)
    # The second range must continue on the sampling grid the first one ends on.
    if frames * speed != (first["out_frame"] - first["in_frame"]) * 100 or frames % step:
        return None
    joined: Doc = {**first, "out_frame": second["out_frame"]}
    if processed_clip_duration(joined) != frames + processed_clip_duration(second):
        return None
    return joined


def _join_pair(head: Mapping[str, Any], tail: Mapping[str, Any]) -> Doc:
    if _properties(head) != _properties(tail):
        reject("not_joinable", NOT_JOINABLE, clip_id=head["clip_id"])
    joined = _joined_windows(head, tail) or _joined_ranges(head, tail)
    if joined is None:
        reject("not_joinable", NOT_JOINABLE, clip_id=head["clip_id"])
    return _with_transition_of(joined, tail)


def join(timeline: Doc, clip_id: str, linked: bool) -> list[str]:
    """Join Through Edits: remove the edit between a clip and the next clip of its track (and of its partners')."""
    required_clip(timeline, clip_id)
    heads = selection(timeline, [clip_id], linked)
    pairs: list[tuple[Doc, Doc]] = []
    for head in heads:
        tail = next_clip(timeline, head)
        if tail is None or active_transition(head.get("effects")) or tail["start_frame"] != clip_end(head):
            reject("not_adjacent", "接合需要同軌且緊接在後的片段，兩者之間不能有空隙或轉場", clip_id=head["clip_id"])
        pairs.append((head, tail))
    tail_ids = {tail["clip_id"] for _, tail in pairs}
    if any(head["clip_id"] in tail_ids for head in heads):
        reject("linked_mismatch", "連結群組內的片段彼此相鄰；請取消連結選取後接合")
    if linked and set(clip_ids_of(select_clips(timeline, tail_ids, True))) != tail_ids:
        reject("linked_mismatch", "後段的連結片段不在各軌相鄰的位置；請取消連結選取後接合")
    joined = {head["clip_id"]: _join_pair(head, tail) for head, tail in pairs}
    timeline["clips"] = [
        joined.get(clip["clip_id"], clip) for clip in timeline["clips"] if clip["clip_id"] not in tail_ids
    ]
    return list(joined)


def set_enabled(timeline: Doc, clip_ids: Sequence[str], enabled: bool, linked: bool) -> list[str]:
    """Enable or disable clips (and their linked partners). A disabled clip keeps its place and is not rendered."""
    selected = selection(timeline, clip_ids, linked)
    updated: list[Doc] = []
    for clip in selected:
        value = {key: item for key, item in clip.items() if key != "enabled"}
        if not enabled:
            value["enabled"] = False
        updated.append(value)
    replace(timeline, updated)
    return clip_ids_of(selected)


__all__ = ["join", "rearrange", "rearrange_target", "set_enabled"]
