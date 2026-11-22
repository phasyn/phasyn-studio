"""Freeze a single-layer, native-frame retake against the selected source revision."""

from __future__ import annotations

import copy
import json
from fractions import Fraction
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.timeline import clip_output_window
from phasyn_components.timeline_edit.model import (
    clip_end,
    find_source,
    find_track,
)
from phasyn_components.timeline_edit.retake_visuals import compatible_visuals

from .revisions import require_revision
from .runner.plan import plan_run
from .studio_gap_plan import refused
from .studio_take_source import published_video, step_source


if TYPE_CHECKING:
    from .state import Controller

type Doc = dict[str, Any]


def _visible_source(
    timeline: Doc, track_id: str, start: int, end: int
) -> tuple[Doc, Doc]:
    track = find_track(timeline, track_id)
    if (
        not track
        or track["kind"] != "video"
        or track["locked"]
        or track["muted"]
        or (
            any(t["kind"] == "video" and t["solo"] for t in timeline["tracks"])
            and not track["solo"]
        )
    ):
        raise refused("請選取可編輯且可見的影像軌")
    overlaps = [
        c
        for c in timeline["clips"]
        if c["track_id"] == track_id and c["start_frame"] < end and clip_end(c) > start
    ]
    if (
        len(overlaps) != 1
        or start < overlaps[0]["start_frame"]
        or end > clip_end(overlaps[0])
        or end <= start
    ):
        raise refused("重製範圍必須完整落在同一個未重疊的影片片段")
    clip = overlaps[0]
    source = find_source(timeline, clip["source_id"])
    if (
        not source
        or source["kind"] != "video"
        or not source["file"]
        or source.get("pending_take_id")
        or not clip.get("enabled", True)
    ):
        raise refused("選定片段尚無可用的原始影片")
    if not compatible_visuals(clip):
        raise refused(
            "原生重製支援原速片段的固定縮放與調色；請先移除保持格、轉場與其他畫面特效"
        )
    return clip, source


def _same_content(first: Doc, second: Doc) -> bool:
    return all(first.get(k) == second.get(k) for k in ("sha256", "size_bytes"))


def _rate(value: object) -> Fraction:
    if not isinstance(value, dict) or any(
        type(value.get(k)) is not int or value[k] < 1 for k in ("num", "den")
    ):
        raise refused("缺少可信的原始影格率")
    return Fraction(value["num"], value["den"])


def _probe_clock(ctl: Controller, run_id: str, key: str, source: Doc) -> Doc:
    run = ctl.runs.read(run_id)
    edge = run["request"]["pipeline"]["outputs"].get(key, {})
    step, typed = step_source(run, edge)
    record = run["steps"][step["step_id"]]
    if (
        run["state"] != "succeeded"
        or typed != run["outputs"].get(key)
        or typed.get("type_id") != "media.probe.v1"
        or not record.get("recording_id")
        or (record.get("invoke_snapshot") or {}).get("frame_clock") is not True
    ):
        raise refused("請選取已完成且留有來源紀錄的影格時鐘探測")
    recording = ctl.store.get(record["recording_id"])
    identity = {
        "provider_id": "media.probe",
        "operation": "invoke",
        "run_id": run_id,
        "node_id": step["node_id"],
        "component_id": step["component_id"],
        "call_id": record.get("call_id"),
        "recording_id": record["recording_id"],
    }
    if (
        not identity["call_id"]
        or record.get("node_id") != step["node_id"]
        or record.get("component_id") != step["component_id"]
        or recording["summary"].get("state") != "succeeded"
        or any(recording["context"].get(k) != v for k, v in identity.items())
    ):
        raise refused("無法核對影格時鐘的產生元件與執行紀錄")
    binding = step["inputs"].get("media", {})
    if "from_input" in binding:
        value = run["request"]["inputs"].get(binding["from_input"], {})
    elif "from_step" in binding:
        _, value = step_source(run, binding)
    else:
        value = binding.get("literal", {})
    clock = (typed.get("value") or {}).get("frame_clock") or {}
    if (
        value.get("type_id") != "media.video.v1"
        or not _same_content(value.get("file") or {}, source["file"])
        or clock.get("kind") != "cfr"
        or clock.get("source_sha256") != source["file"]["sha256"]
        or clock.get("source_size_bytes") != source["file"]["size_bytes"]
        or type(clock.get("first_pts")) is not int
    ):
        raise refused("影格時鐘必須實測同一支固定影格率的原始影片")
    _rate(clock.get("time_base") or {})
    return clock


def _source_clock(
    ctl: Controller, project: Doc, source: Doc, body: Doc
) -> tuple[Fraction, int, str | None]:
    origin = source.get("candidate_origin", source)
    parent = None
    clock: Doc | None = None
    if origin.get("take_id") and origin.get("shot_id"):
        take = next(
            (
                take
                for shot in project["shots"]
                if shot["shot_id"] == origin["shot_id"]
                for take in shot["takes"]
                if take["take_id"] == origin["take_id"]
            ),
            None,
        )
        asset = (take or {}).get("asset") or {}
        if (
            take
            and take["state"] == "succeeded"
            and asset.get("complete")
            and _same_content(asset["file"], source["file"])
        ):
            clock, parent = asset, take["run_id"]
    elif origin.get("run_id") and origin.get("output_key"):
        run = ctl.runs.read(origin["run_id"])
        asset = published_video(run, origin["output_key"])
        if run["state"] == "succeeded" and _same_content(asset["file"], source["file"]):
            clock, parent = asset, run["run_id"]
    if bool(body.get("probe_run_id")) != bool(body.get("probe_output_key")):
        raise refused("探測執行與輸出名稱必須一起指定")
    if body.get("probe_run_id"):
        clock = _probe_clock(
            ctl, body["probe_run_id"], body["probe_output_key"], source
        )
    if (
        not clock
        or type(clock.get("frame_count")) is not int
        or clock["frame_count"] < 1
    ):
        raise refused("請先對原始影片執行「影片影格時鐘」，再選取該探測輸出")
    return _rate(clock.get("fps") or {}), clock["frame_count"], parent


def _declared(pipe: Doc, descriptions: dict[tuple[str, str], Doc]) -> tuple[Doc, Doc]:
    found = []
    for step in pipe["steps"]:
        desc = descriptions.get((step["node_id"].lower(), step["component_id"]), {})
        edit = (desc.get("facts") or {}).get("studio_edit")
        if (
            not isinstance(edit, dict)
            or type(edit.get("version")) is not int
            or edit["version"] != 1
        ):
            continue
        ops = edit.get("operations")
        op = ops.get("native_retake") if isinstance(ops, dict) else None
        selector = edit.get("selector")
        if (
            not isinstance(op, dict)
            or not isinstance(selector, str)
            or not isinstance(op.get("inputs"), dict)
            or not isinstance(op.get("parameters"), dict)
            or not isinstance(op.get("value"), str)
            or step.get("parameters", {}).get(selector) != op["value"]
            or edit.get("timebase") != "frames"
            or edit.get("interval") != "half_open"
            or op.get("clock") != "source"
            or op.get("output_range") != "selection_only"
        ):
            continue
        outputs = edit.get("outputs")
        port = outputs.get("asset") if isinstance(outputs, dict) else None
        if not isinstance(port, str) or not any(
            p["name"] == port and p["type_id"] == "media.asset.v1"
            for p in desc.get("outputs", [])
        ):
            continue
        if not any(
            edge == {"from_step": step["step_id"], "output": port}
            for edge in pipe["outputs"].values()
        ):
            continue
        fields = op.get("parameters", {})
        boundaries = [fields.get(k) for k in ("start_frame", "end_frame")]
        if (
            all(isinstance(n, str) and n for n in boundaries)
            and selector not in boundaries
            and boundaries[0] != boundaries[1]
        ):
            found.append((step, op))
    if len(found) != 1:
        raise refused("請選取含單一原生局部重製操作且公開成片的元件組合")
    return found[0]


def _external(pipe: Doc, step: Doc, op: Doc, role: str, type_id: str) -> str:
    port = op["inputs"].get(role)
    binding = step["inputs"].get(port, {}) if isinstance(port, str) else {}
    name = binding.get("from_input")
    transport = "inline" if type_id == "text.prompt.v1" else "file"
    if not isinstance(name, str) or not any(
        p["name"] == name
        and p["type_id"] == type_id
        and p["transport"] in {transport, "either"}
        for p in pipe["inputs"]
    ):
        raise refused(f"局部重製流程沒有接出對應的輸入：{role}")
    return name


def _range(
    timeline: Doc,
    clip: Doc,
    bounds: tuple[int, int],
    native: Fraction,
    count: int,
) -> tuple[int, int]:
    offset = clip["in_frame"] + clip_output_window(clip)[0] - clip["start_frame"]
    scale = native / _rate(timeline["fps"])
    first, last = ((i + offset) * scale for i in bounds)
    if (
        first.denominator != 1
        or last.denominator != 1
        or not 0 <= first < last <= count
    ):
        raise refused("所選起訖無法精確對齊原始影片的影格邊界")
    return int(first), int(last)


def _selected_mask(project: Doc, item_id: str | None, source: Doc) -> Doc | None:
    if item_id is None:
        return None
    mask = next(
        (i for i in project.get("library", []) if i["item_id"] == item_id), None
    )
    if not isinstance(mask, dict) or mask["kind"] not in {"image", "video"}:
        raise refused("請選擇此專案素材庫裡的影像或影片遮罩")
    mask_source = (mask["file"].get("metadata") or {}).get("source_sha256")
    if mask_source is not None and mask_source != source["file"]["sha256"]:
        raise refused("遮罩所標記的來源版本與重製影片不同")
    if any(
        mask.get(k) and source.get(k) and mask[k] != source[k]
        for k in ("width", "height")
    ):
        raise refused("遮罩與原始影片的尺寸不同")
    return mask


def _bind_mask(pipe: Doc, step: Doc, op: Doc, inputs: Doc, mask: Doc | None) -> None:
    for role in ("mask_image", "mask_video"):
        port = op["inputs"].get(role)
        bound = step["inputs"].get(port) if isinstance(port, str) else None
        if bound is not None and (
            "from_input" not in bound or bound["from_input"] in inputs
        ):
            raise refused("遮罩需要從獨立的素材輸入選取，不能使用預先綁定的遮罩")
    if mask is None:
        if step["parameters"].get(op["parameters"].get("mask_required")) is True:
            raise refused("此流程需要選取遮罩素材")
        return
    kind = mask["kind"]
    name = _external(pipe, step, op, f"mask_{kind}", f"media.{kind}.v1")
    if name in inputs:
        raise refused("遮罩與原始影片必須使用不同的輸入")
    inputs[name] = {"type_id": f"media.{kind}.v1", "file": mask["file"]}


def plan_retake(ctl: Controller, project_id: str, body: Doc) -> Doc:
    """Plan a native selection-only Run without rendering or changing the edit."""
    contracts.validate("StudioRetakePlanRequest", body)
    project = ctl.studio.get(project_id)
    require_revision(
        project["revision"], body["revision"], what="專案", suffix="請重新選取重製範圍"
    )
    timeline = project.get("timeline")
    if not timeline:
        raise refused("請先建立時間軸")
    start, end = body["start_frame"], body["end_frame"]
    clip, source = _visible_source(timeline, body["track_id"], start, end)
    native, count, parent = _source_clock(ctl, project, source, body)
    first, last = _range(timeline, clip, (start, end), native, count)
    descriptions = ctl.catalog.descriptors()
    pipe = copy.deepcopy(ctl.pipelines.get(body["pipeline_id"]))
    step, op = _declared(pipe, descriptions)
    inputs: Doc = {}
    for role, type_id, content in [
        ("prompt", "text.prompt.v1", {"value": body["prompt"]}),
        ("source_video", "media.video.v1", {"file": source["file"]}),
    ]:
        inputs[_external(pipe, step, op, role, type_id)] = {
            "type_id": type_id,
            **content,
        }
    fields = op["parameters"]
    step["parameters"].update({fields["start_frame"]: first, fields["end_frame"]: last})
    mask = _selected_mask(project, body.get("mask_item_id"), source)
    _bind_mask(pipe, step, op, inputs, mask)
    note = {
        "operation": "native_retake",
        "project_id": project_id,
        "revision": project["revision"],
        "track_id": body["track_id"],
        "clip_id": clip["clip_id"],
        "source_id": source["source_id"],
        "source_sha256": source["file"]["sha256"],
        "sequence_range": [start, end],
        "sequence_fps": timeline["fps"],
        "source_range": [first, last],
        "source_fps": {"num": native.numerator, "den": native.denominator},
        "output_source_frames": last - first,
        **{
            k: v
            for k, v in source.get("candidate_origin", source).items()
            if k in {"shot_id", "take_id", "library_id", "run_id", "output_key"}
        },
        **{
            k: body[k]
            for k in ("probe_run_id", "probe_output_key", "mask_item_id")
            if k in body
        },
    }
    result = {
        "pipeline": pipe,
        "inputs": inputs,
        "label": f"{project['title']} · {clip['name']} [{start}, {end})",
        "origin": {
            "studio_work": {
                "project_id": project_id,
                "operation_kind": "retake",
                "source_digest": source["file"]["sha256"],
                **({"shot_id": note["shot_id"]} if note.get("shot_id") else {}),
            },
            "note": json.dumps(note, ensure_ascii=False, separators=(",", ":")),
            **({"source_run_id": parent} if parent else {}),
        },
        "recovery_policy": "observe_only",
    }
    contracts.validate("RunRequest", result)
    plan_run(result, descriptions)
    return result
