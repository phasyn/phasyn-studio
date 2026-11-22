"""Cutting and resizing one clip (the Python twin of the editor's ``slicing.ts``).

A cut keeps the complete source range, effects and keys and only changes the presented ``output_window``, so
splitting and trimming never restart an effect clock. Extending past the processed clock consumes source
handles and is refused when that would change a sampled phase.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from .curves import map_clip_keyframes
from .model import (
    Doc,
    active_transition,
    clip_duration,
    clip_output_window,
    processed_clip_duration,
    to_processing_frame,
)
from .rejection import reject


def slice_clip(clip: Mapping[str, Any], start: int, end: int, clip_id: str) -> Doc:
    """The part [start, end) of the clip's visible frames as a clip of its own."""
    duration = clip_duration(clip)
    if start < 0 or end > duration or start >= end:
        reject("out_of_range", "裁切範圍必須位於片段內")
    transition = active_transition(clip.get("effects"))
    if transition and duration - transition["frames"] < end < duration:
        reject("transition_conflict", "請先移除切點上的轉場")
    value: Doc = copy.deepcopy(dict(clip))
    value["clip_id"] = clip_id
    value["start_frame"] += start
    if start != 0 or end != duration:
        value["output_window"] = {
            "start_frame": to_processing_frame(clip, start),
            "end_frame": to_processing_frame(clip, end),
        }
    if end < duration and value.get("effects"):
        value["effects"].pop("transition_out", None)
    return value


def _blocks_extension(effects: Mapping[str, Any]) -> bool:
    """Effects anchored to a clip edge: extending the clock under them would move what they show."""
    hold = effects.get("hold") or {}
    fade = effects.get("fade") or {}
    camera = effects.get("camera") or {}
    anchored = [
        hold.get("start"),
        hold.get("end"),
        *(
            fade.get(name)
            for name in ("video_in", "video_out", "audio_in", "audio_out")
        ),
    ]
    return (
        any(anchored)
        or bool(effects.get("impact"))
        or bool(camera.get("shake_px"))
        or active_transition(effects) is not None
    )


def _extend(
    clip: Mapping[str, Any], edge: str, delta: int, start: int, end: int
) -> Doc:
    """Grow the processed clock into the source handles before and after it; ``start``/``end`` are the wanted window."""
    effects = clip.get("effects") or {}
    complete = processed_clip_duration(clip)
    if _blocks_extension(effects):
        reject("effect_phase", "延長前請先調整停格、淡入淡出、震動或轉場效果")
    before, after = max(0, -start), max(0, end - complete)
    speed = int(effects.get("speed_percent", 100))
    if (
        before * speed % 100
        or after * speed % 100
        or before % int(effects.get("frame_step", 1))
    ):
        reject(
            "effect_phase", "這個切點無法保留變速或動畫拍數的取樣相位；請選擇對齊的影格"
        )
    value: Doc = copy.deepcopy(dict(clip))
    value["start_frame"] = clip["start_frame"] + (delta if edge == "in" else 0)
    value["in_frame"] = clip["in_frame"] - before * speed // 100
    value["out_frame"] = clip["out_frame"] + after * speed // 100
    value["output_window"] = {"start_frame": start + before, "end_frame": end + before}
    if before:
        value = map_clip_keyframes(
            value,
            lambda keys, _fallback: [
                {**key, "frame": key["frame"] + before} for key in keys
            ],
        )
        title = (value.get("effects") or {}).get("title")
        if title:
            shifted_end = (
                title["end_frame"] if title["end_frame"] is not None else complete
            ) + before
            value["effects"]["title"] = {
                **title,
                "start_frame": title["start_frame"] + before,
                "end_frame": shifted_end,
            }
    if processed_clip_duration(value) != complete + before + after:
        reject("effect_phase", "這個切點無法保留變速片段的精確長度")
    return value


def resize_clip(clip: Mapping[str, Any], edge: str, delta: int) -> Doc:
    """Move one edge by ``delta`` sequence frames (positive is later). Hidden output returns before handles are used."""
    duration = clip_duration(clip)
    if delta == 0:
        return dict(clip)
    if (edge == "in" and delta > 0) or (edge == "out" and delta < 0):
        return slice_clip(
            clip,
            delta if edge == "in" else 0,
            duration + delta if edge == "out" else duration,
            clip["clip_id"],
        )
    window_start, window_end = clip_output_window(clip)
    start = window_start + (delta if edge == "in" else 0)
    end = window_end + (delta if edge == "out" else 0)
    if start >= 0 and end <= processed_clip_duration(clip):
        return {
            **clip,
            "start_frame": clip["start_frame"] + (delta if edge == "in" else 0),
            "output_window": {"start_frame": start, "end_frame": end},
        }
    return _extend(clip, edge, delta, start, end)


__all__ = ["resize_clip", "slice_clip"]
