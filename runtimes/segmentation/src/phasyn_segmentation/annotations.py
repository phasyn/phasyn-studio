"""Validate source-bound pixel prompts before constructing a predictor state."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_media.providers._analysis_video import Source


MAX_FRAMES = 240
MAX_PIXELS = 2048 * 1080
MAX_POINTS = 64
MAX_OBJECT_ID = 2147483647


def invalid(reason: str) -> ComponentError:
    """Report a request the owner can correct."""
    return ComponentError("INVALID_ARGUMENT", reason)


def _coordinate(value: object, limit: int) -> float:
    if type(value) not in (int, float) or not isinstance(value, (int, float)):
        raise invalid("Mark coordinates must be pixel numbers.")
    if not 0 <= value < limit or not isfinite(value):
        raise invalid("Mark coordinates fall outside the source image.")
    return float(value)


@dataclass(frozen=True)
class Mark:
    """The final set of object hints for one presentation frame."""

    frame: int
    points: list[list[float]]
    labels: list[int]
    box: list[float] | None


def _frame(value: dict[str, Any], source: Source) -> int:
    if ("time_us" in value) == ("frame_index" in value):
        raise invalid("Each mark needs exactly one of time_us and frame_index.")
    if "frame_index" in value:
        index = value["frame_index"]
        if type(index) is not int or not 0 <= index < source.clock.count:
            raise invalid("A mark targets a frame outside the source.")
        return index
    timestamp = value["time_us"]
    if type(timestamp) is not int or timestamp < 0:
        raise invalid(
            "time_us must be a nonnegative integer relative to the source's first video frame."
        )
    try:
        return source.clock.frame_at_us(timestamp)
    except ValueError as error:
        raise invalid(
            "time_us reaches or exceeds the exclusive end of the video."
        ) from error


def _mark(value: Any, source: Source) -> Mark:
    if not isinstance(value, dict) or set(value) - {
        "frame_index",
        "time_us",
        "points",
        "box",
    }:
        raise invalid("Each mark needs a frame index and optional points or box.")
    index = _frame(value, source)
    width, height = source.metadata["source_width"], source.metadata["source_height"]
    points, labels = [], []
    raw_points = value.get("points", [])
    if not isinstance(raw_points, list) or len(raw_points) > MAX_POINTS:
        raise invalid("A mark may contain at most 64 points.")
    for point in raw_points:
        if not isinstance(point, dict) or set(point) != {"x", "y", "label"}:
            raise invalid("Points require x, y and a binary label.")
        if type(point["label"]) is not int or point["label"] not in (0, 1):
            raise invalid("Point labels must be 0 (background) or 1 (object).")
        points.append([_coordinate(point["x"], width), _coordinate(point["y"], height)])
        labels.append(point["label"])
    box = None
    if "box" in value:
        raw = value["box"]
        bounds = (width, height, width, height)
        if not isinstance(raw, list) or len(raw) != len(bounds):
            raise invalid("A box needs [left, top, right, bottom] in native pixels.")
        box = [_coordinate(n, bound) for n, bound in zip(raw, bounds, strict=True)]
        if box[0] >= box[2] or box[1] >= box[3]:
            raise invalid("The box must have a positive width and height.")
    if not points and box is None:
        raise invalid("Mark at least one point or a box on each annotated frame.")
    return Mark(index, points, labels, box)


@dataclass(frozen=True)
class Annotations:
    """A single object with one or more versioned, source-bound keyframes."""

    document: dict[str, Any]
    object_id: int
    direction: str
    marks: list[Mark]

    @classmethod
    def parse(cls, value: Any, source: Source) -> Annotations:
        """Reject stale geometry, source substitutions and ambiguous duplicate frames."""
        fields = {
            "version",
            "source_sha256",
            "width",
            "height",
            "object_id",
            "direction",
            "marks",
        }
        if (
            not isinstance(value, dict)
            or fields - value.keys()
            or value.keys() - fields - {"revision"}
        ):
            raise invalid("Provide a versioned mask-annotations document.")
        if type(value["version"]) is not int or value["version"] != 1:
            raise invalid("Unsupported mask-annotations version.")
        revision = value.get("revision", 1)
        if type(revision) is not int or not 1 <= revision <= MAX_OBJECT_ID:
            raise invalid("Annotation revision must be a positive integer.")
        if value["source_sha256"] != source.metadata["source_sha256"] or any(
            type(value[k]) is not int or value[k] != source.metadata[f"source_{k}"]
            for k in ("width", "height")
        ):
            raise invalid(
                "Annotation identity or geometry differs from the selected source."
            )
        token = value["object_id"]
        if type(token) is not int or not 1 <= token <= MAX_OBJECT_ID:
            raise invalid("object_id must be a positive 32-bit integer.")
        direction = value["direction"]
        if not isinstance(direction, str) or direction not in (
            "both",
            "forward",
            "backward",
        ):
            raise invalid("Unknown tracking direction.")
        rows = value["marks"]
        if not isinstance(rows, list) or not 1 <= len(rows) <= source.clock.count:
            raise invalid("Supply between one mark and one mark per source frame.")
        marks = sorted(
            (_mark(item, source) for item in rows), key=lambda mark: mark.frame
        )
        if len({mark.frame for mark in marks}) != len(marks):
            raise invalid(
                "Multiple marks resolve to the same decoded frame; combine their corrections in one mark."
            )
        if not any(mark.box is not None or 1 in mark.labels for mark in marks):
            raise invalid(
                "At least one foreground point or box must identify the object."
            )
        return cls(dict(value), token, direction, marks)

    def active_range(self, total: int) -> range:
        """Return propagation coverage; all frames outside it are published as black."""
        first = self.marks[0].frame if self.direction == "forward" else 0
        last = self.marks[-1].frame + 1 if self.direction == "backward" else total
        return range(first, last)
