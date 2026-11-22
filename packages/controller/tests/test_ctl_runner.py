"""普通 runner：平行分支、同 resource_group 等待、RUN_ACTIVE、失敗停止+一次 cancel、逾時不重送、
取消無回覆、主控重啟 → interrupted（不重送、不推進 DAG）。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from controller_support import (
    ENDPOINT_A,
    ENDPOINT_B,
    NODE_A,
    NODE_B,
    FakeNode,
    Harness,
    Router,
    descriptor,
    pipeline,
    port,
    step,
    wait_until,
)
from phasyn_components import contracts

from phasyn_controller.runner import recovery
from phasyn_controller.runs import RESTART_MESSAGE


def _nodes() -> tuple[FakeNode, FakeNode]:
    node_a = FakeNode(
        NODE_A,
        ENDPOINT_A,
        [
            descriptor(
                NODE_A, "a", resource_group="cpu-1", invoke_defaults={"seed": 7}
            ),
            descriptor(NODE_A, "x", resource_group="cpu-1"),
            descriptor(NODE_A, "d", resource_group="cpu-2"),
        ],
    )
    node_b = FakeNode(
        NODE_B,
        ENDPOINT_B,
        [
            descriptor(NODE_B, "b", resource_group="cpu-1"),
            descriptor(
                NODE_B,
                "c",
                resource_group="cpu-2",
                inputs=[port("value"), port("other")],
            ),
        ],
    )
    return node_a, node_b


def test_read_timeout_marks_unknown_and_is_not_reposted(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node_a, node_b = _nodes()
            await h.add_node(node_a)
            await h.add_node(node_b)

            async def intercept(request: httpx.Request) -> httpx.Response | None:
                if (
                    request.method == "POST"
                    and request.url.path == "/api/components/a/invoke"
                ):
                    await wait_until(
                        lambda: len(node_b.calls) == 1
                    )  # 另一分支已送出後才逾時
                    raise httpx.ReadTimeout("simulated read timeout", request=request)
                return None

            h.router.intercept = intercept
            run = await h.start_run(
                pipeline(
                    [
                        step("slow", NODE_A, "a"),
                        step("other", NODE_B, "b", params={"hang": True}),
                    ]
                )
            )
            done = await h.wait_run(run["run_id"])
            slow = done["steps"]["slow"]
            assert done["state"] == "failed"
            assert slow["state"] == "failed" and slow["remote_outcome_unknown"] is True
            assert (
                slow["error"]["code"] == "NODE_UNREACHABLE"
                and slow["error"]["remote_outcome_unknown"] is True
            )
            assert slow["call_id"]  # 已送出：保留 call_id 供到 Node 查紀錄
            assert done["error"]["remote_outcome_unknown"] is True
            assert len(h.router.seen("POST", "/api/components/a/invoke")) == 1  # 不重送
            assert done["steps"]["other"]["state"] == "cancelled"
            assert len(h.router.seen("POST", "/cancel")) == 1

    asyncio.run(scenario())


def test_restart_marks_legacy_run_interrupted_and_never_reposts(tmp_path: Path) -> None:
    async def scenario() -> None:
        router = Router()
        _, node_b = _nodes()
        async with Harness(tmp_path, router=router) as h1:
            await h1.add_node(node_b)
            run = await h1.start_run(
                pipeline(
                    [
                        step("hang", NODE_B, "b", params={"hang": True}),
                        step(
                            "later",
                            NODE_B,
                            "c",
                            value={"from_step": "hang", "output": "value"},
                            other={"from_input": "text"},
                        ),
                    ]
                )
            )
            await wait_until(lambda: len(node_b.calls) == 1)
        # Older saved runs have no attempt journal. They may only be marked interrupted.
        store = h1.ctl.runs
        legacy = store.read(run["run_id"])
        del legacy["recovery_version"]
        store.write(run["run_id"], json.dumps(legacy).encode())
        # 主控停止：不送 cancel 給 Node；run 改 interrupted
        assert router.seen("POST", "/cancel") == []
        async with Harness(tmp_path, router=router) as h2:
            await h2.add_node(node_b)
            got = (await h2.client.get(f"/api/runs/{run['run_id']}")).json()
            contracts.validate("Run", got)
            assert got["state"] == "interrupted"
            assert got["error"] == {"code": "INTERRUPTED", "message": RESTART_MESSAGE}
            assert (
                got["steps"]["hang"]["state"] == "interrupted"
                and got["steps"]["later"]["state"] == "interrupted"
            )
            await asyncio.sleep(0.1)
            assert (
                len(router.seen("POST", "/invoke")) == 1
            )  # 不重新連回、不推進 DAG、不重送
            rec = (
                await h2.client.get(f"/api/recordings/{got['recording_ids'][0]}")
            ).json()
            assert rec["summary"]["state"] == "interrupted"
            fresh = await h2.start_run(
                pipeline([step("again", NODE_B, "b")])
            )  # 重新執行是新 run
            assert (await h2.wait_run(fresh["run_id"]))["state"] == "succeeded"

    asyncio.run(scenario())


def test_a_lost_invoke_reply_is_settled_from_the_node_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A long call whose reply never comes back ends with the Node's own result, not a wait until its timeout."""
    monkeypatch.setattr(recovery, "WATCH_INTERVAL_S", 0.05)

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node_a, _ = _nodes()
            await h.add_node(node_a)
            run = await h.start_run(
                pipeline([step("long", NODE_A, "a", params={"lose_reply": True})])
            )
            done = await asyncio.wait_for(h.wait_run(run["run_id"]), 10)
            assert done["state"] == "succeeded"
            assert done["steps"]["long"]["state"] == "succeeded"
            assert len(h.router.seen("POST", "/api/components/a/invoke")) == 1

    asyncio.run(scenario())


def test_a_call_the_node_does_not_know_does_not_stay_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The invoke request stays open but the reachable Node has no record of the call: the run ends unknown."""
    monkeypatch.setattr(recovery, "WATCH_INTERVAL_S", 0.05)

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node_a, _ = _nodes()
            await h.add_node(node_a)

            async def intercept(request: httpx.Request) -> httpx.Response | None:
                if request.method == "POST" and request.url.path.endswith("/invoke"):
                    await asyncio.Event().wait()  # the request never reaches the Node
                return None

            h.router.intercept = intercept
            run = await h.start_run(pipeline([step("ghost", NODE_A, "a")]))
            done = await asyncio.wait_for(h.wait_run(run["run_id"]), 10)
            ghost = done["steps"]["ghost"]
            assert ghost["state"] == "failed"
            assert ghost["remote_outcome_unknown"] is True
            assert len(h.router.seen("POST", "/api/components/a/invoke")) == 1

    asyncio.run(scenario())
