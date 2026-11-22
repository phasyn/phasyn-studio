"""Entry point of ``phasyn-studio node --config node.json``.

- ``run(config_path)``: blocks until SIGTERM/SIGINT. It first takes ``<data_dir>/.lock`` (held by another
  process → exit 2) and releases it on the way out. Logs go to stderr (journald friendly).
- ``serve(config)``: the async variant for tests and embedding.

On SIGTERM/SIGINT the Node immediately stops accepting calls and starts, sends a cooperative cancel to the
running calls, and only after the grace period terminates its own process groups; then idle processes are
unloaded and the recording upload is flushed briefly.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

import httpx
from phasyn_server import DataDirBusy, DataDirLock, Server, configure_logging
from phasyn_server.serve import server_config

from .app import create_app
from .config import ConfigError, NodeConfig, load_config
from .service import NodeService


log = logging.getLogger("phasyn_node")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_LOCKED = 2
SHUTDOWN_MARGIN_S = 15


async def serve(
    config: NodeConfig,
    *,
    data_lock: DataDirLock | None = None,
    http_transport: httpx.AsyncBaseTransport | None = None,
    on_server: Callable[[Server], None] | None = None,
) -> None:
    """Start the NodeGateway with the supplied local configuration."""
    app = create_app(config, http_transport=http_transport, data_lock=data_lock)
    service: NodeService = app.state.service
    uv_config = server_config(
        app,
        host=config.bind_host,
        port=config.port,
        graceful_timeout_s=config.cancel_grace_seconds + SHUTDOWN_MARGIN_S,
    )
    server = Server(uv_config, on_exit=service.begin_shutdown)
    if on_server is not None:
        on_server(server)
    await server.serve()


def run(config_path: str) -> int:
    """Run the NodeGateway (blocking); exit code 0 normal, 1 configuration or start failure, 2 data_dir busy."""
    configure_logging()
    try:
        config = load_config(config_path)
        lock = DataDirLock(config.data_dir)
        lock.acquire()
    except (ConfigError, DataDirBusy) as exc:
        error = str(exc)
        code = EXIT_LOCKED if isinstance(exc, DataDirBusy) else EXIT_FAILURE
    else:
        return _run_locked(config, lock)
    log.error("%s", error)
    return code


def _run_locked(config: NodeConfig, lock: DataDirLock) -> int:
    log.info(
        "NodeGateway 啟動中：node_id=%s bind=%s:%d advertise=%s controller=%s",
        config.node_id,
        config.bind_host,
        config.port,
        config.advertise_url,
        config.controller_url,
    )
    code = EXIT_OK
    try:
        asyncio.run(serve(config, data_lock=lock))
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else EXIT_FAILURE
    except KeyboardInterrupt:
        log.info("NodeGateway 已中斷")
    finally:
        lock.release()
    if code:
        log.error("NodeGateway 啟動失敗（exit %s）；請查看上方錯誤", code)
        return EXIT_FAILURE
    return EXIT_OK


__all__ = ["EXIT_FAILURE", "EXIT_LOCKED", "EXIT_OK", "run", "serve"]
