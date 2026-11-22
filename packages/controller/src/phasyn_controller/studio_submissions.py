"""Bind a Studio render to its destination before any step can be dispatched."""

from __future__ import annotations

import asyncio
import logging
from functools import partial
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from . import run_submissions as receipts
from .studio_backfill import image_snapshot


if TYPE_CHECKING:
    from .state import Controller


log = logging.getLogger(__name__)


def _output_keys(take: dict[str, Any], *, image: bool) -> list[str]:
    if not image:
        return [take["output_key"]]
    snapshot = image_snapshot(take["params_snapshot"])
    if snapshot is None:
        raise ComponentError("INVALID_ARGUMENT", "圖片 Take 缺少已凍結的分支輸出")
    ports = snapshot["outputs"]
    white = ports.get("image_white")
    if white is not None and not isinstance(white, str):
        raise ComponentError("INVALID_ARGUMENT", "圖片 Take 的白底輸出必須是分支名稱")
    return [ports["image"]] if white is None else [ports["image"], white]


def attach_render_takes(
    project: dict[str, Any],
    intent: dict[str, Any],
    run: dict[str, Any],
    output_types: dict[str, str],
) -> None:
    """Validate and attach the complete set to a private project copy without selecting it."""
    image = intent["medium"] == "image"
    collection, id_field = (
        ("image_shots", "image_shot_id") if image else ("shots", "shot_id")
    )
    targets = {shot[id_field]: shot for shot in project.get(collection, [])}
    known = {
        t["take_id"]
        for field in ("shots", "image_shots")
        for shot in project.get(field, [])
        for t in shot["takes"]
    }
    expected_type = "image.asset.v1" if image else "media.asset.v1"
    claimed: set[str] = set()
    protected = {
        "run_id",
        "created_at",
        "media_adoption",
        "generation_run_id",
        "parent_generation_run_id",
    }
    artifacts = (
        "asset",
        "video_latent",
        "image",
        "image_white",
        "library_item_id",
        "error",
    )
    for entry in intent["takes"]:
        shot = targets.get(entry["shot_id"])
        if shot is None:
            raise ComponentError(
                "NOT_FOUND",
                "找不到這次生成指定的鏡頭",
                details={"shot_id": entry["shot_id"]},
            )
        draft = entry["take"]
        if (
            protected.intersection(draft)
            or draft.get("state") != "rendering"
            or draft.get("timings_ms") != {}
            or any(draft.get(key) is not None for key in artifacts)
        ):
            raise ComponentError("INVALID_ARGUMENT", "新 Take 只能包含待生成的分支設定")
        take = {**draft, "run_id": run["run_id"], "created_at": run["created_at"]}
        contracts.validate(
            "StudioImageTake" if image else "StudioTake", take, what="生成 Take"
        )
        if take["take_id"] in known:
            raise ComponentError(
                "STATE_CONFLICT",
                "Take ID 已被使用",
                details={"take_id": take["take_id"]},
            )
        known.add(take["take_id"])
        for key in _output_keys(take, image=image):
            if output_types.get(key) != expected_type or key in claimed:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "Take 輸出不存在或分支對應重複",
                    details={"output_key": key},
                )
            claimed.add(key)
        shot["takes"].append(take)
    submitted = {entry["shot_id"] for entry in intent["takes"]}
    for move in intent.get("route_moves", []):
        sid = move["shot_id"]
        if image or sid not in submitted or targets[sid]["route"] != move["from_route"]:
            raise ComponentError(
                "STATE_CONFLICT", "鏡頭分流來源與提交時不符", details={"shot_id": sid}
            )
        targets[sid]["route"] = move["to_route"]


def fail_pending_takes(
    project: dict[str, Any], run_id: str, error: ComponentError
) -> bool:
    """Retire only placeholders carrying this exact reserved run identity."""
    changed = False
    for field in ("shots", "image_shots"):
        for shot in project.get(field, []):
            for take in shot["takes"]:
                if take["run_id"] == run_id and take["state"] == "rendering":
                    take.update(state="interrupted", error=error.to_dict())
                    changed = True
    return changed


def _reconcile(
    ctl: Controller, pid: str, run_id: str, error: ComponentError
) -> dict[str, Any] | None:
    try:
        run = ctl.runs.read(run_id)
    except ComponentError as exc:
        if exc.code != "NOT_FOUND":
            raise
        # Dispatch is allowed only after run.json is published. Its absence at this
        # boundary proves no Node received work, even if the project was already saved.
        ctl.studio.interrupt_render(pid, run_id, error)
        receipts.settle_studio(ctl.data_dir, run_id, error)
        return None
    receipts.settle_studio(ctl.data_dir, run_id)
    return run


def recover(ctl: Controller) -> None:
    """Finish interrupted submissions under the Controller's exclusive data directory lock."""
    for run_id, project_id in receipts.pending_studio(ctl.data_dir):
        error = ComponentError(
            "STATE_CONFLICT",
            "主控在派送前中斷，可重新提交生成",
            details={"run_id": run_id},
        )
        try:
            _reconcile(ctl, project_id, run_id, error)
        except (ComponentError, OSError):
            # Leave the reservation untouched when the evidence cannot be read.
            log.exception("無法核對 Studio 生成收據，保留原紀錄：%s", run_id)


async def submit(
    ctl: Controller, pid: str, key: str, body: dict[str, Any]
) -> dict[str, Any]:
    """Give one immutable operation one run and register its complete set of Takes."""
    async with ctl.studio.writes.lock(pid):
        receipt, first = await asyncio.to_thread(
            receipts.reserve_studio, ctl.data_dir, key, pid, body
        )
        if not first:
            return await receipts.existing_run(ctl, receipt)
        try:
            shots = {entry["shot_id"] for entry in body["takes"]}
            work = {"project_id": pid, "operation_kind": "render"}
            if len(shots) == 1:
                work["shot_id"] = next(iter(shots))
            request = body["run"]
            run = await ctl.runner.create(
                {
                    **request,
                    "origin": {**request.get("origin", {}), "studio_work": work},
                },
                reserved_run_id=receipt.run_id,
                register_takes=partial(ctl.studio.register_render, pid, body),
            )
        except Exception as exc:
            error = (
                exc
                if isinstance(exc, ComponentError)
                else ComponentError(
                    "RUNTIME_ERROR",
                    "無法完成 Studio 生成提交",
                    details={"run_id": receipt.run_id},
                )
            )
            published = await asyncio.to_thread(
                _reconcile, ctl, pid, receipt.run_id, error
            )
            if published is not None:
                return published
            raise
        await asyncio.to_thread(receipts.settle_studio, ctl.data_dir, receipt.run_id)
        return run


def routes(ctl: Controller) -> APIRouter:
    """Expose durable shot generation for Image Studio, Video Studio, CLI and MCP."""
    router = APIRouter()

    @router.post("/api/studio/projects/{project_id}/render-submissions")
    async def render(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        keys = request.headers.getlist("Idempotency-Key")
        if len(keys) != 1:
            raise ComponentError(
                "INVALID_ARGUMENT", "Studio 生成必須提供一個執行收據鍵"
            )
        body = await read_json(request)
        contracts.validate(
            "StudioRenderSubmissionRequest", body, what="Studio 生成提交"
        )

        async def acknowledge() -> JSONResponse:
            run = await submit(ctl, pid, keys[0], body)
            return json_response(run, status_code=202)

        return await ctl.studio.writes.protect(acknowledge())

    return router
