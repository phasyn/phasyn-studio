"""load_policy／idle_unload_seconds（ComponentMetaPatch）：只改定義、原子寫檔、描述一律輸出；無效值 422 且不寫檔。

Node 只保存與上報這兩個欄位；用到才載入與閒置卸載由主控執行（phasyn_controller.runner.on_demand）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from node_testkit import (
    Router,
    assert_valid,
    echo_definition,
    make_config,
    running_node,
)


pytestmark = pytest.mark.anyio


def _stored(config_dir: Path) -> dict[str, Any]:
    path = config_dir / "components" / "echo.json"
    return dict(json.loads(path.read_text(encoding="utf-8"))["definition"])


async def test_load_policy_meta_round_trip(tmp_path: Path) -> None:
    config = make_config(
        tmp_path, components=[echo_definition("echo")], catalog_interval_seconds=60
    )
    config_dir = config.data_dir / "config"
    async with running_node(config, Router()) as node:
        url = "/api/components/echo/meta"
        first = (await node.components())["echo"]
        assert_valid("ComponentDescriptor", first)
        assert (first["load_policy"], first["idle_unload_seconds"]) == (
            "resident",
            None,
        )

        resp = await node.client.patch(
            url, json={"load_policy": "on_demand", "idle_unload_seconds": 900}
        )
        assert resp.status_code == 200, resp.text
        assert_valid("ComponentDescriptor", resp.json())
        assert (resp.json()["load_policy"], resp.json()["idle_unload_seconds"]) == (
            "on_demand",
            900,
        )
        assert resp.json()["state"] == "stopped"  # 只改定義：不會因此啟動
        stored = _stored(config_dir)
        assert (stored["load_policy"], stored["idle_unload_seconds"]) == (
            "on_demand",
            900,
        )

        before = (config_dir / "components" / "echo.json").read_bytes()
        for body in (
            {"load_policy": "lazy"},
            {"idle_unload_seconds": 5},
            {"idle_unload_seconds": "600"},
            {"load_policy": None},
        ):
            bad = await node.client.patch(url, json=body)
            assert (bad.status_code, bad.json()["code"]) == (422, "INVALID_ARGUMENT"), (
                body
            )
        assert (config_dir / "components" / "echo.json").read_bytes() == before

        reset = await node.client.patch(
            url, json={"idle_unload_seconds": None, "load_policy": "resident"}
        )
        assert reset.status_code == 200, reset.text
        assert (reset.json()["load_policy"], reset.json()["idle_unload_seconds"]) == (
            "resident",
            None,
        )
        assert "idle_unload_seconds" not in _stored(config_dir)
