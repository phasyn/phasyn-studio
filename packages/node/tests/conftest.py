"""NodeGateway 測試 fixtures（輔助函式在 node_testkit.py）。"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator

import psutil
import pytest
from node_testkit import runtime_children


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def no_leftover_runtime_processes() -> Iterator[None]:
    """每個測試結束後不得留下元件程序（Node 關閉時必須收掉自己的子程序）。"""
    yield
    leftovers = runtime_children()
    for proc in leftovers:
        with contextlib.suppress(psutil.Error):
            proc.kill()
    assert not leftovers, f"元件程序沒有被收掉：{[p.pid for p in leftovers]}"
