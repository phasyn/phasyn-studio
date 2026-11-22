"""Timeline routes of a Studio project (x-phasyn-extension): the Controller as the authority of the edit.

- ``POST /api/studio/projects/{project_id}/timeline/commands``: named edits for agents, applied in order to the
  normalized project, all or nothing, saved with the project's revision (409 ``REVISION_CONFLICT``). A refusal is
  422 ``STUDIO_TIMELINE_REJECTED`` with ``details.reason`` and ``details.command_index``; nothing is saved.
- ``POST /api/studio/projects/{project_id}/timeline/export``: the export run of the saved timeline, built here
  (no browser), started through the normal run path and recorded in the project's ``exports``.
- ``GET /api/studio/projects/{project_id}/legacy``: the document kept from before the Controller took the
  project's timeline over (read-only).

The rules themselves are pure functions in ``phasyn_components.timeline_edit``.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from contextlib import ExitStack
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_components.timeline_edit import Exporter, TimelineRejected, export_request
from phasyn_components.timeline_edit.commands import RUN_LABEL
from phasyn_components.timeline_edit.export import PROVIDER_ID
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from .media_file_holds import hold_media_files
from .purge import file_key, referenced_files
from .revisions import require_revision
from .studio_audit import client_tag
from .studio_exchange_routes import exchange_routes
from .studio_gap_plan import plan_gap
from .studio_media_probe import inspect_source
from .studio_retake_plan import plan_retake
from .studio_seam import preview_seam
from .studio_take_source import (
    published,
    published_library_media,
    published_timeline_media,
    recorded_output_audio,
)
from .studio_transcription import load_transcript, transcript_output


if TYPE_CHECKING:
    from .state import Controller

BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
LOCAL_ID_CHARS = 40
MAX_EXPORTS = 200


def _base36(value: int) -> str:
    digits = ""
    while value:
        value, digit = divmod(value, 36)
        digits = BASE36[digit] + digits
    return digits or "0"


def local_id(prefix: str) -> str:
    """A document-local id as the editor makes them: the prefix, the time and two random 32-bit numbers in base 36."""
    stamp = _base36(time.time_ns() // 1_000_000)
    return f"{prefix}{stamp}{_base36(secrets.randbits(32))}{_base36(secrets.randbits(32))}"[
        :LOCAL_ID_CHARS
    ]


def export_target(ctl: Controller) -> Exporter:
    """The export component a run uses: a loaded one on a reachable Node first (the order the editor uses)."""
    best: dict[str, Any] | None = None
    best_score = 0
    for (node_id, _component_id), descriptor in sorted(
        ctl.catalog.descriptors().items()
    ):
        if descriptor.get("provider_id") != PROVIDER_ID:
            continue
        loaded = descriptor.get("state") in ("ready", "busy")
        score = (2 if loaded else 0) - (
            4 if ctl.catalog.state(node_id) == "offline" else 0
        )
        if best is None or score > best_score:
            best, best_score = {**descriptor, "node_id": node_id}, score
    if best is None:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            "找不到序列匯出元件（media.concat）；請先在元件頁新增並啟動",
            details={"provider_id": PROVIDER_ID},
        )
    return Exporter.of(best)


def _export_plan(
    ctl: Controller, project_id: str, body: Any
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(the project as it will be exported, the plan of its export run); everything that can refuse, refuses here.

    On success one export slot of the project stays reserved for this export: ``add_export(..., reserved=True)``
    consumes it and ``release_export`` returns it when no record is written.
    """
    contracts.validate("StudioTimelineExportRequest", body, what="時間軸匯出請求")
    project = ctl.studio.get(project_id)
    require_revision(
        project["revision"],
        body["revision"],
        what="專案",
        suffix="請重新讀取專案後再匯出",
    )
    # The slot is taken under the store lock, so concurrent exports cannot pass the cap together.
    if not ctl.studio.reserve_export(project_id, MAX_EXPORTS):
        raise TimelineRejected(
            "limit_exceeded",
            "匯出紀錄已達上限；請先在專案裡移除舊的匯出紀錄",
            limit=MAX_EXPORTS,
        ).to_error()
    try:
        return project, export_request(project, body, export_target(ctl))
    except TimelineRejected as rejection:
        ctl.studio.release_export(project_id)
        raise rejection.to_error() from rejection
    except BaseException:
        ctl.studio.release_export(project_id)
        raise


async def _library_audio_facts(
    ctl: Controller,
    pid: str,
    body: dict[str, Any],
    assets: dict[tuple[str, ...], dict[str, Any]],
    holds: ExitStack,
) -> None:
    ids = {
        cmd["library_id"]
        for cmd in body["commands"]
        if cmd.get("op") in ("place", "range_candidate") and "library_id" in cmd
    }
    if not ids:
        return
    project = await asyncio.to_thread(ctl.studio.get, pid)
    for item in project.get("library") or []:
        if (
            item["item_id"] not in ids
            or item["kind"] != "video"
            or item.get("has_audio") is not None
        ):
            continue
        ref = item["file"]
        holds.enter_context(hold_media_files(ctl, {file_key(ref)}))
        audio = None
        origin = item.get("source") or {}
        if origin.get("kind") == "run_output":
            try:
                run = await asyncio.to_thread(ctl.runs.read, origin["run_id"])
            except ComponentError as exc:
                if exc.code != "NOT_FOUND":
                    raise
            else:
                key = origin["output_key"]
                if (
                    run["state"] == "succeeded"
                    and key in run["outputs"]
                    and published_library_media(run, key)["file"] == ref
                ):
                    audio = await asyncio.to_thread(
                        recorded_output_audio, ctl, run, key
                    )
        if audio is None:
            audio = (await inspect_source(ctl, ref, dry_run=bool(body.get("dry_run"))))[
                "has_audio"
            ]
        assets[("library-audio", item["item_id"], ref["sha256"])] = {"has_audio": audio}


def _note_run_label(
    assets: dict[tuple[str, ...], dict[str, Any]],
    rid: str,
    key: str,
    run: dict[str, Any],
) -> None:
    """The run's label names the placed clip (「台詞配音・…」) instead of its output key and run id."""
    label = run["request"]["pipeline"].get("label")
    if isinstance(label, str) and label.strip():
        assets[(rid, key, RUN_LABEL)] = {"label": label}


async def _with_audio(
    ctl: Controller,
    run: dict[str, Any],
    key: str,
    asset: dict[str, Any],
    *,
    dry_run: bool,
) -> dict[str, Any]:
    if asset["kind"] not in ("final", "video") or asset.get("has_audio") is not None:
        return asset
    audio = await asyncio.to_thread(recorded_output_audio, ctl, run, key)
    if audio is not None:
        return {**asset, "has_audio": audio}
    info = await inspect_source(ctl, asset["file"], dry_run=dry_run)
    fields: dict[str, Any] = {
        field: info[field]
        for field in ("width", "height", "duration_seconds")
        if field in asset and asset[field] is None
    }
    return {**asset, **fields, "has_audio": info["has_audio"]}


async def _apply_media_commands(
    ctl: Controller, pid: str, body: Any, client: str
) -> dict[str, Any]:
    """Hold source runs until the revision-checked command has finished publishing its pinned media."""
    if not isinstance(body, dict) or not isinstance(body.get("commands"), list):
        ctl.studio.writes.committing()
        return await asyncio.to_thread(
            ctl.studio.apply_commands, pid, body, local_id, client
        )
    keys = [
        (c.get("run_id"), c.get("output_key"), c["op"])
        for c in body["commands"]
        if isinstance(c, dict)
        and (
            (
                c.get("op") in ("place", "range_candidate", "collect_output")
                and "run_id" in c
            )
            or (c.get("op") == "caption" and c.get("action") == "import_transcript")
        )
    ]
    uses_library = any(
        isinstance(c, dict)
        and "library_id" in c
        and c.get("op") in ("place", "range_candidate")
        for c in body["commands"]
    )
    if not keys and not uses_library:
        ctl.studio.writes.committing()
        return await asyncio.to_thread(
            ctl.studio.apply_commands, pid, body, local_id, client
        )
    contracts.validate("StudioTimelineCommandsRequest", body)
    assets: dict[tuple[str, ...], dict[str, Any]] = {}
    with ExitStack() as holds:
        await _library_audio_facts(ctl, pid, body, assets, holds)
        for rid, key, op in keys:
            if not rid or not key:
                raise ComponentError("INVALID_ARGUMENT", "選擇執行結果時需要輸出名稱")
            cache_key = (rid, key, op)
            if cache_key in assets:
                continue
            holds.enter_context(ctl.purge.hold_for_attach(rid))
            run = await asyncio.to_thread(ctl.runs.read, rid)
            if run.get("state") != "succeeded":
                raise ComponentError("INVALID_ARGUMENT", "候選片段尚未完成")
            if op == "caption":
                output = transcript_output(run, key)
                holds.enter_context(hold_media_files(ctl, {file_key(output[1])}))
                assets[cache_key] = await load_transcript(
                    ctl, run, key, output, dry_run=bool(body.get("dry_run"))
                )
                continue
            asset = (
                published_library_media(run, key)
                if op == "collect_output"
                else published_timeline_media(run, key)
            )
            holds.enter_context(
                hold_media_files(
                    ctl, {file_key(ref) for ref in referenced_files(asset["file"])}
                )
            )
            await published(ctl, asset["file"])
            assets[cache_key] = await _with_audio(
                ctl, run, key, asset, dry_run=bool(body.get("dry_run"))
            )
            _note_run_label(assets, rid, key, run)
        # Probes and reads above change nothing; a failure there lets the same receipt key retry.
        ctl.studio.writes.committing()
        job = asyncio.create_task(
            asyncio.to_thread(
                ctl.studio.apply_commands, pid, body, local_id, client, assets
            )
        )
        leases = holds.pop_all()

        def release(finished: asyncio.Task[dict[str, Any]]) -> None:
            leases.close()
            if not finished.cancelled():
                finished.exception()

        job.add_done_callback(release)
        return await asyncio.shield(job)


async def _export(ctl: Controller, pid: str, body: Any, client: str) -> dict[str, Any]:
    """Start the export run of the saved timeline and record it in the project's exports."""
    _project, plan = await asyncio.to_thread(_export_plan, ctl, pid, body)
    try:
        # From here a run may exist: a server failure keeps the receipt's outcome unknown.
        ctl.studio.writes.committing()
        run = await ctl.runner.create(plan["body"])
    except BaseException:
        ctl.studio.release_export(pid)
        raise
    record = {
        "export_id": local_id("x"),
        "run_id": run["run_id"],
        "created_at": run["created_at"],
        "state": "rendering",
        "shot_ids": plan["shot_ids"],
        "asset": None,
        "error": None,
        "frames": None,
    }
    try:
        saved = await asyncio.to_thread(
            ctl.studio.add_export, pid, record, client, reserved=True
        )
    except ComponentError as error:
        # The run exists either way: name it, so the caller can follow or cancel it.
        raise ComponentError(
            error.code,
            f"匯出已開始（run {run['run_id']}），但無法寫入專案的匯出紀錄：{error.message}",
            details={**error.details, "run_id": run["run_id"]},
        ) from error
    return {
        "run_id": run["run_id"],
        "export_id": record["export_id"],
        "project": saved,
    }


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for studio timeline."""
    router = APIRouter()

    @router.post("/api/studio/projects/{project_id}/timeline/seam-plan")
    async def seam_plan(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, what="候選接縫預覽")
        return json_response(
            await preview_seam(ctl, pid, body, local_id, export_target(ctl))
        )

    @router.post("/api/studio/projects/{project_id}/timeline/retake-plan")
    async def retake_plan(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, what="局部重製計畫")
        contracts.validate("StudioRetakePlanRequest", body)
        return json_response(await asyncio.to_thread(plan_retake, ctl, pid, body))

    @router.post("/api/studio/projects/{project_id}/timeline/gap-plan")
    async def gap_plan(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, what="空檔生成計畫")
        return json_response(
            await asyncio.to_thread(
                lambda: plan_gap(ctl, pid, body, export_target(ctl))
            )
        )

    @router.post("/api/studio/projects/{project_id}/timeline/commands")
    async def timeline_commands(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, what="時間軸指令")
        client = client_tag(request.headers)
        if isinstance(body, dict) and body.get("dry_run") is True:
            return json_response(await _apply_media_commands(ctl, pid, body, client))
        return await ctl.studio.writes.perform(
            request,
            pid,
            body,
            lambda: _apply_media_commands(ctl, pid, body, client),
        )

    @router.post("/api/studio/projects/{project_id}/timeline/export")
    async def timeline_export(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, what="時間軸匯出請求")
        client = client_tag(request.headers)
        # The run and its export record are one write: a disconnect cannot stop between them, and a receipt key
        # replays the first acknowledgement instead of starting a second export run.
        return await ctl.studio.writes.perform(
            request,
            pid,
            body,
            lambda: _export(ctl, pid, body, client),
            status_code=202,
        )

    router.include_router(exchange_routes(ctl, export_target))

    @router.get("/api/studio/projects/{project_id}/legacy")
    async def legacy_project(project_id: str) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        return json_response(await asyncio.to_thread(ctl.studio.legacy, pid))

    return router


__all__ = ["export_target", "local_id", "routes"]
