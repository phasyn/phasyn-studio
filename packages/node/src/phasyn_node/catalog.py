"""元件目錄上報：每 ``catalog_interval_seconds`` 及狀態改變時 PUT 完整 NodeSnapshot。

首次有效 JSON 即登記，沒有 allowlist／批准／token。回覆的 RegistrationAck 只用來更新位址目錄
（跨 Node FileRef 下載）。主控離線時只記 log：Node 照常運作，已接的 call 照常完成。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from phasyn_components import contracts

from .files import Directory

log = logging.getLogger("phasyn_node.catalog")

PUT_TIMEOUT = httpx.Timeout(5.0, connect=2.0)
MIN_PUSH_GAP_S = 0.2


class CatalogReporter:
    def __init__(
        self,
        *,
        node_id: str,
        controller_url: str,
        client: httpx.AsyncClient,
        directory: Directory,
        interval_s: float,
        snapshot: Callable[[], Awaitable[dict[str, Any]]],
    ) -> None:
        self.node_id = node_id
        self.url = f"{controller_url}/api/catalog/{node_id}"
        self._client = client
        self._directory = directory
        self._interval = max(1.0, float(interval_s))
        self._snapshot = snapshot
        self._trigger = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._reachable: bool | None = None
        self._duplicate_logged = False
        self.pushes = 0
        self.failures = 0
        self.last_ack: dict[str, Any] | None = None

    def trigger(self) -> None:
        self._trigger.set()

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="catalog-reporter")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None

    async def _run(self) -> None:
        last = 0.0
        while True:
            gap = time.monotonic() - last
            if gap < MIN_PUSH_GAP_S:
                await asyncio.sleep(MIN_PUSH_GAP_S - gap)
            self._trigger.clear()
            last = time.monotonic()
            try:
                await self.push_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("目錄上報發生錯誤（已忽略）")
            try:
                await asyncio.wait_for(self._trigger.wait(), timeout=self._interval)
            except TimeoutError:
                pass

    async def push_once(self, *, timeout: httpx.Timeout | None = None) -> bool:
        snapshot = await self._snapshot()
        try:
            response = await self._client.put(self.url, json=snapshot, timeout=timeout or PUT_TIMEOUT)
        except httpx.HTTPError as exc:
            self._mark(False, f"{type(exc).__name__}: {exc}")
            return False
        if response.status_code >= 300:
            self._mark(False, f"HTTP {response.status_code}: {response.text[:300]}")
            return False
        try:
            ack = response.json()
        except ValueError:
            self._mark(False, "回覆不是 JSON")
            return False
        problems = contracts.errors("RegistrationAck", ack)
        if problems:
            self._mark(False, f"RegistrationAck 不符合契約：{problems[0]}")
            return False
        self.pushes += 1
        self.last_ack = ack
        self._directory.update(ack)
        self._mark(True, "")
        if self._directory.state_of(self.node_id) == "duplicate_node_id" and not self._duplicate_logged:
            self._duplicate_logged = True
            log.error(
                "主控回報 node_id %s 同時被兩個程序使用（duplicate_node_id）：這是配置錯誤，請修改其中一台的 node_id 或停止重複程序",
                self.node_id,
            )
        return True

    def _mark(self, ok: bool, reason: str) -> None:
        if not ok:
            self.failures += 1
        if ok != self._reachable:
            if ok:
                log.info("已向主控登記元件目錄（%s）", self.url)
            else:
                log.warning("無法向主控上報元件目錄（Node 照常運作，下個週期再試）：%s", reason)
            self._reachable = ok


__all__ = ["CatalogReporter"]
