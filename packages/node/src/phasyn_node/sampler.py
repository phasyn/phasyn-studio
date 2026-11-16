"""裝置與主機取樣。

每個使用中的裝置只有一個 sampler 執行緒（``sample_id`` 可關聯多個 recording，不會把同一張卡的用量
重複算成多份）。load 或 call 進行中時把樣本掛到該 recording 的 Node 端 Recorder：

- GPU（``pynvml``）：nvml_device_used/total_bytes、nvml_process_used_bytes、device_utilization_pct、
  memory_utilization_pct、device_power_w、device_temperature_c、device_sm_clock_mhz（quality sampled）。
  NVML 不存在／錯誤／欄位不支援（例如整合記憶體（UMA）裝置沒有獨立顯存總量）→ value null 並附原因，絕不填 0，
  也不影響呼叫。CPU 裝置的 GPU 指標為 not_applicable。
- 主機（``psutil``）：host_rss_current_bytes（元件程序 PID）、host_available_bytes、host_swap_used_bytes。
"""

from __future__ import annotations

import contextlib
import itertools
import logging
import re
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import psutil
from phasyn_components.errors import exception_message
from phasyn_components.recorder import Recorder
from phasyn_components.recorder.metrics import metric, not_applicable, unavailable

log = logging.getLogger("phasyn_node.sampler")

GPU_METRICS = (
    "nvml_device_used_bytes",
    "nvml_device_total_bytes",
    "nvml_process_used_bytes",
    "device_utilization_pct",
    "memory_utilization_pct",
    "device_power_w",
    "device_temperature_c",
    "device_sm_clock_mhz",
)
_SAFE_ID = re.compile(r"[^A-Za-z0-9_.:-]+")


def _nvml_reason(exc: BaseException) -> str:
    name = type(exc).__name__
    if "NotSupported" in name:
        return "NVML 回報此裝置不支援此欄位（例如 UMA 裝置沒有獨立顯存總量）"
    return f"NVML 查詢失敗：{name}: {exception_message(exc)}"[:500]


class NvmlDevice:
    """單一 CUDA 裝置的 NVML handle（在 sampler 執行緒內建立與使用）。"""

    def __init__(self, device_id: str) -> None:
        import pynvml

        self._nv: Any = pynvml
        pynvml.nvmlInit()
        try:
            if device_id.startswith(("GPU-", "MIG-")):
                self._handle = pynvml.nvmlDeviceGetHandleByUUID(device_id)
            else:
                self._handle = pynvml.nvmlDeviceGetHandleByIndex(int(device_id))
        except BaseException:
            with contextlib.suppress(Exception):
                pynvml.nvmlShutdown()
            raise

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._nv.nvmlShutdown()

    def _field(
        self, name: str, fn: Any, out: dict[str, dict[str, Any]], *, scale: float = 1.0, integer: bool = False
    ) -> None:
        try:
            raw = fn()
        except Exception as exc:
            out[name] = unavailable(name, _nvml_reason(exc))
            return
        if raw is None:
            out[name] = unavailable(name, "NVML 未提供此值")
            return
        value: float | int = float(raw) * scale
        if integer:
            value = int(value)
        out[name] = metric(name, value, quality="sampled")

    def device_metrics(self) -> dict[str, dict[str, Any]]:
        nv, h = self._nv, self._handle
        out: dict[str, dict[str, Any]] = {}
        try:
            mem = nv.nvmlDeviceGetMemoryInfo(h)
            out["nvml_device_used_bytes"] = metric("nvml_device_used_bytes", int(mem.used), quality="sampled")
            out["nvml_device_total_bytes"] = metric("nvml_device_total_bytes", int(mem.total), quality="sampled")
        except Exception as exc:
            reason = _nvml_reason(exc)
            out["nvml_device_used_bytes"] = unavailable("nvml_device_used_bytes", reason)
            out["nvml_device_total_bytes"] = unavailable("nvml_device_total_bytes", reason)
        try:
            util = nv.nvmlDeviceGetUtilizationRates(h)
            out["device_utilization_pct"] = metric("device_utilization_pct", float(util.gpu), quality="sampled")
            out["memory_utilization_pct"] = metric("memory_utilization_pct", float(util.memory), quality="sampled")
        except Exception as exc:
            reason = _nvml_reason(exc)
            out["device_utilization_pct"] = unavailable("device_utilization_pct", reason)
            out["memory_utilization_pct"] = unavailable("memory_utilization_pct", reason)
        self._field("device_power_w", lambda: nv.nvmlDeviceGetPowerUsage(h), out, scale=0.001)
        self._field("device_temperature_c", lambda: nv.nvmlDeviceGetTemperature(h, nv.NVML_TEMPERATURE_GPU), out)
        self._field("device_sm_clock_mhz", lambda: nv.nvmlDeviceGetClockInfo(h, nv.NVML_CLOCK_SM), out)
        return out

    def process_used(self, pids: set[int]) -> tuple[dict[int, int], str | None]:
        """回傳 {pid: bytes}；整體查詢失敗時回傳原因。"""
        nv, h = self._nv, self._handle
        found: dict[int, int] = {}
        try:
            procs = list(nv.nvmlDeviceGetComputeRunningProcesses(h))
        except Exception as exc:
            return found, _nvml_reason(exc)
        for p in procs:
            pid = int(getattr(p, "pid", -1))
            used = getattr(p, "usedGpuMemory", None)
            if pid in pids and isinstance(used, int) and used >= 0:
                found[pid] = found.get(pid, 0) + used
        return found, None


@dataclass
class _Subscription:
    token: int
    recorder: Recorder
    pid: int | None


def host_metrics() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    try:
        out["host_available_bytes"] = metric(
            "host_available_bytes", int(psutil.virtual_memory().available), quality="sampled"
        )
    except Exception as exc:
        out["host_available_bytes"] = unavailable("host_available_bytes", f"psutil 查詢失敗：{exception_message(exc)}")
    try:
        out["host_swap_used_bytes"] = metric("host_swap_used_bytes", int(psutil.swap_memory().used), quality="sampled")
    except Exception as exc:
        out["host_swap_used_bytes"] = unavailable("host_swap_used_bytes", f"psutil 查詢失敗：{exception_message(exc)}")
    return out


def process_rss(pid: int | None) -> dict[str, Any]:
    if pid is None:
        return unavailable("host_rss_current_bytes", "沒有元件程序 PID")
    try:
        return metric("host_rss_current_bytes", int(psutil.Process(pid).memory_info().rss), quality="sampled")
    except psutil.NoSuchProcess:
        return unavailable("host_rss_current_bytes", "元件程序已結束")
    except Exception as exc:
        return unavailable("host_rss_current_bytes", f"psutil 查詢失敗：{exception_message(exc)}")


class DeviceSampler:
    """一個裝置一條執行緒；只有在有訂閱（load／call 進行中）時才運作。"""

    def __init__(self, hub: SamplerHub, device: Mapping[str, Any]) -> None:
        self.hub = hub
        self.kind = str(device.get("kind") or "cpu")
        self.device_id = str(device.get("id") or "cpu")
        self.key = f"{self.kind}:{self.device_id}"
        self._subs: dict[int, _Subscription] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._counter = itertools.count(1)
        self._tag = _SAFE_ID.sub("-", self.key).strip("-") or "device"

    def add(self, sub: _Subscription) -> None:
        with self._lock:
            self._subs[sub.token] = sub
            if self._thread is None or not self._thread.is_alive():
                self._stop.clear()
                self._thread = threading.Thread(target=self._loop, name=f"sampler-{self._tag}", daemon=True)
                self._thread.start()
            else:
                self._wake.set()  # 新的 load／call 立即取第一個樣本，不等下一個週期

    def remove(self, token: int) -> None:
        with self._lock:
            self._subs.pop(token, None)

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def _loop(self) -> None:
        nvml: NvmlDevice | None = None
        nvml_error: str | None = None
        if self.kind == "cuda":
            try:
                nvml = NvmlDevice(self.device_id)
            except Exception as exc:
                nvml_error = f"NVML 無法使用：{type(exc).__name__}: {exception_message(exc)}"[:500]
                log.info("裝置 %s 的 NVML 取樣不可用（只影響觀測）：%s", self.key, nvml_error)
        try:
            while not self._stop.is_set():
                with self._lock:
                    subs = list(self._subs.values())
                if not subs:
                    with self._lock:
                        if not self._subs:
                            self._thread = None
                            return
                    continue
                try:
                    self._sample_once(subs, nvml, nvml_error)
                except Exception:
                    log.debug("取樣失敗（已忽略）", exc_info=True)
                self._wake.wait(self.hub.interval_s)
                self._wake.clear()
        finally:
            if nvml is not None:
                nvml.close()

    def _sample_once(self, subs: list[_Subscription], nvml: NvmlDevice | None, nvml_error: str | None) -> None:
        sample_id = f"smp-{self._tag}-{next(self._counter)}"
        shared = host_metrics()
        per_pid: dict[int, int] = {}
        pid_reason: str | None = None
        if self.kind == "cuda":
            if nvml is not None:
                shared.update(nvml.device_metrics())
                per_pid, pid_reason = nvml.process_used({s.pid for s in subs if s.pid is not None})
            else:
                for name in GPU_METRICS:
                    shared[name] = unavailable(name, nvml_error or "NVML 無法使用")
        else:
            for name in GPU_METRICS:
                shared[name] = not_applicable(name, "CPU 裝置沒有 GPU 指標")
        for sub in subs:
            metrics = dict(shared)
            metrics["host_rss_current_bytes"] = process_rss(sub.pid)
            if self.kind == "cuda" and nvml is not None:
                if sub.pid is not None and sub.pid in per_pid:
                    metrics["nvml_process_used_bytes"] = metric(
                        "nvml_process_used_bytes", per_pid[sub.pid], quality="sampled"
                    )
                else:
                    metrics["nvml_process_used_bytes"] = unavailable(
                        "nvml_process_used_bytes",
                        pid_reason
                        or "NVML 未列出此 PID（可能尚未建立 CUDA context，或裝置不支援 per-process 查詢）；不以 device used 代替",
                    )
            with contextlib.suppress(Exception):
                sub.recorder.sample(sample_id, device_id=self.device_id, process_id=sub.pid, metrics=metrics)


class SamplerHub:
    def __init__(self, *, hz: float) -> None:
        self.hz = float(hz)
        self.interval_s = 1.0 / self.hz if self.hz > 0 else 0.0
        self._lock = threading.Lock()
        self._devices: dict[str, DeviceSampler] = {}
        self._tokens = itertools.count(1)
        self._index: dict[int, DeviceSampler] = {}

    @property
    def enabled(self) -> bool:
        return self.hz > 0

    def subscribe(self, device: Mapping[str, Any], recorder: Recorder, pid: int | None) -> int | None:
        """把這個 recording 掛到裝置 sampler；recording 的 device_sample_hz=0 時不掛。"""
        if not self.enabled or float(recorder.config.get("device_sample_hz", 2) or 0) <= 0:
            return None
        key = f"{device.get('kind') or 'cpu'}:{device.get('id') or 'cpu'}"
        with self._lock:
            sampler = self._devices.get(key)
            if sampler is None:
                sampler = DeviceSampler(self, device)
                self._devices[key] = sampler
            token = next(self._tokens)
            self._index[token] = sampler
        sampler.add(_Subscription(token=token, recorder=recorder, pid=pid))
        return token

    def unsubscribe(self, token: int | None) -> None:
        if token is None:
            return
        with self._lock:
            sampler = self._index.pop(token, None)
        if sampler is not None:
            sampler.remove(token)

    def stop(self) -> None:
        with self._lock:
            samplers = list(self._devices.values())
            self._index.clear()
        deadline = time.monotonic() + 3
        for sampler in samplers:
            sampler.stop(timeout=max(0.1, deadline - time.monotonic()))


__all__ = ["GPU_METRICS", "DeviceSampler", "NvmlDevice", "SamplerHub", "host_metrics", "process_rss"]
