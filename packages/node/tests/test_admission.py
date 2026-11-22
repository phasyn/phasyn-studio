"""Host protection of gated calls (``NodeConfig.admission``, :mod:`phasyn_node.admission`): a host-safety boundary.

A gated call (exclusive_group ``dit`` here) waits after its inputs while the chip is too hot or free memory is short,
and an emergency cancels it through the Node's own cancel path; calls that are not gated are never touched. The
calls run in real runtime_host processes (test.echo); the sensors are fakes the tests set, and the guard's waits run
``SPEED`` times faster than configured.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from node_testkit import (
    InvokeOptions,
    Node,
    Router,
    assert_valid,
    echo_definition,
    invoke_body,
    make_config,
    read_stream,
    running_node,
    wait_until,
)
from phasyn_components.errors import HOST_MEMORY_INSUFFICIENT_TEXT

from phasyn_node.admission import (
    AdmissionGuard,
    NvmlTemperatures,
    Pause,
    SensorError,
    Sensors,
    ThermalZones,
    read_available_bytes,
)
from phasyn_node.app import create_app
from phasyn_node.config import ConfigError, NodeConfig


pytestmark = pytest.mark.anyio

GIB = 1024**3
SPEED = 100.0
THERMAL: dict[str, Any] = {
    "pause_at_c": 93,
    "resume_below_c": 82,
    "cancel_chip_at_c": 97,
    "cancel_gpu_at_c": 90,
    "sample_seconds": 20,
    "hot_sample_seconds": 5,
}
MEMORY: dict[str, Any] = {
    "start_min_available_bytes": 40 * GIB,
    "cancel_below_available_bytes": 12 * GIB,
    "sample_seconds": 5,
}
LONG = {"steps": 1000, "step_ms": 10}


def _reading[T](value: T | Exception) -> T:
    if isinstance(value, Exception):
        raise value
    return value


@dataclass
class FakeHost:
    """The readings the guard sees, set by the test; an exception is raised instead of read. Reads are counted."""

    chip: float | Exception = 60.0
    gpu: float | Exception = 50.0
    available: int | Exception = 100 * GIB
    chip_reads: int = 0
    memory_reads: int = 0

    def read_chip(self) -> float:
        self.chip_reads += 1
        return _reading(self.chip)

    def read_gpu(self, _device: Mapping[str, Any]) -> float | None:
        return _reading(
            self.gpu
        )  # for any device, even test.echo's CPU one (the NVML reader reads CUDA only)

    def read_memory(self) -> int:
        self.memory_reads += 1
        return _reading(self.available)

    def sensors(self) -> Sensors:
        return Sensors(
            chip_c=self.read_chip, gpu_c=self.read_gpu, available_bytes=self.read_memory
        )


async def fast_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds / SPEED)


def admission(**sections: Any) -> dict[str, Any]:
    return {"gated": {"exclusive_groups": ["dit"]}, **sections}


def gated(component_id: str = "dit") -> dict[str, Any]:
    return {
        **echo_definition(component_id, group=f"g-{component_id}"),
        "exclusive_group": "dit",
    }


@contextlib.asynccontextmanager
async def guarded_node(config: NodeConfig, host: FakeHost) -> AsyncIterator[Node]:
    """``running_node`` whose guard reads ``host`` on the fast clock (swapped in before the service starts)."""
    assert config.admission is not None
    app = create_app(config, http_transport=Router())
    app.state.service.admission = AdmissionGuard(
        config.admission, sensors=host.sensors(), sleep=fast_sleep
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=config.advertise_url,
            timeout=60,
        ) as client,
    ):
        yield Node(app=app, service=app.state.service, client=client, config=config)


def guard_of(node: Node) -> AdmissionGuard:
    guard = node.service.admission
    assert guard is not None
    return guard


def node_events(config: NodeConfig, result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return read_stream(config.data_dir / "recordings" / result["recording_id"], "node")


def log_lines(config: NodeConfig, result: Mapping[str, Any]) -> list[str]:
    return [
        event["data"]["message"]
        for event in node_events(config, result)
        if event["kind"] == "log"
    ]


async def test_a_gated_call_waits_until_the_chip_cools_and_other_calls_pass(
    tmp_path: Path,
) -> None:
    host = FakeHost(chip=94.0)
    config = make_config(
        tmp_path,
        components=[gated(), echo_definition("te", group="g-te")],
        admission=admission(thermal=THERMAL),
    )
    async with guarded_node(config, host) as node:
        guard = guard_of(node)
        assert guard.sampling
        await wait_until(lambda: guard.latch.paused, what="晶片 94°C 時暫停")
        await node.start_ready("dit", "te")
        held = asyncio.create_task(node.invoke("dit", invoke_body(value="hot")))
        await wait_until(lambda: guard.waiting == 1, what="受保護的呼叫在等待")

        # A call that is not gated runs meanwhile: never held back, never watched.
        other = (
            await node.invoke(
                "te", invoke_body(value=1, parameters={"steps": 3, "step_ms": 5})
            )
        ).json()
        assert other["state"] == "succeeded", other
        assert "host_wait_ms" not in other["summary"]["metrics"]

        host.chip = (
            85.0  # under the pause threshold but over the resume one: still paused
        )
        reads = host.chip_reads
        await wait_until(lambda: host.chip_reads >= reads + 4, what="再取樣四次")
        assert (guard.latch.paused, guard.waiting, held.done()) == (True, 1, False)

        host.chip = 81.9
        result = (await held).json()
        assert_valid("InvokeResult", result)
        assert result["state"] == "succeeded", result
        assert not guard.latch.paused and guard.waiting == 0
        assert result["summary"]["metrics"]["host_wait_ms"]["value"] > 0
        lines = log_lines(config, result)
        assert "等待晶片降溫：94.0°C ≥ 93°C（降到 82°C 以下恢復）" in lines
        assert "等待晶片降溫：85.0°C，仍在暫停（降到 82°C 以下恢復）" in lines
        assert any(line.startswith("主機保護放行：等待") for line in lines)


async def test_a_held_call_can_be_cancelled_and_keeps_its_deadline(
    tmp_path: Path,
) -> None:
    host = FakeHost(chip=95.0)
    config = make_config(
        tmp_path,
        components=[gated()],
        admission=admission(thermal=THERMAL, memory=MEMORY),
    )
    async with guarded_node(config, host) as node:
        guard = guard_of(node)
        await node.start_ready("dit")
        call_id = str(uuid.uuid4())
        held = asyncio.create_task(
            node.invoke(
                "dit", invoke_body(value=1, options=InvokeOptions(call_id=call_id))
            )
        )
        await wait_until(lambda: guard.waiting == 1, what="受保護的呼叫在等待")
        cancel = (await node.cancel("dit", call_id)).json()
        assert_valid("CancelResult", cancel)
        assert cancel["accepted"] is True and cancel["process_exited"] is False, (
            cancel
        )  # the model stays loaded
        cancelled = (await held).json()
        assert_valid("InvokeResult", cancelled)
        assert (
            cancelled["state"] == "cancelled"
            and cancelled["error"]["code"] == "CANCELLED"
        ), cancelled
        assert guard.waiting == 0 and (await node.component("dit"))["state"] == "ready"

        # The deadline still applies while held back, and the runtime never got the call.
        timed = (
            await node.invoke(
                "dit", invoke_body(value=1, options=InvokeOptions(timeout_seconds=1))
            )
        ).json()
        assert_valid("InvokeResult", timed)
        assert (
            timed["state"] == "failed" and timed["error"]["code"] == "HOST_PROTECTION"
        ), timed
        details = timed["error"]["details"]
        assert (details["reason"], details["phase"], details["holds"][0]["chip_c"]) == (
            "thermal",
            "admission",
            95.0,
        )
        assert "scheduler_steps_completed" not in timed["summary"]["metrics"]

        # Held back by memory alone until the deadline: a pre-check that found too little, so nothing ran.
        host.chip, host.available = 60.0, 30 * GIB
        short = (
            await node.invoke(
                "dit", invoke_body(value=1, options=InvokeOptions(timeout_seconds=1))
            )
        ).json()
        assert_valid("InvokeResult", short)
        assert (
            short["state"] == "failed"
            and short["error"]["code"] == "HOST_MEMORY_INSUFFICIENT"
        ), short
        assert short["error"]["message"].endswith(HOST_MEMORY_INSUFFICIENT_TEXT)
        assert short["error"]["details"]["holds"] == [
            {
                "reason": "memory",
                "available_bytes": 30 * GIB,
                "start_min_available_bytes": 40 * GIB,
            }
        ]
        assert (await node.component("dit"))["state"] == "ready"


async def test_free_memory_is_needed_before_a_gated_call_starts(tmp_path: Path) -> None:
    host = FakeHost(available=30 * GIB)
    config = make_config(
        tmp_path, components=[gated()], admission=admission(memory=MEMORY)
    )
    async with guarded_node(config, host) as node:
        guard = guard_of(node)
        assert not guard.sampling  # memory alone needs no sampling task
        await node.start_ready("dit")
        held = asyncio.create_task(node.invoke("dit", invoke_body(value=1)))
        await wait_until(lambda: guard.waiting == 1, what="等待主記憶體")
        reads = host.memory_reads
        await wait_until(lambda: host.memory_reads >= reads + 2, what="再取樣兩次")
        assert not held.done()
        host.available = 50 * GIB
        result = (await held).json()
        assert result["state"] == "succeeded", result
        assert "等待主記憶體：可用 30.0 GiB，低於開始門檻 40.0 GiB" in log_lines(
            config, result
        )
        assert host.chip_reads == 0


@pytest.mark.parametrize(
    ("reading", "value", "reason", "sensor"),
    [
        ("chip", 97.5, "thermal", "chip"),
        ("gpu", 90.5, "thermal", "gpu"),
        ("available", 11 * GIB, "memory", "memory"),
    ],
)
async def test_an_emergency_cancels_the_running_gated_call_through_the_cancel_path(
    tmp_path: Path, reading: str, value: float, reason: str, sensor: str
) -> None:
    host = FakeHost()
    config = make_config(
        tmp_path,
        components=[gated(), echo_definition("te", group="g-te")],
        admission=admission(thermal=THERMAL, memory=MEMORY),
    )
    async with guarded_node(config, host) as node:
        await node.start_ready("dit", "te")
        dit = node.service.instances["dit"]
        initial_process = dit.process
        assert initial_process is not None
        pid = initial_process.pid
        running = asyncio.create_task(
            node.invoke("dit", invoke_body(value=1, parameters=LONG))
        )
        await wait_until(
            lambda: dit.active_call is not None and dit.active_call.sent,
            what="元件程序收到呼叫",
        )
        setattr(host, reading, value)
        result = (await running).json()
        assert_valid("InvokeResult", result)
        assert (
            result["state"] == "failed" and result["error"]["code"] == "HOST_PROTECTION"
        ), result
        details = result["error"]["details"]
        assert (
            details["reason"],
            details["sensor"],
            details["phase"],
            details["reading"],
        ) == (
            reason,
            sensor,
            "runtime",
            value,
        )
        assert details["process_killed"] is False
        # Stopped early by the cooperative cancel the Node's cancel path sends, so the model stays loaded.
        assert (
            result["summary"]["metrics"]["scheduler_steps_completed"]["value"]
            < LONG["steps"]
        )
        cancels = [
            event["data"]["fields"]
            for event in node_events(config, result)
            if event["kind"] == "log"
            and event["data"]["message"] == "收到取消要求（cooperative）"
        ]
        assert cancels == [{"reason": reason}]
        assert (await node.component("dit"))["state"] == "ready"
        assert dit.process is not None and dit.process.pid == pid

        # A call that is not gated is never cancelled by the guard, even past the emergency limit.
        other = (
            await node.invoke(
                "te", invoke_body(value=1, parameters={"steps": 20, "step_ms": 10})
            )
        ).json()
        assert other["state"] == "succeeded", other


async def test_without_admission_nothing_samples_or_waits(tmp_path: Path) -> None:
    config = make_config(tmp_path, components=[gated()])
    assert config.admission is None and "admission" not in config.to_dict()
    async with running_node(config) as node:
        assert node.service.admission is None
        assert not [
            task.get_name()
            for task in asyncio.all_tasks()
            if task.get_name().startswith("admission")
        ]
        await node.start_ready("dit")
        result = (await node.invoke("dit", invoke_body(value=1))).json()
        assert result["state"] == "succeeded", result
        assert "host_wait_ms" not in result["summary"]["metrics"]


async def test_unreadable_sensors_never_hold_calls_back(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    host = FakeHost(
        chip=SensorError("zone gone"),
        gpu=SensorError("NVML gone"),
        available=OSError("meminfo gone"),
    )
    config = make_config(
        tmp_path,
        components=[gated()],
        admission=admission(thermal=THERMAL, memory=MEMORY),
    )
    with caplog.at_level(logging.INFO, logger="phasyn_node.admission"):
        async with guarded_node(config, host) as node:
            guard = guard_of(node)
            await node.start_ready("dit")
            result = (
                await node.invoke(
                    "dit", invoke_body(value=1, parameters={"steps": 40, "step_ms": 10})
                )
            ).json()
            assert result["state"] == "succeeded", result
            assert (
                not guard.latch.paused
                and "host_wait_ms" not in result["summary"]["metrics"]
            )
            assert (
                host.chip_reads >= 3 and host.memory_reads >= 3
            )  # read again and again while the call ran
    warned = [
        record.getMessage()
        for record in caplog.records
        if record.name == "phasyn_node.admission" and record.levelno == logging.WARNING
    ]
    assert len(warned) == 3, warned  # one warning per sensor, however often it was read
    assert [
        sum(label in message for message in warned)
        for label in ("「晶片溫度」", "「GPU cpu 溫度」", "「可用主記憶體」")
    ] == [
        1,
        1,
        1,
    ]


async def test_the_pause_latch_has_hysteresis_and_fails_open(tmp_path: Path) -> None:
    config = make_config(tmp_path, admission=admission(thermal=THERMAL))
    assert config.admission is not None
    host = FakeHost()
    guard = AdmissionGuard(config.admission, sensors=host.sensors(), sleep=fast_sleep)
    paused = []
    for chip in (92.9, 93.0, 85.0, 82.0, 81.9, 85.0, 93.5):
        host.chip = chip
        await guard.read_chip()
        paused.append(guard.latch.paused)
    assert paused == [False, True, True, True, False, False, True]
    assert guard.watch_interval() == 5.0  # paused: sampled often
    holds = await guard.holds()
    assert [hold.reason for hold in holds] == ["thermal"]
    assert holds[0].text == "等待晶片降溫：93.5°C ≥ 93°C（降到 82°C 以下恢復）"

    host.chip = SensorError("zone gone")
    await guard.read_chip()
    assert (
        not guard.latch.paused and await guard.holds() == []
    )  # an unreadable chip never holds calls back
    host.chip = 60.0
    await guard.read_chip()
    assert guard.watch_interval() == 20.0  # cool: the normal interval

    # Only a pause the temperature caused ends when the chip cools; another source stays.
    assert guard.latch.pause("deploy", Pause(since=0.0))
    assert [hold.reason for hold in await guard.holds()] == [
        "deploy"
    ]  # read the chip again (60°C)
    assert guard.latch.sources == ("deploy",)
    assert guard.latch.resume("deploy") is not None and not guard.latch.paused


BAD_ADMISSION: list[tuple[dict[str, Any], str]] = [
    (
        {"thermal": {**THERMAL, "resume_below_c": 93}},
        "resume_below_c < pause_at_c < cancel_chip_at_c",
    ),
    (
        {"thermal": {**THERMAL, "cancel_chip_at_c": 93}},
        "resume_below_c < pause_at_c < cancel_chip_at_c",
    ),
    ({"thermal": {**THERMAL, "hot_sample_seconds": 30}}, "不能大於"),
    ({"thermal": {**THERMAL, "sample_seconds": 0}}, "不符合契約"),
    ({"thermal": {**THERMAL, "chip_zone_glob": "thermal_zone*/temp"}}, "絕對路徑"),
    ({"thermal": {**THERMAL, "pause_c": 93}}, "不符合契約"),
    ({"memory": {**MEMORY, "cancel_below_available_bytes": -1}}, "不符合契約"),
    ({"memory": {**MEMORY, "start_min_available_bytes": 8 * GIB}}, "不能小於"),
    (
        {"gated": {"exclusive_groups": [], "provider_ids": []}, "thermal": THERMAL},
        "沒有列出任何",
    ),
    ({}, "至少要有 thermal 或 memory"),
]


@pytest.mark.parametrize(("sections", "match"), BAD_ADMISSION)
async def test_a_bad_admission_block_is_refused(
    tmp_path: Path, sections: dict[str, Any], match: str
) -> None:
    with pytest.raises(ConfigError, match=match):
        make_config(tmp_path, admission=admission(**sections))


async def test_admission_defaults_and_gating(tmp_path: Path) -> None:
    limits = {
        key: THERMAL[key]
        for key in (
            "pause_at_c",
            "resume_below_c",
            "cancel_chip_at_c",
            "cancel_gpu_at_c",
        )
    }
    config = make_config(
        tmp_path, admission={"gated": {"provider_ids": ["h3.dit"]}, "thermal": limits}
    )
    parsed = config.admission
    assert parsed is not None and parsed.memory is None and parsed.thermal is not None
    assert (parsed.gated.exclusive_groups, parsed.gated.provider_ids) == (
        (),
        ("h3.dit",),
    )
    assert parsed.thermal.chip_zone_glob == "/sys/class/thermal/thermal_zone*/temp"
    assert (parsed.thermal.sample_seconds, parsed.thermal.hot_sample_seconds) == (
        20.0,
        5.0,
    )
    assert (
        make_config(tmp_path, admission=config.to_dict()["admission"]).admission
        == parsed
    )
    guard = AdmissionGuard(parsed, sensors=FakeHost().sensors())
    assert guard.gates(exclusive_group=None, provider_id="h3.dit")
    assert not guard.gates(exclusive_group="dit", provider_id="h3.conditioning")


async def test_the_host_readers(tmp_path: Path) -> None:
    zones = tmp_path / "thermal"
    for name, text in {
        "zone0": "45000\n",
        "zone1": "93500\n",
        "zone2": "broken\n",
        "zone3": "255000\n",
    }.items():
        (zones / f"thermal_{name}").mkdir(parents=True)
        (zones / f"thermal_{name}" / "temp").write_text(text, encoding="ascii")
    assert (
        ThermalZones(str(zones / "thermal_zone*" / "temp"))() == 93.5
    )  # the hottest plausible zone
    with pytest.raises(SensorError):
        ThermalZones(str(tmp_path / "none" / "thermal_zone*" / "temp"))()

    meminfo = tmp_path / "meminfo"
    meminfo.write_text(
        "MemTotal:  127535636 kB\nMemFree:  1234 kB\nMemAvailable:  31457280 kB\n",
        encoding="ascii",
    )
    assert read_available_bytes(str(meminfo)) == 31457280 * 1024
    meminfo.write_text("MemTotal:  127535636 kB\n", encoding="ascii")
    with pytest.raises(SensorError):
        read_available_bytes(str(meminfo))
    assert (
        NvmlTemperatures()({"kind": "cpu", "id": "cpu", "resource_group": "g"}) is None
    )  # NVML is never opened
