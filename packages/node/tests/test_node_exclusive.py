"""Exclusive groups (C1) and data-driven limits (C2) with real runtime_host processes.

Holders: ready (or error with a live process) → EXCLUSIVE_GROUP_CONFLICT unless ``replace_exclusive``;
loading/stopping/busy → EXCLUSIVE_GROUP_BUSY. The group lock is the outermost lock and a try-lock.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

import pytest
from node_testkit import (
    InvokeOptions,
    Node,
    assert_valid,
    echo_definition,
    invoke_body,
    make_config,
    running_node,
    wait_until,
)


pytestmark = pytest.mark.anyio

GROUP = "dit"


def member(component_id: str) -> dict[str, Any]:
    return {
        **echo_definition(component_id, group=f"g-{component_id}"),
        "exclusive_group": GROUP,
    }


async def control(
    node: Node, component_id: str, action: str, *, replace: bool | None = None
) -> dict[str, Any]:
    body: dict[str, Any] = {"action": action}
    if replace is not None:
        body["replace_exclusive"] = replace
    response = await node.client.post(
        f"/api/components/{component_id}/control", json=body
    )
    doc: dict[str, Any] = response.json()
    doc["_status"] = response.status_code
    return doc


def assert_refused(doc: dict[str, Any], code: str, holders: list[str]) -> None:
    assert (doc["_status"], doc["code"]) == (409, code), doc
    assert_valid("ExclusiveGroupDetails", doc["details"])
    assert doc["details"]["group"] == GROUP
    assert [item["component_id"] for item in doc["details"]["holders"]] == holders


async def notes(node: Node, component_id: str, operation: str) -> list[str]:
    params = {"component_id": component_id, "operation": operation}
    page = (await node.client.get("/api/recordings", params=params)).json()
    return [note for item in page["items"] for note in item["summary"]["notes"]]


async def noted(node: Node, component_id: str, operation: str, *words: str) -> None:
    """Wait for a note with all ``words`` on the component's recordings of ``operation``. The Node marks a component
    ready (or stopped) before it finalizes and publishes the recording, so its notes can arrive a moment later."""

    async def check() -> bool:
        return any(
            all(word in note for word in words)
            for note in await notes(node, component_id, operation)
        )

    await wait_until(
        check, what=f"{component_id} {operation} recording note with {words}"
    )


async def test_conflict_busy_and_replace(tmp_path: Path) -> None:
    config = make_config(
        tmp_path,
        components=[
            member("d1"),
            member("d2"),
            echo_definition("plain", group="g-plain"),
        ],
    )
    async with running_node(config) as node:
        described = await node.components()
        assert (
            described["d1"]["exclusive_group"],
            described["plain"]["exclusive_group"],
        ) == (GROUP, None)
        assert described["d1"]["limits"] is None

        await node.start_ready(
            "d1", "plain"
        )  # members of other groups (or none) never interfere
        conflict = await control(node, "d2", "start")
        assert_refused(conflict, "EXCLUSIVE_GROUP_CONFLICT", ["d1"])
        assert conflict["details"]["holders"][0] == {
            "component_id": "d1",
            "state": "ready",
            "active_call_id": None,
        }
        refused = await node.component("d2")
        assert (
            refused["state"] == "stopped" and refused["last_error"] is None
        )  # a refusal is not a failure

        call_id = str(uuid.uuid4())
        long_call = asyncio.create_task(
            node.invoke(
                "d1",
                invoke_body(
                    value=1,
                    parameters={"steps": 500, "step_ms": 10},
                    options=InvokeOptions(call_id=call_id),
                ),
            )
        )
        await node.wait_state("d1", "busy")
        busy = await control(node, "d2", "start", replace=True)
        assert_refused(busy, "EXCLUSIVE_GROUP_BUSY", ["d1"])
        assert busy["details"]["holders"][0]["active_call_id"] == call_id
        assert (await node.cancel("d1", call_id)).json()["accepted"] is True
        assert (await long_call).json()["state"] == "cancelled"
        await node.wait_state("d1", "ready")

        replaced = await control(node, "d2", "start", replace=True)
        assert replaced["_status"] == 200, replaced
        await node.wait_state("d2", "ready")
        assert (await node.component("d1"))["state"] == "stopped"
        assert node.service.instances["d1"].process is None
        await noted(node, "d1", "unload", "replace_exclusive", "d2")
        await noted(node, "d2", "load", "replace_exclusive", "d1")

        # restart of a stopped member is a start: refused while d2 holds the group, and d1 stays stopped
        assert_refused(
            await control(node, "d1", "restart"), "EXCLUSIVE_GROUP_CONFLICT", ["d2"]
        )
        assert (await node.component("d1"))["state"] == "stopped"
        # a restarting member is not its own holder
        assert (await control(node, "d2", "restart"))["_status"] == 200
        await node.wait_state("d2", "ready")
