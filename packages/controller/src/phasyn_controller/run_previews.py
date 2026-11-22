"""執行中步驟的中間預覽（x-phasyn-extension；非最終結果）.

- Node 收到元件的新預覽後，best-effort ``POST /api/runs/{run_id}/steps/{step_id}/preview``
  （RunStepPreviewNotice：只有中繼資料，不含影像）。主控只在 run 仍在 runner 中、步驟 running、
  node/component/call_id 都相符、seq 比目前新時記下（RunExecution.previews，只在記憶體，不寫 run.json）；
  步驟結束（_settle）即移除。回 RunStepPreviewAck；不合的通知回 accepted=false，不算錯誤。
- run 狀態（GET /api/runs/{id} 與列表中的執行中 run）在 running 步驟上帶 ``preview``（RunStepPreview）。
- ``GET /api/runs/{run_id}/steps/{step_id}/preview`` 代理 Node 的
  ``GET /api/components/{component_id}/calls/{call_id}/preview``（Node 只保留最新一張、呼叫結束即刪除）；
  url 的 ``seq`` 只用來避開瀏覽器快取，回的永遠是 Node 當下最新的一張。
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from http import HTTPStatus
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id, require_uuid
from phasyn_components.provider import PREVIEW_MAX_BYTES, PREVIEW_MEDIA_TYPES
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse, Response

from .nodeclient import CONNECT_TIMEOUT_S, error_from_response, transport_error


if TYPE_CHECKING:
    from .runner import RunExecution
    from .state import Controller

PREVIEW_TIMEOUT = httpx.Timeout(
    connect=CONNECT_TIMEOUT_S, read=15.0, write=15.0, pool=CONNECT_TIMEOUT_S
)
NOTICE_BODY_LIMIT = 64 * 1024
RELAY_HEADERS = (
    "etag",
    "x-phasyn-preview-seq",
    "x-phasyn-preview-step",
    "x-phasyn-preview-total",
    "x-phasyn-preview-width",
    "x-phasyn-preview-height",
    "x-phasyn-preview-at",
)
_NOTICE_FIELDS = (
    "seq",
    "step",
    "total",
    "width",
    "height",
    "media_type",
    "size_bytes",
    "note",
    "at",
)


def relay_headers(upstream: Mapping[str, str]) -> dict[str, str]:
    """Headers of the Node's preview response passed on to the browser: etag and x-phasyn-preview-*."""
    return {name: upstream[name] for name in RELAY_HEADERS if name in upstream}


def preview_url(run_id: str, step_id: str, seq: int) -> str:
    """Build the download URL for an individual run preview."""
    return f"/api/runs/{run_id}/steps/{quote(step_id, safe='')}/preview?seq={seq}"


def overlay_previews(
    run: dict[str, Any], previews: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """把記憶體中的預覽放進 run 副本的 running 步驟（run.json 本身永遠沒有 preview）."""
    steps = run.get("steps") or {}
    for sid, preview in previews.items():
        entry = steps.get(sid)
        if isinstance(entry, dict) and entry.get("state") == "running":
            entry["preview"] = copy.deepcopy(preview)
    return run


def _preview_progress_error(
    current: dict[str, Any] | None, notice: dict[str, Any]
) -> str | None:
    if current is not None and int(current["seq"]) >= int(notice["seq"]):
        return f"已有較新的預覽（seq {current['seq']}）；預覽通知已忽略"
    if int(notice["step"]) > int(notice["total"]):
        return "step 大於 total；預覽通知已忽略"
    return None


def record_notice(
    execution: RunExecution | None, run_id: str, step_id: str, notice: dict[str, Any]
) -> tuple[bool, str]:
    """（event loop）依通知更新步驟的預覽；回傳 (accepted, message)."""
    if execution is None:
        return False, f"run {run_id} 不在執行中（已結束或不存在）；預覽通知已忽略"
    entry = execution.steps.get(step_id)
    if entry is None:
        return False, f"run {run_id} 沒有步驟 {step_id}；預覽通知已忽略"
    if entry.get("state") != "running":
        return (
            False,
            f"步驟 {step_id} 目前是 {entry.get('state')}，不在執行中；預覽通知已忽略（最終輸出才是結果）",
        )
    expected = (
        str(entry.get("call_id") or "").lower(),
        str(entry.get("node_id") or "").lower(),
        entry.get("component_id"),
    )
    actual = (
        str(notice["call_id"]).lower(),
        str(notice["node_id"]).lower(),
        notice["component_id"],
    )
    if expected != actual:
        return (
            False,
            f"通知的 node／component／call_id 與步驟 {step_id} 目前的呼叫不符；預覽通知已忽略",
        )
    rejection = _preview_progress_error(execution.previews.get(step_id), notice)
    if rejection is not None:
        return False, rejection
    preview = {name: notice[name] for name in _NOTICE_FIELDS}
    preview["url"] = preview_url(run_id, step_id, int(notice["seq"]))
    execution.previews[step_id] = preview
    return True, f"已記錄步驟 {step_id} 的預覽 seq {notice['seq']}"


def _preview_target(
    ctl: Controller, run_id: str, step_id: str
) -> tuple[str, str, str, str]:
    """(endpoint, node_id, component_id, call_id)；步驟不在執行中或還沒有預覽 → 404 PREVIEW_NOT_FOUND."""
    execution = ctl.runner.executions.get(run_id)
    entry = execution.steps.get(step_id) if execution is not None else None
    if (
        execution is None
        or entry is None
        or entry.get("state") != "running"
        or step_id not in execution.previews
    ):
        raise ComponentError(
            "PREVIEW_NOT_FOUND",
            f"run {run_id} 的步驟 {step_id} 目前沒有中間預覽（只在步驟執行中提供；最終輸出才是結果）",
            details={"run_id": run_id, "step_id": step_id},
        )
    node_id = str(entry["node_id"])
    active = execution.active_calls.get(step_id)
    endpoint = (
        active.endpoint
        if active is not None
        else ctl.catalog.endpoint_for_read(node_id)
    )
    return endpoint, node_id, str(entry["component_id"]), str(entry["call_id"])


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for run previews."""
    router = APIRouter()

    @router.post("/api/runs/{run_id}/steps/{step_id}/preview")
    async def post_notice(run_id: str, step_id: str, request: Request) -> JSONResponse:
        rid = require_uuid(run_id, "run_id")
        sid = require_local_id(step_id, "step_id")
        body = await read_json(
            request, limit=NOTICE_BODY_LIMIT, what="RunStepPreviewNotice"
        )
        contracts.validate("RunStepPreviewNotice", body, what="預覽通知")
        accepted, message = record_notice(
            ctl.runner.executions.get(rid), rid, sid, body
        )
        return json_response({"accepted": accepted, "message": message})

    @router.get("/api/runs/{run_id}/steps/{step_id}/preview")
    async def get_preview(run_id: str, step_id: str) -> Response:
        rid = require_uuid(run_id, "run_id")
        sid = require_local_id(step_id, "step_id")
        endpoint, node_id, component_id, call_id = _preview_target(ctl, rid, sid)
        url = f"{endpoint}/api/components/{quote(component_id, safe='')}/calls/{call_id}/preview"
        try:
            resp = await ctl.http.get(url, timeout=PREVIEW_TIMEOUT)
        except httpx.HTTPError as exc:
            raise transport_error(
                exc,
                node_label=ctl.catalog.label(node_id),
                endpoint=endpoint,
                what="中間預覽讀取",
                side_effect=False,
                read_timeout=PREVIEW_TIMEOUT.read,
            ) from exc
        if resp.status_code != HTTPStatus.OK:
            raise error_from_response(
                resp, what=f"Node {ctl.catalog.label(node_id)} 的中間預覽"
            )
        media_type = resp.headers.get("content-type", "").split(";")[0].strip()
        if (
            media_type not in PREVIEW_MEDIA_TYPES
            or len(resp.content) > PREVIEW_MAX_BYTES
        ):
            raise ComponentError(
                "RUNTIME_ERROR",
                f"Node 回的中間預覽不合格（{media_type or '無 Content-Type'}，{len(resp.content)} bytes）",
                details={"media_type": media_type, "size_bytes": len(resp.content)},
                status=502,
            )
        headers = {"Cache-Control": "no-store"}
        headers.update(relay_headers(resp.headers))
        return Response(resp.content, media_type=media_type, headers=headers)

    return router


__all__ = [
    "overlay_previews",
    "preview_url",
    "record_notice",
    "relay_headers",
    "routes",
]
