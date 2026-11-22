"""Place source-relative speech cues on the clip's audible, retimed interval."""

from __future__ import annotations

from collections.abc import Callable
from fractions import Fraction
from typing import Any

from ..timeline import clip_output_window, processed_clip_duration
from ..timeline_limits import MAX_CAPTIONS, MAX_TEXT_CHARS
from .rejection import reject


type Doc = dict[str, Any]


def _nearest(value: Fraction) -> int:
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)


def _mapped(
    clip: Doc, fps: Doc, segments: list[Doc], origin_seconds: Fraction = Fraction(0)
) -> list[Doc]:
    fx = clip.get("effects") or {}
    hold = fx.get("hold") or {}
    head = hold.get("start", 0)
    tail = processed_clip_duration(clip) - hold.get("end", 0)
    window_in, window_out = clip_output_window(clip)
    speed = Fraction(100, fx.get("speed_percent", 100))
    clock = Fraction(fps["num"], 1000 * fps["den"])
    source_in = clip["in_frame"] + origin_seconds * 1000 * clock
    delta = clip["start_frame"] - window_in
    result = []
    for segment in segments:
        first, last = segment["start_ms"], segment["end_ms"]
        start = max(
            window_in, head, head + _nearest((first * clock - source_in) * speed)
        )
        end = min(window_out, tail, head + _nearest((last * clock - source_in) * speed))
        if start < end:
            if len(segment["text"]) > MAX_TEXT_CHARS:
                reject("limit_exceeded", "轉錄段落超過字幕長度上限，請分段後再匯入")
            result.append(
                {
                    "start_frame": start + delta,
                    "end_frame": end + delta,
                    "text": segment["text"],
                    "start_ms": first,
                    "end_ms": last,
                }
            )
            if len(result) > MAX_CAPTIONS:
                reject("limit_exceeded", "轉錄段數超過此時間軸的字幕上限")
    return result


def apply_transcript(
    timeline: Doc, clip_id: str, report: Doc, allocate: Callable[[str], str]
) -> tuple[list[Doc], list[str], int]:
    """Refresh generated cues while retaining and flagging manually edited cues."""
    clip = next((c for c in timeline["clips"] if c["clip_id"] == clip_id), None)
    if clip is None:
        reject("clip_not_found", "選取的字幕來源片段已不存在")
    source: Doc = next(
        (s for s in timeline["sources"] if s["source_id"] == clip["source_id"]), {}
    )
    source_file = source.get("file") or {}
    if (source_file.get("sha256"), source_file.get("size_bytes")) != (
        report["sha256"],
        report["size_bytes"],
    ):
        reject("invalid_command", "轉錄來源與選取片段不是同一份素材")
    offset = report["clip_origin_offset"]
    cues = _mapped(
        clip,
        timeline["fps"],
        report["segments"],
        Fraction(offset["num"], offset["den"]),
    )
    kept, manual, previous = [], [], {}
    for caption in timeline["captions"]:
        old = caption.get("transcription")
        if (
            not old
            or old["clip_id"] != clip_id
            or old["source_sha256"] != report["sha256"]
        ):
            kept.append(caption)
            continue
        span = (old["start_ms"], old["end_ms"])
        authored = any(
            caption[k] != old[k]
            for k in ("text", "start_frame", "end_frame", "size", "position")
        )
        if authored:
            reviewed = (
                old["run_id"] != report["run_id"]
                or old["output_key"] != report["output_key"]
            )
            expected = next(
                (cue for cue in cues if (cue["start_ms"], cue["end_ms"]) == span), None
            )
            reviewed |= expected is None or any(
                expected[k] != old[k] for k in ("start_frame", "end_frame", "text")
            )
            manual.append(span)
            kept.append({**caption, "transcription": {**old, "needs_review": reviewed}})
        else:
            previous[span] = caption
    ids = []
    for cue in cues:
        first, last = cue["start_ms"], cue["end_ms"]
        if any(first < right and last > left for left, right in manual):
            continue
        old_caption = previous.get((first, last), {})
        cid = old_caption.get("caption_id") or allocate("caption")
        content = {k: cue[k] for k in ("start_frame", "end_frame", "text")}
        origin = {
            **cue,
            "size": "medium",
            "position": "bottom",
            "clip_id": clip_id,
            "source_sha256": report["sha256"],
            "run_id": report["run_id"],
            "output_key": report["output_key"],
            "file": report["file"],
            "needs_review": False,
        }
        row = {
            "caption_id": cid,
            **content,
            "size": "medium",
            "position": "bottom",
            "transcription": origin,
        }
        if all(old_caption.get(k) == v for k, v in row.items()):
            row = old_caption
        kept.append(row)
        ids.append(cid)
    if len(kept) > MAX_CAPTIONS:
        reject("limit_exceeded", "匯入後將超過時間軸字幕上限")
    return kept, ids, len(manual)
