"""Run 路由：建立（202）、列表（新到舊、cursor 分頁、封存與專案篩選、摘要投影）、讀取、取消、封存與永久刪除.

封存與永久刪除是 x-phasyn-extension：只接受已結束的 run（runner 仍在執行 → 409）。
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id, require_uuid
from phasyn_server.http import json_response, query_bool, query_int, read_json
from starlette.responses import JSONResponse

from . import run_submissions
from .runs import DEFAULT_PAGE, MAX_PAGE
from .studio_work import ProjectLinks, ProjectScope, history_entry, query_work


if TYPE_CHECKING:
    from .state import Controller


def _project_links(ctl: Controller, project_id: str) -> ProjectLinks:
    try:
        return ctl.studio.work_links(project_id)
    except ComponentError as error:
        if error.code == "NOT_FOUND":
            return {}
        raise


# Step fields a list never needs: the effective settings and per-step outputs (the run's outputs stay)
_DETAIL_STEP_FIELDS = frozenset({"settings", "outputs"})
_VIEWS = ("full", "summary")


def summary_run(run: dict[str, Any]) -> dict[str, Any]:
    """The list projection of a run: every step without its settings and outputs; the detail stays on GET."""
    steps = run.get("steps")
    if not isinstance(steps, dict):
        return run
    return {
        **run,
        "steps": {
            step_id: {k: v for k, v in step.items() if k not in _DETAIL_STEP_FIELDS}
            if isinstance(step, dict)
            else step
            for step_id, step in steps.items()
        },
    }


def _list_view(params: Mapping[str, str]) -> str:
    view = params.get("view") or "full"
    if view not in _VIEWS:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"view 必須是 {'、'.join(_VIEWS)} 之一：{view!r}",
            details={"field": "view", "value": view},
        )
    return view


def _list_work(params: Mapping[str, str]) -> tuple[dict[str, str], bool]:
    """The work filter and whether it came from ``related_project_id`` (which excludes the exact work filters)."""
    work = query_work(params)
    related = params.get("related_project_id")
    if related is None:
        return work, False
    if work:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "related_project_id 不能與 project_id、shot_id、operation_kind、source_digest、recipe_digest 併用",
            details={"field": "related_project_id"},
        )
    return {"project_id": require_local_id(related, "related_project_id")}, True


def _read_runs(
    ctl: Controller,
    rows: list[tuple[str, dict[str, str]]],
    live: dict[str, dict[str, Any] | None],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for rid, work in rows:
        run = live.get(rid)
        if run is None:
            try:
                run = ctl.runs.read(rid)
            except ComponentError:
                continue
        out.append(history_entry(run, work or None))
    return out


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for runs."""
    router = run_submissions.routes(ctl)

    @router.post("/api/runs")
    async def create_run(request: Request) -> JSONResponse:
        body = await read_json(request)
        run = await run_submissions.create(
            ctl, body, request.headers.get("Idempotency-Key")
        )
        return json_response(run, status_code=202)

    @router.get("/api/runs")
    async def list_runs(request: Request) -> JSONResponse:
        params = request.query_params
        limit = (
            query_int(
                params, "limit", default=DEFAULT_PAGE, minimum=1, maximum=MAX_PAGE
            )
            or DEFAULT_PAGE
        )
        archived = params.get("archived") or "exclude"
        view = _list_view(params)
        work, related = _list_work(params)
        scope = (
            ProjectScope(
                await asyncio.to_thread(_project_links, ctl, work["project_id"]),
                related=related,
            )
            if work
            else None
        )
        rows, next_cursor = await asyncio.to_thread(
            ctl.runs.history_page,
            params.get("cursor") or None,
            limit,
            archived=archived,
            work=work,
            scope=scope,
        )
        live = {rid: ctl.runner.snapshot(rid) for rid, _ in rows}

        items = await asyncio.to_thread(_read_runs, ctl, rows, live)
        if view == "summary":
            items = [summary_run(item) for item in items]
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
        if (
            not isinstance(body, dict)
            or set(body) != {"archived"}
            or not isinstance(body["archived"], bool)
        ):
            raise ComponentError(
                "INVALID_ARGUMENT",
                '本文必須是 {"archived": true} 或 {"archived": false}',
            )
        archived = bool(body["archived"])
        ctl.purge.ensure_idle(rid, action="封存" if archived else "取消封存")
        return json_response(
            await asyncio.to_thread(ctl.runs.set_archived, rid, archived=archived)
        )

    @router.delete("/api/runs/{run_id}")
    async def delete_run(run_id: str, request: Request) -> JSONResponse:
        dry_run = query_bool(request.query_params, "dry_run", default=False)
        return json_response(await ctl.purge.purge(run_id, dry_run=dry_run))

    return router


__all__ = ["routes"]
