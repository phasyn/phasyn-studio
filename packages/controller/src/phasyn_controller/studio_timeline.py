"""Timeline routes of a Studio project (x-phasyn-extension): the Controller as the authority of the edit.

- ``POST /api/studio/projects/{project_id}/timeline/commands``: named edits for agents, applied in order to the
  normalized project, all or nothing, saved with the project's revision (409 ``REVISION_CONFLICT``). A refusal is
  422 ``STUDIO_TIMELINE_REJECTED`` with ``details.reason`` and ``details.command_index``; nothing is saved.
- ``POST /api/studio/projects/{project_id}/timeline/export``: the export run of the saved timeline, built here
  (no browser), started through the normal run path and recorded in the project's ``exports``.
- ``GET /api/studio/projects/{project_id}/legacy``: the document kept from before the Controller took the
  project's timeline over (read-only).

The rules themselves are pure functions in ``phasyn_components.timeline_edit``.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_components.timeline_edit import Exporter, TimelineRejected, export_request
from phasyn_components.timeline_edit.export import PROVIDER_ID
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from .revisions import require_revision
from .studio_audit import client_tag

if TYPE_CHECKING:
    from .state import Controller

BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
LOCAL_ID_CHARS = 40
MAX_EXPORTS = 200


def _base36(value: int) -> str:
    digits = ""
    while value:
        value, digit = divmod(value, 36)
        digits = BASE36[digit] + digits
    return digits or "0"


def local_id(prefix: str) -> str:
    """A document-local id as the editor makes them: the prefix, the time and two random 32-bit numbers in base 36."""
    stamp = _base36(time.time_ns() // 1_000_000)
    return f"{prefix}{stamp}{_base36(secrets.randbits(32))}{_base36(secrets.randbits(32))}"[:LOCAL_ID_CHARS]


def export_target(ctl: Controller) -> Exporter:
    """The export component a run uses: a loaded one on a reachable Node first (the order the editor uses)."""
    best: dict[str, Any] | None = None
    best_score = 0
    for (node_id, _component_id), descriptor in sorted(ctl.catalog.descriptors().items()):
        if descriptor.get("provider_id") != PROVIDER_ID:
            continue
        loaded = descriptor.get("state") in ("ready", "busy")
        score = (2 if loaded else 0) - (4 if ctl.catalog.state(node_id) == "offline" else 0)
        if best is None or score > best_score:
            best, best_score = {**descriptor, "node_id": node_id}, score
    if best is None:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            "找不到序列匯出元件（media.concat）；請先在元件頁新增並啟動",
            details={"provider_id": PROVIDER_ID},
        )
    return Exporter.of(best)


def _export_plan(ctl: Controller, project_id: str, body: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """(the project as it will be exported, the plan of its export run); everything that can refuse, refuses here."""
    contracts.validate("StudioTimelineExportRequest", body, what="時間軸匯出請求")
    project = ctl.studio.get(project_id)
    require_revision(project["revision"], body["revision"], what="專案", suffix="請重新讀取專案後再匯出")
    try:
        if len(project.get("exports") or []) >= MAX_EXPORTS:
            raise TimelineRejected(
                "limit_exceeded", "匯出紀錄已達上限；請先在專案裡移除舊的匯出紀錄", limit=MAX_EXPORTS
            )
        return project, export_request(project, body, export_target(ctl))
    except TimelineRejected as rejection:
        raise rejection.to_error() from rejection


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.post("/api/studio/projects/{project_id}/timeline/commands")
    async def timeline_commands(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, what="時間軸指令")
        client = client_tag(request.headers)
        return json_response(await asyncio.to_thread(ctl.studio.apply_commands, pid, body, local_id, client))

    @router.post("/api/studio/projects/{project_id}/timeline/export")
    async def timeline_export(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, what="時間軸匯出請求")
        _project, plan = await asyncio.to_thread(_export_plan, ctl, pid, body)
        run = await ctl.runner.create(plan["body"])
        record = {
            "export_id": local_id("x"),
            "run_id": run["run_id"],
            "created_at": run["created_at"],
            "state": "rendering",
            "shot_ids": plan["shot_ids"],
            "asset": None,
            "error": None,
            "frames": None,
        }
        try:
            saved = await asyncio.to_thread(ctl.studio.add_export, pid, record, client_tag(request.headers))
        except ComponentError as error:
            # The run exists either way: name it, so the caller can follow or cancel it.
            raise ComponentError(
                error.code,
                f"匯出已開始（run {run['run_id']}），但無法寫入專案的匯出紀錄：{error.message}",
                details={**error.details, "run_id": run["run_id"]},
            ) from error
        result = {"run_id": run["run_id"], "export_id": record["export_id"], "project": saved}
        return json_response(result, status_code=202)

    @router.get("/api/studio/projects/{project_id}/legacy")
    async def legacy_project(project_id: str) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        return json_response(await asyncio.to_thread(ctl.studio.legacy, pid))

    return router


__all__ = ["export_target", "local_id", "routes"]
