"""The Node's local recordings (shared routes with the controller).

The local JSONL files are authoritative; the SQLite index is refreshed incrementally before each read.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components.ids import require_uuid
from phasyn_server.http import json_response
from phasyn_server.recordings import events_page, export_response, list_page
from starlette.responses import JSONResponse, Response

if TYPE_CHECKING:
    from ..service import NodeService


def routes(service: NodeService) -> APIRouter:
    router = APIRouter()

    @router.get("/api/recordings")
    async def list_recordings(request: Request) -> JSONResponse:
        await service.index.refresh()
        return json_response(await list_page(service.index.store, request.query_params))

    @router.get("/api/recordings/{recording_id}")
    async def get_recording(recording_id: str) -> JSONResponse:
        rid = require_uuid(recording_id, "recording_id")
        await service.index.refresh_one(rid)
        return json_response(await asyncio.to_thread(service.index.store.get, rid))

    @router.get("/api/recordings/{recording_id}/events")
    async def recording_events(recording_id: str, request: Request) -> JSONResponse:
        rid = require_uuid(recording_id, "recording_id")
        await service.index.refresh_one(rid)
        return json_response(await events_page(service.index.store, rid, request.query_params))

    @router.get("/api/recordings/{recording_id}/export")
    async def export(recording_id: str, request: Request) -> Response:
        rid = require_uuid(recording_id, "recording_id")
        await service.index.refresh_one(rid)
        return await export_response(service.index.store, rid, request.query_params)

    return router


__all__ = ["routes"]
