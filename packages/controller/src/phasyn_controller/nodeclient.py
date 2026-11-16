"""主控 → Node 的普通 HTTP：不自動重送；送出後逾時／斷線 → remote_outcome_unknown。"""

from __future__ import annotations

from typing import Any

import httpx
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_server.http import parse_json_bytes

CONNECT_TIMEOUT_S = 5.0
FORWARD_TIMEOUT = httpx.Timeout(connect=CONNECT_TIMEOUT_S, read=60.0, write=60.0, pool=5.0)
# Idle pooled connections are dropped after this, well before a server closes them (phasyn_server KEEPALIVE_SERVER_S)
KEEPALIVE_CLIENT_S = 2.0
CANCEL_TIMEOUT = httpx.Timeout(connect=CONNECT_TIMEOUT_S, read=15.0, write=15.0, pool=5.0)
READ_TIMEOUT = httpx.Timeout(connect=CONNECT_TIMEOUT_S, read=30.0, write=30.0, pool=5.0)

# 這些錯誤發生時請求沒有完整送達 Node：Node 不可能開始這次操作
NOT_SENT_ERRORS: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
    httpx.UnsupportedProtocol,
    httpx.LocalProtocolError,
    httpx.ProxyError,
)


def request_sent(exc: BaseException) -> bool:
    """傳輸錯誤時請求是否可能已被 Node 收到（收到就可能已在執行）。"""
    return not isinstance(exc, NOT_SENT_ERRORS)


def transport_error(
    exc: BaseException,
    *,
    node_label: str,
    endpoint: str,
    what: str,
    side_effect: bool,
    read_timeout: float | None = None,
) -> ComponentError:
    """把 httpx 傳輸錯誤轉成 NODE_UNREACHABLE；有副作用且可能已送達 → remote_outcome_unknown。"""
    name = type(exc).__name__
    details: dict[str, Any] = {"endpoint": endpoint, "exception_type": f"httpx.{name}", "operation": what}
    if not request_sent(exc):
        return ComponentError(
            "NODE_UNREACHABLE", f"無法連線到 Node {node_label}（{endpoint}）：{name}；{what}沒有送出", details=details
        )
    unknown = side_effect
    if isinstance(exc, httpx.ReadTimeout):
        wait = f"{read_timeout:g} 秒" if read_timeout is not None else "期限"
        msg = f"等待 Node {node_label} 回覆{what}超過 {wait}"
    else:
        msg = f"{what}送出後與 Node {node_label} 的連線中斷（{name}）"
    if unknown:
        msg += "；Node 可能仍在執行（遠端結果未知），不自動重送"
    return ComponentError("NODE_UNREACHABLE", msg, details=details, remote_outcome_unknown=unknown)


def error_from_response(resp: httpx.Response, *, what: str) -> ComponentError:
    """Node 回了非成功狀態：保留它的 Error（code／message／details／remote_outcome_unknown）與 status。"""
    try:
        doc = parse_json_bytes(resp.content)
    except ComponentError:
        doc = None
    if isinstance(doc, dict) and contracts.is_valid("Error", doc):
        return ComponentError.from_dict(doc, status=resp.status_code)
    return ComponentError(
        "RUNTIME_ERROR",
        f"{what}回覆 HTTP {resp.status_code}，本文不是 Error JSON",
        details={"status": resp.status_code, "body_head": resp.text[:500]},
        remote_outcome_unknown=resp.status_code >= 500,
        status=502,
    )


__all__ = [
    "CANCEL_TIMEOUT",
    "CONNECT_TIMEOUT_S",
    "FORWARD_TIMEOUT",
    "NOT_SENT_ERRORS",
    "READ_TIMEOUT",
    "error_from_response",
    "request_sent",
    "transport_error",
]
