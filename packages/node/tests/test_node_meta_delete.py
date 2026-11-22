"""元件顯示資訊（PATCH /api/components/{id}/meta）與刪除（DELETE /api/components/{id}）：真實 runtime_host 子程序。

- meta 任何狀態都可改：不重新載入、不換程序、stored_revision 不變；原子寫入定義檔並重新上報目錄。
- 刪除只在 stopped/error（其餘 409 STATE_CONFLICT）；紀錄保留；刪除記錄讓 Node 設定檔的同名 seed 不在重啟時重建，
  同 id 的 PUT 清除刪除記錄。
"""

from __future__ import annotations

import asyncio
import json
import types
import uuid
from functools import cache
from pathlib import Path
from typing import Any

import pytest
from node_testkit import (
    InvokeOptions,
    Node,
    Router,
    assert_valid,
    cpu_runtime,
    echo_definition,
    fixture_runtime,
    invoke_body,
    make_config,
    running_node,
    wait_until,
)
from phasyn_components import contracts


pytestmark = pytest.mark.anyio


@cache
def delete_result_schema() -> dict[str, Any]:
    doc = json.loads(
        (contracts.contracts_dir() / contracts.OPENAPI_FILE).read_text(encoding="utf-8")
    )
    op = doc["paths"]["/api/components/{component_id}"]["delete"]
    return dict(op["responses"]["200"]["content"]["application/json"]["schema"])


def assert_deleted(body: Any, component_id: str) -> None:
    contracts.validate_with_schema(
        delete_result_schema(), body, code="INVALID_ARGUMENT", what="刪除回覆"
    )
    assert body == {"component_id": component_id, "deleted": True}


def stored(config_dir: Path, component_id: str) -> dict[str, Any]:
    return dict(
        json.loads(
            (config_dir / "components" / f"{component_id}.json").read_text(
                encoding="utf-8"
            )
        )
    )


async def quiet_catalog(router: Router, component_id: str, **fields: Any) -> int:
    """等目錄上報反映目前狀態後回傳 PUT 次數（週期上報設 60 秒：之後的 PUT 只會來自變更通知）。"""
    await wait_until(
        lambda: last_snapshot_has(router, component_id, **fields),
        limit_s=3,
        what="目錄上報追上目前狀態",
    )
    await asyncio.sleep(0.3)  # 讓已觸發的上報送完
    return len(router.controller.catalog_puts)


def last_snapshot_has(router: Router, component_id: str, **fields: Any) -> bool:
    puts = router.controller.catalog_puts
    if not puts:
        return False
    found = {c["component_id"]: c for c in puts[-1]["components"]}.get(component_id)
    if not fields:
        return found is not None
    return found is not None and all(found.get(k) == v for k, v in fields.items())


async def _assert_meta_catalog(node: Node, router: Router, url: str) -> None:
    # 改變會立即重新上報目錄（不等週期上報）；快照符合契約
    pushes = await quiet_catalog(
        router, "echo", label="忙碌中改名", state="ready", active_call_id=None
    )
    resp = await node.client.patch(url, json={"folder": "最後/檢查", "autostart": True})
    assert resp.status_code == 200, resp.text
    await wait_until(
        lambda: (
            len(router.controller.catalog_puts) > pushes
            and last_snapshot_has(router, "echo", folder="最後/檢查", autostart=True)
        ),
        limit_s=2,
        what="meta 變更後立即上報目錄",
    )
    assert router.controller.problems == []


async def _assert_meta_validation(node: Node, config_dir: Path, url: str) -> None:
    # 驗證：空 body、未知欄位、folder 格式、空 label、非布林 autostart → 422；不寫檔
    before = (config_dir / "components" / "echo.json").read_bytes()
    bad_bodies: list[Any] = [
        {},
        {"surprise": 1},
        {"label": "x", "settings": {}},
        {"folder": ""},
        {"folder": "a//b"},
        {"folder": "/a"},
        {"folder": "a/"},
        {"folder": "a\nb"},
        {"folder": "/".join(["層"] * 7)},
        {"folder": "x" * 61},
        {"label": ""},
        {"autostart": "yes"},
        [{"label": "x"}],
    ]
    for body in bad_bodies:
        resp = await node.client.patch(url, json=body)
        assert (resp.status_code, resp.json()["code"]) == (
            422,
            "INVALID_ARGUMENT",
        ), (body, resp.text)
        assert_valid("Error", resp.json())
    assert (config_dir / "components" / "echo.json").read_bytes() == before
    assert (
        await node.client.patch(url, json={"folder": "/".join(["層"] * 6)})
    ).status_code == 200  # 6 層上限

    missing = await node.client.patch("/api/components/nope/meta", json={"label": "x"})
    assert (missing.status_code, missing.json()["code"]) == (404, "NOT_FOUND")


async def test_meta_patch_in_any_state_without_reload(tmp_path: Path) -> None:
    seed = {**echo_definition("echo"), "folder": "測試/CPU"}
    config = make_config(
        tmp_path,
        components=[seed, echo_definition("plain", group="cpu-plain")],
        catalog_interval_seconds=60,
    )
    config_dir = config.data_dir / "config"
    router = Router()
    async with running_node(config, router) as node:
        url = "/api/components/echo/meta"
        components = await node.components()
        assert (components["echo"]["folder"], components["echo"]["autostart"]) == (
            "測試/CPU",
            False,
        )
        assert (components["plain"]["folder"], components["plain"]["autostart"]) == (
            None,
            False,
        )

        # stopped：三個欄位一起改；設定與 revision 不動
        resp = await node.client.patch(
            url, json={"label": "回音", "folder": "生成/H3 DiT", "autostart": True}
        )
        assert resp.status_code == 200, resp.text
        desc = resp.json()
        assert_valid("ComponentDescriptor", desc)
        assert (desc["label"], desc["folder"], desc["autostart"], desc["state"]) == (
            "回音",
            "生成/H3 DiT",
            True,
            "stopped",
        )
        assert desc["settings"]["stored_revision"] == 1
        saved = stored(config_dir, "echo")
        assert (
            saved["stored_revision"] == 1
            and saved["definition"]["settings"] == seed["settings"]
        )
        assert (
            saved["definition"]["label"],
            saved["definition"]["folder"],
            saved["definition"]["autostart"],
        ) == (
            "回音",
            "生成/H3 DiT",
            True,
        )

        # ready：同一個程序、不重新載入；folder=null 取消分類（label 未送 → 不變）
        await node.start_ready("echo")
        inst = node.service.instances["echo"]
        initial_process = inst.process
        assert initial_process is not None
        pid, spawns = initial_process.pid, inst.spawn_count
        resp = await node.client.patch(url, json={"folder": None, "autostart": False})
        assert resp.status_code == 200, resp.text
        desc = resp.json()
        assert_valid("ComponentDescriptor", desc)
        assert (desc["label"], desc["folder"], desc["autostart"], desc["state"]) == (
            "回音",
            None,
            False,
            "ready",
        )
        settings = desc["settings"]
        assert (
            settings["stored_revision"],
            settings["loaded_revision"],
            settings["restart_required"],
        ) == (1, 1, False)
        observed_process = inst.process
        assert (
            observed_process is not None
            and observed_process.pid == pid
            and inst.spawn_count == spawns
        )
        saved = stored(config_dir, "echo")
        assert (
            "folder" not in saved["definition"]
            and saved["definition"]["autostart"] is False
        )
        assert saved["stored_revision"] == 1

        # busy：呼叫照常進行，不受影響
        call_id = str(uuid.uuid4())
        long_call = asyncio.create_task(
            node.invoke(
                "echo",
                invoke_body(
                    value=1,
                    parameters={"steps": 300, "step_ms": 10},
                    options=InvokeOptions(call_id=call_id),
                ),
            )
        )
        await node.wait_state("echo", "busy")
        resp = await node.client.patch(url, json={"label": "忙碌中改名"})
        assert resp.status_code == 200, resp.text
        assert (
            resp.json()["state"],
            resp.json()["active_call_id"],
            resp.json()["label"],
        ) == (
            "busy",
            call_id,
            "忙碌中改名",
        )
        assert (await node.cancel("echo", call_id)).json()["accepted"] is True
        assert (await long_call).json()["state"] == "cancelled"
        observed_process = inst.process
        assert (
            observed_process is not None
            and observed_process.pid == pid
            and inst.spawn_count == spawns
        )

        await _assert_meta_catalog(node, router, url)
        await _assert_meta_validation(node, config_dir, url)


async def _assert_pending_delete_refused(node: Node) -> None:
    # error 狀態但自有程序未確認退出（PROCESS_EXIT_UNCONFIRMED 的情境）→ 仍拒絕，不留下無人管理的程序
    bad_inst = node.service.instances["bad"]
    bad_inst.state = "error"
    bad_inst.process = types.SimpleNamespace(
        pid=999999, process_instance_id="unconfirmed"
    )  # type: ignore[assignment]
    resp = await node.client.delete("/api/components/bad")
    assert resp.status_code == 409 and resp.json()["code"] == "STATE_CONFLICT", (
        resp.text
    )
    assert (
        resp.json()["details"]["pid"] == 999999
        and "尚未確認退出" in resp.json()["message"]
    )
    bad_inst.state, bad_inst.process = "stopped", None
    # restart 的停止階段剛結束（stopped，但接著會再載入）→ 拒絕，不默默取消使用者的 restart
    bad_inst._restart_pending = True
    resp = await node.client.delete("/api/components/bad")
    assert resp.status_code == 409 and resp.json()["details"] == {
        "state": "stopped",
        "restart_pending": True,
    }
    bad_inst._restart_pending = False
    # 取消逾時已終止程序（stopped）但呼叫還在收尾 → 拒絕
    finishing = str(uuid.uuid4())
    bad_inst.active_call = types.SimpleNamespace(call_id=finishing)  # type: ignore[assignment]
    resp = await node.client.delete("/api/components/bad")
    assert resp.status_code == 409 and resp.json()["details"] == {
        "state": "stopped",
        "active_call_id": finishing,
    }
    bad_inst.active_call = None


async def _assert_stopped_delete(node: Node, config_dir: Path, router: Router) -> None:
    # stopped → 可刪除：定義檔移除、寫入刪除記錄、立即重新上報目錄；紀錄保留
    assert (await node.control("echo", "stop")).status_code == 200
    await node.wait_state("echo", "stopped")
    pushes = await quiet_catalog(router, "echo", state="stopped")
    resp = await node.client.delete("/api/components/echo")
    assert resp.status_code == 200, resp.text
    assert_deleted(resp.json(), "echo")
    assert not (config_dir / "components" / "echo.json").exists()
    tombstone = json.loads(
        (config_dir / "deleted-components" / "echo.json").read_text(encoding="utf-8")
    )
    assert (
        tombstone["component_id"] == "echo"
        and tombstone["definition"]["provider_id"] == "test.echo"
    )
    assert (
        "echo" not in node.service.instances and "echo" not in await node.components()
    )
    assert set(await node.components()) == {"slow"}

    for method, path, body in (
        ("DELETE", "/api/components/echo", None),
        ("PATCH", "/api/components/echo/meta", {"label": "x"}),
        ("POST", "/api/components/echo/control", {"action": "start"}),
        ("GET", "/api/components/echo/settings", None),
    ):
        resp = await node.client.request(method, path, json=body)
        assert (resp.status_code, resp.json()["code"]) == (404, "NOT_FOUND"), (
            method,
            path,
            resp.text,
        )

    loads = (
        await node.client.get("/api/recordings", params={"component_id": "echo"})
    ).json()
    assert_valid("RecordingPage", loads)
    operations = sorted(item["context"]["operation"] for item in loads["items"])
    assert (
        operations.count("load") == 1
        and operations.count("unload") == 1
        and "invoke" in operations
    )

    await wait_until(
        lambda: (
            len(router.controller.catalog_puts) > pushes
            and last_snapshot_has(router, "slow")
            and not last_snapshot_has(router, "echo")
        ),
        limit_s=2,
        what="刪除後立即上報目錄（不再列出已刪除的元件）",
    )
    assert router.controller.problems == []


async def test_delete_only_when_stopped_or_error_and_keeps_records(
    tmp_path: Path,
) -> None:
    slow = echo_definition("slow", group="cpu-slow", provider_options={"load_ms": 5000})
    bad = {
        **echo_definition("bad", group="cpu-bad"),
        "runtime_id": "faulty",
    }  # fails while loading
    config = make_config(
        tmp_path,
        components=[echo_definition("echo"), slow, bad],
        runtimes=[cpu_runtime(), fixture_runtime("faulty", "fail_load")],
        catalog_interval_seconds=60,
    )
    config_dir = config.data_dir / "config"
    router = Router()
    async with running_node(config, router) as node:

        async def refused(component_id: str, state: str) -> None:
            resp = await node.client.delete(f"/api/components/{component_id}")
            assert resp.status_code == 409, resp.text
            body = resp.json()
            assert_valid("Error", body)
            assert body == {
                "code": "STATE_CONFLICT",
                "message": f"元件目前是 {state}：先停止才能刪除",
                "details": {"state": state},
            }
            assert (config_dir / "components" / f"{component_id}.json").exists()

        await node.start_ready("echo")
        await refused("echo", "ready")
        call_id = str(uuid.uuid4())
        long_call = asyncio.create_task(
            node.invoke(
                "echo",
                invoke_body(
                    value=1,
                    parameters={"steps": 300, "step_ms": 10},
                    options=InvokeOptions(call_id=call_id),
                ),
            )
        )
        await node.wait_state("echo", "busy")
        await refused("echo", "busy")
        assert (await node.cancel("echo", call_id)).json()["accepted"] is True
        assert (await long_call).json()["state"] == "cancelled"

        loading = await node.control("slow", "start")
        assert loading.status_code == 200 and loading.json()["state"] == "loading", (
            loading.text
        )
        await refused("slow", "loading")
        assert (await node.control("slow", "stop")).status_code == 200
        await node.wait_state("slow", "stopped")

        await _assert_pending_delete_refused(node)
        # 載入失敗停在 error（程序已確認結束）→ 可刪除
        assert (await node.control("bad", "start")).status_code == 200
        failed = await node.wait_state("bad", "error")
        assert failed["last_error"]["code"] == "MODEL_INCOMPATIBLE"
        resp = await node.client.delete("/api/components/bad")
        assert resp.status_code == 200, resp.text
        assert_deleted(resp.json(), "bad")

        await _assert_stopped_delete(node, config_dir, router)


async def test_deleted_seed_is_not_recreated_until_put(tmp_path: Path) -> None:
    seed = {**echo_definition("echo"), "folder": "測試"}
    keep = echo_definition("keep", group="cpu-keep")
    config = make_config(tmp_path, components=[seed, keep])
    config_dir = config.data_dir / "config"
    async with running_node(config) as node:
        resp = await node.client.delete("/api/components/echo")
        assert resp.status_code == 200, resp.text
        assert_deleted(resp.json(), "echo")

    # 模擬服務重啟（同一份設定檔仍列出 echo seed）：不重建
    async with running_node(config) as node:
        assert set(await node.components()) == {"keep"}
        assert not (config_dir / "components" / "echo.json").exists()
        # 同 id 的 PUT 重新建立並清除刪除記錄；folder 由定義帶入
        created = await node.client.put("/api/components/echo", json=seed)
        assert created.status_code == 200, created.text
        assert_valid("ComponentDescriptor", created.json())
        assert (
            created.json()["folder"],
            created.json()["settings"]["stored_revision"],
        ) == ("測試", 1)
        assert not (config_dir / "deleted-components" / "echo.json").exists()

    async with running_node(config) as node:
        components = await node.components()
        assert (
            set(components) == {"echo", "keep"}
            and components["echo"]["folder"] == "測試"
        )
