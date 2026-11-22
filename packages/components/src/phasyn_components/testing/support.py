"""Small helpers shared by the repository's test suites (no pytest dependency here).

FFmpeg-related helpers live in :mod:`phasyn_media.testing` (they need the media tools).
"""

from __future__ import annotations

import asyncio
import socket
import time
from collections.abc import Awaitable, Callable
from typing import Any


POLL_S = 0.02


def free_port(host: str = "127.0.0.1") -> int:
    """A TCP port that was free a moment ago (bind to port 0 and read the choice back)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def wait_until[T](
    predicate: Callable[[], T], *, timeout: float = 10.0, what: str = "condition"
) -> T:
    """Poll ``predicate`` until it returns something truthy (returned); ``AssertionError`` on timeout.

    Use it for conditions the code under test reaches on its own; the timeout is a generous upper
    bound, never a performance claim.
    """
    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if result:
            return result
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {timeout:g} s waiting for {what}")
        time.sleep(POLL_S)


async def wait_until_async(
    predicate: Callable[[], Any | Awaitable[Any]],
    *,
    timeout: float = 10.0,  # noqa: ASYNC109 - The polling deadline is part of the public test SDK.
    what: str = "condition",
) -> Any:
    """:func:`wait_until` for asyncio tests; ``predicate`` may return an awaitable."""
    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
            result = await result
        if result:
            return result
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {timeout:g} s waiting for {what}")
        await asyncio.sleep(POLL_S)


__all__ = ["free_port", "wait_until", "wait_until_async"]
