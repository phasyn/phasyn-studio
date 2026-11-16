"""Run 路由：建立（202）、列表（新到舊、cursor 分頁、封存篩選）、讀取、取消、封存與永久刪除。

封存與永久刪除是 x-phasyn-extension：只接受已結束的 run（runner 仍在執行 → 409）。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_uuid
from phasyn_server.http import json_response, query_bool, query_int, read_json
from starlette.responses import JSONResponse

from .runs import DEFAULT_PAGE, MAX_PAGE

if TYPE_CHECKING:
    from .state import Controller


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.post("/api/runs")
    async def create_run(request: Request) -> JSONResponse:
        body = await read_json(request)
        run = await ctl.runner.create(body)
        return json_response(run, status_code=202)

    @router.get("/api/runs")
    async def list_runs(request: Request) -> JSONResponse:
        params = request.query_params
        limit = query_int(params, "limit", default=DEFAULT_PAGE, minimum=1, maximum=MAX_PAGE) or DEFAULT_PAGE
        archived = params.get("archived") or "exclude"
        ids, next_cursor = ctl.runs.page(params.get("cursor") or None, limit, archived=archived)
        live = {rid: ctl.runner.snapshot(rid) for rid in ids}

        def read_rest() -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for rid in ids:
                run = live.get(rid)
                if run is None:
                    try:
                        run = ctl.runs.read(rid)
                    except ComponentError:
                        continue
                out.append(run)
            return out

        items = await asyncio.to_thread(read_rest)
        return json_response({"items": items, "next_cursor": next_cursor})

    @router.get("/api/runs/{run_id}")
    async def get_run(run_id: str) -> JSONResponse:
        rid = require_uuid(run_id, "run_id")
        run = ctl.runner.snapshot(rid)
        if run is None:
            run = await asyncio.to_thread(ctl.runs.read, rid)
        return json_response(run)

    @router.post("/api/runs/{run_id}/cancel")
    async def cancel_run(run_id: str) -> JSONResponse:
        rid = require_uuid(run_id, "run_id")
        return json_response(await ctl.runner.cancel(rid))

    @router.post("/api/runs/{run_id}/archive")
    async def archive_run(run_id: str, request: Request) -> JSONResponse:
        rid = require_uuid(run_id, "run_id")
        body = await read_json(request)
        if not isinstance(body, dict) or set(body) != {"archived"} or not isinstance(body["archived"], bool):
            raise ComponentError("INVALID_ARGUMENT", '本文必須是 {"archived": true} 或 {"archived": false}')
        archived = bool(body["archived"])
        ctl.purge.ensure_idle(rid, action="封存" if archived else "取消封存")
        return json_response(await asyncio.to_thread(ctl.runs.set_archived, rid, archived))

    @router.delete("/api/runs/{run_id}")
    async def delete_run(run_id: str, request: Request) -> JSONResponse:
        dry_run = query_bool(request.query_params, "dry_run", default=False)
        return json_response(await ctl.purge.purge(run_id, dry_run=dry_run))

    return router


__all__ = ["routes"]
