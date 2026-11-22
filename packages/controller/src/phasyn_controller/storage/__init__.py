"""Storage cleanup (x-phasyn-extension): usage, the reference-graph plan, the guarded deletion and the pins.

Routes: ``GET /api/storage`` (usage), ``POST /api/storage/clean`` (dry run or deletion of the listed items),
``GET``/``POST /api/storage/pins`` (runs and files the cleanup never collects).
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from ..studio_audit import client_tag
from .service import StorageService


if TYPE_CHECKING:
    from ..state import Controller


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for the storage cleanup."""
    router = APIRouter()

    @router.get("/api/storage")
    async def get_usage() -> JSONResponse:
        return json_response(await ctl.storage.usage())

    @router.post("/api/storage/clean")
    async def clean(request: Request) -> JSONResponse:
        body = await read_json(request)
        return json_response(
            await ctl.storage.clean(body, client=client_tag(request.headers))
        )

    @router.get("/api/storage/pins")
    async def get_pins() -> JSONResponse:
        return json_response({"items": await asyncio.to_thread(ctl.storage.pins.list)})

    @router.post("/api/storage/pins")
    async def post_pins(request: Request) -> JSONResponse:
        body = await read_json(request)
        return json_response(await asyncio.to_thread(ctl.storage.pins.update, body))

    return router


__all__ = ["StorageService", "routes"]
