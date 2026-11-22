"""LoRA training jobs: drop videos, give a direction, get a compared and registered LoRA."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.ids import require_uuid
from phasyn_server.http import json_response, query_int, read_json
from starlette.responses import JSONResponse

from . import local_imports
from .engine import LoraTrainings


if TYPE_CHECKING:
    from ..state import Controller

_BODY_LIMIT = 1024 * 1024


def routes(ctl: Controller) -> APIRouter:
    """The training job API and the local video picker."""
    router = APIRouter()

    @router.get("/api/lora-trainings")
    async def listing() -> JSONResponse:
        return json_response({"items": await ctl.trainings.listing()})

    @router.post("/api/lora-trainings")
    async def create(request: Request) -> JSONResponse:
        body = await read_json(request, limit=_BODY_LIMIT)
        return json_response(await ctl.trainings.create(body), status_code=201)

    @router.get("/api/lora-trainings/{training_id}")
    async def show(training_id: str) -> JSONResponse:
        return json_response(
            await ctl.trainings.get(require_uuid(training_id, "training_id"))
        )

    @router.post("/api/lora-trainings/{training_id}/actions")
    async def action(training_id: str, request: Request) -> JSONResponse:
        body = await read_json(request, limit=4096)
        return json_response(
            await ctl.trainings.action(require_uuid(training_id, "training_id"), body)
        )

    @router.patch("/api/lora-trainings/{training_id}/clips")
    async def clips(training_id: str, request: Request) -> JSONResponse:
        body = await read_json(request, limit=_BODY_LIMIT)
        return json_response(
            await ctl.trainings.edit_clips(
                require_uuid(training_id, "training_id"), body
            )
        )

    @router.get("/api/local-imports")
    async def browse(request: Request) -> JSONResponse:
        roots = ctl.config.import_roots
        raw_root = request.query_params.get("root")
        if raw_root is None:
            return json_response(local_imports.roots_listing(roots))
        root = (
            query_int(request.query_params, "root", default=0, minimum=0, maximum=63)
            or 0
        )
        path = request.query_params.get("path") or ""
        return json_response(
            await asyncio.to_thread(local_imports.listing, roots, root, path)
        )

    @router.post("/api/local-imports")
    async def import_one(request: Request) -> JSONResponse:
        body = await read_json(request, limit=4096)
        contracts.validate("LocalImportRequest", body, what="匯入請求")
        ref = await asyncio.to_thread(
            local_imports.import_file,
            ctl.config.import_roots,
            int(body["root"]),
            str(body["path"]),
            ctl.files,
            max_bytes=ctl.config.max_upload_bytes,
        )
        return json_response(ref, status_code=201)

    return router


__all__ = ["LoraTrainings", "routes"]
