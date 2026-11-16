"""紀錄 best-effort 批次上報。

來源：元件程序 telemetry pipe 的 record，以及 Node 自己的 Recorder（``publish=`` callable）。
本機 JSONL 已經是權威；這裡只是有界佇列 + 每 ``publish_interval_ms`` 或滿一批時 POST
``/api/telemetry/batches``。失敗的批次直接丟棄並計數，不重試、不回壓元件程序或模型呼叫。

事件不會被改寫（改寫會讓之後的 fetch-history 產生同 key 不同內容）；超過單批 bytes 上限的單筆
record 單獨成批，超過 ``MAX_RECORD_BYTES`` 的直接丟棄並計數（仍可由 fetch-history 從本機補抓）。
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import logging
import threading
import time
from collections.abc import Mapping
from typing import Any

import httpx

log = logging.getLogger("phasyn_node.publisher")

MAX_CONTEXTS = 64
MAX_SUMMARIES = 64
MAX_EVENTS = 4096
MAX_RECORD_BYTES = 4 * 1024 * 1024
CRITICAL_QUEUE_RECORDS = 1024
CRITICAL_QUEUE_BYTES = 16 * 1024 * 1024
SEND_TIMEOUT = httpx.Timeout(10.0, connect=3.0)


def _dumps(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


class TelemetryPublisher:
    def __init__(
        self, *, node_id: str, controller_url: str, client: httpx.AsyncClient, recording: Mapping[str, Any]
    ) -> None:
        self.node_id = node_id
        self.url = f"{controller_url}/api/telemetry/batches"
        self._client = client
        self.interval_s = max(0.1, int(recording.get("publish_interval_ms", 1000)) / 1000)
        self.batch_events = max(1, min(MAX_EVENTS, int(recording.get("batch_max_events", 256))))
        self.batch_bytes = max(4096, int(recording.get("batch_max_bytes", 256 * 1024)))
        self.queue_events = max(1, int(recording.get("queue_max_events", 8192)))
        self.queue_bytes = max(65536, int(recording.get("queue_max_bytes", 16 * 1024 * 1024)))
        self._lock = threading.Lock()
        self._critical: collections.deque[tuple[str, bytes]] = collections.deque()
        self._critical_bytes = 0
        self._events: collections.deque[bytes] = collections.deque()
        self._event_bytes = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake: asyncio.Event | None = None
        self._wake_pending = False
        self._task: asyncio.Task[None] | None = None
        self._closed = False
        self.stats: dict[str, int] = {
            "records_enqueued": 0,
            "records_dropped": 0,
            "records_sent": 0,
            "batches_sent": 0,
            "batches_failed": 0,
            "records_lost_in_failed_batches": 0,
        }
        self._last_failure_log = 0.0

    # ------------------------------------------------------------------ producer side (any thread)
    def enqueue(self, record: Mapping[str, Any]) -> bool:
        """thread-safe、非阻塞。佇列滿或 record 無法序列化就丟棄並回 False（Recorder 會計數）。"""
        if self._closed:
            return False
        kind = record.get("record")
        data = record.get("data")
        if kind not in ("context", "event", "summary") or not isinstance(data, Mapping):
            return False
        try:
            payload = _dumps(data)
        except (TypeError, ValueError):
            with self._lock:
                self.stats["records_dropped"] += 1
            return False
        size = len(payload)
        with self._lock:
            if size > MAX_RECORD_BYTES:
                self.stats["records_dropped"] += 1
                return False
            if kind == "event":
                if len(self._events) >= self.queue_events or self._event_bytes + size > self.queue_bytes:
                    self.stats["records_dropped"] += 1
                    return False
                self._events.append(payload)
                self._event_bytes += size
                full = len(self._events) >= self.batch_events or self._event_bytes >= self.batch_bytes
            else:
                if len(self._critical) >= CRITICAL_QUEUE_RECORDS or self._critical_bytes + size > CRITICAL_QUEUE_BYTES:
                    self.stats["records_dropped"] += 1
                    return False
                self._critical.append((str(kind), payload))
                self._critical_bytes += size
                full = False
            self.stats["records_enqueued"] += 1
            wake = full and not self._wake_pending
            if wake:
                self._wake_pending = True
        if wake:
            self._signal_wake()
        return True

    def _signal_wake(self) -> None:
        loop, event = self._loop, self._wake
        if loop is None or event is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(event.set)
        except RuntimeError:
            pass

    def pending(self) -> int:
        with self._lock:
            return len(self._events) + len(self._critical)

    # ------------------------------------------------------------------ batching
    def _take_batch(self) -> tuple[bytes, int] | None:
        with self._lock:
            contexts: list[bytes] = []
            summaries: list[bytes] = []
            events: list[bytes] = []
            size = 0
            while self._critical and len(contexts) < MAX_CONTEXTS and len(summaries) < MAX_SUMMARIES:
                kind, payload = self._critical[0]
                if size and size + len(payload) > self.batch_bytes:
                    break
                self._critical.popleft()
                self._critical_bytes -= len(payload)
                (contexts if kind == "context" else summaries).append(payload)
                size += len(payload)
            while self._events and len(events) < self.batch_events:
                payload = self._events[0]
                if size and size + len(payload) > self.batch_bytes:
                    break
                self._events.popleft()
                self._event_bytes -= len(payload)
                events.append(payload)
                size += len(payload)
            self._wake_pending = False
        count = len(contexts) + len(summaries) + len(events)
        if not count:
            return None
        body = b"".join(
            [
                b'{"node_id":',
                _dumps(self.node_id),
                b',"contexts":[',
                b",".join(contexts),
                b'],"events":[',
                b",".join(events),
                b'],"summaries":[',
                b",".join(summaries),
                b"]}",
            ]
        )
        return body, count

    async def _send(self, body: bytes, count: int) -> bool:
        try:
            response = await self._client.post(
                self.url, content=body, headers={"Content-Type": "application/json"}, timeout=SEND_TIMEOUT
            )
        except httpx.HTTPError as exc:
            self._failed(count, f"{type(exc).__name__}: {exc}")
            return False
        if response.status_code >= 300:
            self._failed(count, f"HTTP {response.status_code}")
            return False
        self.stats["batches_sent"] += 1
        self.stats["records_sent"] += count
        try:
            ack = response.json()
            rejected = int(ack.get("rejected_events", 0)) if isinstance(ack, dict) else 0
        except (ValueError, TypeError):
            rejected = 0
        if rejected:
            log.warning(
                "主控拒收 %d 筆紀錄事件：%s", rejected, str(ack.get("message"))[:500] if isinstance(ack, dict) else ""
            )
        return True

    def _failed(self, count: int, reason: str) -> None:
        self.stats["batches_failed"] += 1
        self.stats["records_lost_in_failed_batches"] += count
        now = time.monotonic()
        if now - self._last_failure_log > 30:
            self._last_failure_log = now
            log.warning(
                "紀錄批次上報失敗，已丟棄 %d 筆（不重試；本機 JSONL 仍完整，可由主控手動補抓）：%s", count, reason
            )

    async def drain(self, *, max_batches: int | None = None) -> None:
        sent = 0
        while max_batches is None or sent < max_batches:
            batch = self._take_batch()
            if batch is None:
                return
            ok = await self._send(*batch)
            sent += 1
            if not ok:
                return  # 主控不可達：本輪不再嘗試，下一個週期再送新的批次

    # ------------------------------------------------------------------ lifecycle
    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        while True:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self.interval_s)
            except TimeoutError:
                pass
            self._wake.clear()
            try:
                await self.drain()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("紀錄上報迴圈發生錯誤（已忽略，不影響元件呼叫）")

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self.run(), name="telemetry-publisher")

    async def close(self, *, flush_timeout: float = 2.0) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        try:
            await asyncio.wait_for(self.drain(), timeout=flush_timeout)
        except (TimeoutError, Exception) as exc:
            log.info("關閉前的紀錄上報未完成（%s）；未送出的部分仍在本機 JSONL", type(exc).__name__)
        self._closed = True
        with self._lock:
            leftover = len(self._events) + len(self._critical)
            self._events.clear()
            self._critical.clear()
            self._event_bytes = self._critical_bytes = 0
            if leftover:
                self.stats["records_dropped"] += leftover
        log.info("紀錄上報統計：%s", self.stats)


__all__ = ["TelemetryPublisher"]
