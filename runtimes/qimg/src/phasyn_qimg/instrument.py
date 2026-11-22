"""phasyn_qimg 的 recorder hooks 與權重駐留（與 H3 ``phasyn_h3.instrument`` 相同的量測原則）.

- stage：host span+compute stream 上的 CUDA event pair（只在結果本來就要回到 CPU 的邊界解 event；
  不做 device-wide synchronize）。event 區間是 stream 上的時間，不是 kernel active time。
- 每次 call 的 allocator 峰值（``AllocatorWindow``：allocated 與 reserved 分開，不相加）。
- 權重搬移（after_use=host）：H2D 以 copy 前後的 event pair 計時，記 ``weight_h2d`` transfer；
  用完只把參數指回既有的 host 副本（權重不變，沒有 D2H），記 ``device_discard_count``。
- 未知的量測值一律 null+原因，不補 0。
"""

from __future__ import annotations

import contextlib
import time
import traceback
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from phasyn_components.errors import exception_message, gpu_memory_insufficient
from phasyn_components.recorder import Recorder

from .config import GIB
from .memory import format_gib


# Library workspaces (cuBLAS keeps one per handle and stream from its first use until the process exits) can leave a
# failed first call slightly above its starting allocation without holding any of the call's tensors. Policy
# threshold for judging the cleanup, not a measurement; it is reported with every cleanup report.
FAILURE_RETAINED_TOLERANCE_BYTES = 64 * 1024 * 1024


def _gpu_timing_enabled(rec: Recorder) -> bool:
    return bool(rec.config.get("gpu_event_timing", True)) and rec.mode != "off"


@contextlib.contextmanager
def timed_stage(
    rec: Recorder, name: str, *, part: str | None, cuda: bool
) -> Iterator[Any]:
    """一段 stage：recorder span（host 時間）+ CUDA event 區間（cuda=True 且啟用 gpu_event_timing 時）.

    呼叫端在 with 區塊內把結果搬回 CPU（同步點），所以離開時 event 已完成；未完成或失敗 → null+原因。
    """
    pairs = None
    start = None
    if cuda:
        from phasyn_components.recorder.gpu import EventPairs

        pairs = EventPairs(max_pending=4, enabled=_gpu_timing_enabled(rec))
    with rec.span(name, part=part) as span:
        if pairs is not None:
            with contextlib.suppress(Exception):
                start = pairs.record()
        failed = True
        try:
            yield span
            failed = False
        finally:
            if pairs is not None and not failed:
                result: dict[str, float | None] = {}
                try:
                    end = pairs.record()
                    pairs.pair(start, end, lambda ms: result.__setitem__("ms", ms))
                    pairs.drain(wait=True)
                except Exception as exc:  # noqa: BLE001 - Optional instrumentation failures must not change generation.
                    rec.measurement_error(
                        f"{name} CUDA event：{type(exc).__name__}: {exc}"[:300]
                    )
                ms = result.get("ms")
                span.set_gpu(
                    ms,
                    device_id=None,
                    stream_id=None,
                    reason=None
                    if ms is not None
                    else "CUDA event 未記錄（gpu_event_timing 停用或事件失敗）",
                )


def allocator_window(cuda: bool) -> Any:  # noqa: FBT001 - Keep the published runtime API.
    """CUDA 元件的 allocator 視窗（start 已呼叫）；CPU 元件回傳 None."""
    if not cuda:
        return None
    from phasyn_components.recorder.gpu import AllocatorWindow

    window = AllocatorWindow(0)
    window.start()
    return window


def finish_allocator(rec: Recorder, window: Any, *, scope: str, cuda: bool) -> None:
    """Finish allocator measurements for the call."""
    if window is not None:
        window.finish(rec, scope=scope)
        return
    if not cuda:
        for name in (
            "torch_allocated_peak_bytes",
            "torch_reserved_peak_bytes",
        ):
            rec.set_metric(
                name,
                None,
                quality="not_applicable",
                reason="CPU 元件沒有 CUDA allocator",
            )


def drop_frame_locals(exc: BaseException) -> None:
    """Clear the locals of finished frames in the traceback of a failure.

    While an exception propagates, every frame (decode, forward, hooks…) keeps its device tensors alive, so
    ``empty_cache`` cannot release anything: after a VAE decode OOM the process would keep holding the
    activation memory until the next successful call. Only locals are cleared (file names, line numbers and
    messages are kept); frames still executing are skipped by ``traceback.clear_frames``.
    """
    traceback.clear_frames(exc.__traceback__)


def release_cuda_cache(device: Any) -> None:
    """Return the caching allocator's idle blocks to the driver at the end of a call.

    Each component is its own process: unreleased blocks (TE activations, DiT KV cache and streamed weights, VAE
    decode scratch) stay attributed to this process, leaving the next step on the same GPU with less memory —
    in practice several GiB, enough to make the next VAE decode or TE call OOM or a phase admission fail.
    """
    import torch

    if getattr(device, "type", None) != "cuda":
        return
    with contextlib.suppress(Exception), torch.cuda.device(device):
        torch.cuda.synchronize()
        torch.cuda.empty_cache()


def record_after_release(rec: Any, device: Any) -> None:
    """Measure reserved memory again after ``release_cuda_cache``.

    ``allocator.finish`` records torch_reserved_current_bytes *before* the release, so without this second
    reading a record cannot show whether the release worked (the recorded value can be GiBs while the driver
    already reports a few hundred MiB for the process). A failed reading is a measurement_error, never a guess.
    """
    if getattr(device, "type", None) != "cuda":
        return
    try:
        import torch

        reserved = int(torch.cuda.memory_reserved(device))
    except Exception as exc:  # noqa: BLE001 - Optional instrumentation failures must not change generation.
        rec.measurement_error(
            f"釋放後 reserved 量測失敗：{type(exc).__name__}: {exc}"[:300]
        )
        return
    rec.set_metric(
        "qimg.torch_reserved_after_release_bytes",
        reserved,
        unit="bytes",
        scope="component_call",
        method="runtime_hook",
    )


@dataclass(frozen=True)
class CallMemory:
    """The caching allocator's reading when a call starts its GPU work, kept for ``after_failure``.

    After a failed call the runtime host clears every frame of the call and then runs the provider's
    ``after_failure``; once the provider has dropped the per-call state it keeps itself, :meth:`settle` releases the
    cache and compares what is still allocated with this reading. Every qimg GPU provider resets it at the start of
    ``invoke``, so a failure before any GPU work has no reading and nothing to compare.
    """

    device: Any
    allocated_before: int | None
    reason: str | None = None  # why allocated_before is unknown

    @classmethod
    def start(cls, device: Any, window: Any) -> CallMemory | None:
        """From an allocator window that was just started (None: a CPU call, nothing to check)."""
        if window is None:
            return None
        return cls(
            device,
            getattr(window, "start_allocated", None),
            getattr(window, "reason", None),
        )

    def settle(self, code: str) -> dict[str, Any] | None:
        """Release the cached blocks and check whether the process is back at its allocation before the call.

        Returns the report for the runtime host (it becomes ``Error.details.cleanup``) after a ``GPU_OOM``, or after
        any failure that leaves the state unproven: more than ``FAILURE_RETAINED_TOLERANCE_BYTES`` still allocated, or
        no reading. Then ``reload_required`` is true and ``reason`` tells the user to reload the component; the
        component stays usable, nothing is retried. A clean failure with another code returns None.
        """
        report: dict[str, Any] = {
            "allocated_before_bytes": self.allocated_before,
            "allocated_after_bytes": None,
            "reserved_after_bytes": None,
            "retained_bytes": None,
            "tolerance_bytes": FAILURE_RETAINED_TOLERANCE_BYTES,
            "reload_required": True,
            "reason": None,
        }
        try:
            import torch

            with torch.cuda.device(self.device):
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
            allocated = int(torch.cuda.memory_allocated(self.device))
            reserved = int(torch.cuda.memory_reserved(self.device))
        except Exception as exc:  # noqa: BLE001 - Optional instrumentation failures must not change generation.
            report["reason"] = (
                f"失敗後無法量測 GPU 記憶體（{type(exc).__name__}: {exception_message(exc)[:200]}），"
                "不能確認已釋放；請重新載入元件"
            )
            return report
        report["allocated_after_bytes"] = allocated
        report["reserved_after_bytes"] = reserved
        if self.allocated_before is None:
            report["reason"] = (
                f"呼叫開始時量不到 GPU 記憶體用量（{self.reason or '原因不明'}），"
                f"不能確認失敗後已釋放（清理後仍配置 {format_gib(allocated)}）；請重新載入元件"
            )
            return report
        retained = max(0, allocated - self.allocated_before)
        report["retained_bytes"] = retained
        report["reload_required"] = retained > FAILURE_RETAINED_TOLERANCE_BYTES
        if report["reload_required"]:
            report["reason"] = (
                f"失敗後元件仍佔用 {format_gib(retained)} GPU 記憶體（呼叫開始 {format_gib(self.allocated_before)}、"
                f"清理後 {format_gib(allocated)}）；需要重新載入元件才能釋放"
            )
            return report
        return report if code == "GPU_OOM" else None


def module_bytes(module: Any) -> int:
    """參數+buffer 的實際 storage bytes（共用的 tensor 只算一次；meta tensor 不算）."""
    seen: set[int] = set()
    total = 0
    for tensor in (*module.parameters(), *module.buffers()):
        if id(tensor) in seen or tensor.device.type == "meta":
            continue
        seen.add(id(tensor))
        total += int(tensor.numel()) * int(tensor.element_size())
    return total


def dtype_census(module: Any) -> dict[str, int]:
    """Count model parameters by dtype."""
    out: dict[str, int] = {}
    for p in module.parameters():
        out[str(p.dtype)] = out.get(str(p.dtype), 0) + int(p.numel())
    return out


def check_vram(device: Any, required: int, *, what: str, hint: str) -> dict[str, int]:
    """Pre-check that the weights alone fit in free GPU memory (necessary, not sufficient: activations come on top).

    Too little → GPU_MEMORY_INSUFFICIENT before anything moves.
    """
    import torch

    with torch.cuda.device(device):
        torch.cuda.empty_cache()
    free, total = torch.cuda.mem_get_info(device)
    if free < required:
        raise gpu_memory_insufficient(
            f"{what}：GPU 可用記憶體 {free / GIB:.2f} GiB 小於權重 {required / GIB:.2f} GiB；{hint}",
            details={
                "gpu_free_bytes": int(free),
                "gpu_total_bytes": int(total),
                "weight_bytes": int(required),
            },
        )
    return {"gpu_free_bytes": int(free), "gpu_total_bytes": int(total)}


class HostResidency:
    """offload {mode: none, after_use: host}：權重常駐 host（可 pinned），每次呼叫搬上裝置、用完丟掉裝置副本.

    host 副本在建構時建立一次；之後 ``to_device`` 只做 H2D，``release`` 把參數指回 host 副本並清掉裝置
    cache（權重沒有被修改，不需要 D2H）。
    """

    def __init__(self, module: Any, *, device: Any, pinned: bool) -> None:
        """Initialize the state for this operation."""
        import torch

        self.torch = torch
        self.module = module
        self.device = torch.device(device)
        self.pinned = pinned
        self.on_device = False
        self._host: dict[int, Any] = {}
        self.weight_bytes = 0
        for tensor in self._tensors():
            host = tensor.detach().to("cpu")
            if pinned:
                host = host.pin_memory()
            tensor.data = host
            self._host[id(tensor)] = host
            self.weight_bytes += int(host.numel()) * int(host.element_size())

    def _tensors(self) -> list[Any]:
        seen: set[int] = set()
        out = []
        for tensor in (*self.module.parameters(), *self.module.buffers()):
            if id(tensor) not in seen:
                seen.add(id(tensor))
                out.append(tensor)
        return out

    def to_device(self, rec: Recorder, *, part: str, what: str) -> None:
        """Transfer the block to the configured device."""
        if self.on_device:
            rec.transfer(
                "weight_h2d",
                direction="H2D",
                submitted_bytes=0,
                part=part,
                actual_copy=False,
                reason="權重已在裝置上",
            )
            return
        cuda = self.device.type == "cuda"
        if cuda:
            check_vram(
                self.device,
                self.weight_bytes,
                what=what,
                hint="請改用較小的設定或先停止同一張卡上的其他元件",
            )
        torch = self.torch
        from phasyn_components.recorder.gpu import EventPairs

        pairs = EventPairs(max_pending=2, enabled=cuda and _gpu_timing_enabled(rec))
        start = pairs.record()
        t0 = time.perf_counter_ns()
        for tensor in self._tensors():
            tensor.data = self._host[id(tensor)].to(
                self.device, non_blocking=self.pinned
            )
        submit_ms = (time.perf_counter_ns() - t0) / 1e6
        end = pairs.record()
        result: dict[str, float | None] = {}
        pairs.pair(start, end, lambda ms: result.__setitem__("ms", ms))
        if cuda:
            torch.cuda.current_stream(
                self.device
            ).synchronize()  # 權重必須在 forward 前到位（本來就要等）
        pairs.drain(wait=False)
        self.on_device = True
        rec.transfer(
            "weight_h2d",
            direction="H2D",
            submitted_bytes=self.weight_bytes,
            part=part,
            host_ms=(time.perf_counter_ns() - t0) / 1e6,
            host_submit_ms=submit_ms,
            gpu_event_ms=result.get("ms"),
            src="pinned_host" if self.pinned else "pageable_host",
            dst="device",
            src_memory_kind="pinned" if self.pinned else "host",
            dst_memory_kind="device",
        )

    def release(self, rec: Recorder, *, part: str) -> None:
        """Release the owned buffers and placement state."""
        if not self.on_device:
            return
        self.restore()
        if self.device.type == "cuda":
            with self.torch.cuda.device(self.device):
                self.torch.cuda.empty_cache()
        rec.count(
            "device_discard_count", part=part
        )  # 丟棄裝置副本；host 權重沒變，沒有 D2H

    def restore(self) -> None:
        """把參數指回 host 副本（失敗後的清理也用這個；不需要 recorder）."""
        for tensor in self._tensors():
            tensor.data = self._host[id(tensor)]
        self.on_device = False


__all__ = [
    "FAILURE_RETAINED_TOLERANCE_BYTES",
    "CallMemory",
    "HostResidency",
    "allocator_window",
    "check_vram",
    "drop_frame_locals",
    "dtype_census",
    "finish_allocator",
    "module_bytes",
    "record_after_release",
    "release_cuda_cache",
    "timed_stage",
]
