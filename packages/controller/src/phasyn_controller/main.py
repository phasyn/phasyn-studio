"""Controller entry point: ``phasyn-studio controller --config controller.json`` calls ``run(config_path)``.

Runs in the foreground and stops gracefully on SIGINT/SIGTERM. Exit codes (the same as the Node's): 0 normal,
1 a configuration or start failure, 2 the data_dir is locked by another process. An OS service (systemd user unit / launchd) only
supervises this root process; the controller never restarts anything by itself.
"""

from __future__ import annotations

import asyncio
import logging
import sys

import httpx
from phasyn_server import DataDirBusy, DataDirLock, Server, configure_logging
from phasyn_server.serve import server_config

from .app import create_app
from .config import ConfigError, ControllerConfig, load_config


log = logging.getLogger("phasyn_controller")

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_LOCKED = 2
GRACEFUL_SHUTDOWN_S = 5


def _fail(message: object) -> None:
    sys.stderr.write(f"phasyn-studio controller：{message}\n")


async def serve(
    config: ControllerConfig,
    *,
    lock: DataDirLock | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> None:
    """Run the controller on the current event loop until a stop signal (tests or embedding)."""
    app = create_app(config, lock=lock, transport=transport)
    uv_config = server_config(
        app,
        host=config.bind_host,
        port=config.port,
        graceful_timeout_s=GRACEFUL_SHUTDOWN_S,
    )
    await Server(uv_config).serve()


def run(config_path: str) -> int:
    """Run the controller (blocking) and return the process exit code."""
    configure_logging()
    try:
        config = load_config(config_path)
    except ConfigError as exc:
        _fail(exc)
        return EXIT_CONFIG
    lock = DataDirLock(config.data_dir)
    try:
        lock.acquire()
    except DataDirBusy as exc:
        _fail(exc)
        return EXIT_LOCKED
    code = EXIT_OK
    try:
        asyncio.run(serve(config, lock=lock))
    except KeyboardInterrupt:
        pass
    except SystemExit as exc:  # uvicorn could not start (e.g. the port is taken)
        if exc.code not in (None, 0):
            code = EXIT_CONFIG  # a start failure, whatever uvicorn's own code was (as the Node reports it)
            _fail(f"無法在 {config.bind_host}:{config.port} 啟動（見上方 log）")
    finally:
        lock.release()
    return code


__all__ = ["EXIT_CONFIG", "EXIT_LOCKED", "EXIT_OK", "run", "serve"]
