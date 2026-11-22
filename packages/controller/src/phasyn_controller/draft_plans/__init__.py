"""Human-approved, bounded draft batches. Every result stays separate from the project's active Take."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.ids import require_local_id
from phasyn_server.http import json_response, query_int, read_json
from starlette.responses import JSONResponse

from .branch import branch_plan
from .engine import DraftPlans
from .plan import rejected


if TYPE_CHECKING:
    from ..state import Controller


def routes(ctl: Controller) -> APIRouter:
    """Expose draft planning and approval through project-scoped routes."""
    router = APIRouter(prefix="/api/studio/projects/{project_id}/draft-plans")

    @router.get("")
    async def listing(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        await asyncio.to_thread(ctl.studio.get, pid)
        raw = request.query_params.get("after")
        after = require_local_id(raw, "after") if raw is not None else ""
        limit = (
            query_int(request.query_params, "limit", default=25, minimum=1, maximum=100)
            or 25
        )
        return json_response(
            await asyncio.to_thread(ctl.drafts.store.listing, pid, after, limit)
        )

    @router.get("/{plan_id}")
    async def show(project_id: str, plan_id: str) -> JSONResponse:
        return json_response(
            await ctl.drafts.get(
                require_local_id(project_id, "project_id"),
                require_local_id(plan_id, "plan_id"),
            )
        )

    @router.put("/{plan_id}")
    async def plan(project_id: str, plan_id: str, request: Request) -> JSONResponse:
        body = await read_json(request, limit=128 * 1024)
        return json_response(
            await ctl.drafts.create(
                require_local_id(project_id, "project_id"),
                require_local_id(plan_id, "plan_id"),
                body,
            )
        )

    @router.post("/{plan_id}/branch-plan")
    async def branch(project_id: str, plan_id: str, request: Request) -> JSONResponse:
        body = await read_json(request, limit=4096)
        contracts.validate("StudioDraftBranchPlanRequest", body)
        return json_response(
            await branch_plan(
                ctl,
                require_local_id(project_id, "project_id"),
                require_local_id(plan_id, "plan_id"),
                body,
            )
        )

    @router.post("/{plan_id}/{operation}")
    async def action(
        project_id: str, plan_id: str, operation: str, request: Request
    ) -> JSONResponse:
        if operation not in {"start", "cancel", "select", "reconcile", "release"}:
            raise rejected("unknown_plan_operation")
        body = await read_json(request, limit=4096)
        contracts.validate(
            "StudioDraftSelection" if operation == "select" else "StudioDraftApproval",
            body,
        )
        return json_response(
            await ctl.drafts.action(
                require_local_id(project_id, "project_id"),
                require_local_id(plan_id, "plan_id"),
                operation,
                body,
            )
        )

    return router


__all__ = ["DraftPlans", "routes"]
