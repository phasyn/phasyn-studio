"""Preset：普通 JSON 設定範本，``data_dir/config/presets/<preset_id>.json``.

套用只是 UI 把內容複製進 instance 草稿；preset 沒有核准或資格語意，修改它不影響執行中的 call。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse


if TYPE_CHECKING:
    from .state import Controller


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for presets."""
    router = APIRouter()

    @router.get("/api/presets")
    async def list_presets() -> JSONResponse:
        items = await asyncio.to_thread(ctl.presets.list)
        return json_response(
            {"items": [p for p in items if contracts.is_valid("Preset", p)]}
        )

    @router.get("/api/presets/{preset_id}")
    async def get_preset(preset_id: str) -> JSONResponse:
        pid = require_local_id(preset_id, "preset_id")
        return json_response(await asyncio.to_thread(ctl.presets.get, pid))

    @router.put("/api/presets/{preset_id}")
    async def put_preset(preset_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(preset_id, "preset_id")
        body = await read_json(request)
        contracts.validate("Preset", body, what="preset")
        if body["preset_id"] != pid:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"路徑 preset_id {pid} 與本文 preset_id {body['preset_id']} 不同",
                details={"path_preset_id": pid, "body_preset_id": body["preset_id"]},
            )
        await asyncio.to_thread(ctl.presets.put, pid, body)
        return json_response(body)

    @router.delete("/api/presets/{preset_id}")
    async def delete_preset(preset_id: str) -> JSONResponse:
        """x-phasyn-extension: remove the saved preset; instances it was applied to keep their settings."""
        pid = require_local_id(preset_id, "preset_id")
        if not await asyncio.to_thread(ctl.presets.delete, pid):
            raise ComponentError(
                "NOT_FOUND", f"找不到 preset {pid}", details={"preset_id": pid}
            )
        return json_response({"preset_id": pid, "deleted": True})

    return router


__all__ = ["routes"]
