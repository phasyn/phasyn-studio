"""File routes of the Node: upload, ranged download, explicit delete."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_uuid
from phasyn_server.files import file_response, receive_upload
from phasyn_server.http import json_response
from starlette.responses import JSONResponse, Response

if TYPE_CHECKING:
    from ..service import NodeService

log = logging.getLogger("phasyn_node.files")


def routes(service: NodeService) -> APIRouter:
    router = APIRouter()

    @router.post("/api/files")
    async def upload(request: Request) -> JSONResponse:
        ref = await receive_upload(service.store, request, buffer_bytes=service.config.file_buffer_bytes)
        return json_response(ref, status_code=201)

    @router.get("/api/files/{file_id}")
    async def download(file_id: str, request: Request) -> Response:
        return await file_response(service.store, file_id, request.headers.get("range"))

    @router.delete("/api/files/{file_id}")
    async def delete_file(file_id: str) -> JSONResponse:
        """x-phasyn-extension: explicit permanent delete (the controller's run purge calls it per file; never retried)."""
        fid = require_uuid(file_id, "file_id")
        if not await asyncio.to_thread(service.store.delete, fid):
            raise ComponentError("FILE_NOT_FOUND", f"找不到已發布檔案 {fid}", details={"file_id": fid})
        log.info("已刪除檔案 %s（明確的刪除請求）", fid)
        return json_response({"file_id": fid, "deleted": True})

    return router


__all__ = ["routes"]
