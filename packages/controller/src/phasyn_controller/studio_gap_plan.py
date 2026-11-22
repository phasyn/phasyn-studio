"""Plan a candidate for a bounded gap using the two visible composite frames and a declared edit plugin."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.timeline_edit import Exporter, TimelineRejected, export_request
from phasyn_components.timeline_edit.model import clip_end, find_track

from .revisions import require_revision
from .runner.plan import plan_run


if TYPE_CHECKING:
    from .state import Controller

type Doc = dict[str, Any]
_TIMING_FIELDS = ("frames", "fps_num", "fps_den")


def refused(message: str) -> ComponentError:
    """Return a gap-planning error suitable for the Studio operation response."""
    return ComponentError("INVALID_ARGUMENT", message)


def _fill_step(
    pipe: Doc, descriptions: dict[tuple[str, str], Doc]
) -> tuple[Doc, Doc, Doc]:
    options = []
    for step in pipe["steps"]:
        desc = descriptions.get((step["node_id"].lower(), step["component_id"]), {})
        declaration = (desc.get("facts") or {}).get("studio_edit")
        if (
            not isinstance(declaration, dict)
            or type(declaration.get("version")) is not int
            or declaration["version"] != 1
        ):
            continue
        operations, selector = (
            declaration.get("operations"),
            declaration.get("selector"),
        )
        gap = operations.get("fill_gap") if isinstance(operations, dict) else None
        if (
            not isinstance(gap, dict)
            or not isinstance(selector, str)
            or not isinstance(gap.get("value"), str)
        ):
            continue
        if (
            declaration.get("timebase") == "frames"
            and declaration.get("interval") == "half_open"
            and gap.get("clock") == "requested"
            and gap.get("output_range") == "between_anchors_exclusive"
            and step.get("parameters", {}).get(selector) == gap["value"]
        ):
            options.append((step, declaration, gap))
    if len(options) != 1:
        raise refused("請選取含一個補空檔操作的元件組合")
    return options[0]


def _external(pipe: Doc, step: Doc, operation: Doc, role: str, type_id: str) -> str:
    ports = operation.get("inputs")
    port = ports.get(role) if isinstance(ports, dict) else None
    edge = step["inputs"].get(port, {}) if isinstance(port, str) else {}
    name = edge.get("from_input")
    transport = "inline" if type_id == "text.prompt.v1" else "file"
    if not any(
        p["name"] == name
        and p["type_id"] == type_id
        and p["transport"] in (transport, "either")
        for p in pipe["inputs"]
    ):
        raise refused(f"補空檔操作需要對應的輸入：{role}")
    return str(name)


def _fresh(used: set[str], base: str) -> str:
    name = base
    while name in used:
        name += "_"
    used.add(name)
    return name


@dataclass
class _AnchorWiring:
    project: Doc
    pipe: Doc
    inputs: Doc
    exporter: Exporter
    reader: str

    def wire(self, external: str, frame: int, side: str) -> None:
        """Replace an external image port with a composite timeline frame."""
        project, pipe = self.project, self.pipe
        shot = {
            **project,
            "timeline": {
                **project["timeline"],
                "work_area": {"start_frame": frame, "end_frame": frame + 1},
            },
        }
        one = export_request(shot, {"range": "work_area"}, self.exporter)["body"]
        steps = {s["step_id"] for s in pipe["steps"]}
        composite = _fresh(steps, "composite_" + side)
        still = _fresh(steps, "frame_" + side)
        port = _fresh({p["name"] for p in pipe["inputs"]}, "sequence_" + side)
        for step in pipe["steps"]:
            for name, edge in list(step["inputs"].items()):
                if edge.get("from_input") == external:
                    step["inputs"][name] = {"from_step": still, "output": "image"}
        pipe["inputs"] = [p for p in pipe["inputs"] if p["name"] != external]
        pipe["inputs"].append({**one["pipeline"]["inputs"][0], "name": port})
        self.inputs[port] = one["inputs"]["sequence"]
        writer = {
            **one["pipeline"]["steps"][0],
            "step_id": composite,
            "inputs": {"sequence": {"from_input": port}},
        }
        read = {
            "step_id": still,
            "node_id": self.exporter.node_id,
            "component_id": self.reader,
            "inputs": {"video": {"from_step": composite, "output": "asset"}},
            "parameters": {"position": "first", "frame_index": None},
        }
        pipe["steps"][0:0] = [writer, read]


def plan_gap(ctl: Controller, project_id: str, body: Doc, exporter: Exporter) -> Doc:
    """Return an ordinary runnable pipeline, leaving the project and the queue untouched."""
    contracts.validate("StudioGapPlanRequest", body)
    project = ctl.studio.get(project_id)
    require_revision(
        project["revision"], body["revision"], what="專案", suffix="請重新選取空檔"
    )
    timeline = project.get("timeline")
    if timeline is None:
        raise refused("請選取可編輯的影像軌")
    track = find_track(timeline, body["track_id"])
    if not track or track["kind"] != "video" or track["locked"]:
        raise refused("請選取可編輯的影像軌")
    start, end = body["start_frame"], body["end_frame"]
    clips = [c for c in timeline["clips"] if c["track_id"] == track["track_id"]]
    if (
        not 0 < start < end
        or not any(clip_end(c) == start for c in clips)
        or not any(c["start_frame"] == end for c in clips)
        or any(c["start_frame"] < end and clip_end(c) > start for c in clips)
    ):
        raise refused("請選取同軌兩個片段之間的完整空檔")
    descriptions = ctl.catalog.descriptors()
    reader = next(
        (
            cid
            for (node, cid), desc in sorted(descriptions.items())
            if node == exporter.node_id.lower()
            and desc["provider_id"] == "media.frame"
            and desc.get("state") in ("ready", "busy")
        ),
        None,
    )
    if reader is None:
        raise refused("匯出節點需要可用的取影格元件")
    pipe = copy.deepcopy(ctl.pipelines.get(body["pipeline_id"]))
    step, declaration, operation = _fill_step(pipe, descriptions)
    outputs = declaration.get("outputs")
    if (
        not isinstance(outputs, dict)
        or not isinstance(outputs.get("asset"), str)
        or not any(
            edge == {"from_step": step["step_id"], "output": outputs["asset"]}
            for edge in pipe["outputs"].values()
        )
    ):
        raise refused("補空檔操作需要公開其成片輸出")
    prompt = _external(pipe, step, operation, "prompt", "text.prompt.v1")
    left = _external(pipe, step, operation, "left_frame", "media.image.v1")
    right = _external(pipe, step, operation, "right_frame", "media.image.v1")
    if left == right:
        raise refused("左右錨點需要分開的圖片輸入")
    fields = operation.get("parameters")
    names = [fields.get(k) for k in _TIMING_FIELDS] if isinstance(fields, dict) else []
    if (
        len(names) != len(_TIMING_FIELDS)
        or not all(isinstance(n, str) and n for n in names)
        or len(set(names)) != len(_TIMING_FIELDS)
        or declaration["selector"] in names
    ):
        raise refused("補空檔插件必須宣告長度與有理數影格率")
    step["parameters"].update(
        zip(
            names,
            (end - start, timeline["fps"]["num"], timeline["fps"]["den"]),
            strict=True,
        )
    )
    inputs = {prompt: {"type_id": "text.prompt.v1", "value": body["prompt"]}}
    wiring = _AnchorWiring(project, pipe, inputs, exporter, reader)
    try:
        wiring.wire(left, start - 1, "left")
        wiring.wire(right, end, "right")
    except TimelineRejected as error:
        raise error.to_error() from error
    result = {
        "pipeline": pipe,
        "inputs": inputs,
        "label": f"{project['title']} · [{start}, {end})",
        "recovery_policy": "observe_only",
    }
    contracts.validate("RunRequest", result)
    plan_run(result, descriptions)
    return result
