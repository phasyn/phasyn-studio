"""File endpoints over a ``FileStore`` shared by the controller and the Node.

- ``receive_upload`` (``POST /api/files?media_type=``): the body is written to the store's ``.part`` file in
  ``buffer_bytes`` slices while SHA-256 is computed, and published atomically only when all of it arrived
  (matching Content-Length when one was sent). Bytes are counted as they arrive: past
  ``HttpLimits.upload_bytes`` the partial file is discarded and the request fails with 413
  ``PAYLOAD_TOO_LARGE``. A client that disconnects publishes nothing.
- ``file_response`` (``GET /api/files/{file_id}``): a published file with one byte Range at most
  (``Accept-Ranges``, ``Content-Length``, ``ETag`` = SHA-256); an invalid Range → 416.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
from typing import Any

from fastapi import Request
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore, FileWriter, parse_range
from phasyn_components.ids import require_uuid
from starlette.requests import ClientDisconnect
from starlette.responses import Response, StreamingResponse

from .http import declared_length, error_response, limits_of, payload_too_large

MEDIA_TYPE_MAX = 255
# type/subtype plus optional parameters; no control characters (it is echoed back as Content-Type), so the gap
# before the parameters is spaces or tabs only, never a line break.
MEDIA_TYPE_RE = re.compile(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(?:[ \t]*;[\x20-\x7e]*)?")
UPLOAD_WHAT = "上傳檔案"


def check_media_type(value: str | None) -> str:
    text = (value or "").strip()
    if not text:
        raise ComponentError("INVALID_ARGUMENT", "media_type 查詢參數必填", details={"field": "media_type"})
    if len(text) > MEDIA_TYPE_MAX or not MEDIA_TYPE_RE.fullmatch(text):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"media_type 格式錯誤：{text[:100]!r}（需要 type/subtype，≤{MEDIA_TYPE_MAX} 字）",
            details={"field": "media_type"},
        )
    return text


async def receive_upload(
    store: FileStore, request: Request, *, buffer_bytes: int, limit: int | None = None
) -> dict[str, Any]:
    """Store the request body as a new published file and return its FileRef."""
    media_type = check_media_type(request.query_params.get("media_type"))
    cap = limits_of(request).upload_bytes if limit is None else limit
    expected = declared_length(request)
    if expected is not None and expected > cap:
        raise payload_too_large(UPLOAD_WHAT, cap)
    writer = await asyncio.to_thread(store.new_writer, media_type, {})
    received = 0
    buffer = bytearray()
    try:
        async for chunk in request.stream():
            received += len(chunk)
            if received > cap:
                raise payload_too_large(UPLOAD_WHAT, cap)
            buffer += chunk
            if len(buffer) >= buffer_bytes:
                data = bytes(buffer)
                buffer.clear()
                await asyncio.to_thread(writer.write, data)
        if buffer:
            await asyncio.to_thread(writer.write, bytes(buffer))
        return await asyncio.to_thread(writer.commit, expected_size=expected)
    except ClientDisconnect as exc:
        _discard(store, writer)
        raise ComponentError("FILE_TRUNCATED", "上傳在完成前中斷；沒有發布任何檔案（不續傳）") from exc
    except BaseException:
        _discard(store, writer)
        raise


def _discard(store: FileStore, writer: FileWriter) -> None:
    """Drop the partial file and its (unpublished) directory; cleanup must not mask the original error."""
    with contextlib.suppress(Exception):
        writer.abort()
        store.discard_reserved(writer.file_id)


# Stored files are uploaded data served from the API's origin, with the media type the uploader gave. They are never
# sniffed and never run as a page: an uploaded text/html or image/svg+xml file opened directly stays inert (no script,
# no same-origin requests). <video>, <audio> and <img> loads are not affected.
FILE_SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"}


async def file_response(store: FileStore, file_id: str, range_header: str | None) -> Response:
    """A published file (``FILE_NOT_FOUND`` otherwise), whole or one byte range."""
    fid = require_uuid(file_id, "file_id")
    ref = await asyncio.to_thread(store.fileref, fid)
    size = int(ref["size_bytes"])
    headers = {
        "Accept-Ranges": "bytes",
        "ETag": f'"{ref["sha256"]}"',
        "Cache-Control": "no-transform",
        **FILE_SECURITY_HEADERS,
    }
    try:
        span = parse_range(range_header, size)
    except ComponentError as err:
        return error_response(err, headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"})
    status, start, end = 200, 0, size - 1
    if span is not None:
        start, end = span
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    length = max(0, end - start + 1)
    headers["Content-Length"] = str(length)
    body = store.iter_range(fid, start, end) if length else iter(())
    media_type = str(ref.get("media_type") or "application/octet-stream")
    return StreamingResponse(body, status_code=status, media_type=media_type, headers=headers)


__all__ = [
    "FILE_SECURITY_HEADERS",
    "MEDIA_TYPE_MAX",
    "MEDIA_TYPE_RE",
    "check_media_type",
    "file_response",
    "receive_upload",
]
