"""``resource_group`` try-locks.

Loads and invokes in one ``resource_group`` exclude each other. There is only a try-lock: checking and taking
happen in one synchronous step; a busy group answers DEVICE_BUSY. No hidden queue, memory reservation or VRAM
ledger. (The single-writer ``data_dir`` lock is :class:`phasyn_server.DataDirLock`.)
"""

from __future__ import annotations

import threading


class ResourceLocks:
    """resource_group → holder。thread-safe；只提供 try-lock。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._holders: dict[str, str] = {}

    def try_acquire(self, group: str, holder: str) -> str | None:
        """取得成功回 None；忙碌回目前持有者。"""
        with self._lock:
            current = self._holders.get(group)
            if current is not None:
                return current
            self._holders[group] = holder
            return None

    def release(self, group: str, holder: str) -> None:
        with self._lock:
            if self._holders.get(group) == holder:
                del self._holders[group]

    def holder(self, group: str) -> str | None:
        with self._lock:
            return self._holders.get(group)

    def snapshot(self) -> dict[str, str]:
        with self._lock:
            return dict(self._holders)


__all__ = ["ResourceLocks"]
