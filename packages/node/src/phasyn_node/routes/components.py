"""Node, component and provider routes (contract node routes plus x-phasyn-extension meta/delete/preview)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components.ids import require_uuid
from phasyn_server.http import json_response, read_contract_json
from starlette.responses import JSONResponse, Response

from ..calls import cancel_registered, invoke_once
from ..previews import current_preview, preview_headers


if TYPE_CHECKING:
    from ..service import NodeService


def routes(service: NodeService) -> APIRouter:
    """Register the NodeGateway endpoints for this resource."""
    router = APIRouter()

    @router.get("/api/node")
    async def get_node() -> JSONResponse:
        return json_response(await service.node_snapshot())

    @router.get("/api/components")
    async def list_components() -> JSONResponse:
        return json_response({"items": await service.descriptors()})

    @router.put("/api/components/{component_id}")
    async def put_component(component_id: str, request: Request) -> JSONResponse:
        body = await read_contract_json(request, "InstanceDefinition", what="元件定義")
        return json_response(await service.put_component(component_id, body))

    @router.delete("/api/components/{component_id}")
    async def delete_component(component_id: str) -> JSONResponse:
        """x-phasyn-extension: only stopped/error definitions; recordings and files stay, the seed is not recreated."""
        return json_response(await service.delete_component(component_id))

    @router.patch("/api/components/{component_id}/meta")
    async def patch_meta(component_id: str, request: Request) -> JSONResponse:
        """x-phasyn-extension: label/folder/autostart/limits in any state; no reload, revision unchanged."""
        inst = service.instance(component_id)
        body = await read_contract_json(
            request, "ComponentMetaPatch", what="元件資訊 patch"
        )
        return json_response(await inst.patch_meta(body))

    _control_routes(router, service)
    _invoke_routes(router, service)
    return router


def _control_routes(router: APIRouter, service: NodeService) -> None:
    @router.get("/api/components/{component_id}/settings")
    async def get_settings(component_id: str) -> JSONResponse:
        return json_response(await service.instance(component_id).settings_view())

    @router.patch("/api/components/{component_id}/settings")
    async def patch_settings(component_id: str, request: Request) -> JSONResponse:
        inst = service.instance(component_id)
        body = await read_contract_json(request, "SettingsPatch", what="設定 patch")
        return json_response(await inst.patch_settings(body))

    @router.post("/api/components/{component_id}/control")
    async def control(component_id: str, request: Request) -> JSONResponse:
        """start/stop/restart; ``replace_exclusive`` lets start/restart stop idle members of its exclusive group."""
        inst = service.instance(component_id)
        body = await read_contract_json(request, "ControlRequest", what="控制請求")
        replace = bool(body.get("replace_exclusive", False))
        if body["action"] == "start":
            return json_response(await inst.start(replace_exclusive=replace))
        if body["action"] == "stop":
            return json_response(await inst.stop())
        return json_response(await inst.restart(replace_exclusive=replace))


def _invoke_routes(router: APIRouter, service: NodeService) -> None:
    @router.post("/api/components/{component_id}/invoke")
    async def invoke(component_id: str, request: Request) -> JSONResponse:
        body = await read_contract_json(request, "InvokeRequest", what="呼叫請求")
        task = service.spawn_call_task(
            invoke_once(service, component_id, body), name=f"invoke-{body['call_id']}"
        )
        return json_response(await asyncio.shield(task))

    @router.get("/api/components/{component_id}/calls/{call_id}")
    async def call_receipt(component_id: str, call_id: str) -> JSONResponse:
        cid = require_uuid(call_id, "call_id")
        return json_response(
            await asyncio.to_thread(
                service.calls.receipt, component_id, cid, service.store
            )
        )

    @router.post("/api/components/{component_id}/cancel")
    async def cancel(component_id: str, request: Request) -> JSONResponse:
        body = await read_contract_json(request, "CancelRequest", what="取消請求")
        return json_response(
            await cancel_registered(service, component_id, str(body["call_id"]))
        )

    @router.get("/api/components/{component_id}/calls/{call_id}/preview")
    async def call_preview(component_id: str, call_id: str) -> Response:
        """x-phasyn-extension: the newest intermediate preview of a running call (not a result); none → 404."""
        preview = current_preview(
            service.instance(component_id), require_uuid(call_id, "call_id")
        )
        return Response(
            preview.data,
            media_type=preview.media_type,
            headers=preview_headers(preview),
        )

    @router.get("/api/providers/capabilities")
    async def provider_capabilities(request: Request) -> JSONResponse:
        return json_response(await service.provider_capabilities(request.query_params))

    @router.get("/api/providers")
    async def providers() -> JSONResponse:
        return json_response(await service.providers())


__all__ = ["routes"]
