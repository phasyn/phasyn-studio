"""設定/啟停/取消/provider、元件顯示資訊（meta）與刪除、權重下載、Node 本機紀錄查詢的轉送（普通 HTTP，不自動重送）.

Node 有回覆時轉回它的 status 與本文（包含 Error），一律標成 application/json（不沿用 Node 給的
Content-Type：登記的 Node 回 HTML 也不會在主控的 origin 被當成網頁），本文超過 FORWARD_BODY_LIMIT → 502；
Node 不在目錄、offline → 503 NODE_UNREACHABLE（沒有送出）；連線失敗 → 503（remote_outcome_unknown=false）；
送出後逾時或斷線 → 503 且寫入操作標 remote_outcome_unknown=true。node_id 重複 → 409，不猜要送哪一台。
主控目錄不在轉送時改寫：Node 在定義改變後自行重新上報完整目錄。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id, require_uuid
from phasyn_components.native_catalog import FILTERS
from phasyn_server.http import read_json
from phasyn_server.recordings import PAGE_PARAMS, RECORDING_FILTERS
from starlette.responses import Response

from .nodeclient import FORWARD_TIMEOUT, transport_error


if TYPE_CHECKING:
    from .state import Controller

_MAX_CAPABILITY_FILTER_CHARS = 256

_WHAT = {
    "GET": "讀取",
    "PUT": "寫入",
    "PATCH": "設定保存",
    "POST": "操作",
    "DELETE": "刪除",
}
# Only the known recording filters are forwarded to a Node; node_id comes from the path.
FORWARDED_RECORDING_PARAMS = tuple(
    key for key in (*RECORDING_FILTERS, *PAGE_PARAMS) if key != "node_id"
)
# A Node's answer is relayed whole, so it is bounded; every forwarded endpoint answers API JSON.
FORWARD_BODY_LIMIT = 64 * 1024 * 1024
RELAY_HEADERS = {
    "content-type": "application/json",
    "X-Content-Type-Options": "nosniff",
}


# Keep the public forwarding API compatible with callers that pass an optional body and operation label.
async def forward(  # noqa: PLR0913
    ctl: Controller,
    method: str,
    node_id: str,
    path: str,
    body: Any = None,
    *,
    what: str | None = None,
) -> Response:
    """Forward one component operation to its selected Node."""
    endpoint = ctl.catalog.endpoint_for_call(node_id)
    label = ctl.catalog.label(node_id)
    chunks: list[bytes] = []
    received = 0
    try:
        async with ctl.http.stream(
            method, f"{endpoint}{path}", json=body, timeout=FORWARD_TIMEOUT
        ) as resp:
            status = resp.status_code
            async for chunk in resp.aiter_bytes():
                received += len(chunk)
                if received > FORWARD_BODY_LIMIT:
                    raise ComponentError(
                        "RUNTIME_ERROR",
                        f"Node {label} 的回覆超過 {FORWARD_BODY_LIMIT} bytes，沒有轉送",
                        details={"status": status, "limit_bytes": FORWARD_BODY_LIMIT},
                        status=502,
                    )
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise transport_error(
            exc,
            node_label=label,
            endpoint=endpoint,
            what=what or _WHAT.get(method, "請求"),
            side_effect=method != "GET",
            read_timeout=FORWARD_TIMEOUT.read,
        ) from exc
    return Response(content=b"".join(chunks), status_code=status, headers=RELAY_HEADERS)


def _ids(node_id: str, component_id: str) -> tuple[str, str]:
    return require_uuid(node_id, "node_id"), quote(
        require_local_id(component_id, "component_id"), safe=""
    )


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for forward."""
    router = APIRouter()

    @router.put("/api/nodes/{node_id}/components/{component_id}")
    async def put_component(
        node_id: str, component_id: str, request: Request
    ) -> Response:
        nid, cid = _ids(node_id, component_id)
        body = await read_json(request)
        contracts.validate("InstanceDefinition", body, what="元件定義")
        return await forward(ctl, "PUT", nid, f"/api/components/{cid}", body)

    @router.delete("/api/nodes/{node_id}/components/{component_id}")
    async def delete_component(node_id: str, component_id: str) -> Response:
        """x-phasyn-extension：Node 只在 stopped/error 刪除（否則 409 原樣轉回）；不自動重送."""
        nid, cid = _ids(node_id, component_id)
        return await forward(
            ctl, "DELETE", nid, f"/api/components/{cid}", what="元件刪除"
        )

    @router.patch("/api/nodes/{node_id}/components/{component_id}/meta")
    async def patch_meta(node_id: str, component_id: str, request: Request) -> Response:
        """x-phasyn-extension：名稱/資料夾/自動啟動（任何狀態；Node 不重新載入）."""
        nid, cid = _ids(node_id, component_id)
        body = await read_json(request)
        contracts.validate("ComponentMetaPatch", body, what="元件資訊 patch")
        return await forward(
            ctl, "PATCH", nid, f"/api/components/{cid}/meta", body, what="元件資訊保存"
        )

    @router.get("/api/nodes/{node_id}/components/{component_id}/settings")
    async def get_settings(node_id: str, component_id: str) -> Response:
        nid, cid = _ids(node_id, component_id)
        return await forward(ctl, "GET", nid, f"/api/components/{cid}/settings")

    @router.patch("/api/nodes/{node_id}/components/{component_id}/settings")
    async def patch_settings(
        node_id: str, component_id: str, request: Request
    ) -> Response:
        nid, cid = _ids(node_id, component_id)
        body = await read_json(request)
        contracts.validate("SettingsPatch", body, what="設定 patch")
        return await forward(ctl, "PATCH", nid, f"/api/components/{cid}/settings", body)

    @router.post("/api/nodes/{node_id}/components/{component_id}/control")
    async def control(node_id: str, component_id: str, request: Request) -> Response:
        nid, cid = _ids(node_id, component_id)
        body = await read_json(request)
        contracts.validate("ControlRequest", body, what="啟停請求")
        return await forward(ctl, "POST", nid, f"/api/components/{cid}/control", body)

    @router.post("/api/nodes/{node_id}/components/{component_id}/cancel")
    async def cancel(node_id: str, component_id: str, request: Request) -> Response:
        nid, cid = _ids(node_id, component_id)
        body = await read_json(request)
        contracts.validate("CancelRequest", body, what="取消請求")
        return await forward(ctl, "POST", nid, f"/api/components/{cid}/cancel", body)

    _register_node_tools(router, ctl)
    return router


def _register_node_tools(router: APIRouter, ctl: Controller) -> None:
    @router.get("/api/nodes/{node_id}/components/{component_id}/weights")
    async def get_weights(node_id: str, component_id: str) -> Response:
        """x-phasyn-extension：元件的權重計畫、檔案狀態與下載工作."""
        nid, cid = _ids(node_id, component_id)
        return await forward(ctl, "GET", nid, f"/api/components/{cid}/weights")

    @router.post("/api/nodes/{node_id}/components/{component_id}/weights/download")
    async def download_weights(
        node_id: str, component_id: str, request: Request
    ) -> Response:
        """x-phasyn-extension：使用者明確要求的權重下載（Node 在背景下載，立即回應；不自動重送）."""
        nid, cid = _ids(node_id, component_id)
        body = await read_json(request)
        contracts.validate("WeightsDownloadRequest", body, what="權重下載請求")
        return await forward(
            ctl,
            "POST",
            nid,
            f"/api/components/{cid}/weights/download",
            body,
            what="權重下載",
        )

    @router.post("/api/nodes/{node_id}/components/{component_id}/weights/cancel")
    async def cancel_weights(node_id: str, component_id: str) -> Response:
        """x-phasyn-extension：取消權重下載（暫存檔保留）."""
        nid, cid = _ids(node_id, component_id)
        return await forward(
            ctl,
            "POST",
            nid,
            f"/api/components/{cid}/weights/cancel",
            what="取消權重下載",
        )

    @router.get("/api/nodes/{node_id}/providers/capabilities")
    async def provider_capabilities(node_id: str, request: Request) -> Response:
        nid = require_uuid(node_id, "node_id")
        filters = dict(request.query_params)
        if set(filters) - set(FILTERS) or any(
            len(value) > _MAX_CAPABILITY_FILTER_CHARS for value in filters.values()
        ):
            raise ComponentError(
                "INVALID_ARGUMENT", "Invalid native capability filter."
            )
        return await forward(
            ctl, "GET", nid, "/api/providers/capabilities?" + urlencode(filters)
        )

    @router.get("/api/nodes/{node_id}/providers")
    async def providers(node_id: str) -> Response:
        nid = require_uuid(node_id, "node_id")
        return await forward(ctl, "GET", nid, "/api/providers")

    @router.get("/api/nodes/{node_id}/recordings")
    async def node_recordings(node_id: str, request: Request) -> Response:
        """唯讀查 Node 本機紀錄（找出主控沒收到的 recording，之後由使用者明確 fetch-history）."""
        nid = require_uuid(node_id, "node_id")
        query = {
            k: v
            for k, v in request.query_params.items()
            if k in FORWARDED_RECORDING_PARAMS and v != ""
        }
        query["node_id"] = nid
        return await forward(ctl, "GET", nid, f"/api/recordings?{urlencode(query)}")


__all__ = ["forward", "routes"]
