"""The export run of a saved timeline, built without a browser (the twin of the editor's ``export.ts``).

:func:`export_request` turns a normalized project and the options of ``POST …/timeline/export`` into the run
request for ``media.concat``, or refuses with a stable reason. What the export component on the chosen Node can
do is stated by its descriptor (``facts.timeline_export``, see :class:`Exporter`): a component that does not
draw text itself only gets a timeline whose titles and captions have a current browser-made image, a component
that does not know version 2 gets a version 1 document, and a timeline with an adjustment layer goes only to a
component that composites them.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..canonical import canonical_json
from ..errors import ComponentError
from ..timeline import clip_enabled, validate_timeline
from ..typed import INLINE_MAX_BYTES
from .core import transition_pairs, without_transition
from .model import Doc, timeline_duration
from .normalize import TIMELINE_VERSION
from .rejection import reject, rejection_of
from .shots import PROXY_FIELDS
from .text import caption_fresh, title_fresh


PROVIDER_ID = "media.concat"
PIPELINE_ID = "studio-export"
SEQUENCE_TYPE = "media.sequence.v1"
QUALITY_CRF = {"high": 18, "standard": 23, "small": 28}
SIZES = {"720p": (1280, 720), "1080p": (1920, 1080)}
FITS = {"fill": "cover", "fit": "contain"}
BOOKKEEPING = ("placed_shot_ids", "migration_notes")


@dataclass(frozen=True)
class Exporter:
    """The export component of a run and what it understands (its descriptor's ``facts.timeline_export``).

    ``version``: the highest ``StudioTimeline.version`` it accepts (1 without the fact). ``text``: it draws titles,
    text layers and captions from the document itself; without it they must come with a current image.
    ``adjustment``: it composites adjustment layers (``TimelineSource.kind`` ``adjustment``); without it a timeline
    with one is refused (its contract would refuse the document, and leaving out even a switched-off layer could
    shorten the film).
    """

    node_id: str
    component_id: str
    version: int = 1
    text: bool = False
    adjustment: bool = False

    @classmethod
    def of(cls, descriptor: Mapping[str, Any]) -> Exporter:
        """Build an export representation from the timeline."""
        facts = (descriptor.get("facts") or {}).get("timeline_export")
        facts = facts if isinstance(facts, Mapping) else {}
        version = facts.get("version")
        return cls(
            str(descriptor["node_id"]),
            str(descriptor["component_id"]),
            version
            if isinstance(version, int) and not isinstance(version, bool)
            else 1,
            facts.get("text") is True,
            facts.get("adjustment") is True,
        )


def export_geometry(project: Mapping[str, Any], options: Mapping[str, Any]) -> Doc:
    """Output width, height and (when the size is not the render size) how clips are fitted into it."""
    frame, preset = project["format"], project.get("export_format")
    size = options.get("size")
    if size in SIZES:
        width, height = SIZES[size]
    elif size is None and preset is not None:
        width, height = preset["width"], preset["height"]
    else:
        return {"width": frame["width"], "height": frame["height"]}
    fit = (
        FITS[options["fit"]]
        if "fit" in options
        else (preset["fit"] if preset is not None else "cover")
    )
    return {"width": width, "height": height, "fit": fit}


def _render_range(
    timeline: Mapping[str, Any], options: Mapping[str, Any]
) -> Doc | None:
    if options.get("range", "full") != "work_area":
        return None
    area = timeline.get("work_area")
    if (
        area is None
        or area["start_frame"] >= area["end_frame"]
        or area["end_frame"] > timeline_duration(timeline)
    ):
        reject("work_area", "請先設定有效的序列入出點；匯出範圍不得超過序列長度")
    return dict(area)


def _require_rasters(timeline: Mapping[str, Any], width: int, height: int) -> None:
    """Every title and caption that will be drawn has an image of its current text at the output size."""
    for clip in timeline["clips"]:
        title = (clip.get("effects") or {}).get("title")
        if title and clip_enabled(clip) and not title_fresh(title, width, height):
            reject(
                "text_not_rasterized",
                f"「{clip['name']}」的文字圖層尚未產生或已過期；這個匯出元件不會自行繪製文字，請改從瀏覽器匯出",
                clip_id=clip["clip_id"],
            )
    for caption in timeline["captions"]:
        if not caption_fresh(caption, width, height):
            reject(
                "text_not_rasterized",
                "字幕的文字圖層尚未產生或已過期；這個匯出元件不會自行繪製文字，請改從瀏覽器匯出",
                caption_id=caption["caption_id"],
            )


def _rasterized_text(timeline: Doc, width: int, height: int) -> None:
    """Text layers as image clips of their rasters (the text stays editable in the saved project)."""
    kinds = {source["source_id"]: source for source in timeline["sources"]}
    taken = set(kinds)
    serial = 0
    for clip in timeline["clips"]:
        source = kinds[clip["source_id"]]
        if source["kind"] != "text":
            continue
        effects = dict(clip.get("effects") or {})
        title = effects.pop("title")
        while f"text-render.{serial}" in taken:
            serial += 1
        raster = f"text-render.{serial}"
        taken.add(raster)
        timeline["sources"].append(
            {
                "source_id": raster,
                "name": clip["name"],
                "kind": "image",
                "file": title["image"],
                "width": width,
                "height": height,
                "duration_frames": source["duration_frames"],
                "has_audio": False,
            }
        )
        clip["source_id"] = raster
        clip["effects"] = effects


def _without_disabled(timeline: Doc) -> None:
    """Version 1 has no disabled clips: leave them out, and a transition into one becomes a cut."""
    disabled = {clip["clip_id"] for clip in timeline["clips"] if not clip_enabled(clip)}
    alone = {
        pair.left_id for pair in transition_pairs(timeline) if pair.right_id in disabled
    }
    timeline["clips"] = [
        {
            key: value
            for key, value in (
                without_transition(clip) if clip["clip_id"] in alone else clip
            ).items()
            if key != "enabled"
        }
        for clip in timeline["clips"]
        if clip["clip_id"] not in disabled
    ]


def _require_adjustments(timeline: Mapping[str, Any]) -> None:
    """A component that cannot composite adjustment layers gets no timeline with one: it is refused, never rendered without the layer."""
    adjustments = {
        source["source_id"]
        for source in timeline["sources"]
        if source["kind"] == "adjustment"
    }
    for clip in timeline["clips"]:
        if clip["source_id"] in adjustments:
            reject(
                "adjustment_unsupported",
                f"「{clip['name']}」是調整圖層，這個匯出元件還不能合成；請更新 Node 並重啟後再匯出，或先移除調整圖層",
                clip_id=clip["clip_id"],
            )


def _without_cuts(timeline: Doc) -> None:
    """Where a transition's cut is only tells the editor what to give back when it goes; the export draws the overlap, and an export component that predates cuts refuses the member."""
    for clip in timeline["clips"]:
        transition = (clip.get("effects") or {}).get("transition_out")
        if transition and "cut" in transition:
            plain = {key: value for key, value in transition.items() if key != "cut"}
            clip["effects"] = {**clip["effects"], "transition_out": plain}


def render_snapshot(
    timeline: Mapping[str, Any], exporter: Exporter, width: int, height: int
) -> Doc:
    """The timeline as the export component gets it: no playback proxies, no bookkeeping, only media it can use."""
    snapshot: Doc = copy.deepcopy(
        {key: value for key, value in timeline.items() if key not in BOOKKEEPING}
    )
    _without_cuts(snapshot)
    if not exporter.adjustment:
        _require_adjustments(snapshot)
    if not exporter.text:
        _require_rasters(snapshot, width, height)
        _rasterized_text(snapshot, width, height)
    if exporter.version < TIMELINE_VERSION:
        _without_disabled(snapshot)
        snapshot["version"] = 1
    used = {clip["source_id"] for clip in snapshot["clips"]}
    snapshot["sources"] = [
        {
            key: value
            for key, value in source.items()
            if key not in PROXY_FIELDS and key != "pending_take_id"
        }
        for source in snapshot["sources"]
        if source["source_id"] in used
    ]
    return snapshot


def _exported_shots(timeline: Mapping[str, Any]) -> list[str]:
    """The shots the export shows, in the order they first appear."""
    shots = {
        source["source_id"]: source.get("shot_id") for source in timeline["sources"]
    }
    ordered = sorted(
        (clip for clip in timeline["clips"] if clip_enabled(clip)),
        key=lambda clip: clip["start_frame"],
    )
    return list(
        dict.fromkeys(
            str(shots[clip["source_id"]])
            for clip in ordered
            if shots.get(clip["source_id"])
        )
    )


def export_request(
    project: Mapping[str, Any], options: Mapping[str, Any], exporter: Exporter
) -> Doc:
    """``{"body": <RunRequest>, "frames": <frames the export will have>, "shot_ids": [...]}`` for a project.

    ``project`` is a normalized Studio project and ``options`` a ``StudioTimelineExportRequest``. Raises
    :class:`TimelineRejected` (``empty_timeline``, ``not_rendered``, ``work_area``, ``text_not_rasterized``,
    ``adjustment_unsupported``, ``limit_exceeded`` or a validator reason) when the timeline cannot be exported as it
    is.
    """
    timeline = project.get("timeline")
    if timeline is None:
        reject("empty_timeline", "時間軸沒有可匯出的內容")
    try:
        validate_timeline(timeline, for_export=True)
    except ComponentError as error:
        raise rejection_of(error) from error
    area = _render_range(timeline, options)
    geometry = export_geometry(project, options)
    snapshot = render_snapshot(
        timeline, exporter, geometry["width"], geometry["height"]
    )
    try:
        validate_timeline(snapshot, for_export=True)
    except ComponentError as error:
        raise rejection_of(error) from error
    value: Doc = {
        "clips": [],
        "timeline": snapshot,
        **({"render_range": area} if area else {}),
        **geometry,
    }
    value["fps"] = dict(timeline["fps"])
    size = len(canonical_json(value))
    if size > INLINE_MAX_BYTES:
        reject(
            "limit_exceeded",
            "時間軸太大，無法一次送交匯出元件；請減少片段、關鍵影格或字幕",
            bytes=size,
            limit=INLINE_MAX_BYTES,
        )
    label = f"Studio：{project['title']}・多軌匯出"
    parameters = {
        "crf": QUALITY_CRF[options.get("quality", "high")],
        "preset": options.get("speed", "medium"),
        "audio_bitrate": int(options.get("audio_kbps", 192)) * 1000,
        # Only when asked, so an export without a loudness target builds exactly the request it did before.
        **(
            {"loudness_lufs": int(options["loudness"])}
            if options.get("loudness") is not None
            else {}
        ),
    }
    step = {
        "step_id": "concat",
        "node_id": exporter.node_id,
        "component_id": exporter.component_id,
        "inputs": {"sequence": {"from_input": "sequence"}},
        "parameters": parameters,
    }
    port = {
        "name": "sequence",
        "type_id": SEQUENCE_TYPE,
        "required": True,
        "transport": "inline",
    }
    body = {
        "pipeline": {
            "pipeline_id": PIPELINE_ID,
            "label": label,
            "inputs": [{**port, "description": "多軌剪輯序列"}],
            "steps": [step],
            "outputs": {"final": {"from_step": "concat", "output": "asset"}},
        },
        "inputs": {"sequence": {"type_id": SEQUENCE_TYPE, "value": value}},
        "label": label,
    }
    if (
        isinstance(project.get("project_id"), str)
        and type(project.get("revision")) is int
    ):
        # CLI, MCP and Studio use the same export-origin note. The frozen sequence remains available on the run.
        body["origin"] = {
            "note": canonical_json(
                {
                    "type": "studio.timeline-export.v1",
                    "project_id": project["project_id"],
                    "revision": project["revision"],
                    "snapshot_sha256": None,
                }
            ).decode("utf-8")
        }
    frames = (
        area["end_frame"] - area["start_frame"] if area else timeline_duration(snapshot)
    )
    return {"body": body, "frames": frames, "shot_ids": _exported_shots(timeline)}


__all__ = [
    "PROVIDER_ID",
    "Exporter",
    "export_geometry",
    "export_request",
    "render_snapshot",
]
