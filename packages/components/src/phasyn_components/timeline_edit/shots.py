"""Shots, takes and library items as timeline media (the Python twin of the editor's ``sources.ts``).

A shot is on the timeline through a source that names it. The source is bound to the shot's active take once that
take is finished and complete; until then it is a placeholder with the shot's planned length and no file.
Frame counts are converted to the timeline's rate with the same floating point arithmetic the browser uses, so
both sides agree on every frame.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from typing import Any

from ..timeline_limits import MAX_SEQUENCE_FRAMES, MAX_SOURCE_FRAMES, MAX_SOURCE_SIDE
from .model import Doc
from .text import round_half_up

H3_FPS = 24
SWAP_JOB_TAG = "swap.v1 "
PROXY_FIELDS = ("proxy", "proxy_run_id", "proxy_error", "proxy_source_sha256")


def rate(fps: Mapping[str, Any]) -> float:
    return int(fps["num"]) / int(fps["den"])


def active_take(shot: Mapping[str, Any]) -> Doc | None:
    """The take in use: the chosen one, otherwise the newest finished one."""
    chosen = shot.get("active_take_id")
    takes = shot.get("takes") or []
    if chosen:
        found = next((take for take in takes if take["take_id"] == chosen), None)
        if found is not None:
            return dict(found)
    return next((dict(take) for take in reversed(takes) if take["state"] == "succeeded"), None)


def bound_take(shot: Mapping[str, Any]) -> Doc | None:
    """The take a shot's clips show: its active take once that is finished and its file complete."""
    take = active_take(shot)
    if take is None or take["state"] != "succeeded" or not (take.get("asset") or {}).get("complete"):
        return None
    return take


def source_id(identity: str) -> str:
    """A stable compact id for a media identity such as ``shot/<shot_id>/<take_id>`` (two 32-bit FNV-style hashes)."""
    first, second = 2166136261, 3339675911
    for char in identity:
        code = ord(char)
        first = ((first ^ code) * 16777619) & 0xFFFFFFFF
        second = ((second ^ code) * 2246822519) & 0xFFFFFFFF
    return f"media-{first:x}-{second:x}"


def unique_id(wanted: str, taken: set[str]) -> str:
    """``wanted``, or ``wanted-2``, ``wanted-3`` … when it is taken; the result is added to ``taken``."""
    value, serial = wanted, 1
    while value in taken:
        serial += 1
        value = f"{wanted}-{serial}"
    taken.add(value)
    return value


def _side(value: Any) -> int:
    return max(0, min(MAX_SOURCE_SIDE, int(value)))


def take_frames(shot: Mapping[str, Any], take: Mapping[str, Any] | None, fps: Mapping[str, Any]) -> int:
    """The length of a take (or, without one, of the planned shot) in frames of the timeline's rate."""
    asset = take.get("asset") if take else None
    asset_fps = asset.get("fps") if asset else None
    source_rate = rate(asset_fps) if asset_fps else float(H3_FPS)
    frames = (asset["frame_count"] if asset else 0) or (take["frames"] if take else 0) or shot["frames"]
    return max(1, min(MAX_SOURCE_FRAMES, round_half_up((frames * rate(fps)) / source_rate)))


def shot_source(project: Mapping[str, Any], shot: Mapping[str, Any], fps: Mapping[str, Any]) -> Doc:
    """A shot's source as the timeline binds it; ``file`` is None until the shot has a finished take."""
    take = bound_take(shot)
    asset = take["asset"] if take else None
    frame = project["format"]
    source: Doc = {
        "source_id": source_id(f"shot/{shot['shot_id']}/{take['take_id'] if take else 'pending'}"),
        "name": shot["title"],
        "kind": "video",
        "file": copy.deepcopy(asset["file"]) if asset else None,
        "duration_frames": take_frames(shot, take, fps),
        "width": _side(asset["width"] if asset else frame["width"]),
        "height": _side(asset["height"] if asset else frame["height"]),
        "has_audio": True,
        "shot_id": shot["shot_id"],
    }
    if take:
        source["take_id"] = take["take_id"]
    return source


def library_source(item: Mapping[str, Any], fps: Mapping[str, Any]) -> Doc | None:
    """A library item as a source; None while a video or sound has no known duration."""
    seconds = item.get("duration_seconds")
    if item["kind"] == "image":
        frames = MAX_SEQUENCE_FRAMES
    elif seconds is not None and seconds > 0:
        frames = max(1, min(MAX_SOURCE_FRAMES, round_half_up(seconds * rate(fps))))
    else:
        return None
    return {
        "source_id": source_id(f"library/{item['item_id']}"),
        "name": item["name"],
        "kind": item["kind"],
        "file": copy.deepcopy(item["file"]),
        "duration_frames": frames,
        "width": _side(item.get("width") or 0),
        "height": _side(item.get("height") or 0),
        "has_audio": item["kind"] == "audio" or item.get("has_audio") is True,
        "library_id": item["item_id"],
    }


def _whole(value: Any, minimum: int = 0) -> bool:
    """A JSON number that is a whole number of at least ``minimum`` (5 and 5.0 alike, as in JavaScript)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    return float(value).is_integer() and value >= minimum


def _no_constant(_name: str) -> Any:
    raise ValueError("not JSON")


def swap_job(note: str | None) -> Doc | None:
    """The character-swap job a library video's note carries (the line after the ``swap.v1`` tag), or None."""
    line = next((item for item in (note or "").split("\n") if item.startswith(SWAP_JOB_TAG)), None)
    if line is None:
        return None
    try:
        job = json.loads(line[len(SWAP_JOB_TAG) :], parse_constant=_no_constant)
    except ValueError:
        return None
    if not isinstance(job, dict) or isinstance(job.get("v"), bool) or job.get("v") != 1:
        return None
    limits = (("fps", 1), ("start_frame", 0), ("end_frame", 1), ("max_frames", 1), ("crossfade_frames", 0))
    if any(not _whole(job.get(name), minimum) for name, minimum in limits):
        return None
    if job["end_frame"] <= job["start_frame"] or job.get("audio") not in ("original", "generated"):
        return None
    return {"fps": int(job["fps"]), "start_frame": int(job["start_frame"]), "audio": job["audio"]}


def original_audio(project: Mapping[str, Any]) -> tuple[Doc, Doc] | None:
    """(job, library video) of a character-swap project that keeps the source video's sound; None otherwise."""
    for item in project.get("library") or []:
        if item["kind"] != "video":
            continue
        job = swap_job(item.get("note"))
        if job is not None:
            return (job, dict(item)) if job["audio"] == "original" else None
    return None


def shot_name(shot: Mapping[str, Any]) -> str:
    return str(shot["title"] or shot["shot_id"])


__all__ = [
    "H3_FPS",
    "PROXY_FIELDS",
    "active_take",
    "bound_take",
    "library_source",
    "original_audio",
    "rate",
    "shot_name",
    "shot_source",
    "source_id",
    "swap_job",
    "take_frames",
    "unique_id",
]
