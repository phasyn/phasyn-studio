"""取消、期限與本機資源互斥。"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import psutil
import pytest
from node_testkit import Router, assert_valid, echo_definition, invoke_body, make_config, running_node, wait_until

pytestmark = pytest.mark.anyio

LONG = {"steps": 1000, "step_ms": 10}


async def test_cancel_grace_and_deadline_kill_only_own_process_group(tmp_path: Path) -> None:
    config = make_config(
        tmp_path, components=[echo_definition("slow", group="g-slow"), echo_definition("other", group="g-other")]
    )
    router = Router()
    async with running_node(config, router) as node:
        await node.start_ready("slow", "other")
        slow, other = node.service.instances["slow"], node.service.instances["other"]
        assert slow.process is not None and other.process is not None
        other_pid = other.process.pid

        # 一個 step 睡 5 秒：cooperative 取消在 grace（1 秒）內無法完成 → 只終止自己的 process group
        call_id = str(uuid.uuid4())
        stuck = asyncio.create_task(
            node.invoke("slow", invoke_body(value=1, call_id=call_id, parameters={"steps": 1, "step_ms": 5000}))
        )
        await node.wait_state("slow", "busy")
        call = slow.active_call
        assert call is not None
        runtime_pid = slow.process.process_instance_id

        def runtime_entered_invoke() -> bool:
            # The runtime publishes its own context right before it calls the provider: from then on the
            # provider is inside the 5 s step and can only notice the cancel after it.
            return any(
                ctx["recording_id"] == call.recording_id and ctx["process_instance_id"] == runtime_pid
                for ctx in router.controller.records("contexts")
            )

        await wait_until(runtime_entered_invoke, what="元件程序開始執行呼叫")
        slow_pid = slow.process.pid
        cancel = (await node.cancel("slow", call_id)).json()
        assert_valid("CancelResult", cancel)
        assert cancel["accepted"] is True and cancel["process_exited"] is True  # killed after the 1 s grace
        assert "GPU" in cancel["message"]
        result = (await stuck).json()
        assert_valid("InvokeResult", result)
        assert result["state"] == "cancelled" and result["error"]["details"]["process_killed"] is True
        stopped = await node.wait_state("slow", "stopped")
        assert stopped["last_error"]["code"] == "CANCELLED" and stopped["settings"]["loaded"] is None
        assert not psutil.pid_exists(slow_pid) or psutil.Process(slow_pid).status() == psutil.STATUS_ZOMBIE
        assert psutil.pid_exists(other_pid) and (await node.component("other"))["state"] == "ready"

        # 期限：元件程序自己在 deadline 停下 → CALL_TIMEOUT，instance 仍 ready
        await node.start_ready("slow")
        timed = (await node.invoke("slow", invoke_body(value=1, parameters=LONG, timeout_seconds=1))).json()
        assert_valid("InvokeResult", timed)
        assert timed["state"] == "failed" and timed["error"]["code"] == "CALL_TIMEOUT"
        assert (await node.component("slow"))["state"] == "ready"

        # 期限＋取消逾時：送 cancel、等 grace、終止自有 group → CALL_TIMEOUT，instance stopped 並帶 last_error
        killed = (
            await node.invoke("slow", invoke_body(value=1, parameters={"steps": 1, "step_ms": 5000}, timeout_seconds=1))
        ).json()
        assert_valid("InvokeResult", killed)
        assert killed["state"] == "failed" and killed["error"]["code"] == "CALL_TIMEOUT"
        assert killed["error"]["details"]["process_killed"] is True
        after = await node.wait_state("slow", "stopped")
        assert after["last_error"]["code"] == "CALL_TIMEOUT"
        assert psutil.pid_exists(other_pid) and other.state == "ready"
