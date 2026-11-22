"""Faults of a component process (CPU fixture runtime, no model): no hello, an incompatible protocol, a load that
never finishes, a describe that never answers, and concurrent describes sharing one subprocess.

Every fault ends in a clear error with the process stopped; the Node never retries.
"""

from __future__ import annotations

import contextlib
import sys
from pathlib import Path
from typing import Any

import psutil
import pytest
from misbehaving_runtime import MODULE
from node_testkit import (
    echo_definition,
    fixture_runtime,
    make_config,
    running_node,
    wait_until,
)

from phasyn_node import describe as describe_module, supervisor as supervisor_module
from phasyn_node.config import RuntimeEntry
from phasyn_node.describe import RuntimeCommands


pytestmark = pytest.mark.anyio


def fixture_processes() -> list[psutil.Process]:
    found: list[psutil.Process] = []
    for proc in psutil.Process().children(recursive=True):
        with contextlib.suppress(psutil.Error):
            if MODULE in " ".join(proc.cmdline()):
                found.append(proc)
    return found


@pytest.fixture(autouse=True)
def no_leftover_fixture_processes() -> Any:
    yield
    leftovers = fixture_processes()
    for proc in leftovers:
        with contextlib.suppress(psutil.Error):
            proc.kill()
    assert not leftovers, (
        f"fixture runtime processes were left running: {[p.pid for p in leftovers]}"
    )


def runtime(mode: str, **env: str) -> dict[str, Any]:
    return fixture_runtime("cpu", mode, **env)


@pytest.fixture
def quick_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed start stops the process after this short wait (instead of 15 s)."""
    monkeypatch.setattr(supervisor_module, "EXIT_AFTER_LOAD_FAILURE_S", 0.5)


async def failed_start(tmp_path: Path, mode: str, **overrides: Any) -> dict[str, Any]:
    config = make_config(
        tmp_path,
        components=[echo_definition("echo")],
        runtimes=[runtime(mode)],
        **overrides,
    )
    async with running_node(config) as node:
        assert (
            await node.control("echo", "start")
        ).status_code == 200  # the load runs in the background
        desc = await node.wait_state("echo", "error", limit_s=30)
        instance = node.service.instances["echo"]
        assert (
            instance.process is None and instance.spawn_count == 1
        )  # stopped, and never retried
        await wait_until(
            lambda: not fixture_processes(), limit_s=10, what="fixture runtime stopped"
        )
        error: dict[str, Any] = desc["last_error"]
        return error


@pytest.mark.usefixtures("quick_exit")
async def test_no_hello_is_a_start_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(supervisor_module, "HELLO_TIMEOUT_S", 1.0)
    error = await failed_start(tmp_path, "silent")
    assert error["code"] == "RUNTIME_START_FAILED" and "hello" in error["message"]


@pytest.mark.usefixtures("quick_exit")
async def test_incompatible_protocol_is_refused(tmp_path: Path) -> None:
    error = await failed_start(tmp_path, "old_protocol")
    assert (
        error["code"] == "PROTOCOL_MISMATCH"
        and error["details"]["runtime_protocol"] == "0.1.0"
    )


@pytest.mark.usefixtures("quick_exit")
async def test_a_load_that_never_finishes_times_out(tmp_path: Path) -> None:
    error = await failed_start(tmp_path, "mute_load", load_timeout_seconds=1)
    assert error["code"] == "LOAD_TIMEOUT" and error["details"] == {
        "load_timeout_seconds": 1
    }


def entry(mode: str, **env: str) -> RuntimeEntry:
    spec = runtime(mode, **env)
    return RuntimeEntry(
        runtime_id="cpu", python=sys.executable, module=spec["module"], env=spec["env"]
    )


async def test_a_describe_that_never_answers_is_stopped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(describe_module, "DESCRIBE_TIMEOUT_S", 1.0)
    commands = RuntimeCommands(work_dir=tmp_path / "work", source_revision="rev-1")
    result = await commands.describe(entry("hang_describe"), "test.echo", {})
    assert not result.available and result.error is not None
    assert (
        result.error["code"] == "RUNTIME_UNAVAILABLE"
        and "describe" in result.error["message"]
    )
    assert not fixture_processes()  # its own process group was killed
