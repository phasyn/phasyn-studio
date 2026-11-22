"""Resource placement preview; the guarded request is submitted through the standard /api/runs command."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from .planner import candidate, preview, verify


if TYPE_CHECKING:
    from ..state import Controller


def routes(ctl: Controller) -> APIRouter:
    """Expose resource observations, placement previews and frozen checks."""
    router = APIRouter()

    @router.post("/api/placement/preview")
    async def plan(request: Request) -> JSONResponse:
        body = await read_json(request, limit=256 * 1024)
        contracts.validate("PlacementRequest", body)
        return json_response(await preview(ctl, body))

    @router.post("/api/placement/check")
    async def check(request: Request) -> JSONResponse:
        body = await read_json(request, limit=1024 * 1024)
        contracts.validate("RunRequest", body)
        guard = body.get("placement")
        if not guard:
            raise ComponentError("INVALID_ARGUMENT", "請提供已預覽的資源配置")
        option, current = await candidate(
            ctl,
            {
                "pipeline_id": body["pipeline"]["pipeline_id"],
                "envelope": guard["envelope"],
            },
            body["inputs"],
        )
        if current != body:
            option = {
                **option,
                "state": "rejected",
                "reasons": [*option["reasons"], "approved_request_changed"],
            }
        return json_response(option)

    return router


__all__ = ["routes", "verify"]
