"""Import the cut/trim subset of a Kdenlive OTIO against a trusted Studio timeline."""

from __future__ import annotations

import math
from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, NoReturn
from uuid import NAMESPACE_URL, uuid5

from ..errors import ComponentError
from ..timeline import validate_timeline
from .model import Doc, clip_end, default_motion, track_clips
from .otio import export_timeline
from .otio_delivery import delivery_regions


_FRAME_TOLERANCE = 0.00001


@dataclass
class _Import:
    rate: float
    files: dict[str, tuple[str, int]]
    sources: dict[str, Doc]
    used: set[str] = field(default_factory=set)


def _refuse(message: str) -> NoReturn:
    raise ComponentError("INVALID_ARGUMENT", f"Kdenlive 回剪：{message}")


def _children(item: Any, schema: str) -> list[Doc]:
    if (
        not isinstance(item, dict)
        or item.get("OTIO_SCHEMA") != schema
        or item.get("effects")
        or not isinstance(item.get("children"), list)
    ):
        _refuse("只支援標準軌道、片段與空白。")
    if not all(isinstance(child, dict) for child in item["children"]):
        _refuse("剪輯項目的格式錯誤。")
    return item["children"]


def _number(value: object) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or abs(value) >= 10**15
    ):
        _refuse("時間與影格率必須為有效數值。")
    return float(value)


def _frame(time: Any, rate: float) -> int:
    if not isinstance(time, dict) or time.get("OTIO_SCHEMA") != "RationalTime.1":
        _refuse("時間值格式錯誤。")
    value = _number(time.get("value"))
    units = _number(time.get("rate"))
    if units <= 0 or value < 0:
        _refuse("時間與影格率必須為有效數值。")
    frame = value * rate / units
    if not math.isfinite(frame) or abs(frame - round(frame)) > _FRAME_TOLERANCE:
        _refuse("剪輯點未對齊專案影格。")
    return round(frame)


def _bounds(record: Any, rate: float) -> tuple[int, int]:
    if not isinstance(record, dict) or record.get("OTIO_SCHEMA") != "TimeRange.1":
        _refuse("缺少明確的片段區間。")
    return _frame(record.get("start_time"), rate), _frame(record.get("duration"), rate)


def _eligible(clip: Doc) -> bool:
    return (
        not clip.get("effects")
        and not clip.get("effect_stack")
        and not clip.get("mask")
        and not clip.get("output_window")
        and clip.get("blend_mode", "normal") == "normal"
        and clip.get("motion") == default_motion()
        and clip.get("enabled", True) is True
    )


def _key(*parts: object) -> str:
    return uuid5(NAMESPACE_URL, repr(parts)).hex


def _template(
    item: Doc, originals: list[Doc], context: _Import, start: int, length: int
) -> Doc:
    refs = item.get("media_references")
    key = item.get("active_media_reference_key")
    ref = refs.get(key) if isinstance(refs, dict) and isinstance(key, str) else None
    if not isinstance(ref, dict) or ref.get("OTIO_SCHEMA") != "ExternalReference.1":
        _refuse("片段需要已登錄的外部媒體。")
    url = ref.get("target_url")
    if not isinstance(url, str) or url not in context.files:
        _refuse("請選取重新連結的媒體檔，以比對內容雜湊與大小。")
    matches = []
    for clip in originals:
        file = context.sources[clip["source_id"]].get("file")
        if file and (file["sha256"], file["size_bytes"]) == context.files[url]:
            matches.append(clip)
    meta = item.get("metadata")
    identity = meta.get("phasyn") if isinstance(meta, dict) else None
    if isinstance(identity, dict) and identity.get("clip_id"):
        matches = [c for c in matches if c["clip_id"] == identity["clip_id"]]
    if len(matches) > 1:
        matches = [
            c
            for c in matches
            if c["in_frame"] <= start and start + length <= c["out_frame"]
        ]
    if (
        len(matches) != 1
        or start + length > context.sources[matches[0]["source_id"]]["duration_frames"]
    ):
        _refuse("來源超出素材長度，或無法唯一對應原軌道上的片段。")
    return matches[0]


def _track_clips(
    track: Doc, original: Doc, originals: list[Doc], context: _Import
) -> list[Doc]:
    if any(not _eligible(c) for c in originals):
        _refuse("含特效、調整、變速、轉場或保持格的片段尚不支援回剪。")
    children = _children(track, "Track.1")
    cursor = 0
    result = []
    for item in children:
        start, length = _bounds(item.get("source_range"), context.rate)
        if item.get("effects") or item.get("enabled", True) is not True or length <= 0:
            _refuse("片段必須啟用、具有時長且無外部特效。")
        if item.get("OTIO_SCHEMA") == "Clip.2":
            clip = deepcopy(_template(item, originals, context, start, length))
            clip_id = clip["clip_id"]
            if clip_id in context.used:
                clip_id = _key(clip["track_id"], clip_id, cursor, start, length)
            context.used.add(clip_id)
            clip.update(
                clip_id=clip_id,
                start_frame=cursor,
                in_frame=start,
                out_frame=start + length,
            )
            result.append(clip)
        elif item.get("OTIO_SCHEMA") != "Gap.1" or start != 0:
            _refuse("軌道只支援媒體片段與空白。")
        cursor += length
    if track.get("source_range") is not None and _bounds(
        track["source_range"], context.rate
    ) != (0, cursor):
        _refuse("軌道的裁切長度和內含片段不一致。")
    if original["locked"] and result != originals:
        _refuse("請先解除已變更軌道的鎖定。")
    return result


def _relink_pairs(clips: list[Doc]) -> None:
    groups: dict[tuple[str, int, int, int], list[Doc]] = defaultdict(list)
    for clip in clips:
        if link := clip.get("linked_id"):
            groups[
                link, clip["start_frame"], clip["in_frame"], clip["out_frame"]
            ].append(clip)
    used: set[str] = set()
    for (link, cursor, start, end), members in groups.items():
        identity = link if link not in used else _key(link, cursor, start, end)
        if len(members) > 1:
            used.add(link)
        for clip in members:
            if len(members) > 1:
                clip["linked_id"] = identity
            else:
                clip.pop("linked_id", None)


def _file_identities(
    manifest: list[Doc], relinks: dict[str, tuple[str, int]]
) -> dict[str, tuple[str, int]]:
    files = dict(relinks)
    for source in manifest:
        ref = source["original"]
        if ref:
            known = (ref["sha256"], ref["size_bytes"])
            if files.get(ref["target_url"], known) != known:
                _refuse("重新連結的媒體與原檔內容不同。")
            files[ref["target_url"]] = known
    return files


def _tracks(
    timeline: Doc, document: Doc, rate: float, selected: set[str] | None
) -> list[Doc]:
    if not isinstance(document, dict) or document.get("OTIO_SCHEMA") != "Timeline.1":
        _refuse("需要 OTIO Timeline.1。")
    if document.get("global_start_time") is not None and _frame(
        document["global_start_time"], rate
    ):
        _refuse("目前只支援零點開始的序列。")
    stack = document.get("tracks")
    tracks = _children(stack, "Stack.1")
    if (
        not isinstance(stack, dict)
        or stack.get("source_range") is not None
        or stack.get("enabled", True) is not True
        or (selected is None and len(tracks) != len(timeline["tracks"]))
    ):
        _refuse("需要保留專案的軌道數量與完整序列。")
    if selected is None:
        return tracks
    keys = {
        (t["name"].casefold(), t["kind"])
        for t in timeline["tracks"]
        if t["track_id"] in selected
    }
    matches = [
        t
        for t in tracks
        if (str(t.get("name")).casefold(), str(t.get("kind")).casefold()) in keys
    ]
    if len(matches) != len(selected) or len(keys) != len(selected):
        _refuse("選取的軌道必須能依軌名與類型逐一對應。")
    return matches


def import_kdenlive_edits(
    timeline: Doc,
    document: Doc,
    relinks: dict[str, tuple[str, int]],
    track_ids: list[str] | None = None,
) -> Doc:
    """Project only frame-aligned edits onto stored clips; foreign paths and file identifiers are never opened."""
    projection = export_timeline(timeline)
    rate = timeline["fps"]["num"] / timeline["fps"]["den"]
    selected = None
    if track_ids is not None:
        selected = set(track_ids)
        valid = {t["track_id"] for t in timeline["tracks"]}
        if not selected or len(selected) != len(track_ids) or selected - valid:
            _refuse("請選取專案內要回剪的軌道。")
    tracks = _tracks(timeline, document, rate, selected)
    files = _file_identities(projection["metadata"]["phasyn"]["media"], relinks)
    sources = {s["source_id"]: s for s in timeline["sources"]}
    context = _Import(rate, files, sources)
    restored = deepcopy(timeline)
    clips: list[Doc] = [
        deepcopy(c)
        for c in timeline["clips"]
        if selected is not None and c["track_id"] not in selected
    ]
    context.used.update(c["clip_id"] for c in clips)
    # Kdenlive can reverse the track stack in its exporter. Match names and kinds,
    # retain Studio's stacking order, and reject missing, duplicate or added tracks.
    available = [
        t for t in timeline["tracks"] if selected is None or t["track_id"] in selected
    ]
    # Editors may strip item metadata. Never infer that removing the covered portion of an
    # original track was an intentional cut when a baked composite represents that material.
    meta = document.get("metadata") or {}
    is_delivery = (
        isinstance(meta, dict)
        and isinstance(meta.get("phasyn"), dict)
        and bool(meta["phasyn"].get("delivery_profile"))
    )
    tracks_in_file = document["tracks"]["children"]
    is_delivery = is_delivery or (
        len(tracks_in_file) > len(timeline["tracks"])
        and any(t.get("name") == "Phasyn Composite" for t in tracks_in_file)
    )
    baked = delivery_regions(timeline) if is_delivery else []
    for track in tracks:
        name, kind = (
            str(track.get("name")).casefold(),
            str(track.get("kind")).casefold(),
        )
        matches = [
            t for t in available if t["name"].casefold() == name and t["kind"] == kind
        ]
        if len(matches) != 1:
            _refuse("無法依軌名與類型唯一對應專案軌道。")
        original = matches[0]
        available.remove(original)
        track_id = original["track_id"]
        if any(
            c["clip_id"] in r["clip_ids"]
            and c["start_frame"] < r["end"]
            and r["start"] < clip_end(c)
            for c in track_clips(timeline, track_id)
            for r in baked
        ):
            _refuse("此軌參與效果烘焙，請選取其他原始軌道；烘焙素材有獨立的內容身分。")
        projected = next(
            t
            for t in projection["tracks"]["children"]
            if t["metadata"].get("phasyn", {}).get("track_id") == track_id
        )
        if track.get("enabled", True) != projected["enabled"]:
            _refuse("回剪限於 cut、trim 與媒體重新連結。")
        clips.extend(
            _track_clips(track, original, track_clips(timeline, track_id), context)
        )
    if selected is None:
        _relink_pairs(clips)
    else:
        affected_links = {
            c.get("linked_id") for c in timeline["clips"] if c["track_id"] in selected
        }
        _relink_pairs([c for c in clips if c.get("linked_id") in affected_links])
    restored["clips"] = clips
    validate_timeline(restored)
    return restored
