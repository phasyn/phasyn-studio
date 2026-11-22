"""The edits of the timeline (the Python twin of the editor's ``commands.ts``), each on the edit's own draft.

Semantics follow the browser core: linked clips move together, a ripple moves every sync-locked track with its
markers and captions, a locked track refuses, and a transition is an overlap that belongs to its two clips, placed
on their cut with what they lend beyond it (:mod:`.handles`).
:func:`run_edit` is the transaction around one edit: copy, edit, restore transitions, validate.
"""

from __future__ import annotations

import copy
from collections.abc import Callable, Collection, Mapping, Sequence
from typing import Any

from ..errors import ComponentError
from ..timeline import ADJUSTMENT_TRANSITION, validate_timeline
from ..timeline_limits import (
    MAX_CAPTIONS,
    MAX_CLIPS,
    MAX_MARKERS,
    MAX_SEQUENCE_FRAMES,
    MAX_SOURCES,
    MAX_TRACKS,
    MAX_TRANSITION_FRAMES,
)
from .core import (
    RightLinks,
    adjacent,
    clear_range,
    next_clip,
    open_gap,
    previous_clip,
    reconcile_transitions,
    replace,
    required_clip,
    resize_for_edit,
    restore_pair,
    ripple_tracks,
    selection,
    shifted_metadata,
    split_at,
    transition_neighbours,
    transition_pairs,
    unlocked,
)
from .handles import (
    DEFAULT_ALIGNMENT,
    cut_frame,
    cut_of,
    extend_head,
    extend_tail,
    restore_cut,
    split_at_cut,
    without_transition_out,
)
from .model import (
    AllocateId,
    Doc,
    active_transition,
    clip_duration,
    clip_end,
    find_source,
    find_track,
    is_adjustment,
    new_track,
    processed_clip_duration,
    transition_value,
)
from .rejection import reject, rejection_of
from .timing import change_clip_timing, materialize_clip_window


Edit = Callable[[Doc, dict[str, str]], None]
COUNT_LIMITS = (
    ("tracks", MAX_TRACKS),
    ("clips", MAX_CLIPS),
    ("sources", MAX_SOURCES),
    ("captions", MAX_CAPTIONS),
    ("markers", MAX_MARKERS),
)
PHASE_EFFECTS = ("fade", "impact")
SHAKE_FIELDS = ("shake_px", "shake_frames")


def clip_ids_of(clips: Sequence[Mapping[str, Any]]) -> list[str]:
    """Return the identifiers of the selected clips."""
    return [str(clip["clip_id"]) for clip in clips]


def split(
    timeline: Doc,
    clip_ids: Sequence[str],
    frame: int,
    linked: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
    allocate: AllocateId,
) -> list[str]:
    """Add an edit at ``frame`` in the named clips (and in the linked partners the frame crosses); the new tails."""
    selected = selection(timeline, clip_ids, linked=linked)
    requested = set(clip_ids)
    links = RightLinks(allocate)
    right: set[str] = set()
    output: list[Doc] = []
    created: list[str] = []
    for clip in selected:
        offset = frame - clip["start_frame"]
        if offset <= 0 or offset >= clip_duration(clip):
            if clip["clip_id"] in requested:
                reject(
                    "out_of_range",
                    "分割點必須位於所有選取片段的內部",
                    clip_id=clip["clip_id"],
                )
            if offset <= 0:
                right.add(clip["clip_id"])
            output.append(clip)
            continue
        head, tail = split_at(timeline, clip, frame, allocate)
        link = links.of(clip)
        if link:
            tail["linked_id"] = link
        output.extend((head, tail))
        created.append(tail["clip_id"])
    selected_ids = set(clip_ids_of(selected))
    kept = [clip for clip in timeline["clips"] if clip["clip_id"] not in selected_ids]
    timeline["clips"] = [
        *kept,
        *(
            links.relinked(clip) if clip["clip_id"] in right else clip
            for clip in output
        ),
    ]
    return created


def place(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    timeline: Doc,
    clips: Sequence[Mapping[str, Any]],
    at: int,
    duration: int,
    mode: str,
    allocate: AllocateId,
    origins: dict[str, str],
) -> None:
    """Put ``clips`` (starts relative to 0, inside ``duration``) at ``at``.

    ``insert`` opens the range on every sync-locked track; ``overwrite`` clears it on the tracks of the clips.
    """
    if at < 0 or duration <= 0 or not clips:
        reject("out_of_range", "插入範圍無效")
    targets = {clip["track_id"] for clip in clips}
    for clip in clips:
        unlocked(timeline, clip["track_id"])
        if clip["start_frame"] < 0 or clip_end(clip) > duration:
            reject("out_of_range", "插入片段必須位於指定範圍內")
    if mode == "overwrite":
        clear_range(timeline, targets, at, at + duration, allocate, origins)
    else:
        open_gap(timeline, ripple_tracks(timeline, targets), at, duration, allocate)
    timeline["clips"].extend(
        {**copy.deepcopy(dict(clip)), "start_frame": clip["start_frame"] + at}
        for clip in clips
    )


def _merged_spans(clips: Sequence[Mapping[str, Any]]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for clip in sorted(clips, key=lambda item: item["start_frame"]):
        if spans and clip["start_frame"] <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], clip_end(clip)))
        else:
            spans.append((clip["start_frame"], clip_end(clip)))
    return spans


def _without_interval(
    spans: Sequence[tuple[int, int]], start: int, end: int
) -> list[tuple[int, int]]:
    remaining: list[tuple[int, int]] = []
    for low, high in spans:
        if start >= high or end <= low:
            remaining.append((low, high))
            continue
        if low < start:
            remaining.append((low, start))
        if end < high:
            remaining.append((end, high))
    return remaining


def freed_ranges(
    timeline: Mapping[str, Any],
    removed: Sequence[Mapping[str, Any]],
    tracks: Collection[str],
    neighbours: Collection[str],
) -> list[tuple[int, int]]:
    """The time a ripple delete closes: the removed clips' spans minus what a surviving transition neighbour owns."""
    spans = _merged_spans(removed)
    for clip in timeline["clips"]:
        if clip["track_id"] in tracks and clip["clip_id"] in neighbours:
            spans = _without_interval(spans, clip["start_frame"], clip_end(clip))
    return spans


def close_ranges(
    timeline: Doc,
    tracks: Collection[str],
    ranges: Sequence[tuple[int, int]],
    allocate: AllocateId | None = None,
    origins: dict[str, str] | None = None,
) -> None:
    """Shift what follows each freed range back over it (latest range first); markers and captions follow.

    As in Premiere, a sync-locked track that still has picture or sound in a freed range gives that span up (it is
    extracted there, the clip cut around it) so that the tracks stay in sync. Without ``allocate`` such a clip refuses
    instead (``sync_lock_conflict``).
    """
    for start, end in reversed(ranges):
        if allocate is not None:
            clear_range(
                timeline,
                tracks,
                start,
                end,
                allocate,
                origins if origins is not None else {},
            )
        for clip in timeline["clips"]:
            if (
                clip["track_id"] in tracks
                and clip["start_frame"] < end
                and clip_end(clip) > start
            ):
                reject(
                    "sync_lock_conflict",
                    "同步鎖定軌道在刪除範圍內仍有片段；請一併選取或關閉同步鎖定",
                    clip_id=clip["clip_id"],
                )
        timeline["clips"] = [
            {**clip, "start_frame": clip["start_frame"] - (end - start)}
            if clip["track_id"] in tracks and clip["start_frame"] >= end
            else clip
            for clip in timeline["clips"]
        ]
        shifted_metadata(timeline, start, end, insert=False)


def remove(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    timeline: Doc,
    clip_ids: Sequence[str],
    ripple: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
    linked: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
    allocate: AllocateId | None = None,
    origins: dict[str, str] | None = None,
) -> list[str]:
    """Delete clips; with ``ripple`` the freed time closes on every sync-locked track.

    With ``allocate``, a sync-locked track's own clips inside the freed time are extracted there (Premiere); without
    it they refuse.

    A clip that stays gives back what it lent a transition with a recorded cut into or out of a deleted clip: it ends
    (or starts) at the cut again, and a ripple closes only the time from the cut on.
    """
    selected = selection(timeline, clip_ids, linked=linked)
    ids = set(clip_ids_of(selected))
    incoming, outgoing = transition_neighbours(timeline, ids)
    for pair in transition_pairs(timeline):
        if pair.transition.get("cut") is not None and (pair.left_id in ids) != (
            pair.right_id in ids
        ):
            restore_pair(
                timeline,
                pair,
                left=pair.left_id not in ids,
                right=pair.right_id not in ids,
            )
    timeline["clips"] = [
        clip for clip in timeline["clips"] if clip["clip_id"] not in ids
    ]
    if ripple:
        tracks = ripple_tracks(timeline, {clip["track_id"] for clip in selected})
        # A surviving transition neighbour still owns its complete source interval. Close only time
        # freed by this deletion, rather than removing its overlapping picture or sound.
        freed = freed_ranges(timeline, selected, tracks, incoming | outgoing)
        close_ranges(timeline, tracks, freed, allocate, origins)
    return clip_ids_of(selected)


def ripple_trim(  # noqa: PLR0913 - Keep the published positional and keyword API.
    timeline: Doc,
    selected: Sequence[Mapping[str, Any]],
    resized: Sequence[Mapping[str, Any]],
    edge: str,
    delta: int,
    *,
    keep_spanning: bool = False,
) -> None:
    """Commit a rippled trim: the trimmed clips keep their start and everything after the edit point follows.

    A clip of another sync-locked track that lies across the edit point refuses the trim. ``keep_spanning`` leaves
    a clip that began before the edit where it is instead (a music bed, a title over several clips), as an editor's
    ripple does; only a clip that starts inside removed frames still refuses.
    """
    primary = selected[0]
    boundary = primary["start_frame"] if edge == "in" else clip_end(primary)
    if any(
        (clip["start_frame"] if edge == "in" else clip_end(clip)) != boundary
        for clip in selected
    ):
        reject("linked_mismatch", "連結片段的編輯點不同；請取消連結選取後修剪")
    change = -delta if edge == "in" else delta
    ids = set(clip_ids_of(selected))
    tracks = ripple_tracks(timeline, {clip["track_id"] for clip in selected})
    incoming, outgoing = transition_neighbours(timeline, ids)
    removal_start = boundary if edge == "in" else boundary + change
    removal_end = removal_start - change
    pivot = boundary if change >= 0 else removal_end
    low, high = (pivot, pivot) if change >= 0 else (removal_start, removal_end)
    for clip in timeline["clips"]:
        if (
            clip["clip_id"] in ids
            or clip["track_id"] not in tracks
            or clip["clip_id"] in incoming | outgoing
        ):
            continue
        if keep_spanning and clip["start_frame"] < low:
            continue
        if clip["start_frame"] < high and clip_end(clip) > low:
            reject(
                "sync_lock_conflict",
                "同步鎖定軌道的片段跨越修剪點；請先分割或關閉同步鎖定",
                clip_id=clip["clip_id"],
            )
    replace(
        timeline,
        [
            {**clip, "start_frame": clip["start_frame"] - delta}
            if edge == "in"
            else clip
            for clip in resized
        ],
    )

    def follows(clip: Mapping[str, Any]) -> bool:
        if clip["clip_id"] in ids or clip["track_id"] not in tracks:
            return False
        return clip["clip_id"] in outgoing or (
            clip["clip_id"] not in incoming and clip["start_frame"] >= pivot
        )

    timeline["clips"] = [
        {**clip, "start_frame": clip["start_frame"] + change} if follows(clip) else clip
        for clip in timeline["clips"]
    ]
    if change > 0:
        shifted_metadata(timeline, boundary, boundary + change, insert=True)
    else:
        shifted_metadata(timeline, removal_start, removal_end, insert=False)


def trim(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    timeline: Doc,
    clip_id: str,
    edge: str,
    delta: int,
    ripple: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
    linked: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
) -> list[str]:
    """Move one edge of a clip (and of its linked partners) by ``delta`` frames; ``ripple`` moves what follows."""
    selected = selection(timeline, [clip_id], linked=linked)
    primary = required_clip(timeline, clip_id)
    ordered = [primary, *(clip for clip in selected if clip["clip_id"] != clip_id)]
    resized = [resize_for_edit(clip, edge, delta) for clip in selected]
    if ripple:
        ripple_trim(timeline, ordered, resized, edge, delta)
    else:
        replace(timeline, resized)
    return clip_ids_of(selected)


def roll(
    timeline: Doc,
    left_id: str,
    right_id: str,
    delta: int,
    linked: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
) -> list[str]:
    """Move the cut between two adjacent clips: one grows by what the other gives up."""
    left = required_clip(timeline, left_id)
    right = required_clip(timeline, right_id)
    if not adjacent(left, right):
        reject("not_adjacent", "滾動編輯需要同軌且緊鄰的兩個片段")
    heads = selection(timeline, [left_id], linked=linked)
    tails = selection(timeline, [right_id], linked=linked)
    tail_ids = set(clip_ids_of(tails))
    if any(clip["clip_id"] in tail_ids for clip in heads):
        reject("linked_mismatch", "兩側片段不可屬於同一連結群組")
    if any(not any(adjacent(head, tail) for tail in tails) for head in heads):
        reject("linked_mismatch", "所有連結軌道都必須有相鄰的編輯點")
    if len(heads) != len(tails):
        reject("linked_mismatch", "兩側連結軌道數不同；請取消連結選取後修剪")
    resized = [resize_for_edit(clip, "out", delta) for clip in heads]
    resized += [resize_for_edit(clip, "in", delta) for clip in tails]
    replace(timeline, resized)
    return clip_ids_of(resized)


def slide(timeline: Doc, clip_id: str, delta: int, linked: bool) -> list[str]:  # noqa: FBT001 - Keep the published positional and keyword API.
    """A slide keeps the selected source and duration; only its two neighbours' edges move."""
    selected = selection(timeline, [clip_id], linked=linked)
    selected_ids = set(clip_ids_of(selected))
    roles: dict[str, tuple[Doc, str]] = {}

    def add(clip: Doc, role: str) -> None:
        known = roles.get(clip["clip_id"])
        if known and known[1] != role:
            reject("linked_mismatch", "連結片段的內滑範圍互相重疊")
        roles[clip["clip_id"]] = (clip, role)

    for clip in selected:
        left, right = previous_clip(timeline, clip), next_clip(timeline, clip)
        if (
            left is None
            or right is None
            or not adjacent(left, clip)
            or not adjacent(clip, right)
        ):
            reject("not_adjacent", "內滑工具需要片段兩側都有相鄰片段")
        if left["clip_id"] in selected_ids or right["clip_id"] in selected_ids:
            reject("linked_mismatch", "內滑時請只選取中央片段及其連結片段")
        add(clip, "move")
        for neighbour in selection(timeline, [left["clip_id"]], linked=linked):
            add(neighbour, "out")
        for neighbour in selection(timeline, [right["clip_id"]], linked=linked):
            add(neighbour, "in")
    updates = [
        {**clip, "start_frame": clip["start_frame"] + delta}
        if role == "move"
        else resize_for_edit(clip, role, delta)
        for clip, role in roles.values()
    ]
    replace(timeline, updates)
    return clip_ids_of(selected)


def _cut_between(left: Mapping[str, Any], right: Mapping[str, Any]) -> int:
    """Where the cut between a clip and the next one is: inside the transition between them, else where they meet."""
    current = active_transition(left.get("effects"))
    return cut_frame(right, current) if current else clip_end(left)


def _window_as_before(before: Mapping[str, Any], after: Doc) -> Doc:
    """A clip that had no output window and shows its whole clock again keeps none (a transition made before cuts were recorded is restored by trimming)."""
    window = after.get("output_window")
    if before.get("output_window") is not None or window is None:
        return after
    if window["start_frame"] != 0 or window["end_frame"] != processed_clip_duration(
        after
    ):
        return after
    return {key: value for key, value in after.items() if key != "output_window"}


def transition(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    timeline: Doc,
    clip_id: str,
    kind: str,
    frames: int,
    linked: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
    options: Mapping[str, Any] | None = None,
    alignment: str | None = None,
) -> list[str]:
    """Set or clear the transition on the cut after a clip, as Premiere places one (see :mod:`.handles`).

    The transition sits on the cut by its ``alignment`` and the two clips cover it with their own frames beyond the
    cut; only those two clips (and their linked partners) change, nothing else moves and the sequence keeps its
    length. A change starts again from the cut, and ``cut`` gives both clips back as they were there. ``options``
    (direction, easing, softness) override what the clip's current transition has; a kind keeps those of them it can
    have (``transition_value``). ``alignment`` None keeps the current one (a new transition is centred).
    """
    left = required_clip(timeline, clip_id)
    selected = selection(timeline, [clip_id], linked=linked)
    current = active_transition(left.get("effects"))
    new_frames = 0 if kind == "cut" else frames
    hints = {**(current or {}), **(options or {})}
    if (
        new_frames < 0
        or new_frames > MAX_TRANSITION_FRAMES
        or (kind != "cut" and new_frames < 1)
    ):
        reject("invalid_command", "轉場長度必須介於 1\N{EN DASH}240 影格")
    placement = alignment or (
        cut_of(current)["alignment"] if current else DEFAULT_ALIGNMENT
    )
    primary = next_clip(timeline, left)
    at = (
        _cut_between(left, primary)
        if primary is not None and adjacent(left, primary)
        else None
    )
    ids = set(clip_ids_of(selected))
    updates: list[Doc] = []
    for clip in selected:
        following = next_clip(timeline, clip)
        if (
            at is None
            or following is None
            or not adjacent(clip, following)
            or _cut_between(clip, following) != at
        ):
            reject(
                "not_adjacent",
                "轉場需要各連結軌道都有對齊的相鄰片段",
                clip_id=clip["clip_id"],
            )
        if following["clip_id"] in ids:
            reject(
                "linked_mismatch",
                "兩側片段不可屬於同一連結群組",
                clip_id=clip["clip_id"],
            )
        # An adjustment layer has no picture of its own to dissolve: its effect fades with its fades or its opacity
        if kind != "cut" and (
            is_adjustment(timeline, clip) or is_adjustment(timeline, following)
        ):
            reject("adjustment_layer", ADJUSTMENT_TRANSITION, clip_id=clip["clip_id"])
        existing = active_transition(clip.get("effects"))
        following_source = find_source(timeline, following["source_id"])
        if existing:
            restored_left, restored_right = restore_cut(
                clip, following, existing, following_source
            )
        else:
            restored_left, restored_right = (
                without_transition_out(clip),
                dict(following),
            )
        if kind == "cut":
            updates += [
                _window_as_before(clip, restored_left),
                _window_as_before(following, restored_right),
            ]
            continue
        if new_frames > min(
            clip_duration(restored_left), clip_duration(restored_right)
        ):
            reject(
                "transition_too_long",
                "轉場長度不得超過兩側片段長度",
                clip_id=clip["clip_id"],
            )
        before, after = split_at_cut(new_frames, placement)
        extended, outgoing = extend_tail(
            restored_left, after, find_source(timeline, clip["source_id"])
        )
        started, incoming = extend_head(restored_right, before, following_source)
        value = transition_value(kind, new_frames, hints)
        value["cut"] = {
            "alignment": placement,
            "outgoing": outgoing,
            "incoming": incoming,
        }
        extended["effects"] = {
            **(extended.get("effects") or {}),
            "transition_out": value,
        }
        updates += [
            _window_as_before(clip, extended),
            _window_as_before(following, started),
        ]
    replace(timeline, updates)
    return clip_ids_of(selected)


def slip(timeline: Doc, clip_id: str, delta: int, linked: bool) -> list[str]:  # noqa: FBT001 - Keep the published positional and keyword API.
    """Shift the source range under a clip; the window survives when the complete range still fits the source."""
    selected = selection(timeline, [clip_id], linked=linked)
    slipped: list[Doc] = []
    for clip in selected:
        source = find_source(timeline, clip["source_id"])
        length = int(source["duration_frames"]) if source else 0
        fits = clip["in_frame"] + delta >= 0 and clip["out_frame"] + delta <= length
        base = dict(clip) if fits else materialize_clip_window(clip)
        slipped.append(
            {
                **base,
                "in_frame": base["in_frame"] + delta,
                "out_frame": base["out_frame"] + delta,
            }
        )
    replace(timeline, slipped)
    return clip_ids_of(selected)


def _kind_tracks(timeline: Mapping[str, Any], kind: str) -> list[str]:
    return [
        str(track["track_id"]) for track in timeline["tracks"] if track["kind"] == kind
    ]


def _destinations(
    timeline: Mapping[str, Any],
    selected: Sequence[Mapping[str, Any]],
    primary: Mapping[str, Any],
    track_id: str,
    delta: int,
) -> list[Doc]:
    """The selected clips at their new start and track: all move by the same frames and the same track step."""
    target = unlocked(timeline, track_id)
    origin = unlocked(timeline, primary["track_id"])
    if target["kind"] != origin["kind"]:
        reject("track_kind", "只能移至相同種類的軌道")
    peers = _kind_tracks(timeline, origin["kind"])
    step = peers.index(target["track_id"]) - peers.index(origin["track_id"])
    moved: list[Doc] = []
    for clip in selected:
        home = unlocked(timeline, clip["track_id"])
        tracks = _kind_tracks(timeline, home["kind"])
        index = tracks.index(home["track_id"]) + step
        if not 0 <= index < len(tracks):
            reject("track_not_found", "整組移動超出可用的同類軌道")
        unlocked(timeline, tracks[index])
        if clip["start_frame"] + delta < 0:
            reject("out_of_range", "片段不能移到序列起點之前")
        moved.append(
            {
                **clip,
                "start_frame": clip["start_frame"] + delta,
                "track_id": tracks[index],
            }
        )
    return moved


def move(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    timeline: Doc,
    clip_ids: Sequence[str],
    start_frame: int,
    track_id: str,
    mode: str,
    linked: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
    allocate: AllocateId,
    origins: dict[str, str],
) -> list[str]:
    """Move a selection so that its first clip starts at ``start_frame`` on ``track_id``.

    The clips leave a gap behind. At the destination ``overwrite`` clears what they land on and ``insert`` opens
    room for the whole block on every sync-locked track.
    """
    primary = required_clip(timeline, clip_ids[0])
    selected = selection(timeline, clip_ids, linked=linked)
    moved = _destinations(
        timeline, selected, primary, track_id, start_frame - primary["start_frame"]
    )
    ids = set(clip_ids_of(selected))
    if mode == "insert":
        block_start = min(clip["start_frame"] for clip in moved)
        block_end = max(clip_end(clip) for clip in moved)
        tracks = ripple_tracks(timeline, {clip["track_id"] for clip in moved})
        open_gap(
            timeline, tracks, block_start, block_end - block_start, allocate, skip=ids
        )
    else:
        partners = _kept_partners(timeline, moved)
        # One set of new link ids for the whole move: the picture and the sound of a pair cut on two tracks stay a pair
        links = RightLinks(allocate)
        for clip in moved:
            keep = ids | partners.get(clip["clip_id"], set())
            span = (clip["start_frame"], clip_end(clip))
            clear_range(
                timeline,
                {clip["track_id"]},
                *span,
                allocate,
                origins,
                skip=keep,
                links=links,
            )
    replace(timeline, moved)
    return clip_ids_of(moved)


def _kept_partners(
    timeline: Mapping[str, Any], moved: Sequence[Mapping[str, Any]]
) -> dict[str, set[str]]:
    """For each moved clip, the staying clips it keeps a transition with after the move.

    A transition is an overlap of its two clips. When one of them moves and they still overlap as a transition
    can (same track, same order, at most the shorter clip), the overlap is the transition's new length and must
    not be cleared as occupied space.
    """
    moved_by_id = {clip["clip_id"]: clip for clip in moved}
    kept: dict[str, set[str]] = {}
    for pair in transition_pairs(timeline):
        left_moved, right_moved = (
            pair.left_id in moved_by_id,
            pair.right_id in moved_by_id,
        )
        if left_moved == right_moved:
            continue
        left = moved_by_id.get(pair.left_id) or required_clip(timeline, pair.left_id)
        right = moved_by_id.get(pair.right_id) or required_clip(timeline, pair.right_id)
        overlap = clip_end(left) - right["start_frame"]
        if (
            left["track_id"] == right["track_id"]
            and left["start_frame"] < right["start_frame"]
            and 1 <= overlap <= min(clip_duration(left), clip_duration(right))
        ):
            moved_id, partner_id = (
                (pair.left_id, pair.right_id)
                if left_moved
                else (pair.right_id, pair.left_id)
            )
            kept.setdefault(moved_id, set()).add(partner_id)
    return kept


def _timing_flags(
    updated: Mapping[str, Any], clip: Mapping[str, Any]
) -> tuple[bool, bool, bool, bool]:
    """(speed, hold start, hold end, any sampled phase) changed between a clip and its patched version."""
    new, old = updated.get("effects") or {}, clip.get("effects") or {}
    speed = new.get("speed_percent", 100) != old.get("speed_percent", 100)
    hold_start = (new.get("hold") or {}).get("start", 0) != (old.get("hold") or {}).get(
        "start", 0
    )
    hold_end = (new.get("hold") or {}).get("end", 0) != (old.get("hold") or {}).get(
        "end", 0
    )
    phase = speed or hold_start or hold_end
    phase = phase or any(
        new.get(name) != old.get(name) or (name in new) != (name in old)
        for name in PHASE_EFFECTS
    )
    phase = phase or new.get("frame_step", 1) != old.get("frame_step", 1)
    new_camera, old_camera = new.get("camera") or {}, old.get("camera") or {}
    return (
        speed,
        hold_start,
        hold_end,
        phase
        or any(new_camera.get(n, 0) != old_camera.get(n, 0) for n in SHAKE_FIELDS),
    )


def _peer_effects(
    item: Mapping[str, Any],
    wanted: Mapping[str, Any],
    *,
    speed: bool,
    hold_start: bool,
    hold_end: bool,
) -> Doc:
    """A linked partner's effects with only the speed or hold edge that changed on the edited clip."""
    effects = dict(item.get("effects") or {})
    if speed and "speed_percent" in wanted:
        effects["speed_percent"] = wanted["speed_percent"]
    elif speed:
        effects.pop("speed_percent", None)
    if hold_start:
        effects["hold"] = {
            **(effects.get("hold") or {}),
            "start": (wanted.get("hold") or {}).get("start", 0),
        }
    if hold_end:
        effects["hold"] = {
            **(effects.get("hold") or {}),
            "end": (wanted.get("hold") or {}).get("end", 0),
        }
    return effects


def patch_clip(
    timeline: Doc,
    clip_id: str,
    patch: Mapping[str, Any],
    linked: bool,  # noqa: FBT001 - Keep the published positional and keyword API.
) -> list[str]:
    """Replace clip properties (None removes one). A speed or hold change also retimes the linked partners."""
    clip = required_clip(timeline, clip_id)
    peers = selection(timeline, [clip_id], linked=linked)
    # A patch value of None removes the field (a clip has no field that may be null).
    updated: Doc = {
        key: value
        for key, value in {**clip, **copy.deepcopy(dict(patch))}.items()
        if value is not None
    }
    speed, hold_start, hold_end, phase = _timing_flags(updated, clip)
    timing = speed or hold_start or hold_end
    wanted = updated.get("effects") or {}
    result: list[Doc] = []
    for item in peers:
        primary = item["clip_id"] == clip_id
        if not phase:
            result.append(updated if primary else item)
        elif primary:
            # The other patched fields apply as they are; the effects go through the retiming of what the clip shows.
            base = {key: value for key, value in updated.items() if key != "effects"}
            if "effects" in item:
                base["effects"] = item["effects"]
            result.append(
                {
                    **change_clip_timing(base, updated.get("effects")),
                    "name": updated["name"],
                }
            )
        elif timing:
            result.append(
                change_clip_timing(
                    item,
                    _peer_effects(
                        item,
                        wanted,
                        speed=speed,
                        hold_start=hold_start,
                        hold_end=hold_end,
                    ),
                )
            )
        else:
            result.append(item)
    replace(timeline, result)
    return clip_ids_of(result)


def patch_track(timeline: Doc, track_id: str, patch: Mapping[str, Any]) -> None:
    """Apply changes to a timeline track."""
    if find_track(timeline, track_id) is None:
        reject("track_not_found", "找不到選取的軌道", track_id=track_id)
    timeline["tracks"] = [
        {**track, **patch} if track["track_id"] == track_id else track
        for track in timeline["tracks"]
    ]


def add_track(timeline: Doc, kind: str, name: str, allocate: AllocateId) -> str:
    """Add a track to the timeline."""
    track = new_track(allocate("track"), kind, name)
    timeline["tracks"].append(track)
    return str(track["track_id"])


def remove_track(timeline: Doc, track_id: str) -> None:
    """Remove a timeline track."""
    unlocked(timeline, track_id)
    if any(clip["track_id"] == track_id for clip in timeline["clips"]):
        reject("track_not_empty", "軌道仍有片段；請先移動或移除片段", track_id=track_id)
    timeline["tracks"] = [
        track for track in timeline["tracks"] if track["track_id"] != track_id
    ]


def _normalize_generated_layers(timeline: Doc) -> None:
    """A text or an adjustment layer has no source to trim: its range restarts at 0 (and a text covers the clip)."""
    kinds = {source["source_id"]: source["kind"] for source in timeline["sources"]}
    clips: list[Doc] = []
    for clip in timeline["clips"]:
        kind = kinds.get(clip["source_id"])
        title = (clip.get("effects") or {}).get("title")
        if kind != "adjustment" and (kind != "text" or not title):
            clips.append(clip)
            continue
        restarted = {
            **clip,
            "in_frame": 0,
            "out_frame": clip["out_frame"] - clip["in_frame"],
        }
        if kind == "text" and title:
            restarted["effects"] = {
                **clip["effects"],
                "title": {**title, "start_frame": 0, "end_frame": None},
            }
        clips.append(restarted)
    timeline["clips"] = clips


def check_limits(timeline: Mapping[str, Any]) -> None:
    """Enforce the timeline size limits."""
    for name, limit in COUNT_LIMITS:
        if len(timeline[name]) > limit:
            reject("limit_exceeded", "時間軸項目數超過上限", field=name, limit=limit)


def check_frames(timeline: Mapping[str, Any]) -> None:
    """Frames an edit pushed out of range, refused with their reason before the schema refuses them without one."""
    for clip in timeline["clips"]:
        if clip["in_frame"] < 0 or clip["out_frame"] <= clip["in_frame"]:
            reject(
                "source_range", "片段入出點超出原始素材範圍", clip_id=clip["clip_id"]
            )
        if clip["start_frame"] < 0:
            reject("out_of_range", "片段不能移到序列起點之前", clip_id=clip["clip_id"])
    ends = [clip["start_frame"] for clip in timeline["clips"]]
    ends += [marker["frame"] for marker in timeline["markers"]]
    ends += [caption["end_frame"] for caption in timeline["captions"]]
    if any(frame > MAX_SEQUENCE_FRAMES for frame in ends):
        reject("limit_exceeded", "剪輯長度超過序列上限", max_frames=MAX_SEQUENCE_FRAMES)


def validated(timeline: Doc) -> Doc:
    """The timeline when it is a valid document; a typed rejection with the validator's reason otherwise."""
    check_limits(timeline)
    check_frames(timeline)
    try:
        validate_timeline(timeline)
    except ComponentError as error:
        raise rejection_of(error) from error
    return timeline


def run_edit(
    timeline: Mapping[str, Any], edit: Edit, *, reconcile: bool = False
) -> Doc:
    """One transactional edit of a valid timeline: a fully valid new document, or a rejection and nothing changed.

    ``reconcile`` returns transitions to the original pairs that still overlap after the edit moved or cut clips.
    """
    draft: Doc = copy.deepcopy(dict(timeline))
    origins: dict[str, str] = {}
    edit(draft, origins)
    if reconcile:
        reconcile_transitions(timeline, draft, origins)
    _normalize_generated_layers(draft)
    return validated(draft)


__all__ = [
    "Edit",
    "add_track",
    "check_frames",
    "check_limits",
    "clip_ids_of",
    "close_ranges",
    "freed_ranges",
    "move",
    "patch_clip",
    "patch_track",
    "place",
    "remove",
    "remove_track",
    "ripple_trim",
    "roll",
    "run_edit",
    "slide",
    "slip",
    "split",
    "transition",
    "trim",
    "validated",
]
