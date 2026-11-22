"""Keep captions at the same position from overlapping (the preview would stack them unreadably).

The same rule as the Studio editor's fitCaptions (apps/frontend/src/features/studio/editor/captionFit.ts): within
one position, a caption that runs into the next one ends where the next one starts; when two start on the same frame,
the later one in the list starts when the earlier one ends and keeps its length. A generated caption whose times are still the generated
ones keeps its transcription record in step, so it is not mistaken for a manual edit when the transcript is applied
again. Captions at different positions (top and bottom) may overlap.
"""

from __future__ import annotations

from itertools import pairwise
from typing import Any

from ..timeline_limits import MAX_SEQUENCE_FRAMES


Doc = dict[str, Any]


def _set(caption: Doc, key: str, value: int) -> None:
    generated = caption.get("transcription")
    if isinstance(generated, dict) and generated.get(key) == caption[key]:
        caption["transcription"] = {**generated, key: value}
    caption[key] = value


def _overlap(captions: list[Doc]) -> tuple[Doc, Doc] | None:
    order = sorted(
        range(len(captions)),
        key=lambda i: (
            captions[i]["position"],
            captions[i]["start_frame"],
            i,
        ),
    )
    for left, right in pairwise(order):
        first, second = captions[left], captions[right]
        if (
            first["position"] == second["position"]
            and second["start_frame"] < first["end_frame"]
        ):
            return first, second
    return None


def fit_captions(captions: list[Doc]) -> list[Doc]:
    """Captions (copies) without overlaps at the same position; the input is not changed."""
    fitted = [dict(caption) for caption in captions]
    for _ in range(len(fitted) * len(fitted) + 1):
        pair = _overlap(fitted)
        if pair is None:
            break
        first, second = pair
        if first["start_frame"] < second["start_frame"]:
            _set(first, "end_frame", second["start_frame"])
        else:
            length = second["end_frame"] - second["start_frame"]
            _set(second, "start_frame", first["end_frame"])
            _set(
                second,
                "end_frame",
                min(
                    MAX_SEQUENCE_FRAMES,
                    max(second["end_frame"], second["start_frame"] + max(1, length)),
                ),
            )
    return fitted
