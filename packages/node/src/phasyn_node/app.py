"""NodeGateway HTTP app: the node and shared routes of contracts/openapi.json plus the x-phasyn-extension routes
(``GET /api/providers``, ``DELETE /api/files/{id}``, ``PATCH /api/components/{id}/meta``,
``DELETE /api/components/{id}``, ``GET /api/components/{id}/calls/{call_id}/preview``).

Every error is a contract ``Error`` (code, zh-Hant message, details); there is no identity, token or
permission check, and browsers are refused (the frontend reaches Nodes only through the controller).
Request bodies are validated against the contract JSON Schema and bounded in size; NaN/Infinity are rejected.
Unexpected errors return only the exception type (the stack goes to the log).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from phasyn_server import DataDirLock, HostPolicy, HttpLimits, create_api

from . import __version__
from .config import NodeConfig
from .routes import components, files, recordings, weights
from .service import NodeService


def create_app(
    config: NodeConfig,
    *,
    http_transport: httpx.AsyncBaseTransport | None = None,
    data_lock: DataDirLock | None = None,
) -> FastAPI:
    service = NodeService(config, http_transport=http_transport, data_lock=data_lock)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await service.start()
        try:
            yield
        finally:
            await service.stop()

    app = create_api(
        title="Phasyn Studio NodeGateway",
        version=__version__,
        role="node",
        limits=HttpLimits(config.max_json_body_bytes, config.max_upload_bytes),
        lifespan=lifespan,
        hosts=HostPolicy.for_service(
            config.allowed_hosts, advertise_url=config.advertise_url, bind_host=config.bind_host
        ),
    )
    app.state.service = service
    for module in (components, files, recordings, weights):
        app.include_router(module.routes(service))
    return app


__all__ = ["create_app"]
