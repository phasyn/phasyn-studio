"""用到才載入（load_policy = on_demand）的邊界：自動啟動後才送出呼叫、不驅逐 resident／忙碌元件、互斥群組替換、
閒置卸載在忙碌或有排隊步驟時跳過、resident 元件行為不變。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from controller_support import (
    ENDPOINT_A,
    NODE_A,
    FakeNode,
    Harness,
    descriptor,
    pipeline,
    step,
    wait_until,
)

from phasyn_controller.runner import on_demand


@pytest.fixture(autouse=True)
def _fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(on_demand, "RETRY_S", 0.05)
    monkeypatch.setattr(on_demand, "POLL_S", 0.01)


def comp(component_id: str, state: str = "stopped", **fields: Any) -> dict[str, Any]:
    """A fake descriptor; ``policy`` (default on_demand, None = no field), ``group``, ``resource_group``,
    ``active_call_id``."""
    desc = descriptor(
        NODE_A,
        component_id,
        resource_group=fields.get("resource_group", "gpu-0"),
        loaded_revision=1 if state in ("ready", "busy") else None,
    )
    desc.update(
        state=state,
        exclusive_group=fields.get("group"),
        active_call_id=fields.get("active_call_id"),
    )
    policy = fields.get("policy", "on_demand")
    if policy is not None:
        desc["load_policy"] = policy
    return desc


class LoadingNode:
    """FakeNode 上的 control：start → loading → ready（每次狀態改變都重新登記到主控目錄）；stop → stopped."""

    def __init__(self, h: Harness, node: FakeNode, *, load_s: float = 0.05) -> None:
        self.h = h
        self.node = node
        self.load_s = load_s
        self.controls: list[tuple[str, dict[str, Any]]] = []
        self.tasks: set[asyncio.Task[None]] = set()
        h.router.intercept = self.intercept

    async def push(self) -> None:
        resp = await self.h.client.put(
            f"/api/catalog/{self.node.node_id}", json=self.node.snapshot()
        )
        assert resp.status_code == 200, resp.text

    async def set_state(self, cid: str, state: str) -> None:
        desc = self.node.components[cid]
        desc["state"] = state
        desc["settings"]["loaded_revision"] = 1 if state in ("ready", "busy") else None
        desc["settings"]["loaded"] = (
            desc["settings"]["stored"]["load"] if state in ("ready", "busy") else None
        )
        await self.push()

    async def _finish_load(self, cid: str, replaced: list[str]) -> None:
        for other in replaced:
            await self.set_state(other, "stopped")
        await asyncio.sleep(self.load_s)
        await self.set_state(cid, "ready")

    async def intercept(self, request: httpx.Request) -> httpx.Response | None:
        if request.method != "POST" or not request.url.path.endswith("/control"):
            return None
        cid = request.url.path.split("/")[-2]
        body = json.loads(request.content)
        self.controls.append((cid, body))
        desc = self.node.components[cid]
        if body["action"] == "start":
            group = desc.get("exclusive_group")
            replaced = [
                other
                for other, d in self.node.components.items()
                if other != cid
                and group
                and d.get("exclusive_group") == group
                and d["state"] == "ready"
            ]
            if replaced and not body.get("replace_exclusive"):
                return httpx.Response(
                    409,
                    json={
                        "code": "EXCLUSIVE_GROUP_CONFLICT",
                        "message": "假 Node：互斥群組已載入",
                        "details": {"group": group, "holders": []},
                        "remote_outcome_unknown": False,
                    },
                )
            desc["state"] = "loading"
            await self.push()
            task = asyncio.create_task(self._finish_load(cid, replaced))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
            return httpx.Response(200, json=desc)
        if body["action"] == "stop":
            if desc["state"] == "busy" or desc.get("active_call_id"):
                return httpx.Response(
                    409,
                    json={
                        "code": "COMPONENT_BUSY",
                        "message": "假 Node：忙碌",
                        "details": {},
                        "remote_outcome_unknown": False,
                    },
                )
            await self.set_state(cid, "stopped")
            return httpx.Response(200, json=desc)
        return None

    def starts(self) -> list[tuple[str, dict[str, Any]]]:
        return [c for c in self.controls if c[1]["action"] == "start"]


async def _cancel(h: Harness, run_id: str) -> dict[str, Any]:
    resp = await h.client.post(f"/api/runs/{run_id}/cancel")
    assert resp.status_code in (200, 202), resp.text
    return await h.wait_run(run_id)


def test_stopped_on_demand_component_is_started_before_its_call(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = FakeNode(NODE_A, ENDPOINT_A, [comp("wan")])
            await h.add_node(node)
            loader = LoadingNode(h, node, load_s=0.3)
            run = await h.start_run(pipeline([step("gen", NODE_A, "wan")]))

            async def loading_visible() -> dict[str, Any]:
                resp = await h.client.get(f"/api/runs/{run['run_id']}")
                return dict(resp.json()["steps"]["gen"])

            await wait_until(lambda: len(loader.starts()) == 1)
            seen = await loading_visible()
            assert seen["state"] == "running"
            assert seen["component_load"]["phase"] == "loading"
            assert seen["component_load"]["component_id"] == "wan"
            assert node.calls == []  # 還沒 ready：沒有送出呼叫
            done = await h.wait_run(run["run_id"])
            assert done["state"] == "succeeded", done
            assert "component_load" not in done["steps"]["gen"]
            assert loader.starts() == [
                ("wan", {"action": "start", "replace_exclusive": False})
            ]
            assert len(node.calls) == 1

    asyncio.run(scenario())


def test_resident_component_keeps_todays_behaviour(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = FakeNode(NODE_A, ENDPOINT_A, [comp("te", policy=None)])
            await h.add_node(node)
            loader = LoadingNode(h, node)
            run = await h.start_run(pipeline([step("s", NODE_A, "te")]))
            await h.wait_run(run["run_id"])
            assert (
                loader.starts() == []
            )  # 沒有 load_policy（resident）：主控從不自動啟動

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("holder", "reason"),
    [
        (
            {"state": "ready", "policy": None},
            "exclusive_resident",
        ),  # 常駐元件不被驅逐
        (
            {"state": "busy", "policy": "on_demand", "active_call_id": None},
            "exclusive_busy",
        ),  # 忙碌元件不被驅逐
        (
            {
                "state": "ready",
                "policy": "on_demand",
                "active_call_id": "00000000-0000-4000-8000-0000000000aa",
            },
            "exclusive_busy",
        ),
    ],
)
def test_never_evicts_resident_or_busy_member(
    tmp_path: Path, holder: dict[str, Any], reason: str
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = FakeNode(
                NODE_A,
                ENDPOINT_A,
                [
                    comp("dit-a", group="dit", **holder),
                    comp("dit-b", group="dit"),
                ],
            )
            await h.add_node(node)
            loader = LoadingNode(h, node)
            run = await h.start_run(pipeline([step("s", NODE_A, "dit-b")]))

            async def waiting() -> dict[str, Any]:
                resp = await h.client.get(f"/api/runs/{run['run_id']}")
                return dict(resp.json())

            for _ in range(200):
                snap = await waiting()
                if (snap["steps"]["s"].get("component_load") or {}).get("reason"):
                    break
                await asyncio.sleep(0.01)
            snap = await waiting()
            entry = snap["steps"]["s"]
            assert snap["state"] == "running"  # 等待，不是失敗
            assert entry["state"] == "waiting"
            assert entry["component_load"]["phase"] == "waiting"
            assert entry["component_load"]["reason"] == reason
            assert entry["component_load"]["holders"] == ["dit-a"]
            await asyncio.sleep(0.2)  # 幾輪重試後仍不送 start、不送 stop
            assert loader.controls == []
            assert node.calls == []
            done = await _cancel(h, run["run_id"])
            assert done["steps"]["s"]["state"] == "cancelled"
            assert "component_load" not in done["steps"]["s"]

    asyncio.run(scenario())


def test_idle_on_demand_member_is_replaced(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = FakeNode(
                NODE_A,
                ENDPOINT_A,
                [
                    comp("dit-a", state="ready", group="dit"),
                    comp("dit-b", group="dit"),
                ],
            )
            await h.add_node(node)
            loader = LoadingNode(h, node)
            run = await h.start_run(pipeline([step("s", NODE_A, "dit-b")]))
            done = await h.wait_run(run["run_id"])
            assert done["state"] == "succeeded", done
            assert loader.starts() == [
                ("dit-b", {"action": "start", "replace_exclusive": True})
            ]
            assert node.components["dit-a"]["state"] == "stopped"

    asyncio.run(scenario())


def test_member_needed_by_a_ready_step_is_not_swapped(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = FakeNode(
                NODE_A,
                ENDPOINT_A,
                [
                    comp("dit-a", state="ready", group="dit", resource_group="gpu-0"),
                    comp("dit-b", group="dit", resource_group="gpu-1"),
                ],
            )
            await h.add_node(node)
            loader = LoadingNode(h, node)
            gate = node.gate("a")
            run = await h.start_run(
                pipeline(
                    [
                        step("on-a", NODE_A, "dit-a", params={"gate": "a"}),
                        step("on-b", NODE_A, "dit-b"),
                    ]
                )
            )
            await wait_until(lambda: node.started("on-a"))
            await asyncio.sleep(0.15)  # on-a 正在跑：dit-a 不能被換掉
            assert loader.starts() == []
            snap = (await h.client.get(f"/api/runs/{run['run_id']}")).json()
            assert (
                snap["steps"]["on-b"]["component_load"]["reason"]
                == "exclusive_reserved"
            )
            gate.set()
            done = await h.wait_run(run["run_id"])
            assert done["state"] == "succeeded", done
            assert loader.starts() == [
                ("dit-b", {"action": "start", "replace_exclusive": True})
            ]

    asyncio.run(scenario())


def test_idle_unload_skips_busy_reserved_and_resident(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = FakeNode(
                NODE_A,
                ENDPOINT_A,
                [
                    comp("idle", state="ready", resource_group="gpu-0"),
                    comp(
                        "calling",
                        state="ready",
                        resource_group="gpu-1",
                        active_call_id="00000000-0000-4000-8000-0000000000ab",
                    ),
                    comp("queued", state="ready", resource_group="gpu-2"),
                    comp(
                        "resident", state="ready", policy=None, resource_group="gpu-3"
                    ),
                    comp("short", state="ready", resource_group="gpu-4"),
                ],
            )
            node.components["short"]["idle_unload_seconds"] = 60
            await h.add_node(node)
            loader = LoadingNode(h, node)
            od = h.ctl.runner.on_demand
            gate = node.gate("q")
            run = await h.start_run(
                pipeline([step("q", NODE_A, "queued", params={"gate": "q"})])
            )
            await wait_until(lambda: node.started("q"))
            await od.unload_idle()  # 第一次只開始計時
            assert loader.controls == []

            h.clock.advance(61)
            await loader.push()  # 前進時鐘後 Node 重新登記（否則被當成 offline）
            await od.unload_idle()
            assert [c[0] for c in loader.controls] == ["short"]  # 自訂 60 秒的先到期

            h.clock.advance(600)
            await loader.push()
            await od.unload_idle()
            stopped = [c[0] for c in loader.controls if c[1]["action"] == "stop"]
            # calling（有進行中的呼叫）、queued（有 run 的步驟要用）、resident 都不停止
            assert stopped == ["short", "idle"]
            assert node.components["queued"]["state"] == "ready"
            assert node.components["resident"]["state"] == "ready"
            gate.set()
            await h.wait_run(run["run_id"])

    asyncio.run(scenario())


def test_step_waits_while_component_is_being_unloaded(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = FakeNode(NODE_A, ENDPOINT_A, [comp("wan", state="ready")])
            await h.add_node(node)
            loader = LoadingNode(h, node)
            od = h.ctl.runner.on_demand
            od.unloading.add((NODE_A, "wan"))
            run = await h.start_run(pipeline([step("s", NODE_A, "wan")]))
            await asyncio.sleep(0.1)
            snap = (await h.client.get(f"/api/runs/{run['run_id']}")).json()
            assert snap["steps"]["s"]["state"] == "waiting"
            assert snap["steps"]["s"]["component_load"]["reason"] == "stopping"
            assert node.calls == []
            await loader.set_state("wan", "stopped")
            od.unloading.clear()
            done = await h.wait_run(run["run_id"])
            assert done["state"] == "succeeded", done
            assert [c[0] for c in loader.starts()] == ["wan"]

    asyncio.run(scenario())
