"""Request and response helpers shared by the controller and the NodeGateway.

Every error body is a contract ``Error``; the HTTP status comes from the error code
(``phasyn_components.errors.HTTP_STATUS``). JSON request bodies must be sent as ``Content-Type:
application/json`` (otherwise 415 ``UNSUPPORTED_MEDIA_TYPE``: a browser "simple request" cannot carry it) and
are bounded: larger than the app's ``HttpLimits.json_body_bytes`` → 413 ``PAYLOAD_TOO_LARGE``, before or
while the body is read.
``compressed_json_response`` gzips large or frequently polled JSON (catalog, a recording) when the client
accepts it; file and media streams (Range) never go through it.
"""

from __future__ import annotations

import asyncio
import gzip
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from starlette.responses import JSONResponse, Response

DEFAULT_JSON_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
JSON_MEDIA_TYPE = "application/json"
GZIP_MIN_BYTES = 1024
GZIP_LEVEL = 6
MAX_SAFE_INT = 2**53 - 1


@dataclass(frozen=True)
class HttpLimits:
    """Request size limits of one app (configurable: ``max_json_body_bytes`` / ``max_upload_bytes``)."""

    json_body_bytes: int = DEFAULT_JSON_BODY_BYTES
    upload_bytes: int = DEFAULT_UPLOAD_BYTES


def limits_of(request: Request) -> HttpLimits:
    limits = getattr(request.app.state, "http_limits", None)
    return limits if isinstance(limits, HttpLimits) else HttpLimits()


# ---------------------------------------------------------------------- responses
def error_response(err: ComponentError, *, headers: Mapping[str, str] | None = None) -> JSONResponse:
    return JSONResponse(err.to_dict(), status_code=err.status, headers=dict(headers or {}))


def json_response(doc: Any, status_code: int = 200, *, headers: Mapping[str, str] | None = None) -> JSONResponse:
    return JSONResponse(doc, status_code=status_code, headers=dict(headers or {}))


def attachment(filename: str) -> dict[str, str]:
    """``Content-Disposition: attachment`` with a file name reduced to ``[A-Za-z0-9._-]``."""
    safe = "".join(c for c in filename if c.isascii() and (c.isalnum() or c in "-_.")) or "download"
    return {"Content-Disposition": f'attachment; filename="{safe}"'}


def accepts_gzip(header: str | None) -> bool:
    """Whether Accept-Encoding names gzip (``gzip;q=0`` is a refusal; ``*`` is deliberately not honoured)."""
    for item in (header or "").split(","):
        name, _, params = item.strip().partition(";")
        if name.strip().lower() != "gzip":
            continue
        quality = params.strip().lower()
        if quality.startswith("q="):
            try:
                return float(quality[2:]) > 0
            except ValueError:
                return False
        return True
    return False


def encode_json(doc: Any, *, gzip_ok: bool) -> tuple[bytes, bool]:
    """Same serialisation as JSONResponse; gzip (mtime=0: same content, same bytes) when large enough."""
    body = json.dumps(doc, ensure_ascii=False, allow_nan=False, indent=None, separators=(",", ":")).encode("utf-8")
    if gzip_ok and len(body) >= GZIP_MIN_BYTES:
        return gzip.compress(body, compresslevel=GZIP_LEVEL, mtime=0), True
    return body, False


async def compressed_json_response(request: Request, doc: Any, status_code: int = 200) -> Response:
    """JSON response, gzipped when accepted; serialising and compressing run in a thread."""
    body, compressed = await asyncio.to_thread(
        encode_json, doc, gzip_ok=accepts_gzip(request.headers.get("accept-encoding"))
    )
    headers = {"Vary": "Accept-Encoding"}
    if compressed:
        headers["Content-Encoding"] = "gzip"
    return Response(content=body, status_code=status_code, media_type="application/json", headers=headers)


# ---------------------------------------------------------------------- request bodies
def payload_too_large(what: str, limit: int) -> ComponentError:
    return ComponentError("PAYLOAD_TOO_LARGE", f"{what}超過上限 {limit} bytes", details={"limit_bytes": limit})


def declared_length(request: Request) -> int | None:
    raw = request.headers.get("content-length")
    return int(raw) if raw is not None and raw.isdigit() else None


def require_json_content_type(request: Request, *, what: str) -> None:
    raw = request.headers.get("content-type") or ""
    if raw.split(";", 1)[0].strip().lower() != JSON_MEDIA_TYPE:
        raise ComponentError(
            "UNSUPPORTED_MEDIA_TYPE",
            f"{what}需要 Content-Type: {JSON_MEDIA_TYPE}（收到 {raw[:100]!r}）",
            details={"content_type": raw[:200]},
        )


def _reject_constant(name: str) -> Any:
    raise ValueError(f"JSON 不允許 {name}")


def parse_json_bytes(data: bytes | bytearray, *, what: str = "JSON 本文") -> Any:
    """Strict JSON (NaN／Infinity rejected); empty, invalid or too deeply nested → 422 INVALID_ARGUMENT."""
    if not data:
        raise ComponentError("INVALID_ARGUMENT", f"需要{what}")
    try:
        return json.loads(data, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:  # ValueError covers UnicodeDecodeError; deep nesting → RecursionError
        raise ComponentError("INVALID_ARGUMENT", f"{what}不是有效 JSON：{exc}") from exc


async def read_json(request: Request, *, limit: int | None = None, what: str = "JSON 本文") -> Any:
    """Read and parse a bounded JSON body; ``limit`` defaults to the app's ``HttpLimits.json_body_bytes``."""
    require_json_content_type(request, what=what)
    cap = limits_of(request).json_body_bytes if limit is None else limit
    declared = declared_length(request)
    if declared is not None and declared > cap:
        raise payload_too_large(what, cap)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > cap:
            raise payload_too_large(what, cap)
    return parse_json_bytes(body, what=what)


async def read_contract_json(
    request: Request, definition: str, *, what: str, limit: int | None = None
) -> dict[str, Any]:
    """``read_json`` plus validation against the contract ``definition`` (422 INVALID_ARGUMENT)."""
    doc = await read_json(request, limit=limit, what=what)
    contracts.validate(definition, doc, what=what)
    return dict(doc)


# ---------------------------------------------------------------------- query parameters
def query_int(
    params: Mapping[str, str], name: str, *, default: int | None, minimum: int, maximum: int = MAX_SAFE_INT
) -> int | None:
    raw = params.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ComponentError("INVALID_ARGUMENT", f"{name} 必須是整數：{raw[:100]!r}", details={"field": name}) from exc
    if value < minimum or value > maximum:
        raise ComponentError(
            "INVALID_ARGUMENT", f"{name} 必須介於 {minimum} 與 {maximum}", details={"field": name, "value": value}
        )
    return value


def query_bool(params: Mapping[str, str], name: str, *, default: bool) -> bool:
    """Only ``true``／``false`` (case-insensitive); empty means the default."""
    raw = params.get(name)
    if raw is None or raw == "":
        return default
    value = raw.strip().lower()
    if value not in ("true", "false"):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"{name} 必須是 true 或 false：{raw[:100]!r}",
            details={"field": name, "value": raw[:100]},
        )
    return value == "true"


__all__ = [
    "DEFAULT_JSON_BODY_BYTES",
    "DEFAULT_UPLOAD_BYTES",
    "GZIP_MIN_BYTES",
    "JSON_MEDIA_TYPE",
    "MAX_SAFE_INT",
    "HttpLimits",
    "accepts_gzip",
    "attachment",
    "compressed_json_response",
    "declared_length",
    "encode_json",
    "error_response",
    "json_response",
    "limits_of",
    "parse_json_bytes",
    "payload_too_large",
    "query_bool",
    "query_int",
    "read_contract_json",
    "read_json",
    "require_json_content_type",
]
