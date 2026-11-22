"""Storage routes of the Node (x-phasyn-extension): the inventory the Controller's cleanup reads, and its deletions.

``GET /api/node/storage`` lists the published files, the downloaded copies of other nodes' files and the local
recordings. ``POST /api/node/storage/clean`` deletes exactly the listed items; the inputs of the calls running now,
downloads in progress and recordings still being written are kept (``kept``), whatever the Controller asked. The
Controller decides what is unreferenced; the Node only refuses to pull a file from under a running call.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components import contracts, storage
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse


if TYPE_CHECKING:
    from ..service import NodeService

log = logging.getLogger("phasyn_node.storage")


def busy_files(service: NodeService) -> set[storage.FileKey]:
    """Files the running calls read (inputs and parameters) and remote files being downloaded."""
    keys = set(service.resolver.in_flight())
    for instance in list(service.active_calls.values()):
        call = instance.active_call
        if call is not None:
            keys.update(storage.fileref_keys([call.inputs, call.parameters]))
    return keys


def open_recordings(service: NodeService) -> set[str]:
    """Recordings that may still grow: the running calls' and every one not indexed since its last write."""
    ids = set(service.index.pending())
    for instance in list(service.active_calls.values()):
        call = instance.active_call
        if call is not None:
            ids.add(call.recording_id)
    return ids


def routes(service: NodeService) -> APIRouter:
    """Register the storage endpoints of the Node."""
    router = APIRouter()

    @router.get("/api/node/storage")
    async def get_storage() -> JSONResponse:
        doc = await asyncio.to_thread(
            storage.inventory,
            service.store,
            service.index.store,
            busy=busy_files(service),
            open_recordings=open_recordings(service),
        )
        doc["work"] = await asyncio.to_thread(service.work_state)
        return json_response(doc)

    @router.post("/api/node/storage/clean")
    async def clean_storage(request: Request) -> JSONResponse:
        body = await read_json(request)
        contracts.validate("NodeStorageCleanRequest", body, what="儲存清理請求")
        result = await asyncio.to_thread(
            storage.clean,
            service.store,
            service.index.store,
            body,
            busy=busy_files(service),
            open_recordings=open_recordings(service),
        )
        done = sum(1 for item in result["items"] if item["status"] == "deleted")
        log.info("儲存清理：刪除 %d 項（主控指定 %d 項）", done, len(result["items"]))
        return json_response(result)

    return router


__all__ = ["routes"]
