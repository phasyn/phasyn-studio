"""The cut a transition sits on (the Python twin of the editor's ``transitionCut.ts``).

A transition lies on the edit point between two clips the way Premiere places one: centred on the cut, starting at
it or ending at it (its alignment), covered by the two clips' own frames beyond the cut. The outgoing clip runs on
after the cut and the incoming clip starts before it, each first from its hidden output, then from the source beyond
its range, and where the media runs out by holding its edge frame (insufficient media). Nothing else moves: applying,
changing or removing a transition only lengthens or shortens the two clips at the cut, and what each clip lent is
recorded in the transition (``cut``, contract ``MediaClipTransitionCut``), so that removing it gives back exactly what
it took. A transition without ``cut`` (made before cuts were recorded) has its cut in the middle of its overlap.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from .curves import clip_curves, map_clip_keyframes
from .model import Doc, clip_end, clip_output_window, processed_clip_duration
from .rejection import reject

DEFAULT_ALIGNMENT = "center"
INEXACT = "這個切點無法保留變速片段的精確長度"


def split_at_cut(frames: int, alignment: str) -> tuple[int, int]:
    """(frames before the cut, frames after it). A centred transition of odd length has its extra frame after it."""
    before = 0 if alignment == "start" else frames if alignment == "end" else frames // 2
    return before, frames - before


def _side(frames: int, source: int = 0, freeze: int = 0) -> Doc:
    return {"frames": frames, "source": source, "freeze": freeze}


def cut_of(transition: Mapping[str, Any]) -> Doc:
    """The recorded cut of a transition, else the middle of its overlap, lent wholly from the clips' own frames."""
    recorded = transition.get("cut")
    if recorded is not None:
        return copy.deepcopy(dict(recorded))
    before, after = split_at_cut(int(transition["frames"]), DEFAULT_ALIGNMENT)
    return {"alignment": DEFAULT_ALIGNMENT, "outgoing": _side(after), "incoming": _side(before)}


def cut_frame(right: Mapping[str, Any], transition: Mapping[str, Any]) -> int:
    """The sequence frame of the cut between a clip with ``transition`` and ``right``, the clip it leads into."""
    return int(right["start_frame"]) + int(cut_of(transition)["incoming"]["frames"])


def _speed(clip: Mapping[str, Any]) -> int:
    return int((clip.get("effects") or {}).get("speed_percent", 100))


def _end_anchored(clip: Mapping[str, Any]) -> bool:
    """Effects tied to the end of a clip's clock: growing or shrinking the clock there moves them."""
    fade = (clip.get("effects") or {}).get("fade") or {}
    return bool(fade.get("video_out", 0) > 0 or fade.get("audio_out", 0) > 0)


def _start_anchored(clip: Mapping[str, Any]) -> bool:
    """Effects tied to its start: fades in, impact frames and a shake that begins on the first frame."""
    effects = clip.get("effects") or {}
    fade = effects.get("fade") or {}
    camera = effects.get("camera") or {}
    shake = camera.get("shake_px", 0) > 0 and camera.get("shake_frames", 0) > 0
    return bool(fade.get("video_in", 0) > 0 or fade.get("audio_in", 0) > 0 or "impact" in effects or shake)


def _held(clip: Mapping[str, Any], edge: str) -> int:
    return int(((clip.get("effects") or {}).get("hold") or {}).get(edge, 0))


def _whole_frames(clip: Mapping[str, Any], wanted: int, available: int | None, phase: bool) -> int:
    """The most frames, up to ``wanted``, that cover whole source frames at the clip's speed within ``available``
    source frames (None: no limit, a text layer); at the start also whole frame-step drawings."""
    speed = _speed(clip)
    step = int((clip.get("effects") or {}).get("frame_step", 1)) if phase else 1
    frames = wanted if available is None else min(wanted, available * 100 // speed)
    while frames > 0:
        if frames * speed % 100 == 0 and frames % step == 0:
            return frames
        frames -= 1
    return 0


def _with_effects(clip: Mapping[str, Any], effects: Mapping[str, Any]) -> Doc:
    """The clip with these effects; an effects object left empty goes."""
    value = {key: item for key, item in clip.items() if key != "effects"}
    if effects:
        value["effects"] = dict(effects)
    return value


def _with_hold(clip: Mapping[str, Any], edge: str, frames: int) -> Doc:
    """The hold at one edge changed by ``frames`` (negative gives frames back); an edge at 0, then an empty hold, go."""
    effects = dict(clip.get("effects") or {})
    hold = dict(effects.get("hold") or {})
    held = int(hold.get(edge, 0)) + frames
    if held > 0:
        hold[edge] = held
    else:
        hold.pop(edge, None)
    if hold:
        effects["hold"] = hold
    else:
        effects.pop("hold", None)
    return _with_effects(clip, effects)


def without_transition_out(clip: Mapping[str, Any]) -> Doc:
    """The clip without its outgoing transition (an effects object left empty goes)."""
    effects = clip.get("effects") or {}
    if "transition_out" not in effects:
        return dict(clip)
    return _with_effects(clip, {key: item for key, item in effects.items() if key != "transition_out"})


def _shift_clock(clip: Mapping[str, Any], frames: int) -> Doc:
    """The clip's clock moved by ``frames`` at its start: keys and the title stay on the content they belong to."""
    if frames == 0:
        return dict(clip)
    value = map_clip_keyframes(clip, lambda keys, _fallback: [{**key, "frame": key["frame"] + frames} for key in keys])
    title = (value.get("effects") or {}).get("title")
    if title:
        end = None if title["end_frame"] is None else title["end_frame"] + frames
        value["effects"] = {
            **value["effects"],
            "title": {**title, "start_frame": title["start_frame"] + frames, "end_frame": end},
        }
    return value


def _with_window(clip: Mapping[str, Any], start: int, end: int, explicit: bool) -> Doc:
    """The visible window [start, end) of the processed frames; a clip that had none and shows them all keeps none."""
    value = {key: item for key, item in clip.items() if key != "output_window"}
    if explicit or start != 0 or end != processed_clip_duration(value):
        value["output_window"] = {"start_frame": start, "end_frame": end}
    return value


def _fits_clock(clip: Mapping[str, Any], complete: int) -> bool:
    """Whether the keys, the title, the fades and the impact frames of a clip still fit a clock of ``complete``."""
    if any(key["frame"] > complete for keys in clip_curves(clip) for key in keys):
        return False
    effects = clip.get("effects") or {}
    title = effects.get("title")
    if title and (
        title["start_frame"] >= complete or (title["end_frame"] is not None and title["end_frame"] > complete)
    ):
        return False
    fade = effects.get("fade") or {}
    if fade.get("video_in", 0) + fade.get("video_out", 0) > complete or fade.get("video_out", 0) >= complete:
        return False
    if fade.get("audio_in", 0) + fade.get("audio_out", 0) > complete:
        return False
    return bool(int((effects.get("impact") or {}).get("frames", 0)) <= complete)


def _fits_shift(clip: Mapping[str, Any], frames: int, text: bool) -> bool:
    """Whether the keys and the title of a clip stay on its clock when its first ``frames`` frames go. A text
    layer's title always covers the whole layer (the edit sets it so again), so it does not count."""
    if any(key["frame"] < frames for keys in clip_curves(clip) for key in keys):
        return False
    title = (clip.get("effects") or {}).get("title")
    return text or not title or title["start_frame"] >= frames


def extend_tail(clip: Mapping[str, Any], frames: int, source: Mapping[str, Any] | None) -> tuple[Doc, Doc]:
    """The outgoing clip running on ``frames`` past its end, and what it lent (a ``MediaClipTransitionSide``).

    Its hidden output first, then the source after its out point (whole source frames at its speed, never past the
    end of the source), then a hold of its last frame. A fade-out moves when the clock grows, so a clip with one
    refuses frames it does not have.
    """
    explicit = clip.get("output_window") is not None
    start, end = clip_output_window(clip)
    complete = processed_clip_duration(clip)
    rest = frames - min(frames, complete - end)
    value: Doc = copy.deepcopy(dict(clip))
    extended = 0
    if rest > 0 and not _end_anchored(clip) and not _held(clip, "end"):
        available = int(source["duration_frames"]) - int(clip["out_frame"]) if source is not None else 0
        extended = _whole_frames(clip, rest, available, False)
        value["out_frame"] = int(value["out_frame"]) + extended * _speed(clip) // 100
        rest -= extended
    if rest > 0:
        if _end_anchored(clip):
            reject(
                "effect_phase",
                f"「{clip['name']}」結尾有淡出，素材不足時無法在切點後重複影格；請先移除淡出，或改用「在切點結束」",
                clip_id=clip["clip_id"],
            )
        value = _with_hold(value, "end", rest)
    if processed_clip_duration(value) != complete + extended + rest:
        reject("effect_phase", INEXACT, clip_id=clip["clip_id"])
    return _with_window(value, start, end + frames, explicit), _side(frames, extended, rest)


def extend_head(clip: Mapping[str, Any], frames: int, source: Mapping[str, Any] | None) -> tuple[Doc, Doc]:
    """The incoming clip starting ``frames`` earlier, and what it lent (a ``MediaClipTransitionSide``).

    Its hidden output first, then the source before its in point (whole source frames at its speed and whole
    frame-step drawings, never before the start of the source), then a hold of its first frame. Fades in, impact
    frames and a shake begin on the clip's first frame, so a clip with one refuses frames it does not have.
    """
    explicit = clip.get("output_window") is not None
    start, end = clip_output_window(clip)
    complete = processed_clip_duration(clip)
    shown = min(frames, start)
    rest = frames - shown
    value: Doc = copy.deepcopy(dict(clip))
    extended = 0
    if rest > 0 and not _start_anchored(clip) and not _held(clip, "start"):
        # A text layer has no source frames: any frame of it is the same layer.
        available = None if source is not None and source["kind"] == "text" else int(clip["in_frame"])
        extended = _whole_frames(clip, rest, available, True)
        value["in_frame"] = int(value["in_frame"]) - extended * _speed(clip) // 100
        rest -= extended
    if rest > 0:
        if _start_anchored(clip):
            reject(
                "effect_phase",
                f"「{clip['name']}」開頭有淡入、衝擊格或震動，素材不足時無法在切點前重複影格；請先移除，或改用「從切點開始」",
                clip_id=clip["clip_id"],
            )
        value = _with_hold(value, "start", rest)
    added = extended + rest
    if processed_clip_duration(value) != complete + added:
        reject("effect_phase", INEXACT, clip_id=clip["clip_id"])
    value = _with_window(_shift_clock(value, added), start - shown, end + added, explicit)
    value["start_frame"] = int(clip["start_frame"]) - frames
    return value, _side(frames, extended, rest)


def retract_tail(clip: Mapping[str, Any], side: Mapping[str, Any]) -> Doc:
    """The outgoing clip back at the cut: it ends ``side.frames`` earlier, and the hold and the source frames the
    transition added go again where they are still hidden beyond the cut."""
    explicit = clip.get("output_window") is not None
    start, end = clip_output_window(clip)
    cut = end - int(side["frames"])
    if int(side["frames"]) < 0 or cut <= start:
        reject("out_of_range", "裁切範圍必須位於片段內", clip_id=clip["clip_id"])
    value: Doc = copy.deepcopy(dict(clip))
    complete = processed_clip_duration(clip)
    if not _end_anchored(clip):
        thaw = min(int(side["freeze"]), _held(clip, "end"), complete - cut)
        if thaw > 0 and _fits_clock(value, complete - thaw):
            value = _with_hold(value, "end", -thaw)
            complete -= thaw
        if int(side["source"]) > 0 and not _held(value, "end"):
            given = _whole_frames(value, min(int(side["source"]), complete - cut), None, False)
            if given > 0 and _fits_clock(value, complete - given):
                value["out_frame"] = int(value["out_frame"]) - given * _speed(value) // 100
                complete -= given
    if processed_clip_duration(value) != complete:
        reject("effect_phase", INEXACT, clip_id=clip["clip_id"])
    return _with_window(value, start, cut, explicit)


def retract_head(clip: Mapping[str, Any], side: Mapping[str, Any], source: Mapping[str, Any] | None) -> Doc:
    """The incoming clip back at the cut: it starts ``side.frames`` later, and the hold and the source frames the
    transition added go again where they are still hidden before the cut."""
    explicit = clip.get("output_window") is not None
    start, end = clip_output_window(clip)
    cut = start + int(side["frames"])
    if int(side["frames"]) < 0 or cut >= end:
        reject("out_of_range", "裁切範圍必須位於片段內", clip_id=clip["clip_id"])
    value: Doc = copy.deepcopy(dict(clip))
    removed = 0
    text = source is not None and source["kind"] == "text"
    if not _start_anchored(clip):
        thaw = min(int(side["freeze"]), _held(clip, "start"), cut)
        if thaw > 0 and _fits_shift(value, thaw, text):
            value = _with_hold(value, "start", -thaw)
            removed = thaw
        if int(side["source"]) > 0 and not _held(value, "start"):
            given = _whole_frames(value, min(int(side["source"]), cut - removed), None, True)
            if given > 0 and _fits_shift(value, removed + given, text):
                value["in_frame"] = int(value["in_frame"]) + given * _speed(value) // 100
                removed += given
    if processed_clip_duration(value) != processed_clip_duration(clip) - removed:
        reject("effect_phase", INEXACT, clip_id=clip["clip_id"])
    value = _with_window(_shift_clock(value, -removed), cut - removed, end - removed, explicit)
    value["start_frame"] = int(clip["start_frame"]) + int(side["frames"])
    return value


def restore_cut(
    left: Mapping[str, Any], right: Mapping[str, Any], transition: Mapping[str, Any], source: Mapping[str, Any] | None
) -> tuple[Doc, Doc]:
    """A transition's two clips back at its cut, without the transition: what it lent and added given back."""
    cut = cut_of(transition)
    return retract_tail(without_transition_out(left), cut["outgoing"]), retract_head(right, cut["incoming"], source)


def reconciled_cut(
    cut: Mapping[str, Any],
    before: tuple[Mapping[str, Any], Mapping[str, Any]],
    after: tuple[Mapping[str, Any], Mapping[str, Any]],
) -> Doc:
    """The cut of a transition whose overlap an edit changed: it moves with the edge that moved and that side keeps
    its frames; when both moved alike (or neither did) it moves with both. What the clips lent beyond the cut stays
    recorded, so removing the transition still gives it back."""
    (old_left, old_right), (new_left, new_right) = before, after
    overlap = clip_end(new_left) - int(new_right["start_frame"])
    end_moved = clip_end(new_left) != clip_end(old_left)
    start_moved = new_right["start_frame"] != old_right["start_frame"]
    if not end_moved and start_moved:
        outgoing = overlap - min(int(cut["incoming"]["frames"]), overlap)
    else:
        outgoing = min(int(cut["outgoing"]["frames"]), overlap)
    return {
        **cut,
        "outgoing": {**cut["outgoing"], "frames": outgoing},
        "incoming": {**cut["incoming"], "frames": overlap - outgoing},
    }


__all__ = [
    "DEFAULT_ALIGNMENT",
    "cut_frame",
    "cut_of",
    "extend_head",
    "extend_tail",
    "reconciled_cut",
    "restore_cut",
    "retract_head",
    "retract_tail",
    "split_at_cut",
    "without_transition_out",
]
