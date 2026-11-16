"""Building blocks every edit shares: selection, locks, ripple tracks, transitions as overlap, links and metadata.

The Python twin of the helpers at the top of the editor's ``commands.ts``. Each function works on the edit's own
draft of the timeline (``timeline`` is mutated) and raises :class:`TimelineRejected` before it leaves it invalid.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .handles import cut_of, reconciled_cut, retract_head, retract_tail, without_transition_out
from .model import (
    AllocateId,
    Doc,
    active_transition,
    clip_duration,
    clip_end,
    find_source,
    find_track,
    select_clips,
    track_clips,
)
from .rejection import TimelineRejected, reject
from .slicing import resize_clip, slice_clip


@dataclass(frozen=True)
class TransitionPair:
    """A transition belongs to the two clips it joins, never to whichever clip happens to come next."""

    left_id: str
    right_id: str
    transition: Doc


def required_clip(timeline: Mapping[str, Any], clip_id: str) -> Doc:
    for clip in timeline["clips"]:
        if clip["clip_id"] == clip_id:
            return dict(clip)
    reject("clip_not_found", "找不到選取的片段", clip_id=clip_id)


def unlocked(timeline: Mapping[str, Any], track_id: str) -> Doc:
    track = find_track(timeline, track_id)
    if track is None:
        reject("track_not_found", "找不到選取的軌道", track_id=track_id)
    if track["locked"]:
        reject("track_locked", "軌道已鎖定；請先解鎖再編輯", track_id=track_id)
    return track


def selection(timeline: Mapping[str, Any], ids: Collection[str], linked: bool = True) -> list[Doc]:
    """The named clips with their linked partners, all on unlocked tracks (document order)."""
    if not ids:
        reject("invalid_command", "請先選取片段")
    for clip_id in ids:
        required_clip(timeline, clip_id)
    selected = select_clips(timeline, ids, linked)
    for clip in selected:
        unlocked(timeline, clip["track_id"])
    return selected


def replace(timeline: Doc, clips: Iterable[Mapping[str, Any]]) -> None:
    replacements = {clip["clip_id"]: dict(clip) for clip in clips}
    timeline["clips"] = [replacements.get(clip["clip_id"], clip) for clip in timeline["clips"]]


def ripple_tracks(timeline: Mapping[str, Any], targets: Collection[str]) -> set[str]:
    """The tracks a ripple moves: the edited ones (which must be unlocked) and every unlocked sync-locked track."""
    for track_id in targets:
        unlocked(timeline, track_id)
    return {
        track["track_id"]
        for track in timeline["tracks"]
        if track["track_id"] in targets or (track["sync_lock"] and not track["locked"])
    }


def previous_clip(timeline: Mapping[str, Any], clip: Mapping[str, Any], skip: Collection[str] = ()) -> Doc | None:
    """The clip before ``clip`` on its track; clips named in ``skip`` do not count."""
    ordered = [item for item in track_clips(timeline, clip["track_id"]) if item["clip_id"] not in skip]
    index = next((i for i, item in enumerate(ordered) if item["clip_id"] == clip["clip_id"]), 0)
    return ordered[index - 1] if index > 0 else None


def next_clip(timeline: Mapping[str, Any], clip: Mapping[str, Any]) -> Doc | None:
    ordered = track_clips(timeline, clip["track_id"])
    index = next((i for i, item in enumerate(ordered) if item["clip_id"] == clip["clip_id"]), len(ordered))
    return ordered[index + 1] if index + 1 < len(ordered) else None


def transition_pairs(timeline: Mapping[str, Any]) -> list[TransitionPair]:
    pairs: list[TransitionPair] = []
    for track in timeline["tracks"]:
        ordered = track_clips(timeline, track["track_id"])
        for index, clip in enumerate(ordered[:-1]):
            transition = active_transition(clip.get("effects"))
            if transition:
                pairs.append(TransitionPair(clip["clip_id"], ordered[index + 1]["clip_id"], transition))
    return pairs


def transition_neighbours(timeline: Mapping[str, Any], ids: Collection[str]) -> tuple[set[str], set[str]]:
    """Clips outside ``ids`` joined by a transition to a clip inside: (those before, those after)."""
    incoming: set[str] = set()
    outgoing: set[str] = set()
    for pair in transition_pairs(timeline):
        if pair.left_id in ids and pair.right_id not in ids:
            outgoing.add(pair.right_id)
        if pair.right_id in ids and pair.left_id not in ids:
            incoming.add(pair.left_id)
    return incoming, outgoing


def without_transition(clip: Mapping[str, Any]) -> Doc:
    if not active_transition(clip.get("effects")):
        return dict(clip)
    effects = dict(clip["effects"])
    del effects["transition_out"]
    return {**clip, "effects": effects}


def resize_for_edit(clip: Mapping[str, Any], edge: str, delta: int) -> Doc:
    """Resize the source geometry first; the original neighbours restore any surviving transition afterwards."""
    return resize_clip(without_transition(clip), edge, delta)


def _bare(clip: Mapping[str, Any]) -> Doc:
    """A clip without its outgoing transition and without an effects object that is left empty."""
    value = without_transition_out(clip)
    if value.get("effects") == {}:
        del value["effects"]
    return value


def _untouched(original: Mapping[str, Any], clip: Mapping[str, Any]) -> bool:
    """Whether an edit left a clip exactly as it was (its transition aside)."""
    before = next((item for item in original["clips"] if item["clip_id"] == clip["clip_id"]), None)
    return before is not None and _bare(before) == _bare(clip)


def restore_pair(timeline: Doc, pair: TransitionPair, *, left: bool, right: bool) -> None:
    """A transition with a recorded cut that an edit separates: the named clips go back to the cut and give back what
    they lent it, as the transition command leaves them (the outgoing clip also loses the transition). A clip that
    cannot (what it lent no longer fits it) keeps its frames, as an edit always did."""
    cut = cut_of(pair.transition)
    if left:
        try:
            outgoing = retract_tail(without_transition_out(required_clip(timeline, pair.left_id)), cut["outgoing"])
        except TimelineRejected:
            pass
        else:
            replace(timeline, [outgoing])
    if right:
        clip = required_clip(timeline, pair.right_id)
        try:
            incoming = retract_head(clip, cut["incoming"], find_source(timeline, clip["source_id"]))
        except TimelineRejected:
            pass
        else:
            replace(timeline, [incoming])


def _given_back(original: Mapping[str, Any], timeline: Mapping[str, Any], clip_id: str) -> bool:
    """Whether a clip of a separated pair gives back what it lent: it is still there, unlocked, as the edit found it."""
    clip = next((item for item in timeline["clips"] if item["clip_id"] == clip_id), None)
    track = find_track(timeline, clip["track_id"]) if clip is not None else None
    return clip is not None and track is not None and not track["locked"] and _untouched(original, clip)


def reconcile_transitions(original: Mapping[str, Any], timeline: Doc, origins: Mapping[str, str]) -> None:
    """Give every original pair that still overlaps its transition back (with the new overlap); drop the others.

    A recorded cut moves with the edge that moved (:func:`.handles.reconciled_cut`). When a pair with a recorded cut
    came apart, a clip the edit left as it was gives back what it lent the transition beyond the cut.
    """
    pairs = {pair.left_id: pair for pair in transition_pairs(original)}
    kept: set[str] = set()
    for track in timeline["tracks"]:
        ordered = track_clips(timeline, track["track_id"])
        for index, clip in enumerate(ordered):
            pair = pairs.get(origins.get(clip["clip_id"], clip["clip_id"]))
            if pair is None:
                continue
            following = ordered[index + 1] if index + 1 < len(ordered) else None
            updated = without_transition(clip)
            still_paired = (
                following is not None and origins.get(following["clip_id"], following["clip_id"]) == pair.right_id
            )
            overlap = clip_end(clip) - following["start_frame"] if following is not None and still_paired else 0
            if overlap > 0 and following is not None:
                kept.add(pair.left_id)
                # Geometry and source ranges stay untouched. Final validation rejects an invalid overlap.
                transition = {**pair.transition, "frames": overlap}
                if pair.transition.get("cut") is not None:
                    before = (required_clip(original, pair.left_id), required_clip(original, pair.right_id))
                    transition["cut"] = reconciled_cut(pair.transition["cut"], before, (clip, following))
                updated["effects"] = {**(updated.get("effects") or {}), "transition_out": transition}
            replace(timeline, [updated])
    for pair in pairs.values():
        if pair.left_id in kept or pair.transition.get("cut") is None:
            continue
        left, right = (_given_back(original, timeline, clip_id) for clip_id in (pair.left_id, pair.right_id))
        restore_pair(timeline, pair, left=left, right=right)


def shifted_metadata(timeline: Doc, start: int, end: int, insert: bool) -> None:
    """Markers and captions follow a ripple: [start, end) opens (``insert``) or closes."""
    amount = end - start

    def adjust(position: int) -> int:
        if insert:
            return position + amount if position >= start else position
        return position - amount if position >= end else min(position, start)

    timeline["markers"] = [{**marker, "frame": adjust(marker["frame"])} for marker in timeline["markers"]]
    captions = []
    for caption in timeline["captions"]:
        # An exclusive end at the insertion point stays: the caption ends where the new material begins.
        keeps_end = insert and caption["end_frame"] == start
        moved = {
            **caption,
            "start_frame": adjust(caption["start_frame"]),
            "end_frame": caption["end_frame"] if keeps_end else adjust(caption["end_frame"]),
        }
        if moved["end_frame"] > moved["start_frame"]:
            captions.append(moved)
    timeline["captions"] = captions


class RightLinks:
    """New link ids for the right-hand sides of cut link groups (one per group, allocated on first use)."""

    def __init__(self, allocate: AllocateId) -> None:
        self._allocate = allocate
        self._links: dict[str, str] = {}

    def of(self, clip: Mapping[str, Any]) -> str | None:
        """The link of the part of ``clip`` after a cut; None for an unlinked clip."""
        linked = clip.get("linked_id")
        if not linked:
            return None
        if linked not in self._links:
            self._links[linked] = self._allocate("link")
        return self._links[linked]

    def relinked(self, clip: Mapping[str, Any]) -> Doc:
        """A complete right-side member follows the new group even when another member supplied its id later."""
        link = self._links.get(clip.get("linked_id") or "")
        return {**clip, "linked_id": link} if link else dict(clip)

    def changes(self, clip: Mapping[str, Any]) -> bool:
        return bool(self._links.get(clip.get("linked_id") or ""))


def adjacent(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    """``right`` follows ``left`` on its track, at the cut or at the start of their transition."""
    transition = active_transition(left.get("effects"))
    cut = clip_end(left) - (int(transition["frames"]) if transition else 0)
    return left["track_id"] == right["track_id"] and cut == right["start_frame"]


def split_at(
    timeline: Mapping[str, Any], clip: Mapping[str, Any], frame: int, allocate: AllocateId, skip: Collection[str] = ()
) -> tuple[Doc, Doc]:
    """Cut ``clip`` at a sequence frame inside it: (head with the clip's id, tail with a new id)."""
    previous = previous_clip(timeline, clip, skip)
    if previous and active_transition(previous.get("effects")) and clip_end(previous) > frame:
        reject("transition_conflict", "請先移除切點上的轉場")
    offset = frame - clip["start_frame"]
    # A cut where the outgoing transition starts would leave a part wholly inside it, starting with the next clip
    outgoing = active_transition(clip.get("effects"))
    if outgoing and offset >= clip_duration(clip) - int(outgoing["frames"]):
        reject("transition_conflict", "請先移除切點上的轉場")
    head = slice_clip(clip, 0, offset, clip["clip_id"])
    tail = slice_clip(clip, offset, clip_duration(clip), allocate("clip"))
    return head, tail


def _edge_inside_transition(
    timeline: Mapping[str, Any], tracks: Collection[str], edges: Collection[int], skip: Collection[str]
) -> bool:
    """Whether one of ``edges`` falls strictly inside the overlap of a transition on ``tracks`` (clips in ``skip``,
    which the edit is about to move, do not count)."""
    clips = {clip["clip_id"]: clip for clip in timeline["clips"]}
    for pair in transition_pairs(timeline):
        left, right = clips[pair.left_id], clips[pair.right_id]
        if left["track_id"] not in tracks or pair.left_id in skip or pair.right_id in skip:
            continue
        if any(right["start_frame"] < edge < clip_end(left) for edge in edges):
            return True
    return False


def clear_range(
    timeline: Doc,
    tracks: Collection[str],
    start: int,
    end: int,
    allocate: AllocateId,
    origins: dict[str, str],
    skip: Collection[str] = (),
    links: RightLinks | None = None,
) -> None:
    """Empty [start, end) on ``tracks``: clips inside go, clips across an edge are cut back (overwrite, lift).

    A cut clip loses its transition here; :func:`reconcile_transitions` returns it to a pair that still overlaps.
    A range that begins or ends inside a transition's overlap is refused: cutting there would leave two shorter
    transitions and change frames outside the range. Clips named in ``skip`` are left alone (the clips an edit is
    about to move). ``links`` shares the new link ids of cut groups between the calls of one edit.
    """
    if _edge_inside_transition(timeline, tracks, (start, end), skip):
        reject("transition_conflict", "請先移除切點上的轉場")
    output: list[Doc] = []
    links = links if links is not None else RightLinks(allocate)
    right: set[str] = set()
    for clip in timeline["clips"]:
        if clip["clip_id"] in skip or clip["track_id"] not in tracks or clip_end(clip) <= start:
            output.append(clip)
            continue
        if clip["start_frame"] >= end:
            right.add(clip["clip_id"])
            output.append(clip)
            continue
        unlocked(timeline, clip["track_id"])
        source = without_transition(clip)
        keeps_head = clip["start_frame"] < start
        if keeps_head:
            output.append(slice_clip(source, 0, start - clip["start_frame"], clip["clip_id"]))
        if clip_end(clip) > end:
            tail_id = allocate("clip") if keeps_head else clip["clip_id"]
            tail = slice_clip(source, end - clip["start_frame"], clip_duration(clip), tail_id)
            link = links.of(clip)
            if link:
                tail["linked_id"] = link
            origins[tail["clip_id"]] = clip["clip_id"]
            output.append(tail)
    timeline["clips"] = [links.relinked(clip) if clip["clip_id"] in right else clip for clip in output]


def open_gap(
    timeline: Doc, tracks: Collection[str], at: int, amount: int, allocate: AllocateId, skip: Collection[str] = ()
) -> None:
    """Shift everything from ``at`` on by ``amount`` on ``tracks``; a clip across ``at`` is cut and its tail shifts.

    Markers and captions follow. Clips named in ``skip`` are left alone (the clips an edit is about to move).
    """
    output: list[Doc] = []
    links = RightLinks(allocate)
    right: set[str] = set()
    for clip in timeline["clips"]:
        if clip["clip_id"] in skip or clip["track_id"] not in tracks or clip_end(clip) <= at:
            output.append(clip)
        elif clip["start_frame"] >= at:
            right.add(clip["clip_id"])
            output.append({**clip, "start_frame": clip["start_frame"] + amount})
        else:
            head, tail = split_at(timeline, clip, at, allocate, skip)
            tail["start_frame"] += amount
            link = links.of(clip)
            if link:
                tail["linked_id"] = link
            output.extend((head, tail))
    timeline["clips"] = [links.relinked(clip) if clip["clip_id"] in right else clip for clip in output]
    shifted_metadata(timeline, at, at + amount, True)


__all__ = [
    "RightLinks",
    "TransitionPair",
    "adjacent",
    "clear_range",
    "next_clip",
    "open_gap",
    "previous_clip",
    "reconcile_transitions",
    "replace",
    "required_clip",
    "resize_for_edit",
    "restore_pair",
    "ripple_tracks",
    "selection",
    "shifted_metadata",
    "split_at",
    "transition_neighbours",
    "transition_pairs",
    "unlocked",
    "without_transition",
]
