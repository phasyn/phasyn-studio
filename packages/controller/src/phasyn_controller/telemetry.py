"""``POST /api/telemetry/batches``：收下 Node 上報的紀錄副本.

驗證 EventBatch → RecordingStore.ingest_batch（在 thread 執行）→ BatchAck。以
(recording_id, stream_id, seq) 去重；相同鍵不同內容記 CORRUPT_RECORD，不覆蓋。這只是 log 防重，
不重播任何 run。Node 不等這個回覆才繼續運算。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse


if TYPE_CHECKING:
    from .state import Controller

BATCH_BODY_LIMIT = 32 * 1024 * 1024


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for telemetry."""
    router = APIRouter()

    def ingest(batch: Any) -> dict[str, Any]:
        contracts.validate("EventBatch", batch, what="EventBatch")
        return ctl.store.ingest_batch(batch)

    @router.post("/api/telemetry/batches")
    async def post_batch(request: Request) -> JSONResponse:
        batch = await read_json(request, limit=BATCH_BODY_LIMIT, what="EventBatch")
        ack = await asyncio.to_thread(ingest, batch)
        return json_response(ack)

    return router


__all__ = ["routes"]
