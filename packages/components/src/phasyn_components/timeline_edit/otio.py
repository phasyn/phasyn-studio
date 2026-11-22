"""OpenTimelineIO interchange of a normalized Studio timeline, using the native OTIO JSON schemas.

External references use bundle-relative, content-addressed names. The caller copies and verifies
the media described by the manifest. This module performs no file or network operations.
"""

from __future__ import annotations

import json
from copy import deepcopy
from fractions import Fraction
from typing import Any

from ..errors import ComponentError
from ..timeline import (
    clip_duration,
    clip_enabled,
    clip_output_window,
    validate_timeline,
)
from .handles import cut_of
from .model import (
    Doc,
    active_transition,
    default_motion,
    timeline_duration,
    track_clips,
)


_FORMAT = "phasyn.studio.otio.v1"
_COLORS = {
    "amber": "YELLOW",
    "blue": "BLUE",
    "green": "GREEN",
    "rose": "PINK",
    "violet": "PURPLE",
}
_SUFFIX = {
    "audio/flac": "flac",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
}


def _time(frame: int, rate: float) -> Doc:
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": rate, "value": float(frame)}


def _range(start: int, length: int, rate: float) -> Doc:
    return {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": _time(start, rate),
        "duration": _time(length, rate),
    }


def _item(schema: str, name: str, time_range: Doc | None, **fields: Any) -> Doc:
    return {
        "OTIO_SCHEMA": schema,
        "name": name,
        "metadata": {},
        "source_range": time_range,
        "effects": [],
        "markers": [],
        "enabled": True,
        "color": None,
        **fields,
    }


def _media(file: Doc | None) -> Doc | None:
    if file is None:
        return None
    suffix = _SUFFIX.get(file["media_type"], "bin")
    return {
        "target_url": f"media/{file['sha256']}.{suffix}",
        **{
            key: file[key]
            for key in ("node_id", "file_id", "sha256", "size_bytes", "media_type")
        },
    }


def _manifest(source: Doc) -> Doc:
    return {
        "source_id": source["source_id"],
        "name": source["name"],
        "kind": source["kind"],
        "shot_id": source.get("shot_id"),
        "take_id": source.get("take_id"),
        "library_id": source.get("library_id"),
        "original": _media(source["file"]),
        "proxy": _media((source.get("proxy") or {}).get("file")),
    }


def _marker(name: str, color: str, time_range: Doc, identity: Doc) -> Doc:
    return {
        "OTIO_SCHEMA": "Marker.2",
        "name": name,
        "color": color,
        "marked_range": time_range,
        "comment": "",
        "metadata": {"phasyn": identity},
    }


_NORMAL_SPEED = 100


def _offline_reason(clip: Doc, source: Doc) -> str | None:
    effects = clip.get("effects") or {}
    if (
        effects.get("speed_percent", 100) != _NORMAL_SPEED
        or effects.get("frame_step", 1) != 1
        or any((effects.get("hold") or {}).values())
    ):
        return "retiming_requires_bake"
    if source["kind"] in ("text", "adjustment"):
        return "generated_layer_requires_bake"
    if source["file"] is None:
        return "source_media_unavailable"
    return None


def _visual_effects(clip: Doc) -> list[str]:
    effects = sorted(
        set(clip.get("effects") or {})
        - {"speed_percent", "frame_step", "hold", "transition_out"}
    )
    if clip["motion"] != default_motion():
        effects.append("motion")
    if clip.get("effect_stack"):
        effects.append("effect_stack")
    if clip.get("mask"):
        effects.append("mask")
    if clip.get("blend_mode", "normal") != "normal":
        effects.append("blend_mode")
    return effects


def _clip_item(
    clip: Doc, source: Doc, handles: tuple[int, int], rate: float, report: list[Doc]
) -> Doc:
    before, after = handles
    duration = clip_duration(clip)
    length = duration - before - after
    reason = _offline_reason(clip, source)
    identity = {
        "clip_id": clip["clip_id"],
        "source_id": source["source_id"],
        "linked_id": clip.get("linked_id"),
        "shot_id": source.get("shot_id"),
        "take_id": source.get("take_id"),
    }
    file = _media(source["file"])
    ref: Doc = {
        "OTIO_SCHEMA": "MissingReference.1",
        "name": source["name"],
        "metadata": {},
        "available_image_bounds": None,
        "available_range": _range(0, duration, rate),
    }
    start = before
    if reason is None and file is not None:
        ref.update(
            {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": file["target_url"],
                "available_range": _range(0, source["duration_frames"], rate),
            }
        )
        start += clip["in_frame"] + clip_output_window(clip)[0]
    else:
        report.append(
            {
                "clip_id": clip["clip_id"],
                "code": reason,
                "representation": "offline_clip",
            }
        )
    unsupported = _visual_effects(clip)
    if unsupported:
        report.append(
            {
                "clip_id": clip["clip_id"],
                "code": "properties_metadata_only",
                "fields": unsupported,
            }
        )
    return _item(
        "Clip.2",
        clip["name"],
        _range(start, length, rate),
        metadata={"phasyn": identity},
        enabled=clip_enabled(clip),
        media_references={"DEFAULT_MEDIA": ref},
        active_media_reference_key="DEFAULT_MEDIA",
    )


def _transition(clip: Doc, fx: Doc, cut: Doc, rate: float, report: list[Doc]) -> Doc:
    native = fx["kind"] == "crossfade"
    if not native:
        report.append(
            {
                "clip_id": clip["clip_id"],
                "code": "custom_transition",
                "kind": fx["kind"],
                "representation": "timed_custom_transition",
            }
        )
    return {
        "OTIO_SCHEMA": "Transition.1",
        "name": fx["kind"],
        "metadata": {"phasyn": {"clip_id": clip["clip_id"], "settings": fx}},
        "transition_type": "SMPTE_Dissolve" if native else "Custom_Transition",
        "in_offset": _time(cut["incoming"]["frames"], rate),
        "out_offset": _time(cut["outgoing"]["frames"], rate),
    }


def _track(
    track: Doc,
    clips: list[Doc],
    sources: dict[str, Doc],
    rate: float,
    report: list[Doc],
) -> Doc:
    items: list[Doc] = []
    cursor = before = 0
    for clip in clips:
        fx = active_transition(clip.get("effects"))
        cut = cut_of(fx) if fx else None
        after = cut["outgoing"]["frames"] if cut else 0
        start = clip["start_frame"] + before
        if start > cursor:
            items.append(_item("Gap.1", "", _range(0, start - cursor, rate)))
        items.append(
            _clip_item(clip, sources[clip["source_id"]], (before, after), rate, report)
        )
        cursor = clip["start_frame"] + clip_duration(clip) - after
        before = cut["incoming"]["frames"] if cut else 0
        if fx and cut:
            items.append(_transition(clip, fx, cut, rate, report))
    if track["gain_db"] or track["pan"]:
        report.append(
            {"track_id": track["track_id"], "code": "track_mix_metadata_only"}
        )
    return _item(
        "Track.1",
        track["name"],
        None,
        kind=track["kind"].title(),
        children=items,
        metadata={"phasyn": {"track_id": track["track_id"]}},
    )


def export_timeline(timeline: Doc, *, name: str = "Phasyn Studio") -> Doc:
    """Return a native .otio JSON document, including the relink manifest and conversion report."""
    validate_timeline(timeline)
    timeline = deepcopy(timeline)
    fps = timeline["fps"]
    rate = float(Fraction(fps["num"], fps["den"]))
    sources = {source["source_id"]: source for source in timeline["sources"]}
    report: list[Doc] = []
    tracks = []
    solo = {track["kind"] for track in timeline["tracks"] if track["solo"]}
    for track in timeline["tracks"]:
        item = _track(
            track, track_clips(timeline, track["track_id"]), sources, rate, report
        )
        item["enabled"] = not track["muted"] and (
            track["kind"] not in solo or track["solo"]
        )
        tracks.append(item)
    markers = [
        _marker(
            marker["name"],
            _COLORS[marker["color"]],
            _range(marker["frame"], 0, rate),
            {"marker_id": marker["marker_id"]},
        )
        for marker in timeline["markers"]
    ]
    for caption in timeline["captions"]:
        bounds = _range(
            caption["start_frame"], caption["end_frame"] - caption["start_frame"], rate
        )
        markers.append(
            _marker(
                caption["text"], "WHITE", bounds, {"caption_id": caption["caption_id"]}
            )
        )
        report.append(
            {"caption_id": caption["caption_id"], "code": "caption_as_range_marker"}
        )
    if timeline["master_gain_db"]:
        report.append({"code": "master_gain_metadata_only"})
    # A marker contributes no duration in OTIO. Pad past the last clip only when a Studio caption extends the sequence.
    last_clip = max(
        (clip["start_frame"] + clip_duration(clip) for clip in timeline["clips"]),
        default=0,
    )
    end = timeline_duration(timeline)
    if end > last_clip:
        tracks.append(
            _item(
                "Track.1",
                "Caption extent",
                None,
                kind="Video",
                children=[_item("Gap.1", "", _range(0, end, rate))],
            )
        )
    return {
        "OTIO_SCHEMA": "Timeline.1",
        "name": name,
        "global_start_time": _time(0, rate),
        "metadata": {
            "phasyn": {
                "format": _FORMAT,
                "fps": fps,
                "snapshot_json": json.dumps(
                    timeline,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ),
                "media": [_manifest(source) for source in sources.values()],
                "auxiliary": _auxiliary_media(timeline),
                "report": report,
            }
        },
        "tracks": _item("Stack.1", "tracks", None, children=tracks, markers=markers),
    }


def restore_timeline(document: Doc) -> Doc:
    """Restore the exact Studio snapshot after checking its OTIO projection, including placement and media URLs."""
    metadata = document.get("metadata")
    record = metadata.get("phasyn") if isinstance(metadata, dict) else None
    if (
        not isinstance(record, dict)
        or record.get("format") != _FORMAT
        or not isinstance(record.get("snapshot_json"), str)
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", "這份 OTIO 缺少可還原的 Phasyn Studio 時間軸快照。"
        )
    try:
        snapshot = json.loads(record["snapshot_json"])
    except (ValueError, RecursionError) as error:
        raise ComponentError(
            "INVALID_ARGUMENT", "OTIO 內的 Phasyn Studio 時間軸快照無法解析。"
        ) from error
    if not isinstance(snapshot, dict):
        raise ComponentError(
            "INVALID_ARGUMENT", "OTIO 內的 Phasyn Studio 時間軸快照必須是物件。"
        )
    if not isinstance(document.get("name"), str) or document != export_timeline(
        snapshot, name=document["name"]
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            "OTIO 剪輯內容與 Studio 快照不同；請核對外部修改後再還原。",
        )
    return snapshot


def _auxiliary_media(timeline: Doc) -> list[Doc]:
    """Locate caption and title raster assets which accompany the editable timeline."""
    items = [
        {
            "owner_id": caption["caption_id"],
            "name": caption["text"],
            "role": "caption_image",
            "file": _media(caption["image"]),
        }
        for caption in timeline["captions"]
        if caption.get("image")
    ]
    for clip in timeline["clips"]:
        title = (clip.get("effects") or {}).get("title") or {}
        if title.get("image"):
            items.append(
                {
                    "owner_id": clip["clip_id"],
                    "name": clip["name"],
                    "role": "title_image",
                    "file": _media(title["image"]),
                }
            )
    return items


def export_project(project: Doc) -> Doc:
    """Describe one stored project revision, its projected edit and the takes referenced by its timeline."""
    timeline = project.get("timeline")
    if not isinstance(timeline, dict):
        raise ComponentError("INVALID_ARGUMENT", "這個專案尚未儲存時間軸。")
    document = export_timeline(timeline, name=project["title"])
    linked = {
        (source.get("shot_id"), source.get("take_id")) for source in timeline["sources"]
    }
    takes = [
        {
            "shot_id": shot["shot_id"],
            "shot_name": shot.get("title"),
            "take_id": take["take_id"],
            **{
                key: take.get(key)
                for key in ("run_id", "prompt", "seed", "route", "steps")
            },
        }
        for shot in project.get("shots", [])
        for take in shot.get("takes", [])
        if (shot["shot_id"], take["take_id"]) in linked
    ]
    return {
        "project_id": project["project_id"],
        "title": project["title"],
        "revision": project["revision"],
        "document": document,
        "takes": takes,
    }
