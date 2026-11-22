"""Changing a clip's time effects (the Python twin of the editor's ``timing.ts``).

A timing edit acts on what the clip shows. A windowed clip is first turned into an equivalent clip without a
window, which is only done when nothing is lost: no hidden key, no restarted tempo, no fade or hold cut in two.
Keys keep their place in the clip's content, so a speed or hold change moves them, and a move that would land
between frames is refused instead of rounded.
"""

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping
from fractions import Fraction
from typing import Any, NoReturn

from ..timeline import curve_value
from ..timeline_limits import MAX_KEYFRAMES
from .curves import (
    Keys,
    clip_curves,
    map_clip_keyframes,
    slice_compositing,
    slice_motion,
    upsert_curve_key,
)
from .model import Doc, clip_duration, clip_output_window, processed_clip_duration
from .rejection import reject


FADE_EDGES = ("video_in", "video_out", "audio_in", "audio_out")
HOLD_EDGES = ("start", "end")


_NORMAL_PERCENT = 100


def _no_materialize() -> NoReturn:
    reject(
        "effect_phase",
        "這項時間調整無法保留目前裁切的效果相位；請先還原裁切或移除時間效果。",
    )


def _no_retime() -> NoReturn:
    reject(
        "effect_phase",
        "這項時間調整無法保留關鍵影格的整數位置；請先調整關鍵影格或文字範圍。",
    )


def _window_cuts_effect(
    effects: Mapping[str, Any], start: int, end: int, duration: int
) -> bool:
    """Whether the window [start, end) cuts through a hold, a fade or an impact of the complete clock."""
    hold = effects.get("hold") or {}
    fade = effects.get("fade") or {}
    hold_in, core_end = int(hold.get("start", 0)), duration - int(hold.get("end", 0))
    if (
        (0 < start < hold_in)
        or (core_end < end < duration)
        or start >= core_end
        or end <= hold_in
    ):
        return True
    fade_in = max(int(fade.get("video_in", 0)), int(fade.get("audio_in", 0)))
    fade_out = max(int(fade.get("video_out", 0)), int(fade.get("audio_out", 0)))
    if (0 < start < fade_in) or (end < duration and end < fade_in):
        return True
    if start > duration - fade_out or (duration - fade_out < end < duration):
        return True
    impact_frames = int((effects.get("impact") or {}).get("frames", 0))
    return (0 < start < impact_frames) or (end < duration and end < impact_frames)


def _materialized_effects(
    effects: Mapping[str, Any], start: int, end: int, duration: int
) -> Doc:
    """The effects of the window as a clip of its own: only the hold, fade and impact of an edge it still has."""
    hold = effects.get("hold") or {}
    fade = effects.get("fade") or {}
    value: Doc = dict(effects)
    value["hold"] = {
        "start": hold.get("start", 0) if start == 0 else 0,
        "end": hold.get("end", 0) if end == duration else 0,
    }
    value["fade"] = {
        "video_in": fade.get("video_in", 0) if start == 0 else 0,
        "audio_in": fade.get("audio_in", 0) if start == 0 else 0,
        "video_out": fade.get("video_out", 0) if end == duration else 0,
        "audio_out": fade.get("audio_out", 0) if end == duration else 0,
    }
    if start > 0:
        value.pop("impact", None)
    title = value.get("title")
    if title:
        title_start = max(start, title["start_frame"])
        title_end = min(
            end, title["end_frame"] if title["end_frame"] is not None else duration
        )
        if title_start >= title_end:
            del value["title"]
        else:
            value["title"] = {
                **title,
                "start_frame": title_start - start,
                "end_frame": title_end - start,
            }
    return value


def materialize_clip_window(clip: Mapping[str, Any]) -> Doc:
    """The clip without ``output_window``, showing exactly what the window showed; refused when that loses anything."""
    duration = processed_clip_duration(clip)
    start, end = clip_output_window(clip)
    value: Doc = copy.deepcopy(dict(clip))
    value.pop("output_window", None)
    if start == 0 and end == duration:
        return value
    effects = clip.get("effects") or {}
    camera = effects.get("camera") or {}
    hidden_key = any(
        key["frame"] < start or key["frame"] > end
        for keys in clip_curves(clip)
        for key in keys
    )
    shaking = bool(camera.get("shake_px")) and bool(camera.get("shake_frames"))
    # Restarting tempo processing on a cropped source changes PCM even at exact frame boundaries.
    if (
        hidden_key
        or shaking
        or int(effects.get("speed_percent", 100)) != _NORMAL_PERCENT
    ):
        _no_materialize()
    hold_in = int((effects.get("hold") or {}).get("start", 0))
    core_end = duration - int((effects.get("hold") or {}).get("end", 0))
    if _window_cuts_effect(effects, start, end, duration):
        _no_materialize()
    first = max(0, start - hold_in)
    if first % int(effects.get("frame_step", 1)):
        _no_materialize()
    if clip.get("effects") is not None:
        value["effects"] = _materialized_effects(
            copy.deepcopy(dict(clip["effects"])), start, end, duration
        )
    value["in_frame"] = clip["in_frame"] + first
    value["out_frame"] = (
        clip["out_frame"]
        if end == duration
        else clip["in_frame"] + min(core_end, end) - hold_in
    )
    value["motion"] = slice_motion(clip["motion"], start, end)
    value.update(slice_compositing(clip, start, end))
    if processed_clip_duration(value) != end - start:
        _no_materialize()
    return value


def _merged_effects(
    clip: Mapping[str, Any], old: Mapping[str, Any], requested: Mapping[str, Any]
) -> Doc:
    """``old`` with the members the request changed; of a hold or a fade only the edges that changed."""
    current = clip.get("effects") or {}
    merged: Doc = dict(old)
    for name in dict.fromkeys([*current, *requested]):
        if current.get(name) == requested.get(name) and (name in current) == (
            name in requested
        ):
            continue
        if name in ("hold", "fade"):
            edges = HOLD_EDGES if name == "hold" else FADE_EDGES
            group = dict(old.get(name) or {})
            for edge in edges:
                wanted = (requested.get(name) or {}).get(edge, 0)
                if (current.get(name) or {}).get(edge, 0) != wanted:
                    group[edge] = wanted
            merged[name] = group
        elif name in requested:
            merged[name] = requested[name]
        else:
            merged.pop(name, None)
    return merged


def _clock_map(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> tuple[Callable[[int], Fraction | None], list[int]]:
    """Where a frame of the old clock (hold, core, hold) lies in the new one, and the old boundaries that need a key."""
    old_hold = (before.get("effects") or {}).get("hold") or {}
    new_hold = (after.get("effects") or {}).get("hold") or {}
    old_start, old_end = int(old_hold.get("start", 0)), int(old_hold.get("end", 0))
    new_start, new_end = int(new_hold.get("start", 0)), int(new_hold.get("end", 0))
    old_core = processed_clip_duration(before) - old_start - old_end
    new_core = processed_clip_duration(after) - new_start - new_end

    def position(frame: int) -> Fraction | None:
        if frame < old_start:
            return Fraction(frame * new_start, old_start)
        if frame <= old_start + old_core:
            return new_start + Fraction((frame - old_start) * new_core, old_core)
        if old_end == 0:
            return None
        return (
            new_start
            + new_core
            + Fraction((frame - old_start - old_core) * new_end, old_end)
        )

    boundaries: list[int] = []
    if old_start > 0 and new_start * old_core != new_core * old_start:
        boundaries.append(old_start)
    if old_end > 0 and new_end * old_core != new_core * old_end:
        boundaries.append(old_start + old_core)
    return position, boundaries


def _whole(value: Fraction | None) -> int | None:
    return int(value) if value is not None and value.denominator == 1 else None


def _retimed_keys(
    keys: Keys,
    fallback: float,
    position: Callable[[int], Fraction | None],
    boundaries: list[int],
) -> Keys:
    """Keys moved to the new clock; a key is added where the time scale changes under a curve."""
    prepared = keys
    for boundary in boundaries:
        if any(key["frame"] < boundary for key in prepared) and any(
            key["frame"] > boundary for key in prepared
        ):
            prepared = upsert_curve_key(
                prepared, boundary, curve_value(prepared, boundary, fallback)
            )
    frames = [_whole(position(key["frame"])) for key in prepared]
    if (
        len(prepared) > MAX_KEYFRAMES
        or None in frames
        or len(set(frames)) != len(frames)
    ):
        _no_retime()
    return [
        {**key, "frame": frame} for key, frame in zip(prepared, frames, strict=True)
    ]


def change_clip_timing(
    clip: Mapping[str, Any], effects: Mapping[str, Any] | None
) -> Doc:
    """The clip with ``effects`` as its new effects, keys and title following the content they sit on."""
    before = materialize_clip_window(clip)
    merged = _merged_effects(clip, before.get("effects") or {}, effects or {})
    value: Doc = {**before, "effects": merged}
    position, boundaries = _clock_map(before, value)
    value = map_clip_keyframes(
        value,
        lambda keys, fallback: _retimed_keys(keys, fallback, position, boundaries),
    )
    title = merged.get("title")
    if title:
        start = _whole(position(title["start_frame"]))
        end = (
            None if title["end_frame"] is None else _whole(position(title["end_frame"]))
        )
        if start is None or (title["end_frame"] is not None and end is None):
            _no_retime()
        value["effects"] = {
            **merged,
            "title": {**title, "start_frame": start, "end_frame": end},
        }
    if clip_duration(value) <= 0:
        _no_retime()
    return value


__all__ = ["change_clip_timing", "materialize_clip_window"]
