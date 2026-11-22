"""Project-scoped immutable character/scene entries and compiled shot bindings."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Literal

from fastapi import APIRouter, Request
from phasyn_components.creative_library.plan import build_plan
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse


if TYPE_CHECKING:
    from .state import Controller


_MAX_REVISION_DIGITS = 10


def _medium(medium: str) -> Literal["video", "image"]:
    if medium == "video":
        return "video"
    if medium == "image":
        return "image"
    raise ComponentError("INVALID_ARGUMENT", "鏡頭類型必須為 video 或 image")


def _revision(request: Request) -> int | None:
    values = request.query_params.getlist("revision")
    if not values:
        return None
    if (
        len(values) != 1
        or not values[0].isascii()
        or not values[0].isdecimal()
        or not 1 <= len(values[0]) <= _MAX_REVISION_DIGITS
    ):
        raise ComponentError("INVALID_ARGUMENT", "revision 必須為正整數")
    value = int(values[0])
    if not 1 <= value <= 2**31 - 1:
        raise ComponentError("INVALID_ARGUMENT", "revision 超出可查詢範圍")
    return value


def routes(ctl: Controller) -> APIRouter:
    """Serve versioned creative entries, shot bindings and compiled plans."""
    router = APIRouter(prefix="/api/studio/projects/{project_id}/creative")

    @router.get("/entries")
    async def list_entries(project_id: str) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        return json_response(
            await asyncio.to_thread(ctl.studio.creative.list_entries, pid)
        )

    @router.get("/entries/{entry_id}")
    async def read_entry(
        project_id: str, entry_id: str, request: Request
    ) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        eid = require_local_id(entry_id, "entry_id")
        return json_response(
            await asyncio.to_thread(
                ctl.studio.creative.read, pid, "entry", eid, _revision(request)
            )
        )

    @router.put("/entries/{entry_id}")
    async def write_entry(
        project_id: str, entry_id: str, request: Request
    ) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        eid = require_local_id(entry_id, "entry_id")
        body = await read_json(request, limit=128 * 1024, what="創作設定版本")
        return await ctl.studio.writes.perform(
            request,
            pid,
            body,
            lambda: asyncio.to_thread(
                ctl.studio.creative.write, pid, "entry", eid, body
            ),
        )

    @router.get("/shots/{medium}/{shot_id}")
    async def read_binding(
        project_id: str, medium: str, shot_id: str, request: Request
    ) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        sid = require_local_id(shot_id, "shot_id")
        return json_response(
            await asyncio.to_thread(
                ctl.studio.creative.read, pid, _medium(medium), sid, _revision(request)
            )
        )

    @router.put("/shots/{medium}/{shot_id}")
    async def write_binding(
        project_id: str, medium: str, shot_id: str, request: Request
    ) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        sid = require_local_id(shot_id, "shot_id")
        body = await read_json(request, limit=128 * 1024, what="鏡頭創作設定綁定")
        return await ctl.studio.writes.perform(
            request,
            pid,
            body,
            lambda: asyncio.to_thread(
                ctl.studio.creative.write, pid, _medium(medium), sid, body
            ),
        )

    @router.get("/shots/{medium}/{shot_id}/plan")
    async def plan_binding(
        project_id: str, medium: str, shot_id: str, request: Request
    ) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        sid = require_local_id(shot_id, "shot_id")
        pipeline_id = require_local_id(
            request.query_params.get("pipeline_id"), "pipeline_id"
        )
        revision = _revision(request)
        if revision is None:
            raise ComponentError("INVALID_ARGUMENT", "請指定要執行的鏡頭綁定版本")

        def plan() -> dict[str, Any]:
            pin = ctl.studio.creative.read(pid, _medium(medium), sid, revision)[
                "version"
            ]
            pipeline = ctl.pipelines.get(pipeline_id)
            keys = {
                (step["node_id"], step["component_id"]) for step in pipeline["steps"]
            }
            return build_plan(pin, pipeline, ctl.catalog.descriptors(keys))

        return json_response(await asyncio.to_thread(plan))

    return router
