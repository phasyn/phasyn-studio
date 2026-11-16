"""Model weight routes (x-phasyn-extension): the component's weight plan and file
status, and an explicit, license-acknowledged download that runs as a background job (poll the GET for progress)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_server.http import json_response, read_contract_json
from starlette.responses import JSONResponse

if TYPE_CHECKING:
    from ..service import NodeService


def routes(service: NodeService) -> APIRouter:
    router = APIRouter()

    @router.get("/api/components/{component_id}/weights")
    async def get_weights(component_id: str) -> JSONResponse:
        return json_response(await service.weights.view(service.instance(component_id)))

    @router.post("/api/components/{component_id}/weights/download")
    async def download_weights(component_id: str, request: Request) -> JSONResponse:
        inst = service.instance(component_id)
        body = await read_contract_json(request, "WeightsDownloadRequest", what="權重下載請求")
        return json_response(await service.weights.start(inst, body))

    @router.post("/api/components/{component_id}/weights/cancel")
    async def cancel_weights(component_id: str) -> JSONResponse:
        return json_response(await service.weights.cancel(service.instance(component_id)))

    return router


__all__ = ["routes"]
