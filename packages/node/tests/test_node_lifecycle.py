"""元件程序生命週期：真實 runtime_host 子程序。"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import uuid
from pathlib import Path

import pytest
from node_testkit import (
    InvokeOptions,
    Node,
    assert_valid,
    cpu_runtime,
    echo_definition,
    fixture_runtime,
    invoke_body,
    make_config,
    running_node,
    wait_until,
)
from phasyn_server import DataDirBusy

from phasyn_node.main import EXIT_LOCKED, run
from phasyn_node.service import NodeService


pytestmark = pytest.mark.anyio


def pending_start(service: NodeService, component_id: str) -> list[str]:
    """Names of unfinished spawn/load/restart tasks of one component (an automatic restart would show here)."""
    prefixes = tuple(f"{kind}-{component_id}" for kind in ("spawn", "load", "restart"))
    return [
        t.get_name()
        for t in service._tasks
        if not t.done() and t.get_name().startswith(prefixes)
    ]


async def _assert_unexpected_exit(node: Node) -> None:
    inst = node.service.instances["echo"]
    # 意外退出：error（RUNTIME_EXITED），進行中的 call 以 RUNTIME_ERROR 結束，不自動重啟
    await node.start_ready("echo")
    assert inst.spawn_count == 2
    doomed = asyncio.create_task(
        node.invoke(
            "echo", invoke_body(value=1, parameters={"steps": 500, "step_ms": 10})
        )
    )
    await node.wait_state("echo", "busy")
    faulted_process = inst.process
    assert faulted_process is not None
    os.kill(faulted_process.pid, signal.SIGKILL)
    result = (await doomed).json()
    assert_valid("InvokeResult", result)
    assert result["state"] == "failed" and result["error"]["code"] == "RUNTIME_ERROR"
    assert result["error"]["details"]["process_exited"] is True
    crashed = await node.wait_state("echo", "error")
    assert crashed["last_error"]["code"] == "RUNTIME_EXITED"
    assert crashed["settings"]["loaded_revision"] is None
    assert inst.state == "error" and inst.spawn_count == 2 and inst.process is None
    assert not pending_start(node.service, "echo")  # nothing restarts it


async def test_start_idempotent_busy_stop_and_unexpected_exit(tmp_path: Path) -> None:
    config = make_config(tmp_path, components=[echo_definition("echo")])
    async with running_node(config) as node:
        inst = node.service.instances["echo"]
        first, second = await asyncio.gather(
            node.control("echo", "start"), node.control("echo", "start")
        )
        for response in (first, second):
            assert response.status_code == 200, response.text
            assert_valid("ComponentDescriptor", response.json())
            assert response.json()["state"] in ("loading", "ready")
        ready = await node.wait_state("echo", "ready")
        assert (
            ready["settings"]["loaded_revision"] == 1
            and ready["recorder_state"] == "ok"
        )
        assert ready["inputs"] and ready["outputs"] and len(ready["parts"]) == 2
        pid = inst.process.pid if inst.process else None
        again = await node.control("echo", "start")
        assert again.status_code == 200 and again.json()["state"] == "ready"
        running_process = inst.process
        assert (
            inst.spawn_count == 1
            and running_process is not None
            and running_process.pid == pid
        )

        call_id = str(uuid.uuid4())
        long_call = asyncio.create_task(
            node.invoke(
                "echo",
                invoke_body(
                    value=1,
                    parameters={"steps": 500, "step_ms": 10},
                    options=InvokeOptions(call_id=call_id),
                ),
            )
        )
        busy = await node.wait_state("echo", "busy")
        assert busy["active_call_id"] == call_id
        for action in ("stop", "restart"):
            refused = await node.control("echo", action)
            assert (
                refused.status_code == 409
                and refused.json()["code"] == "COMPONENT_BUSY"
            ), refused.text
            assert_valid("Error", refused.json())
        cancel = await node.cancel("echo", call_id)
        assert cancel.json()["accepted"] is True
        assert (await long_call).json()["state"] == "cancelled"

        stopping = await node.control("echo", "stop")
        assert stopping.status_code == 200 and stopping.json()["state"] in (
            "stopping",
            "stopped",
        )
        stopped = await node.wait_state("echo", "stopped")
        assert stopped["last_error"] is None and stopped["settings"]["loaded"] is None
        stopped_process = inst.process
        assert stopped_process is None
        assert (await node.control("echo", "stop")).json()[
            "state"
        ] == "stopped"  # no-op

        await _assert_unexpected_exit(node)
        # 每個 start/stop 都有 recording（沒有 run 也可查）
        page = (
            await node.client.get(
                "/api/recordings", params={"component_id": "echo", "operation": "load"}
            )
        ).json()
        assert_valid("RecordingPage", page)
        assert len(page["items"]) == 2
        unloads = (
            await node.client.get(
                "/api/recordings",
                params={"component_id": "echo", "operation": "unload"},
            )
        ).json()
        assert (
            len(unloads["items"]) == 1
            and unloads["items"][0]["summary"]["state"] == "succeeded"
        )


async def test_load_failures_are_visible_and_never_auto_restarted(
    tmp_path: Path,
) -> None:
    # The settings pass the Node's checks; the provider then fails while loading (fixture runtime).
    bad = {**echo_definition("bad", group="cpu-bad"), "runtime_id": "faulty"}
    ghost = {**echo_definition("ghost", group="cpu-ghost"), "runtime_id": "broken"}
    runtimes = [
        cpu_runtime(),
        cpu_runtime("broken", python=str(tmp_path / "missing" / "bin" / "python")),
        fixture_runtime("faulty", "fail_load"),
    ]
    config = make_config(tmp_path, components=[bad, ghost], runtimes=runtimes)
    async with running_node(config) as node:
        started = await node.control("bad", "start")
        assert started.status_code == 200 and started.json()["state"] == "loading"
        failed = await node.wait_state("bad", "error")
        assert failed["last_error"]["code"] == "MODEL_INCOMPATIBLE"
        assert (
            failed["settings"]["loaded"] is None
            and failed["settings"]["loaded_revision"] is None
        )
        inst = node.service.instances["bad"]
        # The state turns to error before the failed load's own task has finished its recording: let that task end
        # first, so the checks below see only what came after it (a restart or reload would be a new task).
        load = inst._task
        await wait_until(
            lambda: load is None or load.done(), what="the failed load task to end"
        )
        assert inst.state == "error" and inst.spawn_count == 1 and inst.process is None
        assert not pending_start(node.service, "bad")  # never restarted or reloaded
        assert node.service.locks.snapshot() == {}
        loads = (
            await node.client.get(
                "/api/recordings",
                params={"component_id": "bad", "error_code": "MODEL_INCOMPATIBLE"},
            )
        ).json()
        assert len(loads["items"]) == 1
        recording = loads["items"][0]
        assert (
            recording["summary"]["state"] == "failed"
            and recording["context"]["operation"] == "load"
        )

        # runtime 的 python 不存在：start 422，狀態維持 stopped 並帶 last_error，不 spawn
        refused = await node.control("ghost", "start")
        assert (
            refused.status_code == 422
            and refused.json()["code"] == "RUNTIME_UNAVAILABLE"
        )
        ghost_desc = await node.component("ghost")
        assert (
            ghost_desc["state"] == "stopped"
            and ghost_desc["last_error"]["code"] == "RUNTIME_UNAVAILABLE"
        )
        assert node.service.instances["ghost"].spawn_count == 0

        # provider not installed: the definition is refused (the provider cannot check its settings)
        missing = {
            **echo_definition("missing", group="cpu-missing"),
            "provider_id": "test.not_installed",
        }
        created = await node.client.put("/api/components/missing", json=missing)
        assert (
            created.status_code == 422
            and created.json()["code"] == "PROVIDER_NOT_INSTALLED"
        )
        assert "missing" not in node.service.instances

        providers = (await node.client.get("/api/providers")).json()
        assert_valid("ProviderList", providers)
        by_runtime = {
            (p["runtime_id"], p["provider_id"]): p for p in providers["items"]
        }
        assert by_runtime[("cpu", "test.echo")]["available"] is True
        assert by_runtime[("broken", "test.echo")]["available"] is False
        assert "python" in by_runtime[("broken", "test.echo")]["reason"]


async def test_put_component_rules_seed_persistence_and_data_dir_lock(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, components=[echo_definition("echo")])
    extra = echo_definition("extra", group="cpu-extra")
    async with running_node(config) as node:
        mismatch = await node.client.put("/api/components/other", json=extra)
        assert (
            mismatch.status_code == 422
            and mismatch.json()["code"] == "INVALID_ARGUMENT"
        )
        unknown_runtime = await node.client.put(
            "/api/components/extra", json={**extra, "runtime_id": "nope"}
        )
        assert unknown_runtime.status_code == 422
        invalid = await node.client.put(
            "/api/components/extra", json={**extra, "surprise": 1}
        )
        assert invalid.status_code == 422
        created = await node.client.put("/api/components/extra", json=extra)
        assert created.status_code == 200, created.text
        assert_valid("ComponentDescriptor", created.json())
        assert (
            created.json()["state"] == "stopped"
            and created.json()["settings"]["stored_revision"] == 1
        )
        replaced = await node.client.put(
            "/api/components/extra", json={**extra, "label": "改名"}
        )
        assert (
            replaced.json()["label"] == "改名"
            and replaced.json()["settings"]["stored_revision"] == 2
        )
        saved = json.loads(
            (config.data_dir / "config" / "components" / "extra.json").read_text(
                encoding="utf-8"
            )
        )
        assert saved["stored_revision"] == 2 and saved["definition"]["label"] == "改名"

        await node.start_ready("extra")
        conflict = await node.client.put("/api/components/extra", json=extra)
        assert (
            conflict.status_code == 409 and conflict.json()["code"] == "STATE_CONFLICT"
        )
        assert "settings" in conflict.json()["message"]

        # 同一 data_dir 的第二個 Node：拒絕（exit 2）
        with pytest.raises(DataDirBusy):
            await NodeService(config).start()
        config_file = tmp_path / "node.json"
        config_file.write_text(json.dumps(config.to_dict()), encoding="utf-8")
        assert run(str(config_file)) == EXIT_LOCKED

    # 重新啟動：seed 只在沒有保存的定義時才寫入；保存的定義（含 revision）優先
    seed_v2 = {**echo_definition("echo"), "label": "seed v2"}
    auto = {**echo_definition("auto", group="cpu-auto"), "autostart": True}
    auto2 = {
        **echo_definition("auto2", group="cpu-auto"),
        "autostart": True,
    }  # 同 group：依序啟動，不互撞 DEVICE_BUSY
    config2 = make_config(
        tmp_path, node_id=config.node_id, components=[seed_v2, auto, auto2]
    )
    async with running_node(config2) as node:
        components = await node.components()
        assert components["echo"]["label"] == "echo echo"
        assert (
            components["extra"]["label"] == "改名"
            and components["extra"]["settings"]["stored_revision"] == 2
        )
        assert (
            components["echo"]["state"] == "stopped"
            and components["extra"]["state"] == "stopped"
        )
        await node.wait_state(
            "auto", "ready"
        )  # autostart=true 只在 Node 啟動時處理一次
        await node.wait_state("auto2", "ready")
        await wait_until(
            lambda: (
                node.service.catalog is not None and node.service.catalog.pushes > 0
            ),
            what="catalog push",
        )


async def test_shutdown_rejects_new_work_and_cancels_active_call(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, components=[echo_definition("echo")])
    async with running_node(config) as node:
        await node.start_ready("echo")
        call_id = str(uuid.uuid4())
        long_call = asyncio.create_task(
            node.invoke(
                "echo",
                invoke_body(
                    value=1,
                    parameters={"steps": 2000, "step_ms": 10},
                    options=InvokeOptions(call_id=call_id),
                ),
            )
        )
        await node.wait_state("echo", "busy")
        node.service.begin_shutdown()  # 與 SIGTERM/SIGINT 相同的第一步
        refused = await node.invoke("echo", invoke_body(value=1))
        assert (
            refused.status_code == 503
            and refused.json()["code"] == "NODE_SHUTTING_DOWN"
        )
        assert (await node.control("echo", "start")).status_code in (200, 503)
        result = (await long_call).json()
        assert_valid("InvokeResult", result)
        assert (
            result["state"] == "cancelled"
            and result["error"]["details"]["reason"] == "shutdown"
        )
    assert node.service.instances["echo"].process is None
    assert node.service.instances["echo"].state == "stopped"
