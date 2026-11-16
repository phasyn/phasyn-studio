"""Host protection of heavy calls (opt-in ``NodeConfig.admission``, made for a unified-memory GPU host with 128 GB shared by CPU and GPU).

A call is *gated* when its component's ``exclusive_group`` or ``provider_id`` is listed in ``admission.gated``. A
gated call waits after its inputs are ready (downloads never hold the GPU) and before its runtime phase while the
host protection says no, and it is cancelled when an emergency limit is crossed while it runs. Other calls are
never delayed or cancelled; their heat still counts, since the chip sensor sees the whole host.

- ``thermal``: the chip temperature is the hottest ``chip_zone_glob`` zone (m°C). At ``pause_at_c`` the pause latch
  closes: new gated calls wait, running ones go on. It opens again only below ``resume_below_c``, and only for a
  pause the temperature caused (the latch keeps a set of pause sources; ``thermal`` is the only one so far and the
  only one that ends by itself). A running gated call is cancelled when the chip reaches ``cancel_chip_at_c`` or its
  CUDA device (NVML) ``cancel_gpu_at_c``. A task samples the chip every ``sample_seconds``, every
  ``hot_sample_seconds`` while paused or at or above ``resume_below_c``; waits and watches read it as well.
- ``memory``: a gated call starts only with ``MemAvailable`` (/proc/meminfo) of at least
  ``start_min_available_bytes``, and while it runs it is cancelled once ``MemAvailable`` falls below
  ``cancel_below_available_bytes`` (sampled every ``sample_seconds``).
- Every sample of a wait adds a line with the readings and thresholds to the call's recording, and the wait is the
  call's ``wait`` phase (``host_wait_ms``). The call deadline still applies, and a cancel ends the wait at once.
- A sensor that cannot be read turns its check off (fail-open), with one warning until it reads again.
- Nothing is ever killed by name: an emergency is ``invoke.cancel_call`` (cooperative, then only this instance's own
  process group after ``cancel_grace_seconds``), and the call ends as failed with ``HOST_PROTECTION``. A call that
  reaches its deadline while held back ran nothing: ``HOST_MEMORY_INSUFFICIENT`` when only memory held it,
  ``HOST_PROTECTION`` otherwise.

Without an ``admission`` block none of this exists: no sampling task, no waits.
"""

from __future__ import annotations

import asyncio
import contextlib
import glob
import logging
import threading
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from phasyn_components.errors import ComponentError, exception_message, host_memory_insufficient
from phasyn_components.recorder import Recorder

from .config import DEFAULT_CHIP_ZONE_GLOB, AdmissionConfig, ThermalLimits

log = logging.getLogger("phasyn_node.admission")

GIB = 1024**3
THERMAL = "thermal"  # the chip temperature's pause source: the only one so far, and it ends by itself
MEMORY = "memory"
PLAUSIBLE_C = (-40.0, 200.0)  # a zone outside this range is broken, not hot: skipped, never trusted
FALLBACK_INTERVAL_S = 5.0  # unused in practice: a valid admission block always has thermal or memory

Clock = Callable[[], float]
Sleep = Callable[[float], Awaitable[None]]


class SensorError(Exception):
    """A sensor could not be read; the message says why."""


def _nothing() -> None:
    return None


@dataclass(frozen=True)
class Sensors:
    """The guard's readers. Each runs in a worker thread and raises when it cannot read; the GPU reader returns
    None for a device that has no GPU temperature (not CUDA)."""

    chip_c: Callable[[], float]
    gpu_c: Callable[[Mapping[str, Any]], float | None]
    available_bytes: Callable[[], int]
    close: Callable[[], None] = _nothing


class ThermalZones:
    """The chip temperature: the hottest zone of ``pattern`` (m°C). Unreadable or implausible zones are skipped."""

    def __init__(self, pattern: str) -> None:
        self.pattern = pattern
        self._paths: list[str] = []

    def __call__(self) -> float:
        if not self._paths:  # listed once; looked for again while there is none
            self._paths = sorted(glob.glob(self.pattern))
        values: list[float] = []
        for path in self._paths:
            try:
                with open(path, encoding="ascii") as fh:
                    value = int(fh.read().strip()) / 1000.0
            except (OSError, ValueError):
                continue
            if PLAUSIBLE_C[0] < value < PLAUSIBLE_C[1]:
                values.append(value)
        if not values:
            raise SensorError(f"{self.pattern} 沒有讀得到的溫度（{len(self._paths)} 個 zone）")
        return max(values)


def read_available_bytes(path: str = "/proc/meminfo") -> int:
    """``MemAvailable`` of /proc/meminfo, in bytes."""
    with open(path, encoding="ascii") as fh:
        for line in fh:
            name, _, rest = line.partition(":")
            if name == "MemAvailable":
                fields = rest.split()
                return int(fields[0]) * (1024 if fields[1:] == ["kB"] else 1)
    raise SensorError(f"{path} 沒有 MemAvailable")


class NvmlTemperatures:
    """GPU temperature (NVML ``NVML_TEMPERATURE_GPU``) of a CUDA device, opened by UUID or index as the sampler does.

    NVML that cannot start, or a device it does not know, keeps failing with the same reason: it is not retried."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._nv: Any = None
        self._failed: str | None = None
        self._handles: dict[str, Any] = {}
        self._unknown: dict[str, str] = {}

    def __call__(self, device: Mapping[str, Any]) -> float | None:
        if str(device.get("kind") or "cpu") != "cuda":
            return None
        device_id = str(device.get("id") or "")
        with self._lock:
            nv = self._open()
            handle = self._handle(nv, device_id)
            return float(nv.nvmlDeviceGetTemperature(handle, nv.NVML_TEMPERATURE_GPU))

    def _open(self) -> Any:
        if self._failed is not None:
            raise SensorError(self._failed)
        if self._nv is None:
            try:
                import pynvml

                pynvml.nvmlInit()
            except Exception as exc:
                self._failed = f"NVML 無法使用：{type(exc).__name__}: {exception_message(exc)}"[:500]
                raise SensorError(self._failed) from exc
            self._nv = pynvml
        return self._nv

    def _handle(self, nv: Any, device_id: str) -> Any:
        if device_id in self._unknown:
            raise SensorError(self._unknown[device_id])
        handle = self._handles.get(device_id)
        if handle is None:
            try:
                if device_id.startswith(("GPU-", "MIG-")):
                    handle = nv.nvmlDeviceGetHandleByUUID(device_id)
                else:
                    handle = nv.nvmlDeviceGetHandleByIndex(int(device_id))
            except Exception as exc:
                reason = f"NVML 找不到裝置 {device_id}：{type(exc).__name__}: {exception_message(exc)}"[:500]
                self._unknown[device_id] = reason
                raise SensorError(reason) from exc
            self._handles[device_id] = handle
        return handle

    def close(self) -> None:
        with self._lock:
            nv, self._nv = self._nv, None
            self._handles.clear()
        if nv is not None:
            with contextlib.suppress(Exception):
                nv.nvmlShutdown()


def default_sensors(config: AdmissionConfig) -> Sensors:
    """This host's readers: thermal zones, NVML and /proc/meminfo (nothing is opened before the first reading)."""
    nvml = NvmlTemperatures()
    pattern = config.thermal.chip_zone_glob if config.thermal is not None else DEFAULT_CHIP_ZONE_GLOB
    return Sensors(chip_c=ThermalZones(pattern), gpu_c=nvml, available_bytes=read_available_bytes, close=nvml.close)


def _gib(value: int) -> str:
    return f"{value / GIB:.1f}"


@dataclass(frozen=True)
class Pause:
    """One pause source: when it began and the reading that began it."""

    since: float
    reading: float | None = None


class PauseLatch:
    """The pause sources that hold new gated calls back (a pause never touches a running call).

    Only ``thermal`` exists so far, and only the chip temperature ends it. Another source (a memory watchdog, a
    deployment, a person) would come with its own release rule; the temperature never ends it."""

    def __init__(self) -> None:
        self._sources: dict[str, Pause] = {}

    @property
    def paused(self) -> bool:
        return bool(self._sources)

    @property
    def sources(self) -> tuple[str, ...]:
        return tuple(sorted(self._sources))

    def get(self, source: str) -> Pause | None:
        return self._sources.get(source)

    def pause(self, source: str, pause: Pause) -> bool:
        """Pause for ``source``; False when that source already holds the latch."""
        if source in self._sources:
            return False
        self._sources[source] = pause
        return True

    def resume(self, source: str) -> Pause | None:
        """End the pause of ``source`` only (other sources stay); None when it held nothing."""
        return self._sources.pop(source, None)


@dataclass(frozen=True)
class Hold:
    """One reason a gated call may not start yet: its progress text and the same readings as data."""

    reason: str
    text: str
    fields: dict[str, Any]


@dataclass(frozen=True)
class Trip:
    """The emergency limit a running gated call crossed; ``reason`` is also the reason of its cancel."""

    reason: str
    sensor: str
    reading: float | int
    threshold: float | int
    text: str

    def error(self, *, process_killed: bool, process_exited: bool | None) -> dict[str, Any]:
        """The call's error once the cancel path has stopped it."""
        message = self.text + (
            "；cooperative 取消逾時，已終止自有 process group（模型已卸載，需要時請手動 start）"
            if process_killed
            else ""
        )
        details: dict[str, Any] = {
            "reason": self.reason,
            "phase": "runtime",
            "sensor": self.sensor,
            "reading": self.reading,
            "threshold": self.threshold,
            "process_killed": process_killed,
        }
        if process_killed:
            details["process_exited"] = process_exited
        return ComponentError("HOST_PROTECTION", message, details=details).to_dict()


class AdmissionGuard:
    """The host protection of one Node (``NodeConfig.admission``; see the module docstring).

    ``sensors``, ``clock`` and ``sleep`` are injected so tests run on fake readings and a fast clock."""

    def __init__(
        self,
        config: AdmissionConfig,
        *,
        sensors: Sensors | None = None,
        clock: Clock = time.monotonic,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self.config = config
        self.sensors = sensors if sensors is not None else default_sensors(config)
        self.clock = clock
        self.sleep = sleep
        self.latch = PauseLatch()
        self.chip_c: float | None = None  # the newest chip reading (None: none yet, or unreadable)
        self.waiting = 0  # gated calls held back right now
        self._failing: set[str] = set()
        self._task: asyncio.Task[None] | None = None

    def gates(self, *, exclusive_group: str | None, provider_id: str) -> bool:
        """Whether calls of this component are held back and watched."""
        gated = self.config.gated
        return provider_id in gated.provider_ids or (
            exclusive_group is not None and exclusive_group in gated.exclusive_groups
        )

    @property
    def sampling(self) -> bool:
        """The chip temperature task is running (only with ``thermal``)."""
        return self._task is not None and not self._task.done()

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self._task is not None:
            return
        log.info(
            "主機保護已啟用：受保護的呼叫 exclusive_groups=%s provider_ids=%s；溫度 %s；主記憶體 %s",
            list(self.config.gated.exclusive_groups),
            list(self.config.gated.provider_ids),
            self.config.thermal,
            self.config.memory,
        )
        if self.config.thermal is not None:
            task = asyncio.create_task(self._sample_chip(), name="admission-thermal")
            task.add_done_callback(self._sampler_done)
            self._task = task

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self.sensors.close)

    async def _sample_chip(self) -> None:
        while True:
            await self.read_chip()
            await self.sleep(self._interval(thermal=True, memory=False))

    @staticmethod
    def _sampler_done(task: asyncio.Task[None]) -> None:
        if not task.cancelled() and task.exception() is not None:
            log.error(
                "主機保護的溫度取樣停止了（等待與監看中的呼叫仍會讀溫度）：%s",
                task.exception(),
                exc_info=task.exception(),
            )

    # ------------------------------------------------------------------ readings
    async def _read[T](self, key: str, read: Callable[..., T], *args: Any, what: str) -> T | None:
        """One reading in a worker thread. A failure is no reading (fail-open), warned once until it reads again."""
        try:
            value = await asyncio.to_thread(read, *args)
        except Exception as exc:
            if key not in self._failing:
                self._failing.add(key)
                log.warning(
                    "主機保護：讀不到「%s」（%s）；這項檢查先停用（fail-open），讀得到時自動恢復",
                    what,
                    exception_message(exc),
                )
            return None
        if key in self._failing:
            self._failing.discard(key)
            log.info("主機保護：「%s」又讀得到了，恢復這項檢查", what)
        return value

    async def read_chip(self) -> float | None:
        """A fresh chip temperature, which also moves the pause latch (None without ``thermal`` or when unreadable)."""
        if self.config.thermal is None:
            return None
        chip = await self._read("chip", self.sensors.chip_c, what="晶片溫度")
        self.observe_chip(chip)
        return chip

    def observe_chip(self, chip: float | None) -> None:
        """Move the thermal pause by one reading: pause at ``pause_at_c``, resume only below ``resume_below_c``.

        An unreadable chip never holds calls back: it ends a thermal pause (fail-open)."""
        limits = self.config.thermal
        if limits is None:
            return
        self.chip_c = chip
        if chip is not None and chip >= limits.pause_at_c:
            if self.latch.pause(THERMAL, Pause(since=self.clock(), reading=chip)):
                log.warning(
                    "主機保護：晶片溫度 %.1f°C ≥ %g°C，暫停新的受保護呼叫（進行中的繼續）；降到 %g°C 以下恢復",
                    chip,
                    limits.pause_at_c,
                    limits.resume_below_c,
                )
            return
        if chip is not None and chip >= limits.resume_below_c:
            return  # between the thresholds: the latch stays as it is
        ended = self.latch.resume(THERMAL)
        if ended is None:
            return
        paused_s = self.clock() - ended.since
        if chip is None:
            log.warning("主機保護：讀不到晶片溫度，解除溫度暫停（fail-open；暫停了 %.0f 秒）", paused_s)
        else:
            log.info(
                "主機保護：晶片溫度 %.1f°C < %g°C，恢復受保護的呼叫（暫停了 %.0f 秒）",
                chip,
                limits.resume_below_c,
                paused_s,
            )

    def _interval(self, *, thermal: bool, memory: bool) -> float:
        """The sampling interval of the checks named: the thermal one is short while paused or warm."""
        intervals: list[float] = []
        limits = self.config.thermal
        if thermal and limits is not None:
            warm = self.latch.get(THERMAL) is not None or (
                self.chip_c is not None and self.chip_c >= limits.resume_below_c
            )
            intervals.append(limits.hot_sample_seconds if warm else limits.sample_seconds)
        if memory and self.config.memory is not None:
            intervals.append(self.config.memory.sample_seconds)
        return min(intervals, default=FALLBACK_INTERVAL_S)

    def hold_interval(self, holds: Sequence[Hold]) -> float:
        return self._interval(
            thermal=any(hold.reason != MEMORY for hold in holds), memory=any(hold.reason == MEMORY for hold in holds)
        )

    def watch_interval(self) -> float:
        return self._interval(thermal=True, memory=True)

    # ------------------------------------------------------------------ admission
    async def holds(self) -> list[Hold]:
        """Fresh readings: every reason a gated call may not start now (empty: it may start)."""
        found: list[Hold] = []
        thermal, memory = self.config.thermal, self.config.memory
        chip = await self.read_chip()
        if thermal is not None and chip is not None and self.latch.get(THERMAL) is not None:
            found.append(_thermal_hold(chip, thermal))
        found += [
            Hold(source, f"等待暫停解除：{source}", {"reason": source})
            for source in self.latch.sources
            if source != THERMAL
        ]
        if memory is not None:
            available = await self._read(MEMORY, self.sensors.available_bytes, what="可用主記憶體")
            if available is not None and available < memory.start_min_available_bytes:
                found.append(
                    Hold(
                        MEMORY,
                        f"等待主記憶體：可用 {_gib(available)} GiB，低於開始門檻 {_gib(memory.start_min_available_bytes)} GiB",
                        {
                            "reason": MEMORY,
                            "available_bytes": available,
                            "start_min_available_bytes": memory.start_min_available_bytes,
                        },
                    )
                )
        return found

    def admission(self, *, recorder: Recorder, component_id: str, call_id: str) -> AdmissionWait:
        return AdmissionWait(self, recorder=recorder, component_id=component_id, call_id=call_id)

    # ------------------------------------------------------------------ emergency
    async def emergency(self, device: Mapping[str, Any]) -> Trip | None:
        """Fresh readings of a running gated call: the first emergency limit it crossed, or None."""
        thermal, memory = self.config.thermal, self.config.memory
        if thermal is not None:
            chip = await self.read_chip()
            if chip is not None and chip >= thermal.cancel_chip_at_c:
                return Trip(
                    THERMAL,
                    "chip",
                    chip,
                    thermal.cancel_chip_at_c,
                    f"主機保護：晶片溫度 {chip:.1f}°C ≥ 緊急門檻 {thermal.cancel_chip_at_c:g}°C，已取消這個呼叫；"
                    f"重新送出的呼叫會等晶片降到 {thermal.resume_below_c:g}°C 以下才開始",
                )
            device_id = str(device.get("id") or "")
            gpu = await self._read(f"gpu:{device_id}", self.sensors.gpu_c, device, what=f"GPU {device_id} 溫度")
            if gpu is not None and gpu >= thermal.cancel_gpu_at_c:
                return Trip(
                    THERMAL,
                    "gpu",
                    gpu,
                    thermal.cancel_gpu_at_c,
                    f"主機保護：GPU 溫度 {gpu:.1f}°C ≥ 緊急門檻 {thermal.cancel_gpu_at_c:g}°C，已取消這個呼叫；降溫後再送出",
                )
        if memory is not None:
            available = await self._read(MEMORY, self.sensors.available_bytes, what="可用主記憶體")
            if available is not None and available < memory.cancel_below_available_bytes:
                return Trip(
                    MEMORY,
                    MEMORY,
                    available,
                    memory.cancel_below_available_bytes,
                    f"主機保護：可用主記憶體 {_gib(available)} GiB，低於緊急門檻 "
                    f"{_gib(memory.cancel_below_available_bytes)} GiB，已取消這個呼叫；釋放主記憶體後再送出",
                )
        return None

    def watch(self, device: Mapping[str, Any], on_trip: Callable[[Trip], bool]) -> EmergencyWatch:
        return EmergencyWatch(self, device, on_trip)


def _thermal_hold(chip: float, limits: ThermalLimits) -> Hold:
    if chip >= limits.pause_at_c:
        text = f"等待晶片降溫：{chip:.1f}°C ≥ {limits.pause_at_c:g}°C（降到 {limits.resume_below_c:g}°C 以下恢復）"
    else:
        text = f"等待晶片降溫：{chip:.1f}°C，仍在暫停（降到 {limits.resume_below_c:g}°C 以下恢復）"
    fields = {
        "reason": THERMAL,
        "chip_c": chip,
        "pause_at_c": limits.pause_at_c,
        "resume_below_c": limits.resume_below_c,
    }
    return Hold(THERMAL, text, fields)


class AdmissionWait:
    """A gated call right before its runtime phase: ``check`` once, then ``run`` while anything holds it back."""

    def __init__(self, guard: AdmissionGuard, *, recorder: Recorder, component_id: str, call_id: str) -> None:
        self.guard = guard
        self.recorder = recorder
        self.component_id = component_id
        self.call_id = call_id
        self.holds: list[Hold] = []  # the last reasons it was held back (kept for the deadline error)
        self.started: float | None = None

    def text(self) -> str:
        return "；".join(hold.text for hold in self.holds)

    def waited_s(self) -> float:
        return 0.0 if self.started is None else max(0.0, self.guard.clock() - self.started)

    async def check(self) -> bool:
        """Fresh readings: True when the call may start now."""
        self.holds = await self.guard.holds()
        return not self.holds

    async def run(self) -> None:
        """Wait (cancellable) until nothing holds the call back; every sample adds a line to its recording."""
        guard = self.guard
        self.started = guard.clock()
        guard.waiting += 1
        log.info("主機保護：元件 %s 的呼叫 %s 等待放行：%s", self.component_id, self.call_id, self.text())
        level = "warning"
        try:
            while True:
                self.recorder.log(level, self.text(), phase="admission", holds=[hold.fields for hold in self.holds])
                level = "info"
                await guard.sleep(guard.hold_interval(self.holds))
                holds = await guard.holds()
                if not holds:
                    break
                self.holds = holds
        finally:
            guard.waiting -= 1
        waited = self.waited_s()
        self.recorder.log(
            "info", f"主機保護放行：等待 {waited:.0f} 秒後開始執行", phase="admission", waited_seconds=round(waited, 3)
        )
        log.info("主機保護：元件 %s 的呼叫 %s 放行（等待 %.0f 秒）", self.component_id, self.call_id, waited)

    def timeout_error(self, timeout_seconds: int) -> dict[str, Any]:
        """The deadline came while the call was held back: nothing ran."""
        details: dict[str, Any] = {
            "phase": "admission",
            "timeout_seconds": timeout_seconds,
            "waited_seconds": round(self.waited_s(), 3),
            "holds": [hold.fields for hold in self.holds],
        }
        if self.holds and all(hold.reason == MEMORY for hold in self.holds):
            finding = f"主機保護：等到呼叫期限（timeout_seconds={timeout_seconds}）主記憶體仍不足（{self.text()}）"
            return host_memory_insufficient(finding, details={"reason": MEMORY, **details}).to_dict()
        return ComponentError(
            "HOST_PROTECTION",
            f"主機保護：等到呼叫期限（timeout_seconds={timeout_seconds}）仍未放行（{self.text()}）；呼叫沒有執行",
            details={"reason": self.holds[0].reason if self.holds else THERMAL, **details},
        ).to_dict()


class EmergencyWatch:
    """A running gated call, sampled until its first emergency. ``on_trip`` turns that into a cancel, or declines
    when the call already has an outcome or a cancel under way; ``trip`` is the emergency that cancelled it."""

    def __init__(self, guard: AdmissionGuard, device: Mapping[str, Any], on_trip: Callable[[Trip], bool]) -> None:
        self.guard = guard
        self.device = dict(device)
        self.on_trip = on_trip
        self.trip: Trip | None = None

    async def run(self) -> None:
        guard = self.guard
        while True:
            await guard.sleep(guard.watch_interval())
            trip = await guard.emergency(self.device)
            if trip is None:
                continue
            if self.on_trip(trip):
                self.trip = trip
            return


__all__ = [
    "AdmissionGuard",
    "AdmissionWait",
    "EmergencyWatch",
    "Hold",
    "NvmlTemperatures",
    "Pause",
    "PauseLatch",
    "SensorError",
    "Sensors",
    "ThermalZones",
    "Trip",
    "default_sensors",
    "read_available_bytes",
]
