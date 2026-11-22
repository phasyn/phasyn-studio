"""接線草稿（Pipeline）的保存：``data_dir/config/pipelines/<pipeline_id>.json``.

PUT 只檢查結構、引用與循環（不需要目錄），不執行；執行時的完整檢查在 POST /api/runs。
DELETE（x-phasyn-extension）只刪草稿檔；已建立的 run 保留自己凍結的接線副本。
GET 的順序依使用者的分類與排序（x-phasyn-extension，``pipeline_layout``）：分類依序、組內依序，然後未分類。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_components.pipeline import validate_pipeline
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse


if TYPE_CHECKING:
    from .state import Controller


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for pipelines."""
    router = APIRouter()

    @router.get("/api/pipelines")
    async def list_pipelines() -> JSONResponse:
        items = await asyncio.to_thread(
            lambda: ctl.pipeline_layout.order(ctl.pipelines.list())
        )
        return json_response({"items": items})

    @router.get("/api/pipelines/{pipeline_id}")
    async def get_pipeline(pipeline_id: str) -> JSONResponse:
        pid = require_local_id(pipeline_id, "pipeline_id")
        return json_response(await asyncio.to_thread(ctl.pipelines.get, pid))

    @router.put("/api/pipelines/{pipeline_id}")
    async def put_pipeline(pipeline_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(pipeline_id, "pipeline_id")
        body = await read_json(request)
        if not isinstance(body, dict):
            raise ComponentError("INVALID_ARGUMENT", "接線必須是 JSON object")
        await asyncio.to_thread(validate_pipeline, body, None)
        if body["pipeline_id"] != pid:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"路徑 pipeline_id {pid} 與本文 pipeline_id {body['pipeline_id']} 不同",
                details={
                    "path_pipeline_id": pid,
                    "body_pipeline_id": body["pipeline_id"],
                },
            )
        await asyncio.to_thread(ctl.pipelines.put, pid, body)
        return json_response(body)

    @router.delete("/api/pipelines/{pipeline_id}")
    async def delete_pipeline(pipeline_id: str) -> JSONResponse:
        pid = require_local_id(pipeline_id, "pipeline_id")
        if not await asyncio.to_thread(ctl.pipelines.delete, pid):
            raise ComponentError(
                "NOT_FOUND", f"找不到接線 {pid}", details={"pipeline_id": pid}
            )
        return json_response({"pipeline_id": pid, "deleted": True})

    return router


__all__ = ["routes"]
