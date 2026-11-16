"""跨 run 的資源仲裁：同時有兩個 active run 時，同一 (node_id, resource_group) 一次只給一個步驟；
較舊的 run 先挑，較新的 run 只能用沒人要的 key；run 停止或取消時放開它的 key。"""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import json
from pathlib import Path
from typing import Any

from controller_support import ENDPOINT_A, NODE_A, TYPE, FakeNode, Harness, descriptor, pipeline, step, wait_until

INPUTS = {"text": {"type_id": TYPE, "value": "hi"}}


def _node() -> FakeNode:
    return FakeNode(
        NODE_A,
        ENDPOINT_A,
        [
            descriptor(NODE_A, "a", resource_group="cpu-1"),
            descriptor(NODE_A, "x", resource_group="cpu-1"),
            descriptor(NODE_A, "d", resource_group="cpu-2"),
        ],
    )


def _two_slots(h: Harness) -> None:
    # The ControllerConfig contract still pins max_active_runs to 1; the runner reads the live config.
    h.ctl.config = dataclasses.replace(h.ctl.config, max_active_runs=2)


async def _step_reaches(h: Harness, run_id: str, step_id: str, state: str) -> dict[str, Any]:
    while True:
        run = dict((await h.client.get(f"/api/runs/{run_id}")).json())
        if run["steps"][step_id]["state"] == state:
            return run
        assert run["state"] == "running", f"{run_id} ended before {step_id} reached {state}"
        await asyncio.sleep(0.01)


def _overlaps(node: FakeNode, components: set[str]) -> list[tuple[str, str]]:
    calls = sorted((c for c in node.calls if c["component_id"] in components), key=lambda c: c["start"])
    return [(a["step_id"], b["step_id"]) for a, b in itertools.pairwise(calls) if b["start"] < a["end"]]


def test_two_runs_never_hold_one_key_and_the_older_run_picks_first(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            _two_slots(h)
            node = _node()
            await h.add_node(node)
            first = await h.start_run(
                pipeline(
                    [
                        step("a1", NODE_A, "a", params={"gate": "g1"}),
                        step("b1", NODE_A, "x", params={"gate": "g1b"}, value={"from_step": "a1", "output": "value"}),
                    ]
                )
            )
            await wait_until(lambda: node.started("a1"))
            second = await h.start_run(
                pipeline([step("x2", NODE_A, "x", params={"gate": "g2"}), step("d2", NODE_A, "d")])
            )
            third = await h.client.post(
                "/api/runs", json={"pipeline": pipeline([step("z", NODE_A, "d")]), "inputs": INPUTS}
            )
            assert (third.status_code, third.json()["code"]) == (409, "RUN_ACTIVE")
            assert third.json()["details"]["active_run_ids"] == [first["run_id"], second["run_id"]]

            done_d2 = await asyncio.wait_for(_step_reaches(h, second["run_id"], "d2", "succeeded"), 5)
            assert done_d2["steps"]["x2"]["state"] == "waiting" and not node.started("x2")  # the free key went young

            node.gate("g1").set()  # a1 ends: the older run's b1 and the younger run's x2 both want cpu-1
            await wait_until(lambda: node.started("b1"))
            await asyncio.sleep(0.05)
            assert not node.started("x2")
            node.gate("g1b").set()
            assert (await h.wait_run(first["run_id"]))["state"] == "succeeded"
            await wait_until(lambda: node.started("x2"))
            node.gate("g2").set()
            assert (await h.wait_run(second["run_id"]))["state"] == "succeeded"
            events = await h.client.get(f"/api/recordings/{second['recording_ids'][0]}/events?limit=200")
            text = json.dumps(events.json()["events"], ensure_ascii=False)
            assert f"步驟 x2 等待同一 Node／resource_group 的步驟 a1（run {first['run_id']}） 完成" in text, text
            assert [c["step_id"] for c in node.calls if c["component_id"] in ("a", "x")] == ["a1", "b1", "x2"]
            assert _overlaps(node, {"a", "x"}) == []
            assert h.ctl.runner.active == [] and h.ctl.runner.holders() == {}

    asyncio.run(scenario())


def test_a_stopped_or_cancelled_run_releases_its_keys(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            _two_slots(h)
            node = _node()
            await h.add_node(node)
            first = await h.start_run(pipeline([step("hold", NODE_A, "a", params={"hang": True})]))
            await wait_until(lambda: node.started("hold"))
            second = await h.start_run(pipeline([step("next", NODE_A, "x")]))
            await asyncio.wait_for(_step_reaches(h, second["run_id"], "next", "waiting"), 5)

            # Cancelling a run that only waits ends it at once and never sends its call.
            refused = await h.client.post(
                "/api/runs", json={"pipeline": pipeline([step("never", NODE_A, "x")]), "inputs": INPUTS}
            )
            assert refused.json()["code"] == "RUN_ACTIVE"
            assert (await h.client.post(f"/api/runs/{second['run_id']}/cancel")).status_code == 200
            cancelled = await h.wait_run(second["run_id"])
            assert cancelled["state"] == "cancelled" and cancelled["steps"]["next"]["state"] == "cancelled"
            assert not node.started("next")

            third = await h.start_run(pipeline([step("after", NODE_A, "x")]))
            await asyncio.wait_for(_step_reaches(h, third["run_id"], "after", "waiting"), 5)
            assert (await h.client.post(f"/api/runs/{first['run_id']}/cancel")).status_code == 200
            assert (await h.wait_run(first["run_id"]))["state"] == "cancelled"
            assert (await h.wait_run(third["run_id"]))["state"] == "succeeded"  # the stopped run's key was freed
            assert _overlaps(node, {"a", "x"}) == []
            assert h.ctl.runner.active == [] and h.ctl.runner.holders() == {}

    asyncio.run(scenario())
