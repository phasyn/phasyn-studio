"""Controller file endpoints and the browser media proxy.

- ``POST /api/files?media_type=``: streamed, hashed, size-bounded upload; the FileRef's ``node_id`` is the
  controller's ``instance_id`` (user uploads such as source clips are served by the controller).
- ``GET /api/files/{id}``: one byte Range at most; an invalid Range → 416.
- ``GET /api/media/{node_id}/{file_id}``: for the browser's players only. The controller's own files are served
  locally; otherwise the request is streamed from that Node's ``GET /api/files/{id}`` (only the Range header
  is forwarded; status, Content-Range and friends are relayed). Intermediate tensors never pass through the
  controller: the runner only hands out FileRefs and Nodes download from each other.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

import httpx
from fastapi import APIRouter, Request
from phasyn_components.ids import require_uuid
from phasyn_server.files import FILE_SECURITY_HEADERS, file_response, receive_upload
from phasyn_server.http import json_response
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, Response, StreamingResponse

from .nodeclient import CONNECT_TIMEOUT_S, transport_error


if TYPE_CHECKING:
    from .state import Controller

UPLOAD_BUFFER_BYTES = 8 * 1024 * 1024
MEDIA_TIMEOUT = httpx.Timeout(
    connect=CONNECT_TIMEOUT_S, read=60.0, write=30.0, pool=CONNECT_TIMEOUT_S
)
RELAY_HEADERS = (
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-encoding",
    "content-disposition",
    "etag",
    "last-modified",
)


async def proxy_node_file(
    ctl: Controller, node_id: str, file_id: str, range_header: str | None
) -> Response:
    """Stream the requested Node file and forward supported range headers."""
    endpoint = ctl.catalog.endpoint_for_read(node_id)
    headers = {"Range": range_header} if range_header else {}
    request = ctl.http.build_request(
        "GET", f"{endpoint}/api/files/{file_id}", headers=headers, timeout=MEDIA_TIMEOUT
    )
    try:
        upstream = await ctl.http.send(request, stream=True)
    except httpx.HTTPError as exc:
        raise transport_error(
            exc,
            node_label=ctl.catalog.label(node_id),
            endpoint=endpoint,
            what="檔案讀取",
            side_effect=False,
            read_timeout=MEDIA_TIMEOUT.read,
        ) from exc
    relayed = {
        name: upstream.headers[name]
        for name in RELAY_HEADERS
        if name in upstream.headers
    }
    relayed.update(
        FILE_SECURITY_HEADERS
    )  # a Node's file is served from the controller's origin here

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    # Both closers are needed: Starlette skips the background task when the client disconnects mid-stream,
    # and the generator's finally never runs when the body is not iterated at all. aclose() is idempotent.
    return StreamingResponse(
        body(),
        status_code=upstream.status_code,
        headers=relayed,
        background=BackgroundTask(upstream.aclose),
    )


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for files."""
    router = APIRouter()

    @router.post("/api/files")
    async def upload(request: Request) -> JSONResponse:
        ref = await receive_upload(ctl.files, request, buffer_bytes=UPLOAD_BUFFER_BYTES)
        return json_response(ref, status_code=201)

    @router.get("/api/files/{file_id}")
    async def download(file_id: str, request: Request) -> Response:
        return await file_response(ctl.files, file_id, request.headers.get("range"))

    @router.get("/api/media/{node_id}/{file_id}")
    async def media(node_id: str, file_id: str, request: Request) -> Response:
        nid = require_uuid(node_id, "node_id")
        fid = require_uuid(file_id, "file_id")
        range_header = request.headers.get("range")
        if nid == ctl.instance_id:
            return await file_response(ctl.files, fid, range_header)
        return await proxy_node_file(ctl, nid, fid, range_header)

    return router


__all__ = ["proxy_node_file", "routes"]
