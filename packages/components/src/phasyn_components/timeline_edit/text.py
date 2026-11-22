"""Text on the timeline: title layout defaults, the layout keys that tell a fresh raster from a stale one, text layers and SRT import (the Python twin of the editor's ``title.ts``, ``textLayer.ts`` and ``captions.ts``).

A title or caption image is a browser-made raster of one text at one output size. ``title_key`` and
``caption_key`` reproduce the browser's keys character for character (they are ``JSON.stringify`` of a list), so
the Controller can tell whether a stored image still shows the text it belongs to.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from decimal import Decimal
from fractions import Fraction
from typing import Any

from ..timeline_limits import (
    MAX_CAPTIONS,
    MAX_SEQUENCE_FRAMES,
    MAX_SRT_CHARS,
    MAX_TEXT_CHARS,
    MAX_TRACKS,
)
from .model import AllocateId, Doc, default_motion, find_track, new_track, track_free
from .rejection import reject


TITLE_SIZE_RATIO = {"small": 0.05, "medium": 0.075, "large": 0.11}
STYLE_FIELDS = ("font_family", "font_size", "font_weight", "color", "align", "x", "y")
TEXT_LAYER_NAME = "文字圖層"
TEXT_LAYER_SECONDS = 5
CAPTION_SECONDS = 3
# What JavaScript's \s and String.trim() treat as white space, as code points (U+2000 to U+200A is a range).
_SPACE_POINTS = (
    9,
    10,
    11,
    12,
    13,
    0x20,
    0xA0,
    0x1680,
    *range(0x2000, 0x200B),
    0x2028,
    0x2029,
    0x202F,
    0x205F,
    0x3000,
    0xFEFF,
)
_SPACE_CHARS = "".join(map(chr, _SPACE_POINTS))
_BLANK_LINE = re.compile(r"\n[ \t]*\n")
_ARROW = re.compile(f"[{re.escape(_SPACE_CHARS)}]+-->[{re.escape(_SPACE_CHARS)}]+")
_TIME = re.compile(r"([0-9]{2,}):([0-5][0-9]):([0-5][0-9])[,.]([0-9]{3})")
_NUMBER = re.compile(r"[0-9]+")


_MAX_FIXED_POINT = 21
_MIN_FIXED_POINT = -6
_SUBTITLE_ENDPOINTS = 2


def round_half_up(value: Fraction | float) -> int:
    """The nearest integer, a tie going up: what JavaScript's ``Math.round`` returns."""
    floor = math.floor(value)
    return floor + 1 if value - floor >= Fraction(1, 2) else floor


def js_number(value: float) -> str:
    """A number as ``JSON.stringify`` prints it (``81`` for 81.0, ``1e-7`` for 0.0000001)."""
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    sign, digits, exponent = Decimal(repr(abs(value))).as_tuple()
    text = "".join(str(digit) for digit in digits).rstrip("0") or "0"
    if not isinstance(exponent, int):
        return "null"
    point = len(digits) + exponent  # the value is 0.<text> x 10^point
    prefix = "-" if value < 0 or sign else ""
    return _decimal_digits(text, point, prefix)


def _decimal_digits(text: str, point: int, prefix: str) -> str:
    count = len(text)
    if count <= point <= _MAX_FIXED_POINT:
        return prefix + text + "0" * (point - count)
    if 0 < point <= _MAX_FIXED_POINT:
        return f"{prefix}{text[:point]}.{text[point:]}"
    if _MIN_FIXED_POINT < point <= 0:
        return f"{prefix}0.{'0' * -point}{text}"
    mantissa = text if count == 1 else f"{text[0]}.{text[1:]}"
    return f"{prefix}{mantissa}e{'+' if point - 1 > 0 else '-'}{abs(point - 1)}"


def _js_array(values: Sequence[Any]) -> str:
    parts = [
        json.dumps(value, ensure_ascii=False)
        if isinstance(value, str)
        else js_number(value)
        for value in values
    ]
    return f"[{','.join(parts)}]"


def default_title_style(position: str = "center", size: str = "medium") -> Doc:
    """The style a title gets when it has none of its own (sizes are pixels of a 1080-line frame)."""
    lower = position == "lower_third"
    heights = {"top": 0.13, "bottom": 0.85, "lower_third": 0.79}
    return {
        "font_family": "sans",
        "font_size": round_half_up(1080 * TITLE_SIZE_RATIO[size]),
        "font_weight": 700,
        "color": "#ffffff",
        "align": "left" if lower else "center",
        "x": 0.06 if lower else 0.5,
        "y": heights.get(position, 0.5),
    }


def title_key(title: Mapping[str, Any], width: int, height: int) -> str:
    """The layout a title raster was made for; a different ``image_key`` means the image is stale."""
    base = [title["text"], title["position"], title["size"], width, height]
    style = title.get("style")
    if not style:
        return _js_array(["title.v1", *base])
    return _js_array(["title.v2", *base, *(style[name] for name in STYLE_FIELDS)])


def caption_key(caption: Mapping[str, Any], width: int, height: int) -> str:
    """Identify a caption by its source settings."""
    return _js_array(
        [caption["text"], caption["position"], caption["size"], width, height]
    )


def title_fresh(title: Mapping[str, Any], width: int, height: int) -> bool:
    """The title has a raster of its current text, layout and output size."""
    return title.get("image") is not None and title.get("image_key") == title_key(
        title, width, height
    )


def caption_fresh(caption: Mapping[str, Any], width: int, height: int) -> bool:
    """Check whether the caption still matches its source."""
    return caption.get("image") is not None and caption.get("image_key") == caption_key(
        caption, width, height
    )


def seconds_to_frames(seconds: int, fps: Mapping[str, Any]) -> int:
    """Convert seconds to timeline frames."""
    return max(1, round_half_up(Fraction(seconds * int(fps["num"]), int(fps["den"]))))


def add_text_layer(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    timeline: Doc,
    title: Mapping[str, Any],
    at: int,
    duration: int | None,
    track_id: str | None,
    size: tuple[int, int],
    allocate: AllocateId,
) -> str:
    """Add a generated text source and its clip showing ``title``; the id of the clip.

    Without ``track_id`` the layer goes on the top video track when that is unlocked and free, otherwise on a new
    video track. ``duration`` None is five seconds, or what is left of the sequence.
    """
    if at < 0 or at >= MAX_SEQUENCE_FRAMES:
        reject("out_of_range", "文字圖層起點超出時間軸範圍")
    if duration is None:
        frames = min(
            MAX_SEQUENCE_FRAMES - at,
            seconds_to_frames(TEXT_LAYER_SECONDS, timeline["fps"]),
        )
    else:
        frames = duration
    if frames < 1:
        reject("out_of_range", "文字圖層長度必須至少 1 影格")
    track = _text_track(timeline, at, frames, track_id, allocate)
    source_id = allocate("text")
    timeline["sources"].append(
        {
            "source_id": source_id,
            "name": TEXT_LAYER_NAME,
            "kind": "text",
            "file": None,
            "width": size[0],
            "height": size[1],
            "duration_frames": MAX_SEQUENCE_FRAMES,
            "has_audio": False,
        }
    )
    clip_id = allocate("clip")
    timeline["clips"].append(
        {
            "clip_id": clip_id,
            "name": TEXT_LAYER_NAME,
            "source_id": source_id,
            "track_id": track["track_id"],
            "start_frame": at,
            "in_frame": 0,
            "out_frame": frames,
            "motion": default_motion(),
            "effects": {
                "title": {
                    **title,
                    "start_frame": 0,
                    "end_frame": None,
                    "image": None,
                    "image_key": None,
                }
            },
        }
    )
    return clip_id


def _text_track(
    timeline: Doc, at: int, frames: int, track_id: str | None, allocate: AllocateId
) -> Doc:
    if track_id is not None:
        track = find_track(timeline, track_id)
        if track is None:
            reject("track_not_found", "找不到選取的軌道", track_id=track_id)
        if track["kind"] != "video":
            reject("track_kind", "文字圖層只能放在影像軌", track_id=track_id)
        if track["locked"]:
            reject("track_locked", "軌道已鎖定；請先解鎖再編輯", track_id=track_id)
        if not track_free(timeline, track, at, at + frames):
            reject(
                "overlap",
                "指定軌道在這段時間已有片段；請選擇其他軌道或時間",
                track_id=track_id,
            )
    else:
        top = next(
            (item for item in reversed(timeline["tracks"]) if item["kind"] == "video"),
            None,
        )
        if top is not None and track_free(timeline, top, at, at + frames):
            track = top
        elif len(timeline["tracks"]) < MAX_TRACKS:
            track = new_track(allocate("track"), "video", TEXT_LAYER_NAME)
            timeline["tracks"].append(track)
        else:
            reject(
                "limit_exceeded",
                "請先在未鎖定的影像軌保留文字圖層空間，或移除不用的軌道",
                limit=MAX_TRACKS,
            )
    return track


def _milliseconds(value: str) -> int | None:
    match = _TIME.fullmatch(value.strip(_SPACE_CHARS))
    if match is None:
        return None
    hours, minutes, seconds, fraction = (int(part) for part in match.groups())
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction


def parse_srt(text: str, fps: Mapping[str, Any]) -> list[Doc]:
    """The captions of an SRT text (without ids), in file order; the whole text is checked before any is used."""
    if len(text) > MAX_SRT_CHARS:
        reject("srt_invalid", "字幕檔不得超過 1 MB")
    body = (
        text.removeprefix("﻿")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip(_SPACE_CHARS)
    )
    blocks = _BLANK_LINE.split(body)
    if not body or len(blocks) > MAX_CAPTIONS:
        reject("srt_invalid", "字幕檔需包含 1\N{EN DASH}500 段字幕")
    rate = Fraction(int(fps["num"]), int(fps["den"]))
    captions: list[Doc] = []
    for index, block in enumerate(blocks, start=1):
        lines = block.split("\n")
        if lines and _NUMBER.fullmatch(lines[0]):
            lines.pop(0)
        times = _ARROW.split(lines.pop(0)) if lines else []
        start = _milliseconds(times[0]) if times and times[0] else None
        end = _milliseconds(times[1]) if len(times) > 1 and times[1] else None
        content = "\n".join(lines).strip(_SPACE_CHARS)
        first = -1 if start is None else round_half_up(start * rate / 1000)
        last = -1 if end is None else round_half_up(end * rate / 1000)
        valid = (
            len(times) == _SUBTITLE_ENDPOINTS
            and 0 <= first < last <= MAX_SEQUENCE_FRAMES
            and 0 < len(content) <= MAX_TEXT_CHARS
        )
        if not valid:
            reject("srt_invalid", f"第 {index} 段字幕的時間或文字格式無效", index=index)
        captions.append(
            {
                "start_frame": first,
                "end_frame": last,
                "text": content,
                "position": "bottom",
                "size": "medium",
            }
        )
    return captions


__all__ = [
    "CAPTION_SECONDS",
    "STYLE_FIELDS",
    "TEXT_LAYER_NAME",
    "add_text_layer",
    "caption_fresh",
    "caption_key",
    "default_title_style",
    "js_number",
    "parse_srt",
    "round_half_up",
    "seconds_to_frames",
    "title_fresh",
    "title_key",
]
