"""Keyframe curves under edits (the Python twin of the editor's ``curves.ts`` and ``animation.ts``).

A cut never restarts an easing: slicing reparameterizes the interval a key owns (``curve_range``), and a
key inserted between two keys splits that interval. Evaluation itself lives in ``phasyn_components.timeline``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from ..timeline import curve_value
from .model import EFFECT_CHANNELS, MASK_CHANNELS, MOTION_CHANNELS, Doc

Keys = list[Doc]
KeyTransform = Callable[[Keys, float], Keys]


def _last_at_or_before(keys: Sequence[Mapping[str, Any]], frame: float) -> Mapping[str, Any] | None:
    return next((key for key in reversed(keys) if key["frame"] <= frame), None)


def _first_after(keys: Sequence[Mapping[str, Any]], frame: float) -> Mapping[str, Any] | None:
    return next((key for key in keys if key["frame"] > frame), None)


def _interval_position(left: Mapping[str, Any], right: Mapping[str, Any], frame: float) -> float:
    """Where ``frame`` lies in the easing interval the left key owns (its ``curve_range``, by default 0–1)."""
    low, high = left.get("curve_range", [0, 1])
    return max(0, min(1, low + (high - low) * (frame - left["frame"]) / (right["frame"] - left["frame"])))


def curve_slice(keys: Sequence[Mapping[str, Any]], start: int, end: int, fallback: float) -> Keys:
    """The curve on [start, end] as keys relative to ``start``, with every easing interval preserved."""
    if not keys:
        return []
    times = [start, *(key["frame"] for key in keys if start < key["frame"] < end), end]
    result: Keys = []
    for index, time in enumerate(times):
        left = _last_at_or_before(keys, time)
        right = _first_after(keys, time)
        value = curve_value(keys, time, fallback)
        if left is None or right is None:
            result.append({"frame": time - start, "value": value, "interpolation": "linear"})
            continue
        following = times[index + 1] if index + 1 < len(times) else time
        key: Doc = {"frame": time - start, "value": value, "interpolation": left["interpolation"]}
        if left.get("bezier"):
            key["bezier"] = list(left["bezier"])
        if following > time:
            upper = min(following, right["frame"])
            key["curve_range"] = [_interval_position(left, right, time), _interval_position(left, right, upper)]
        result.append(key)
    return result


def upsert_curve_key(keys: Sequence[Mapping[str, Any]], frame: int, value: float) -> Keys:
    """Set the value at ``frame``; a new key splits the easing interval it lands in instead of restarting it."""
    if any(key["frame"] == frame for key in keys):
        return [{**key, "value": value} if key["frame"] == frame else dict(key) for key in keys]
    left = next((key for key in reversed(keys) if key["frame"] < frame), None)
    right = _first_after(keys, frame)
    inserted: Doc = {"frame": frame, "value": value, "interpolation": "linear"}
    if left is not None:
        inserted = {**left, "frame": frame, "value": value}
    inserted.pop("curve_range", None)
    previous = dict(left) if left is not None else None
    if left is not None and right is not None and previous is not None:
        low, high = left.get("curve_range", [0, 1])
        split = low + (high - low) * (frame - left["frame"]) / (right["frame"] - left["frame"])
        previous["curve_range"] = [low, split]
        inserted["curve_range"] = [split, high]
    updated = [previous if key is left and previous is not None else dict(key) for key in keys]
    return sorted([*updated, inserted], key=lambda key: key["frame"])


def _map_container(container: Mapping[str, Any], channels: Sequence[str], transform: KeyTransform) -> Doc:
    """An effect or a mask with ``transform`` applied to its animated channels (others untouched)."""
    result = dict(container)
    if not container.get("keyframes"):
        return result
    keyframes = dict(container["keyframes"])
    for channel in channels:
        keys = keyframes.get(channel)
        if keys:
            keyframes[channel] = transform(list(keys), container[channel])
    result["keyframes"] = keyframes
    return result


def _map_compositing(clip: Mapping[str, Any], result: Doc, transform: KeyTransform) -> None:
    if clip.get("effect_stack") is not None:
        result["effect_stack"] = [
            _map_container(effect, EFFECT_CHANNELS[effect["kind"]], transform) for effect in clip["effect_stack"]
        ]
    if clip.get("mask") is not None:
        result["mask"] = _map_container(clip["mask"], MASK_CHANNELS, transform)


def map_clip_keyframes(clip: Mapping[str, Any], transform: KeyTransform) -> Doc:
    """A copy of the clip with ``transform(keys, fixed_value)`` applied to every animated channel.

    Channels are visited in a fixed order (motion, effect stack, mask), as the editor does.
    """
    result = dict(clip)
    motion = dict(clip["motion"])
    keyframes = dict(motion["keyframes"])
    for channel in MOTION_CHANNELS:
        keys = keyframes.get(channel)
        if keys:
            keyframes[channel] = transform(list(keys), motion[channel])
    motion["keyframes"] = keyframes
    result["motion"] = motion
    _map_compositing(clip, result, transform)
    return result


def slice_motion(motion: Mapping[str, Any], start: int, end: int) -> Doc:
    """Motion with its curves cut to [start, end]; channels without keys are left out."""
    result = dict(motion)
    result["keyframes"] = {
        channel: curve_slice(motion["keyframes"][channel], start, end, motion[channel])
        for channel in MOTION_CHANNELS
        if motion["keyframes"].get(channel)
    }
    return result


def slice_compositing(clip: Mapping[str, Any], start: int, end: int) -> Doc:
    """The clip's ``effect_stack`` and ``mask`` (the ones it has) with their curves cut to [start, end]."""
    result: Doc = {}
    _map_compositing(clip, result, lambda keys, fallback: curve_slice(keys, start, end, fallback))
    return result


def clip_curves(clip: Mapping[str, Any]) -> list[Keys]:
    """Every key list of a clip (motion, effect stack, mask), empty ones included."""
    curves = [list(keys) for keys in clip["motion"]["keyframes"].values()]
    for effect in clip.get("effect_stack") or []:
        curves += [list(keys) for keys in (effect.get("keyframes") or {}).values()]
    mask = clip.get("mask")
    if mask:
        curves += [list(keys) for keys in (mask.get("keyframes") or {}).values()]
    return curves


__all__ = [
    "KeyTransform",
    "Keys",
    "clip_curves",
    "curve_slice",
    "map_clip_keyframes",
    "slice_compositing",
    "slice_motion",
    "upsert_curve_key",
]
