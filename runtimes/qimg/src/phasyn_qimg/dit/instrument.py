"""DiT 去噪迴圈的 recorder hooks（與 H3 ``phasyn_h3/instrument.py`` 一致的量測方式）。

- 每 step：host 時間＋compute stream 上的 CUDA event pair（只在 step 邊界非阻塞 poll，call 結束才 drain）。
- 每 block：forward pre-hook（prepend）與 forward hook 的 event 區間，彙總成 part_call（group_stream 時區間含
  等待權重與 hook 搬運，不是 kernel active time）。
- group_stream：包裝每個 ModuleGroup 的 ``onload_``，在 side stream 上記 event pair → ``weight_h2d`` 完成量。
- 計數：scheduler_steps_completed、denoiser_forwards_completed、cfg_branch_forward_count（uncond 分支）、
  block_forward_count、block_load_count；``qimg.dit.step_ms``（每步 host 平均，count＝步數）。
- steps ≠ NFE ≠ module forward 次數；只回報實際觀測到的計數。
"""

from __future__ import annotations

import collections
import contextlib
import functools
import time
from collections.abc import Callable
from typing import Any

from phasyn_components import upstream
from phasyn_components.recorder import Recorder

# diffusers ModuleGroup attributes the block-transfer measurement relies on (pinned build; checked per group)
GROUP_ATTRS = ("onload_", "modules", "parameters", "stream", "group_id")


class DitObserver:
    """實作 driver.StepObserver：取消檢查、step 計時、預覽送出。"""

    def __init__(
        self,
        rec: Recorder,
        *,
        check_cancelled: Callable[[], None],
        sigmas: list[float],
        cfg: bool,
        device: Any,
        preview_due: Callable[[int], bool] | None = None,
        preview_submit: Callable[[Any, int], None] | None = None,
    ) -> None:
        from phasyn_components.recorder.gpu import EventPairs, TraceWindow

        cfg_rec = rec.config
        on_cuda = getattr(device, "type", None) == "cuda"
        self.rec = rec
        self.cfg = cfg
        self._check = check_cancelled
        self.sigmas = sigmas
        self.gpu = on_cuda and bool(cfg_rec.get("gpu_event_timing", True)) and rec.mode != "off"
        self.pairs = EventPairs(max_pending=int(cfg_rec.get("cuda_pending_event_pairs", 4096)), enabled=self.gpu)
        self.trace = TraceWindow(rec, name="qimg-dit-denoise") if on_cuda else None
        self._preview_due = preview_due
        self._preview_submit = preview_submit
        self.rows: dict[int, dict[str, Any]] = {}
        self.forwards = 0
        self.uncond_forwards = 0
        self.current_step: int | None = None
        self._t0 = 0
        self._start: Any = None
        self._trace_scope: Any = None
        self.blocks: dict[str, dict[str, Any]] = collections.defaultdict(
            lambda: {"forwards": 0, "host_ms": 0.0, "gpu_ms": 0.0, "gpu_missing": 0}
        )
        self.handles: list[Any] = []
        self.patched: list[tuple[Any, Any]] = []
        self.preview_ms = 0.0

    # ------------------------------------------------------------------ StepObserver
    def check_cancelled(self) -> None:
        self._check()

    def step_start(self, index: int) -> None:
        self.current_step = index
        self._t0 = time.perf_counter_ns()
        self._start = self.pairs.record()
        if self.trace is not None and self.trace.wants(index):
            self._trace_scope = self.trace.step(index)
            self._trace_scope.__enter__()

    def forward_done(self, index: int, branch: str) -> None:
        self.forwards += 1
        if branch == "uncond":
            self.uncond_forwards += 1

    def step_end(self, index: int, *, sigma: float, forwards: int) -> None:
        end = self.pairs.record()
        if self._trace_scope is not None:
            with contextlib.suppress(Exception):
                self._trace_scope.__exit__(None, None, None)
            self._trace_scope = None
        host_ms = (time.perf_counter_ns() - self._t0) / 1e6
        row = {"host_ms": host_ms, "gpu_ms": None, "sigma": sigma, "forwards": forwards}
        self.rows[index] = row
        self.pairs.pair(self._start, end, functools.partial(row.__setitem__, "gpu_ms"))
        self.pairs.poll()

    def wants_preview(self, index: int) -> bool:
        return self._preview_due is not None and self._preview_submit is not None and self._preview_due(index + 1)

    def preview(self, index: int, x0: Callable[[], Any]) -> None:
        if self._preview_submit is None:
            return
        t0 = time.perf_counter()
        try:
            self._preview_submit(x0(), index + 1)
        finally:
            self.preview_ms += (time.perf_counter() - t0) * 1000

    # ------------------------------------------------------------------ block hooks
    @contextlib.contextmanager
    def attach(self, transformer: Any, groups: list[Any] | None = None) -> Any:
        try:
            self._install(transformer, groups or [])
            yield self
        finally:
            self._uninstall()

    def _install(self, transformer: Any, groups: list[Any]) -> None:
        self.rec.declare(
            "scheduler_steps_completed",
            "denoiser_forwards_completed",
            "cfg_branch_forward_count",
            "block_forward_count",
        )
        for idx, block in enumerate(getattr(transformer, "transformer_blocks", [])):
            part = f"transformer.transformer_blocks.{idx}"
            self.handles.append(block.register_forward_pre_hook(self._make_pre(), prepend=True))
            self.handles.append(block.register_forward_hook(self._make_post(part)))
        if groups:
            self.rec.declare("block_load_count")
            for group in groups:
                self._wrap_group(group)

    def _uninstall(self) -> None:
        for handle in self.handles:
            with contextlib.suppress(Exception):
                handle.remove()
        self.handles.clear()
        for group, original in reversed(self.patched):
            with contextlib.suppress(Exception):
                if original is None:
                    delattr(group, "onload_")
                else:
                    group.onload_ = original
        self.patched.clear()

    def _make_pre(self) -> Any:
        def hook(module: Any, _args: Any) -> None:
            module._phasyn_qimg_state = {"t0": time.perf_counter_ns(), "a": self.pairs.record()}

        return hook

    def _make_post(self, part: str) -> Any:
        def hook(module: Any, _args: Any, _out: Any) -> None:
            state = getattr(module, "_phasyn_qimg_state", None)
            if state is None:
                return
            module._phasyn_qimg_state = None
            end = self.pairs.record()
            agg = self.blocks[part]
            agg["forwards"] += 1
            agg["host_ms"] += (time.perf_counter_ns() - state["t0"]) / 1e6

            def done(ms: float | None, a: dict[str, Any] = agg) -> None:
                if ms is None:
                    a["gpu_missing"] += 1
                else:
                    a["gpu_ms"] += ms

            self.pairs.pair(state["a"], end, done)

        return hook

    def _transfer_done(self, transfer_id: str, nbytes: int, gpu_ms: float | None) -> None:
        self.rec.transfer_completed(transfer_id, completed_bytes=nbytes, gpu_event_ms=gpu_ms)

    def _wrap_group(self, group: Any) -> None:
        missing = upstream.missing_attrs(group, GROUP_ATTRS)
        if missing:  # measurement only: degrade explicitly instead of failing the call or recording zeros
            self.rec.note(
                f"group offload 的 ModuleGroup 缺少 {', '.join(missing)}（diffusers 介面與釘版不同）；這個 group 不量測搬運"
            )
            return
        original_bound = group.onload_
        had_instance = "onload_" in vars(group)
        stream = group.stream
        params = [p for m in group.modules for p in m.parameters()] + list(group.parameters or [])
        nbytes = sum(int(p.numel() * p.element_size()) for p in params)
        name = str(group.group_id or "group")

        def onload_() -> Any:
            start = self.pairs.record(stream) if stream is not None else None
            t0 = time.perf_counter()
            result = original_bound()
            submit_ms = (time.perf_counter() - t0) * 1000
            end = self.pairs.record(stream) if stream is not None else None
            if stream is None:
                # unmatched group：同步 .to(device)，host 時間即完成時間
                self.rec.transfer(
                    "weight_h2d",
                    direction="H2D",
                    submitted_bytes=nbytes,
                    part=f"transformer.{name}",
                    step_index=self.current_step,
                    host_ms=submit_ms,
                    src="host",
                    dst="device",
                    src_memory_kind="pageable",
                    dst_memory_kind="device",
                )
            else:
                tid = self.rec.transfer(
                    "weight_h2d",
                    direction="H2D",
                    submitted_bytes=nbytes,
                    completion_status="submitted",
                    part=f"transformer.{name}",
                    step_index=self.current_step,
                    host_submit_ms=submit_ms,
                    src="pinned_host",
                    dst="device",
                    src_memory_kind="pinned",
                    dst_memory_kind="device",
                )
                self.pairs.pair(start, end, functools.partial(self._transfer_done, tid, nbytes))
            self.rec.count("block_load_count", part=f"transformer.{name}")
            return result

        group.onload_ = onload_
        self.patched.append((group, original_bound if had_instance else None))

    # ------------------------------------------------------------------ finish
    def finish(self, *, completed: bool) -> dict[str, Any]:
        """call 結束邊界：drain event（結果本來就必須完成）、寫 step／part／counter／metric。"""
        self.pairs.drain(wait=True)
        rec = self.rec
        host = []
        for step in sorted(self.rows):
            row = self.rows[step]
            host.append(row["host_ms"])
            rec.step(
                step,
                host_ms=row["host_ms"],
                gpu_event_ms=row["gpu_ms"],
                scheduler_update_index=step,
                forward_index=row["forwards"],
                cfg_branch="cond+uncond（CFG）" if self.cfg else "cond（無 CFG）",
                sigma=row["sigma"],
            )
        rec.count("scheduler_steps_completed", len(self.rows))
        rec.count("denoiser_forwards_completed", self.forwards)
        rec.count("cfg_branch_forward_count", self.uncond_forwards)
        total_blocks = 0
        for part, agg in sorted(self.blocks.items()):
            total_blocks += agg["forwards"]
            gpu = None if agg["gpu_missing"] else agg["gpu_ms"]
            rec.part_call(part, host_ms=agg["host_ms"], gpu_event_ms=gpu, calls=agg["forwards"])
        rec.count("block_forward_count", total_blocks)
        if host:
            rec.set_metric(
                "qimg.dit.step_ms",
                sum(host) / len(host),
                unit="ms",
                quality="derived",
                scope="component_call_steps_mean",
                method="host_monotonic（每步含 forward 與 Euler 更新；GPU 非同步時為提交時間）",
                count=len(host),
            )
            gpu_values = [self.rows[s]["gpu_ms"] for s in sorted(self.rows)]
            if all(v is not None for v in gpu_values):
                rec.set_metric(
                    "qimg.dit.step_gpu_ms",
                    sum(gpu_values) / len(gpu_values),
                    unit="ms",
                    quality="derived",
                    scope="device_stream_interval_mean",
                    method="cuda_event",
                    count=len(gpu_values),
                )
            else:
                rec.set_metric(
                    "qimg.dit.step_gpu_ms",
                    None,
                    quality="unavailable",
                    reason="CPU 裝置或部分 CUDA event 未解",
                    unit="ms",
                )
        else:
            rec.set_metric("qimg.dit.step_ms", None, quality="unavailable", reason="沒有完成任何 step", unit="ms")
        if self.pairs.dropped:
            rec.notice(
                "DETAIL_TRUNCATED",
                f"CUDA event pair 達上限 {self.pairs.max_pending}，{self.pairs.dropped} 個區間未記錄",
                dropped_events=self.pairs.dropped,
            )
            rec.set_coverage("partial", "部分 CUDA event 區間因待解上限未記錄")
        if not self.gpu:
            rec.note("沒有 CUDA event（CPU 裝置或 gpu_event_timing 關閉）：只有 host 時間")
        rec.note("block 時間為 compute stream 上的 CUDA event 區間（含等待與空隙），不是 kernel active time")
        if self.trace is not None and self.trace.enabled:
            rec.note(f"trace 狀態：{self.trace.status}{'（' + self.trace.reason + '）' if self.trace.reason else ''}")
        if not completed:
            rec.note(f"去噪未完成：完成 {len(self.rows)} 步")
        return {"steps_completed": len(self.rows), "forwards": self.forwards, "preview_main_thread_ms": self.preview_ms}


__all__ = ["DitObserver"]
