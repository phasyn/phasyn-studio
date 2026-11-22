"""``create_app(config) -> FastAPI``: one HTTP endpoint for the frontend, catalog, runner, forwarding and records.

There is no login, token, CORS or role, and no auto-generated OpenAPI document (``contracts/`` is the
contract). Errors, body limits and the browser write guard come from :mod:`phasyn_server`.
"""

from __future__ import annotations

import asyncio
import platform
import socket
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter, FastAPI, Request
from phasyn_components import PROTOCOL_VERSION
from phasyn_server import DataDirLock, HostPolicy, HttpLimits, create_api
from phasyn_server.http import (
    compressed_json_response,
    json_response,
    query_bool,
    read_json,
)
from starlette.responses import JSONResponse, Response

from . import (
    VERSION,
    cost_profiles,
    creative_library,
    draft_plans,
    files,
    forward,
    inference_presets,
    inference_recipes,
    lora_training,
    pipeline_layout,
    pipelines,
    placement,
    plugins,
    presets,
    prompt_library,
    prompt_studies,
    recordings,
    run_previews,
    runs_api,
    storage,
    studio,
    studio_media_take,
    studio_portable,
    studio_reviews,
    studio_submissions,
    studio_take_attach,
    studio_timeline,
    studio_writes,
    telemetry,
)
from .config import ControllerConfig
from .state import Controller
from .static import SpaFallback


def _core_routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.put("/api/catalog/{node_id}")
    async def put_catalog(node_id: str, request: Request) -> JSONResponse:
        body = await read_json(request, what="NodeSnapshot")
        ack, changed = await asyncio.to_thread(ctl.catalog.register, node_id, body)
        if changed:
            ctl.save_catalog_cache_soon()
        return json_response(ack)

    @router.get("/api/catalog")
    async def get_catalog(request: Request) -> Response:
        """Full catalog (default); ``?parts=false`` = CatalogLite (x-phasyn-extension, for frontend polling).

        Both are gzipped when accepted: the full catalog is mostly parts and every open tab polls it.
        """
        include_parts = query_bool(request.query_params, "parts", default=True)
        doc = await asyncio.to_thread(
            ctl.catalog.catalog if include_parts else ctl.catalog.catalog_lite
        )
        return await compressed_json_response(request, doc)

    @router.get("/api/controller")
    async def controller_info() -> JSONResponse:
        cfg = ctl.config
        return json_response(
            {
                "controller_id": cfg.instance_id,
                "label": cfg.label,
                "endpoint": cfg.advertise_url,
                "protocol_version": PROTOCOL_VERSION,
                "version": VERSION,
                "platform": f"{platform.system()} {platform.release()} {platform.machine()}".strip(),
                "hostname": socket.gethostname(),
                "started_at": ctl.started_at,
                "max_active_runs": cfg.max_active_runs,
                "node_stale_seconds": cfg.node_stale_seconds,
            }
        )

    return router


def create_app(
    config: ControllerConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    clock: Callable[[], float] | None = None,
    lock: DataDirLock | None = None,
) -> FastAPI:
    """Build the controller app. ``lock`` is taken by the caller (CLI); without it the lifespan takes it.

    ``transport`` and ``clock`` only let tests replace the HTTP to Nodes and the monotonic clock.
    """
    ctl = Controller(config, transport=transport, clock=clock, lock=lock)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await ctl.startup()
        try:
            yield
        finally:
            await ctl.shutdown()

    app = create_api(
        title="Phasyn Studio Controller",
        version=VERSION,
        role="controller",
        limits=HttpLimits(config.max_json_body_bytes, config.max_upload_bytes),
        lifespan=lifespan,
        hosts=HostPolicy.for_service(
            config.allowed_hosts,
            advertise_url=config.advertise_url,
            bind_host=config.bind_host,
        ),
    )
    app.state.controller = ctl
    for module in (
        forward,
        pipelines,
        pipeline_layout,
        runs_api,
        inference_presets,
        inference_recipes,
        run_previews,
        telemetry,
        recordings,
        files,
        presets,
        studio,
        studio_reviews,
        studio_submissions,
        creative_library,
        draft_plans,
        lora_training,
        studio_portable,
        studio_media_take,
        studio_take_attach,
        studio_timeline,
        studio_writes,
        prompt_library,
        prompt_studies,
        plugins,
        cost_profiles,
        placement,
        storage,
    ):
        app.include_router(module.routes(ctl))
    app.include_router(_core_routes(ctl))
    app.router.default = SpaFallback(config.static_dir)
    return app


__all__ = ["VERSION", "create_app"]
