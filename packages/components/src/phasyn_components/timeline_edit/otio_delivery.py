"""Kdenlive delivery projection with frame-addressed composite replacements."""

from __future__ import annotations

from collections import defaultdict
from copy import deepcopy

from ..canonical import canonical_json, digest
from ..errors import ComponentError
from ..timeline import clip_enabled
from .model import Doc, active_transition, clip_end, timeline_duration
from .otio import _item, _offline_reason, _range, _visual_effects


_HANDLE = 12
_MAX_STEPS = 256


def _affected(timeline: Doc, track: Doc, clip: Doc, source: Doc) -> bool:
    reason = _offline_reason(clip, source)
    if reason in {"retiming_requires_bake", "generated_layer_requires_bake"}:
        return True
    if track["kind"] == "video":
        return bool(_visual_effects(clip))
    motion, fx = clip["motion"], clip.get("effects") or {}
    keys = motion.get("keyframes") or {}
    fade = fx.get("fade") or {}
    return any(
        (
            track["gain_db"],
            track["pan"],
            timeline["master_gain_db"],
            motion["gain_db"],
            motion["pan"],
            keys.get("gain_db"),
            keys.get("pan"),
            fx.get("mute"),
            fx.get("volume_db"),
            fade.get("audio_in"),
            fade.get("audio_out"),
        )
    )


def delivery_regions(timeline: Doc) -> list[Doc]:
    """Merge overlapping visual effects across tracks; plan sound per original track."""
    spans: dict[tuple[str, str], list[tuple[int, int]]] = defaultdict(list)
    tracks = {t["track_id"]: t for t in timeline["tracks"]}
    sources = {s["source_id"]: s for s in timeline["sources"]}
    solo = {t["kind"] for t in tracks.values() if t["solo"]}
    contributors: dict[tuple[str, str], list[Doc]] = defaultdict(list)
    for clip in timeline["clips"]:
        track = tracks[clip["track_id"]]
        if (
            not clip_enabled(clip)
            or track["muted"]
            or (track["kind"] in solo and not track["solo"])
        ):
            continue
        layer = (
            ("video", "") if track["kind"] == "video" else ("audio", track["track_id"])
        )
        contributors[layer].append(clip)
        end = clip_end(clip)
        if _affected(timeline, track, clip, sources[clip["source_id"]]):
            spans[layer].append((clip["start_frame"], end))
        if transition := active_transition(clip.get("effects")):
            spans[layer].append((end - transition["frames"], end))
    for caption in timeline["captions"]:
        spans["video", ""].append((caption["start_frame"], caption["end_frame"]))
    end_frame = timeline_duration(timeline)
    result: list[Doc] = []
    for layer, ranges in sorted(spans.items()):
        merged: list[tuple[int, int]] = []
        for a, b in sorted(ranges):
            if merged and a <= merged[-1][1]:
                merged[-1] = merged[-1][0], max(merged[-1][1], b)
            else:
                merged.append((a, b))
        available = (
            end_frame
            if layer[0] == "video"
            else max(clip_end(c) for c in contributors[layer])
        )
        for start, end in merged:
            first, last = max(0, start - _HANDLE), min(available, end + _HANDLE)
            result.append(
                {
                    "key": f"bake{len(result) + 1}",
                    "kind": layer[0],
                    "track_id": layer[1] or None,
                    "start": start,
                    "end": end,
                    "first": first,
                    "last": last,
                    "clip_ids": [
                        c["clip_id"]
                        for c in contributors[layer]
                        if c["start_frame"] < last and first < clip_end(c)
                    ],
                    "caption_ids": [
                        c["caption_id"]
                        for c in timeline["captions"]
                        if layer[0] == "video"
                        and c["start_frame"] < last
                        and first < c["end_frame"]
                    ],
                }
            )
    return result


def _baked_clip(region: Doc, rate: float) -> Doc:
    ref = {
        "OTIO_SCHEMA": "ExternalReference.1",
        "name": region["key"],
        "metadata": {},
        "available_image_bounds": None,
        "target_url": region["target_url"],
        "available_range": _range(0, region["last"] - region["first"], rate),
    }
    return _item(
        "Clip.2",
        region["key"],
        _range(
            region["start"] - region["first"], region["end"] - region["start"], rate
        ),
        metadata={
            "phasyn": {"delivery_bake": region["key"], "sha256": region["sha256"]}
        },
        active_media_reference_key="DEFAULT_MEDIA",
        media_references={"DEFAULT_MEDIA": ref},
    )


def _editable_parts(
    track: Doc, regions: list[Doc], rate: float
) -> list[tuple[int, Doc]]:
    pieces: list[tuple[int, Doc]] = []
    cursor = 0
    for item in track["children"]:
        # An OTIO transition overlaps adjacent items without advancing the cut.
        if item["OTIO_SCHEMA"] == "Transition.1":
            continue
        span = item["source_range"]
        end = cursor + int(span["duration"]["value"])
        if item["OTIO_SCHEMA"] == "Clip.2":
            first = cursor
            for region in regions:
                if region["end"] <= first or region["start"] >= end:
                    continue
                if first < region["start"]:
                    pieces.append(
                        (
                            first,
                            _slice(item, first - cursor, region["start"] - first, rate),
                        )
                    )
                first = max(first, region["end"])
            if first < end:
                pieces.append((first, _slice(item, first - cursor, end - first, rate)))
        cursor = end
    return pieces


def _slice(item: Doc, offset: int, length: int, rate: float) -> Doc:
    value = deepcopy(item)
    start = int(value["source_range"]["start_time"]["value"])
    value["source_range"] = _range(start + offset, length, rate)
    return value


def _sequence(parts: list[tuple[int, Doc]], rate: float) -> list[Doc]:
    cursor = 0
    children = []
    for start, item in sorted(parts, key=lambda row: row[0]):
        if start > cursor:
            children.append(_item("Gap.1", "", _range(0, start - cursor, rate)))
        children.append(item)
        cursor = start + int(item["source_range"]["duration"]["value"])
    return children


def delivery_document(document: Doc, regions: list[Doc]) -> Doc:
    """Replace covered intervals on every contributing layer while preserving the editable snapshot separately."""
    delivery = deepcopy(document)
    rate = delivery["global_start_time"]["rate"]
    tracks = delivery["tracks"]["children"]
    videos = [r for r in regions if r["kind"] == "video"]
    for track in tracks:
        if not track["enabled"]:
            continue
        track_id = track["metadata"].get("phasyn", {}).get("track_id")
        sound = [
            r for r in regions if r["kind"] == "audio" and r["track_id"] == track_id
        ]
        affected = videos if track["kind"] == "Video" else sound
        if affected:
            parts = _editable_parts(track, affected, rate)
            parts.extend((r["start"], _baked_clip(r, rate)) for r in sound)
            track["children"] = _sequence(parts, rate)
    if videos:
        children = _sequence([(r["start"], _baked_clip(r, rate)) for r in videos], rate)
        tracks.append(
            _item("Track.1", "Phasyn Composite", None, children=children, kind="Video")
        )
    delivery["metadata"]["phasyn"]["delivery_profile"] = "kdenlive-composite-v1"
    return delivery


def _sequence_input(reference: Doc, asset: Doc, region: Doc) -> Doc:
    area = {"start_frame": region["first"], "end_frame": region["last"]}
    if region["kind"] == "video":
        # Full compositing, captions and cross-track masks are already in this
        # revision-verified file. Its sound belongs on the independent tracks.
        return {
            "clips": [
                {
                    "asset": {**asset, "actual_settings": {}},
                    "in_frame": region["first"],
                    "out_frame": region["last"],
                    "effects": {"mute": True},
                }
            ],
            "fps": asset["fps"],
            "width": asset["width"],
            "height": asset["height"],
        }
    sequence = reference["request"]["inputs"]["sequence"]["value"]
    timeline = sequence["timeline"]
    track = next(t for t in timeline["tracks"] if t["track_id"] == region["track_id"])
    clips = [c for c in timeline["clips"] if c["track_id"] == region["track_id"]]
    sources = {c["source_id"] for c in clips}
    # Keep the stem in the original sequence clock. Other tracks' image assets
    # and text rasters are unrelated to its sound and need no transfer to the Node.
    return {
        **sequence,
        "render_range": area,
        "timeline": {
            **timeline,
            "tracks": [{**track, "solo": False, "muted": False}],
            "clips": clips,
            "sources": [s for s in timeline["sources"] if s["source_id"] in sources],
            "captions": [],
            "markers": [],
        },
    }


def bake_request(project: Doc, regions: list[Doc], reference: Doc, asset: Doc) -> Doc:
    """Freeze one standard Node operation per composite interval or affected audio stem."""
    if not 0 < len(regions) <= _MAX_STEPS:
        raise ComponentError("INVALID_ARGUMENT", "效果素材區段數必須介於 1 至 256。")
    renderer = reference["request"]["pipeline"]["steps"][0]
    pipe: Doc = {
        "pipeline_id": "studio-delivery-bakes",
        "label": "剪輯交付效果素材",
        "steps": [],
        "inputs": [],
        "outputs": {},
    }
    inputs = {}
    for region in regions:
        key = region["key"]
        pipe["inputs"].append(
            {
                "name": key,
                "type_id": "media.sequence.v1",
                "required": True,
                "transport": "inline",
                "description": "含修剪餘裕的交付區段",
            }
        )
        inputs[key] = {
            "type_id": "media.sequence.v1",
            "value": _sequence_input(reference, asset, region),
        }
        params = {
            **renderer["parameters"],
            **({"audio_only": True} if region["kind"] == "audio" else {"crf": 0}),
        }
        pipe["steps"].append(
            {
                **renderer,
                "step_id": key,
                "inputs": {"sequence": {"from_input": key}},
                "parameters": params,
            }
        )
        pipe["outputs"][key] = {"from_step": key, "output": "asset"}
    origin = {
        "type": "studio.otio-bakes.v1",
        "project_id": project["project_id"],
        "reference_run_id": reference["run_id"],
        "timeline_sha256": digest(project["timeline"]),
        "reference_sha256": asset["file"]["sha256"],
    }
    return {
        "pipeline": pipe,
        "inputs": inputs,
        "origin": {"note": canonical_json(origin).decode()},
    }
