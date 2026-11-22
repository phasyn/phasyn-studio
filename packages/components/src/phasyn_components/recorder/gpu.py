"""GPU recorder hooks（需要 torch；只在 GPU 元件程序內延遲匯入）。 … #v4-recorder-7.

- CUDA event 在實際 stream 上記錄；只有 ``end.query()`` 為真（或在結果本來就必須完成的邊界）
  才讀 ``elapsed_time``。不為了紀錄做 device-wide synchronize、``.item()`` 或 ``.cpu()``。
- event interval 是 stream 上的區間（可能含等待／空隙），不是 kernel active time 總和；不同
  stream 的區間不相加。
- 每 call 的 allocator 峰值：開始 reset、結束讀 peak；allocated 與 reserved 分開，不相加。
- trace 模式：只在指定 steps 開 torch.profiler，輸出 Chrome trace JSON；backend 不可用時回報
  trace_status=unavailable，推論照常完成。
"""

from __future__ import annotations

import collections
import contextlib
import json
import tempfile
from collections.abc import Callable, Iterator
from importlib import import_module
from pathlib import Path
from types import ModuleType
from typing import Any

from .core import Recorder


Callback = Callable[[float | None], None]


def _torch() -> ModuleType:
    return import_module("torch")


def stream_id(stream: Any) -> str | None:
    """Identify the current GPU stream."""
    if stream is None:
        return None
    for attr in ("stream_id", "cuda_stream"):
        value = getattr(stream, attr, None)
        if value is not None:
            return str(value)
    return None


class EventPairs:
    """有上限的待解 CUDA event pair。滿了就不再記新的 pair（計入 dropped，回呼 None）."""

    def __init__(self, *, max_pending: int, enabled: bool = True) -> None:
        """Initialize event pairs with its configuration."""
        self.max_pending = max(1, int(max_pending))
        self.enabled = enabled
        self._pending: collections.deque[tuple[Any, Any, Callback]] = (
            collections.deque()
        )
        self.dropped = 0
        self.resolved = 0

    def record(self, stream: Any | None = None) -> Any | None:
        """Record a GPU timing event."""
        if not self.enabled:
            return None
        torch = _torch()
        event = torch.cuda.Event(enable_timing=True)
        if stream is None:
            event.record()
        else:
            event.record(stream)
        return event

    def pair(self, start: Any | None, end: Any | None, callback: Callback) -> None:
        """Record a paired interval on a GPU stream."""
        if start is None or end is None:
            callback(None)
            return
        if len(self._pending) >= self.max_pending:
            self.dropped += 1
            callback(None)
            return
        self._pending.append((start, end, callback))

    def poll(self) -> int:
        """非阻塞：只解已完成的 pair（end.query() 為真）."""
        done = 0
        remaining: collections.deque[tuple[Any, Any, Callback]] = collections.deque()
        while self._pending:
            start, end, callback = self._pending.popleft()
            try:
                complete = bool(end.query())
            except Exception:  # noqa: BLE001 - Optional CUDA instrumentation must report failure without stopping the provider.
                callback(None)
                continue
            if complete:
                try:
                    callback(float(start.elapsed_time(end)))
                except Exception:  # noqa: BLE001 - Optional CUDA instrumentation must report failure without stopping the provider.
                    callback(None)
                done += 1
            else:
                remaining.append((start, end, callback))
        self._pending = remaining
        self.resolved += done
        return done

    def drain(self, *, wait: bool) -> int:
        """Call 結束邊界：wait=True 時逐一等待最後的 event（結果本來就必須完成），再解全部."""
        if wait:
            for _start, end, _cb in list(self._pending):
                with contextlib.suppress(Exception):
                    end.synchronize()
        done = self.poll()
        for _start, _end, callback in self._pending:
            callback(None)
        self._pending.clear()
        return done

    @property
    def pending(self) -> int:
        """Return the number of pending measurements."""
        return len(self._pending)


class AllocatorWindow:
    """此程序、此 device 的 PyTorch caching allocator（不是整張 GPU）。量測失敗只降級紀錄，不影響運算."""

    def __init__(self, device: Any) -> None:
        """Initialize allocator window with its configuration."""
        self.torch = _torch()
        self.device = device
        self.available = bool(self.torch.cuda.is_available())
        self.reason: str | None = (
            None if self.available else "此程序沒有可用的 CUDA allocator"
        )
        self.start_allocated: int | None = None
        self.start_reserved: int | None = None
        self.peak_allocated = 0
        self.peak_reserved = 0

    def _call(self, fn: Callable[[], Any]) -> Any:
        if not self.available:
            return None
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - Optional CUDA instrumentation must report failure without stopping the provider.
            self.available = False
            self.reason = f"allocator 量測失敗：{type(exc).__name__}: {exc}"[:500]
            return None

    def start(self) -> None:
        """Start collecting measurements."""
        cuda = self.torch.cuda
        self._call(lambda: (cuda.init(), cuda.current_device()))
        self._call(lambda: cuda.reset_peak_memory_stats(self.device))
        allocated = self._call(lambda: int(cuda.memory_allocated(self.device)))
        reserved = self._call(lambda: int(cuda.memory_reserved(self.device)))
        self.start_allocated, self.start_reserved = allocated, reserved
        self.peak_allocated = allocated or 0
        self.peak_reserved = reserved or 0

    def observe(self) -> None:
        """讀目前 peak（host 端 allocator 計數，不同步 GPU）."""
        cuda = self.torch.cuda
        alloc = self._call(lambda: int(cuda.max_memory_allocated(self.device)))
        res = self._call(lambda: int(cuda.max_memory_reserved(self.device)))
        self.merge_peaks(alloc, res)

    def merge_peaks(self, allocated: int | None, reserved: int | None) -> None:
        """Merge allocator peak measurements."""
        if allocated is not None:
            self.peak_allocated = max(self.peak_allocated, int(allocated))
        if reserved is not None:
            self.peak_reserved = max(self.peak_reserved, int(reserved))

    def finish(self, rec: Recorder, *, scope: str) -> None:
        """Finish and return the completed operation."""
        names = (
            "torch_allocated_current_bytes",
            "torch_allocated_peak_bytes",
            "torch_reserved_current_bytes",
            "torch_reserved_peak_bytes",
        )
        if self.available:
            self.observe()
        cuda = self.torch.cuda
        current_alloc = self._call(lambda: int(cuda.memory_allocated(self.device)))
        current_res = self._call(lambda: int(cuda.memory_reserved(self.device)))
        if not self.available:
            for name in names:
                rec.set_metric(
                    name, None, quality="unavailable", reason=self.reason or "不可得"
                )
            if self.reason and "失敗" in self.reason:
                rec.measurement_error(self.reason)
            return
        rec.set_metric("torch_allocated_current_bytes", current_alloc, scope=scope)
        rec.set_metric("torch_allocated_peak_bytes", self.peak_allocated, scope=scope)
        rec.set_metric("torch_reserved_current_bytes", current_res, scope=scope)
        rec.set_metric("torch_reserved_peak_bytes", self.peak_reserved, scope=scope)


class TraceWindow:
    """trace 模式：只對指定 steps 開 torch.profiler；輸出 Chrome trace JSON 到 recording."""

    def __init__(
        self, rec: Recorder, *, name: str, max_bytes: int = 512 * 1024 * 1024
    ) -> None:
        """Initialize trace window with its configuration."""
        self.rec = rec
        self.name = name
        self.config = rec.config
        self.enabled = rec.mode == "trace"
        self.steps = {int(s) for s in self.config.get("trace_steps") or []}
        self.max_bytes = max_bytes
        self._profiler: Any = None
        self.status = "disabled" if not self.enabled else "pending"
        self.reason: str | None = None

    def wants(self, step: int | None) -> bool:
        """Check whether the configured measurement is enabled."""
        return self.enabled and (
            not self.steps or (step is not None and step in self.steps)
        )

    @contextlib.contextmanager
    def step(self, step: int) -> Iterator[None]:
        """Record a scheduler step."""
        if not self.wants(step):
            yield
            return
        started = self._start()
        try:
            yield
        finally:
            if started:
                self._stop(f"{self.name}-step{step}")

    def _start(self) -> bool:
        try:
            profiler = import_module("torch.profiler")

            activities = [profiler.ProfilerActivity.CPU]
            if _torch().cuda.is_available():
                activities.append(profiler.ProfilerActivity.CUDA)
            self._profiler = profiler.profile(
                activities=activities,
                record_shapes=bool(self.config.get("record_shapes")),
                with_stack=bool(self.config.get("with_stack")),
            )
            self._profiler.__enter__()
        except Exception as exc:  # noqa: BLE001 - Optional CUDA instrumentation must report failure without stopping the provider.
            self.status, self.reason = (
                "unavailable",
                f"{type(exc).__name__}: {exc}"[:500],
            )
            self.rec.notice(
                "TRACE_UNAVAILABLE", f"torch.profiler 無法啟動：{self.reason}"
            )
            self._profiler = None
            return False
        return True

    def _stop(self, trace_name: str) -> None:
        prof, self._profiler = self._profiler, None
        if prof is None:
            return
        try:
            prof.__exit__(None, None, None)
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "trace.json"
                prof.export_chrome_trace(str(path))
                size = path.stat().st_size
                if size > self.max_bytes:
                    self.status = "partial"
                    self.rec.notice(
                        "TRACE_TRUNCATED",
                        f"trace {trace_name} 為 {size} bytes，超過上限 {self.max_bytes}；不保存",
                    )
                    return
                with path.open(encoding="utf-8") as fh:
                    doc = json.load(fh)
            self.rec.write_trace(trace_name, doc)
            self.status = "available"
        except Exception as exc:  # noqa: BLE001 - Optional CUDA instrumentation must report failure without stopping the provider.
            self.status, self.reason = (
                "unavailable",
                f"{type(exc).__name__}: {exc}"[:500],
            )
            self.rec.notice("TRACE_UNAVAILABLE", f"trace 匯出失敗：{self.reason}")


def torch_backend_flags() -> dict[str, Any]:
    """實際 backend 旗標（觀測值，不是設定宣告）."""
    torch = _torch()
    out: dict[str, Any] = {}
    with contextlib.suppress(Exception):
        out["matmul_tf32"] = bool(torch.backends.cuda.matmul.allow_tf32)
    with contextlib.suppress(Exception):
        out["cudnn_tf32"] = bool(torch.backends.cudnn.allow_tf32)
    with contextlib.suppress(Exception):
        out["reduced_precision_reduction_fp16"] = bool(
            torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction
        )
    with contextlib.suppress(Exception):
        out["reduced_precision_reduction_bf16"] = bool(
            torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction
        )
    with contextlib.suppress(Exception):
        out["float32_matmul_precision"] = str(torch.get_float32_matmul_precision())
    return out


def runtime_identity() -> dict[str, Any]:
    """Collect the observable identity of the runtime and its device."""
    torch = _torch()
    out: dict[str, Any] = {"torch": torch.__version__}
    with contextlib.suppress(Exception):
        out["cuda"] = torch.version.cuda
    with contextlib.suppress(Exception):
        out["cudnn"] = torch.backends.cudnn.version()
    with contextlib.suppress(Exception):
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            out["device_name"] = props.name
            out["device_capability"] = f"{props.major}.{props.minor}"
            out["device_total_memory_bytes"] = int(props.total_memory)
    with contextlib.suppress(Exception):
        pynvml = import_module("pynvml")

        pynvml.nvmlInit()
        out["driver"] = pynvml.nvmlSystemGetDriverVersion()
    return out


__all__ = [
    "AllocatorWindow",
    "EventPairs",
    "TraceWindow",
    "runtime_identity",
    "stream_id",
    "torch_backend_flags",
]
