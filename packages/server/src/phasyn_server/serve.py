"""Foreground serving for the controller and the NodeGateway.

``Server`` is ``uvicorn.Server`` with two changes: after a graceful SIGINT/SIGTERM shutdown it returns
instead of re-raising the signal (so ``run()`` can release the data_dir lock and return an exit code), and
an optional ``on_exit`` hook runs on the event loop as soon as the signal arrives (the Node uses it to stop
accepting calls and cancel the running ones before uvicorn's own shutdown).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
import threading
from collections.abc import Callable, Iterator
from types import FrameType
from typing import Any

import uvicorn

LOG_LEVEL_ENV = "PHASYN_LOG_LEVEL"
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
HANDLED_SIGNALS = (signal.SIGINT, signal.SIGTERM)
# HTTP client libraries log every request at INFO (a Node's catalog PUT every few seconds, telemetry batches)
QUIET_LOGGERS = ("httpx", "httpcore")


def configure_logging() -> None:
    """stderr logging (journald friendly) for the controller and the Node alike.

    The level comes from ``PHASYN_LOG_LEVEL`` (default INFO). Below DEBUG the HTTP client loggers are limited to
    WARNING so periodic requests do not flood the log; uvicorn's per-request access log is off
    (:func:`server_config`), its start-up and error messages stay.
    """
    name = (os.environ.get(LOG_LEVEL_ENV) or "INFO").upper()
    levels = logging.getLevelNamesMapping()
    level = levels.get(name, logging.INFO)
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        root.addHandler(handler)
    root.setLevel(level)
    for quiet in QUIET_LOGGERS:
        logging.getLogger(quiet).setLevel(logging.NOTSET if level <= logging.DEBUG else logging.WARNING)


# Servers keep idle connections longer than their clients do (the Controller drops them after 2 s), so a client never
# sends on a connection the server is closing at the same moment (a ReadError with an unknown remote outcome)
KEEPALIVE_SERVER_S = 30


def server_config(app: Any, *, host: str, port: int, graceful_timeout_s: int) -> uvicorn.Config:
    return uvicorn.Config(
        app,
        host=host,
        port=port,
        lifespan="on",
        log_config=None,
        access_log=False,
        proxy_headers=False,
        server_header=False,
        timeout_graceful_shutdown=graceful_timeout_s,
        timeout_keep_alive=KEEPALIVE_SERVER_S,
    )


class Server(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, *, on_exit: Callable[[], None] | None = None) -> None:
        super().__init__(config)
        self._on_exit = on_exit
        self._loop: asyncio.AbstractEventLoop | None = None

    async def serve(self, sockets: Any = None) -> None:
        self._loop = asyncio.get_running_loop()
        await super().serve(sockets=sockets)

    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        super().handle_exit(sig, frame)
        loop = self._loop
        if self._on_exit is not None and loop is not None and not loop.is_closed():
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(self._on_exit)

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        # Same as uvicorn, minus re-raising the captured signal after shutdown.
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        original = {sig: signal.signal(sig, self.handle_exit) for sig in HANDLED_SIGNALS}
        try:
            yield
        finally:
            for sig, handler in original.items():
                signal.signal(sig, handler)


__all__ = ["LOG_LEVEL_ENV", "QUIET_LOGGERS", "Server", "configure_logging", "server_config"]
