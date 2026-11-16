"""時間：UTC RFC3339 只作查詢／粗排；計時一律 monotonic（十進位字串跨 wire）。"""

from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timezone
from functools import lru_cache

UTC = timezone.utc  # noqa: UP017 - GPU runtime 環境需相容較舊 Python


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_rfc3339(value: str) -> datetime:
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def mono_ns() -> int:
    return time.monotonic_ns()


@lru_cache(maxsize=1)
def boot_id() -> str:
    """同一開機期間 CLOCK_MONOTONIC 才可比較；Linux 用 kernel boot_id，其他平台用程序內 UUID。"""
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as fh:
            return fh.read().strip()
    except OSError:
        return f"process-{os.getpid()}-{uuid.uuid4()}"


def host_clock_domain(node_id: str) -> str:
    """host monotonic clock domain：node 與開機識別；跨 Node 不可直接相減。"""
    return f"host-monotonic:{node_id}:{boot_id()}"


__all__ = ["boot_id", "host_clock_domain", "mono_ns", "parse_rfc3339", "utc_now"]
