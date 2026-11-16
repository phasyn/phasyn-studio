"""HTTP routes of the Studio plugin packages (x-phasyn-extension).

- Reads: the registry (``GET /api/studio/plugins``), one package, its removal preview, one of its files and its
  export. Writes: install or update, switch off or on, remove, reload a development package.
- A write is refused before the route runs when it comes from another site or from an opaque origin (``Origin:
  null``, which is what a sandboxed frame sends): the Controller's request guard (``phasyn_server.middleware``)
  answers 400 ``BAD_REQUEST``. An upload must also be ``Content-Type: application/octet-stream``, which a page of
  another site cannot send without a preflight this service never answers.
- An upload is counted while it arrives: past ``plugins.max_package_bytes`` the answer is 413 and its staging
  directory is removed, like after every other failure. One that stops arriving is ended the same way, because the
  store's single writer is held from the first byte of an upload to the end of its installation.
- A package file is served as data: ``application/octet-stream`` (a bitmap whose header was checked keeps its image
  type), ``nosniff`` and a ``sandbox`` policy, so nothing a stranger packed runs or renders in this origin.
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Iterator
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components.errors import ComponentError
from phasyn_server.files import FILE_SECURITY_HEADERS
from phasyn_server.http import (
    attachment,
    compressed_json_response,
    declared_length,
    json_response,
    payload_too_large,
    query_bool,
    read_contract_json,
)
from starlette.background import BackgroundTask
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, Response, StreamingResponse

from .store import UPLOAD_NAME, PluginStore, disk_error

if TYPE_CHECKING:
    from ..state import Controller

PACKAGE_MEDIA_TYPE = "application/octet-stream"
UPLOAD_WHAT = "插件包"
UPLOAD_BUFFER_BYTES = 1024 * 1024
UPLOAD_IDLE_SECONDS = 30.0  # the longest wait for the next bytes of an upload
EXPORT_BLOCK_BYTES = 1024 * 1024
_DIGEST = re.compile(r"[0-9a-f]{64}")
# Package files: data of this origin that must never run, render as a page or be embedded by another site.
PLUGIN_FILE_HEADERS = {
    **FILE_SECURITY_HEADERS,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-cache",
}


def _digest(request: Request, *, required: bool) -> str | None:
    raw = request.query_params.get("digest")
    if raw is None and not required:
        return None
    if raw is None or not _DIGEST.fullmatch(raw):
        raise ComponentError("INVALID_ARGUMENT", "digest 必須是 64 個十六進位字元", details={"field": "digest"})
    return raw


def _require_package_body(request: Request) -> None:
    raw = request.headers.get("content-type") or ""
    if raw.split(";", 1)[0].strip().lower() != PACKAGE_MEDIA_TYPE:
        raise ComponentError(
            "UNSUPPORTED_MEDIA_TYPE",
            f"{UPLOAD_WHAT}需要 Content-Type: {PACKAGE_MEDIA_TYPE}（收到 {raw[:100]!r}）",
            details={"content_type": raw[:200]},
        )


def _new_upload(path: Path) -> IO[bytes]:
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb")


async def _receive(request: Request, path: Path, limit: int) -> None:
    """Write the request body to ``path``, counting as it arrives; more than ``limit`` bytes → 413.

    The store's single writer is held while an upload arrives, so an upload that stops arriving is ended after
    ``UPLOAD_IDLE_SECONDS``: a connection that died without closing must not block every later write.
    """
    declared = declared_length(request)
    if declared is not None and declared > limit:
        raise payload_too_large(UPLOAD_WHAT, limit)
    received = 0
    buffer = bytearray()
    chunks = aiter(request.stream())
    handle = await asyncio.to_thread(_new_upload, path)
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(anext(chunks), UPLOAD_IDLE_SECONDS)
            except StopAsyncIteration:
                break
            except TimeoutError as exc:  # before OSError below: TimeoutError is one
                raise ComponentError(
                    "FILE_TRUNCATED",
                    "上傳中途停頓太久；沒有安裝任何東西",
                    details={"idle_seconds": UPLOAD_IDLE_SECONDS},
                ) from exc
            received += len(chunk)
            if received > limit:
                raise payload_too_large(UPLOAD_WHAT, limit)
            buffer += chunk
            if len(buffer) >= UPLOAD_BUFFER_BYTES:
                data = bytes(buffer)
                buffer.clear()
                await asyncio.to_thread(handle.write, data)
        await asyncio.to_thread(handle.write, bytes(buffer))
        await asyncio.to_thread(handle.flush)  # here, so that a full disk is reported as one
    except ClientDisconnect as exc:
        raise ComponentError("FILE_TRUNCATED", "上傳在完成前中斷；沒有安裝任何東西") from exc
    except OSError as exc:
        raise disk_error(exc, "無法接收插件包") from exc
    finally:
        await asyncio.to_thread(handle.close)


def _install(store: PluginStore, staged: Path, *, replace: bool, dry_run: bool, digest: str | None) -> dict[str, Any]:
    """The part of an installation that runs in a worker thread. It removes the staging directory itself: nothing
    else may touch that directory while the thread works in it, whatever happens to the request meanwhile."""
    try:
        return store.install(staged, replace=replace, dry_run=dry_run, digest=digest)
    finally:
        store.discard_staging(staged)


def _blocks(source: IO[bytes]) -> Iterator[bytes]:
    try:
        while block := source.read(EXPORT_BLOCK_BYTES):
            yield block
    finally:
        source.close()


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    def store() -> PluginStore:
        return ctl.plugins

    @router.get("/api/studio/plugins")
    async def list_plugins(request: Request) -> Response:
        return await compressed_json_response(request, store().document())

    @router.post("/api/studio/plugins")
    async def install_plugin(request: Request) -> JSONResponse:
        replace = query_bool(request.query_params, "replace", default=False)
        dry_run = query_bool(request.query_params, "dry_run", default=False)
        digest = _digest(request, required=False)
        store().require_install_enabled()
        _require_package_body(request)
        with store().exclusive():
            staged = await asyncio.to_thread(store().new_staging)
            try:
                await _receive(request, staged / UPLOAD_NAME, store().limits.package_bytes)
            except BaseException:
                await asyncio.to_thread(store().discard_staging, staged)
                raise
            result = await asyncio.to_thread(_install, store(), staged, replace=replace, dry_run=dry_run, digest=digest)
        return json_response(result, status_code=200 if dry_run else 201)

    @router.get("/api/studio/plugins/{plugin_id}")
    async def get_plugin(plugin_id: str) -> JSONResponse:
        return json_response(await asyncio.to_thread(store().detail, plugin_id))

    @router.patch("/api/studio/plugins/{plugin_id}")
    async def patch_plugin(plugin_id: str, request: Request) -> JSONResponse:
        body = await read_contract_json(request, "StudioPluginPatch", what="插件設定")
        with store().exclusive():
            detail = await asyncio.to_thread(
                store().set_disabled,
                plugin_id,
                disabled=bool(body["disabled"]),
                expected_revision=int(body["expected_revision"]),
            )
        return json_response(detail)

    @router.delete("/api/studio/plugins/{plugin_id}")
    async def remove_plugin(plugin_id: str, request: Request) -> JSONResponse:
        digest = _digest(request, required=True)
        with store().exclusive():
            removed = await asyncio.to_thread(store().remove, plugin_id, digest=str(digest))
        return json_response(removed)

    @router.get("/api/studio/plugins/{plugin_id}/removal-preview")
    async def removal_preview(plugin_id: str) -> JSONResponse:
        return json_response(await asyncio.to_thread(store().removal_preview, plugin_id))

    @router.get("/api/studio/plugins/{plugin_id}/files/{path:path}")
    async def plugin_file(plugin_id: str, path: str) -> Response:
        item, data = await asyncio.to_thread(store().file, plugin_id, path)
        headers = {**PLUGIN_FILE_HEADERS, "ETag": f'"{item.sha256}"'}
        return Response(content=data, media_type=item.media_type, headers=headers)

    @router.get("/api/studio/plugins/{plugin_id}/package")
    async def export_plugin(plugin_id: str) -> Response:
        name, source = await asyncio.to_thread(store().export, plugin_id)
        headers = {**PLUGIN_FILE_HEADERS, **attachment(name)}
        # Both closers are needed: the background task is skipped when the client disconnects mid-stream, and the
        # generator's finally never runs when the body is not iterated at all. close() is idempotent.
        return StreamingResponse(
            _blocks(source), media_type=PACKAGE_MEDIA_TYPE, headers=headers, background=BackgroundTask(source.close)
        )

    @router.post("/api/studio/plugins/{plugin_id}/reload")
    async def reload_plugin(plugin_id: str) -> JSONResponse:
        with store().exclusive():
            detail = await asyncio.to_thread(store().reload, plugin_id)
        return json_response(detail)

    return router


__all__ = ["PLUGIN_FILE_HEADERS", "routes"]
