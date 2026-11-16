"""Node 本機紀錄的查詢索引。

本機 JSONL 是權威，SQLite 只是可重建索引。這個 data_dir 只有 Node（與它 spawn 的元件程序）會寫
recording，而且 recording_id 都由 Node 指派，所以查詢前只需要增量索引「仍在寫或剛結束」的
recording；啟動時在背景完整掃一次。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3
import threading
from pathlib import Path

from phasyn_components.records import RecordingStore

log = logging.getLogger("phasyn_node.recordings")


class RecordingIndex:
    def __init__(self, recordings_root: Path, index_path: Path) -> None:
        self.store = RecordingStore(recordings_root, index_path)
        self._lock = threading.Lock()
        self._dirty: set[str] = set()
        self._closed: set[str] = set()
        self._refresh_lock = asyncio.Lock()
        self._initial: asyncio.Task[None] | None = None

    def touch(self, recording_id: str) -> None:
        with self._lock:
            self._dirty.add(recording_id)
            self._closed.discard(recording_id)

    def close(self, recording_id: str) -> None:
        """recording 已結束：下次索引後就不再追蹤。"""
        with self._lock:
            if recording_id in self._dirty:
                self._closed.add(recording_id)

    def start(self) -> None:
        if self._initial is None:
            self._initial = asyncio.create_task(self._initial_index(), name="recording-index-initial")

    async def _initial_index(self) -> None:
        try:
            added = await asyncio.to_thread(self.store.index_local)
            if added:
                log.info("紀錄索引已補齊 %d 筆本機事件", added)
        except Exception:
            log.exception("啟動時建立紀錄索引失敗（查詢會以增量方式補上）")

    def _index_pending(self) -> None:
        with self._lock:
            ids = sorted(self._dirty)
        for rid in ids:
            try:
                self.store.index_recording(rid)
            except (OSError, sqlite3.DatabaseError, ValueError):
                log.debug("索引 recording %s 失敗", rid, exc_info=True)
                continue
            with self._lock:
                if rid in self._closed:
                    self._closed.discard(rid)
                    self._dirty.discard(rid)

    async def refresh(self) -> None:
        if self._initial is not None and not self._initial.done():
            with contextlib.suppress(Exception):
                await asyncio.shield(self._initial)
        async with self._refresh_lock:
            await asyncio.to_thread(self._index_pending)

    async def refresh_one(self, recording_id: str) -> None:
        if self._initial is not None and not self._initial.done():
            with contextlib.suppress(Exception):
                await asyncio.shield(self._initial)
        try:
            await asyncio.to_thread(self.store.index_recording, recording_id)
        except (OSError, sqlite3.DatabaseError):
            log.debug("索引 recording %s 失敗", recording_id, exc_info=True)

    async def close_store(self, *, timeout: float = 10.0) -> None:
        # 背景執行緒無法中途取消：等它完成；逾時就不關 SQLite（程序結束時由 OS 回收）
        if self._initial is not None and not self._initial.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._initial), timeout=timeout)
            except (TimeoutError, Exception):
                log.warning("啟動時的紀錄索引尚未完成；略過關閉索引資料庫")
                return
        async with self._refresh_lock:
            await asyncio.to_thread(self._index_pending)
            await asyncio.to_thread(self.store.close)


__all__ = ["RecordingIndex"]
