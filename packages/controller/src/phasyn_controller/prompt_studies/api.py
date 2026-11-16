"""HTTP routes of the prompt studies (x-phasyn-extension)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components.ids import require_local_id
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from .checks import invalid
from .deletion import DELETE_MODES

if TYPE_CHECKING:
    from ..state import Controller


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.get("/api/prompt-studies")
    async def list_studies(request: Request) -> JSONResponse:
        archived = request.query_params.get("archived") or "exclude"
        return json_response({"items": await asyncio.to_thread(ctl.prompt_studies.list, archived)})

    @router.get("/api/prompt-studies/{study_id}")
    async def get_study(study_id: str) -> JSONResponse:
        sid = require_local_id(study_id, "study_id")
        return json_response(await asyncio.to_thread(ctl.prompt_studies.get, sid))

    @router.put("/api/prompt-studies/{study_id}")
    async def put_study(study_id: str, request: Request) -> JSONResponse:
        sid = require_local_id(study_id, "study_id")
        body = await read_json(request, what="反推研究")
        return json_response(await asyncio.to_thread(ctl.prompt_studies.put, sid, body))

    @router.get("/api/prompt-studies/{study_id}/deletion-preview")
    async def deletion_preview(study_id: str, request: Request) -> JSONResponse:
        sid = require_local_id(study_id, "study_id")
        return json_response(await ctl.prompt_study_deletion.preview(sid, request.query_params.get("mode") or ""))

    @router.delete("/api/prompt-studies/{study_id}")
    async def delete_study(study_id: str, request: Request) -> JSONResponse:
        sid = require_local_id(study_id, "study_id")
        mode = request.query_params.get("mode") or ""
        if mode not in DELETE_MODES:
            raise invalid("刪除研究需要 mode=keep_images 或 mode=all（先看 deletion-preview 的範圍）", field="mode")
        raw = request.query_params.get("revision")
        if raw is None or not raw.isdigit():
            raise invalid("刪除研究需要 revision（目前看到的版本）", field="revision")
        return json_response(await ctl.prompt_study_deletion.delete(sid, mode, int(raw)))

    return router


__all__ = ["routes"]
