"""HTTP entry points for versioned, native H3 and Qwen inference presets."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.ids import require_local_id
from phasyn_server.http import json_response, query_int, read_json
from starlette.responses import JSONResponse

from .service import PresetService


if TYPE_CHECKING:
    from ..state import Controller


def routes(ctl: Controller) -> APIRouter:
    """Read and write immutable revisions, then preflight and submit that exact revision."""
    router = APIRouter()
    svc = PresetService(ctl)

    @router.get("/api/inference-presets")
    async def listing() -> JSONResponse:
        return json_response({"items": await asyncio.to_thread(svc.store.summaries)})

    @router.get("/api/inference-presets/{preset_id}")
    async def get(preset_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(preset_id, "preset_id")
        rev = query_int(request.query_params, "revision", default=None, minimum=1)
        record = await asyncio.to_thread(svc.store.get, pid, rev)
        record["submissions"] = await asyncio.to_thread(
            svc.store.runs, pid, record["revision"]
        )
        return json_response(record)

    @router.put("/api/inference-presets/{preset_id}")
    async def put(preset_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(preset_id, "preset_id")
        body = await read_json(request)
        contracts.validate(
            "InferencePresetCapture", body, what="InferencePresetCapture"
        )
        return json_response(await asyncio.to_thread(svc.save, pid, body))

    @router.post("/api/inference-presets/{preset_id}/preflight")
    async def preview(preset_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(preset_id, "preset_id")
        body = await read_json(request)
        contracts.validate(
            "InferencePresetResolve", body, what="InferencePresetResolve"
        )
        preset = await asyncio.to_thread(svc.store.get, pid, body["revision"])
        return json_response(await svc.preflight(preset, body))

    @router.post("/api/inference-presets/{preset_id}/submit")
    async def submit(preset_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(preset_id, "preset_id")
        body = await read_json(request)
        contracts.validate("InferencePresetSubmit", body, what="InferencePresetSubmit")
        return json_response(await svc.submit(pid, body), status_code=202)

    return router
