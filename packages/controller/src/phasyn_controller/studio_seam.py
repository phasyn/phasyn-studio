"""Preview the exact proposed range replacement with the existing timeline audio and layers."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.canonical import canonical_json, digest
from phasyn_components.errors import ComponentError
from phasyn_components.timeline_edit import (
    Exporter,
    TimelineRejected,
    apply_commands,
    export_request,
)
from phasyn_components.timeline_edit.model import AllocateId, timeline_duration

from .revisions import require_revision
from .studio_take_source import published_timeline_media


if TYPE_CHECKING:
    from .state import Controller

type Doc = dict[str, Any]


def _plan(
    project: Doc,
    command: Doc,
    assets: dict[tuple[str, ...], Doc],
    allocate: AllocateId,
    exporter: Exporter,
) -> Doc:
    try:
        edited, _ = apply_commands(project, [command], allocate, assets)
        timeline = edited["timeline"]
        fps = timeline["fps"]
        context = max(1, round(fps["num"] / fps["den"]))
        timeline["work_area"] = {
            "start_frame": max(0, command["start_frame"] - context),
            "end_frame": min(
                timeline_duration(timeline), command["end_frame"] + context
            ),
        }
        result = export_request(
            edited, {"range": "work_area", "speed": "fast"}, exporter
        )["body"]
    except TimelineRejected as error:
        raise error.to_error() from error
    result["label"] = "局部候選接縫預覽"
    result["origin"] = {
        "studio_work": {
            "project_id": project["project_id"],
            "operation_kind": "seam",
            "recipe_digest": digest(command),
        },
        "note": canonical_json(
            {"revision": project["revision"], "command": command}
        ).decode(),
    }
    return result


async def preview_seam(
    ctl: Controller, pid: str, body: Doc, allocate: AllocateId, exporter: Exporter
) -> Doc:
    """Return a renderable plan without persisting edits or replacing any candidate."""
    if (
        not isinstance(body, dict)
        or set(body) != {"revision", "command"}
        or type(body["revision"]) is not int
    ):
        raise ComponentError("INVALID_ARGUMENT", "接縫預覽需要專案修訂與選區指令")
    command = body["command"]
    contracts.validate("TimelineCommandRangeCandidate", command)
    project = await asyncio.to_thread(ctl.studio.get, pid)
    require_revision(
        project["revision"], body["revision"], what="專案", suffix="請重新載入選區"
    )
    assets: dict[tuple[str, ...], Doc] = {}
    if "run_id" in command:
        rid, key = command["run_id"], command["output_key"]
        with ctl.purge.hold_for_attach(rid):
            run = await asyncio.to_thread(ctl.runs.read, rid)
            if run.get("state") != "succeeded":
                raise ComponentError("INVALID_ARGUMENT", "候選片段尚未完成")
            assets[rid, key, "range_candidate"] = published_timeline_media(run, key)
    return await asyncio.to_thread(_plan, project, command, assets, allocate, exporter)
