"""Revision-bound NLE handoff and import preview using Controller-owned media identities."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from contextlib import ExitStack
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components.canonical import canonical_json, digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id, require_uuid
from phasyn_components.timeline_edit import Exporter, TimelineRejected, export_request
from phasyn_components.timeline_edit.otio import export_project
from phasyn_components.timeline_edit.otio_delivery import bake_request, delivery_regions
from phasyn_components.timeline_edit.otio_edits import import_kdenlive_edits
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse, StreamingResponse

from .revisions import require_revision
from .studio_exchange import exchange_response
from .studio_take_source import published_library_media, published_video


if TYPE_CHECKING:
    from .state import Controller

type Doc = dict[str, Any]


def _project(ctl: Controller, pid: str, revision: int) -> Doc:
    project = ctl.studio.get(pid)
    require_revision(
        project["revision"], revision, what="專案", suffix="請重新讀取時間軸"
    )
    if not project.get("timeline"):
        raise ComponentError("INVALID_ARGUMENT", "專案尚未儲存時間軸")
    return project


def _edits(ctl: Controller, pid: str, body: Doc) -> Doc:
    if (
        not isinstance(body, dict)
        or set(body)
        not in (
            {"revision", "document", "relinks"},
            {"revision", "document", "relinks", "track_ids"},
        )
        or type(body["revision"]) is not int
        or not isinstance(body["relinks"], dict)
        or (
            "track_ids" in body
            and (
                not isinstance(body["track_ids"], list)
                or not all(isinstance(k, str) for k in body["track_ids"])
            )
        )
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", "回剪需要專案版本、OTIO 文件與媒體對照"
        )
    project = _project(ctl, pid, body["revision"])
    files = {}
    for url, fid in body["relinks"].items():
        file = ctl.files.fileref(require_uuid(fid, "file_id"))
        files[url] = (file["sha256"], file["size_bytes"])
    return import_kdenlive_edits(
        project["timeline"], body["document"], files, body.get("track_ids")
    )


def _plan(project: Doc, target: Exporter) -> Doc:
    try:
        body = export_request(project, {"range": "full", "speed": "fast"}, target)[
            "body"
        ]
    except TimelineRejected as error:
        raise error.to_error() from error
    # Freeze the renderer dialect as well as the exact saved edit. Rechecking a
    # completed output must work after its component is unloaded or disconnected.
    receipt = {
        "type": "studio.otio-reference.v1",
        "project_id": project["project_id"],
        "timeline_sha256": digest(project["timeline"]),
        "renderer": {
            "version": target.version,
            "text": target.text,
            "adjustment": target.adjustment,
        },
    }
    body["origin"] = {"note": canonical_json(receipt).decode()}
    return body


def _reference(project: Doc, run: Doc) -> Doc:
    request = run["request"]
    try:
        note = json.loads(request["origin"]["note"])
        (step,) = request["pipeline"]["steps"]
        dialect = note["renderer"]
    except (ValueError, KeyError, TypeError) as error:
        raise ComponentError(
            "INVALID_ARGUMENT", "執行紀錄缺少合成參考片的完整快照"
        ) from error
    if (
        not isinstance(dialect, dict)
        or set(dialect) != {"version", "text", "adjustment"}
        or type(dialect["version"]) is not int
        or type(dialect["text"]) is not bool
        or type(dialect["adjustment"]) is not bool
    ):
        raise ComponentError("INVALID_ARGUMENT", "參考片的匯出能力描述無效")
    target = Exporter(step["node_id"], step["component_id"], **dialect)
    expected = _plan(project, target)
    if run["state"] != "succeeded" or any(
        request.get(field) != expected[field]
        for field in ("inputs", "pipeline", "origin")
    ):
        raise ComponentError(
            "STATE_CONFLICT", "此執行的完整序列或媒體設定與目前版本不同"
        )
    asset = published_video(run, "final")
    concat = (asset.get("actual_settings") or {}).get("concat")
    if (
        asset["file"]["media_type"] != "video/mp4"
        or not isinstance(concat, dict)
        or concat.get("timeline") is not True
    ):
        raise ComponentError("INVALID_ARGUMENT", "需要已發布的完整時間軸 MP4 參考片")
    return {"run_id": run["run_id"], "file": asset["file"]}


def _bakes(project: Doc, reference: Doc, run: Doc | None = None) -> Doc:
    asset = published_video(reference, "final")
    regions = delivery_regions(project["timeline"])
    plan = bake_request(project, regions, reference, asset)
    if run is None:
        return plan
    if run["state"] != "succeeded" or any(
        run["request"].get(k) != v for k, v in plan.items()
    ):
        raise ComponentError(
            "STATE_CONFLICT", "這組效果素材與目前的時間軸或參考片不同。"
        )
    for region in regions:
        key = region["key"]
        media = published_library_media(run, key)
        file = media["file"]
        audio = region["kind"] == "audio"
        value = run["outputs"][key]["value"]
        length = region["last"] - region["first"]
        concat = value["actual_settings"].get("concat", {})
        valid = (
            (
                concat.get("audio_only") is True
                and concat.get("expected_frames") == length
            )
            if audio
            else (
                value["frame_count"] == length
                and value["fps"] == asset["fps"]
                and (value["width"], value["height"])
                == (asset["width"], asset["height"])
            )
        )
        if (
            not valid
            or file["media_type"] != ("audio/mp4" if audio else "video/mp4")
            or (file["file_id"], file["node_id"])
            == (asset["file"]["file_id"], asset["file"]["node_id"])
        ):
            raise ComponentError(
                "MEDIA_INCOMPLETE", "交付素材的影格範圍、媒體種類或身分不符。"
            )
        suffix = "m4a" if audio else "mp4"
        region.update(
            file=file,
            asset_id=value["asset_id"],
            sha256=file["sha256"],
            target_url=f"bakes/{file['sha256']}.{suffix}",
        )
    return {"run_id": run["run_id"], "regions": regions}


def exchange_routes(
    ctl: Controller, renderer: Callable[[Controller], Exporter]
) -> APIRouter:
    """Mount read-only projection/preview routes; writes still use the normal revision-checked project save."""
    router = APIRouter(prefix="/api/studio/projects/{project_id}/timeline/otio")

    @router.post("/edits")
    async def edits(project_id: str, request: Request) -> JSONResponse:
        body = await read_json(request, what="Kdenlive 回剪預覽")
        return json_response(
            await asyncio.to_thread(
                _edits, ctl, require_local_id(project_id, "project_id"), body
            )
        )

    @router.post("/reference-plan")
    async def reference_plan(project_id: str, request: Request) -> JSONResponse:
        body = await read_json(request, what="合成參考片")
        if (
            not isinstance(body, dict)
            or set(body) - {"revision", "reference_run"}
            or "revision" not in body
            or type(body["revision"]) is not int
        ):
            raise ComponentError("INVALID_ARGUMENT", "請指定合成參考片的專案修訂")
        project = await asyncio.to_thread(
            _project, ctl, require_local_id(project_id, "project_id"), body["revision"]
        )
        if "reference_run" not in body:
            return json_response(await asyncio.to_thread(_plan, project, renderer(ctl)))
        rid = require_uuid(body["reference_run"], "reference_run")
        with ctl.purge.hold_for_attach(rid):
            run = await asyncio.to_thread(ctl.runs.read, rid)
            await asyncio.to_thread(_reference, project, run)
            return json_response(await asyncio.to_thread(_bakes, project, run))

    @router.get("")
    async def snapshot(project_id: str) -> JSONResponse:
        project = await asyncio.to_thread(
            ctl.studio.get, require_local_id(project_id, "project_id")
        )
        result = await asyncio.to_thread(export_project, project)
        result["delivery_region_count"] = len(
            await asyncio.to_thread(delivery_regions, project["timeline"])
        )
        return json_response(result)

    @router.get(".zip")
    async def archive(
        project_id: str,
        revision: int,
        reference_run: str | None = None,
        bake_run: str | None = None,
    ) -> StreamingResponse:
        return await _archive(ctl, project_id, revision, reference_run, bake_run)

    return router


async def _archive(
    ctl: Controller,
    project_id: str,
    revision: int,
    reference_run: str | None,
    bake_run: str | None,
) -> StreamingResponse:
    project = await asyncio.to_thread(
        _project, ctl, require_local_id(project_id, "project_id"), revision
    )
    snapshot = await asyncio.to_thread(export_project, project)
    if not reference_run:
        if bake_run:
            raise ComponentError(
                "INVALID_ARGUMENT", "交付效果素材需要原參考片的執行身分。"
            )
        return await exchange_response(ctl, snapshot)
    rid = require_uuid(reference_run, "reference_run")
    with ExitStack() as stack:
        stack.enter_context(ctl.purge.hold_for_attach(rid))
        run = await asyncio.to_thread(ctl.runs.read, rid)
        snapshot["reference"] = await asyncio.to_thread(_reference, project, run)
        if bake_run:
            bid = require_uuid(bake_run, "bake_run")
            stack.enter_context(ctl.purge.hold_for_attach(bid))
            result = await asyncio.to_thread(ctl.runs.read, bid)
            snapshot["bakes"] = await asyncio.to_thread(_bakes, project, run, result)
        elif not await asyncio.to_thread(delivery_regions, project["timeline"]):
            snapshot["bakes"] = {"run_id": None, "regions": []}
        return await exchange_response(ctl, snapshot)
