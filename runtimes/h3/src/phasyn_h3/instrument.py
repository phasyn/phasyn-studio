"""DiT 去噪迴圈的 recorder hooks。

- 每 step：在 loop 傳入的 step_profiler 位置記 host 時間與 compute stream 上的 CUDA event pair。
- 每 block：forward pre-hook（prepend，於 layerwise 管理器等待 prefetch 之前）、一般 pre-hook（等待之後）、
  forward hook 三個 event：(B−A)=compute stream 等權重的時間，(C−B)=block compute 區間。只在
  step 邊界非阻塞 poll；迴圈結束後（recipe 本來就同步）才解剩下的 event。
- 逐層串流的 H2D：包裝 layerwise 管理器的 prefetch_layer／release_layer；bytes 取自管理器持有的
  host 權重表，copy stream 上的 event pair 決定完成；courier（mapped）路徑只能記 submitted。
- steps≠NFE≠module forward 次數≠kernel 數：只回報實際觀測到的計數；kernel 數只來自 trace。
"""

from __future__ import annotations

import collections
import contextlib
import time
from collections.abc import Iterator
from typing import Any

from phasyn_components.recorder import Recorder
from phasyn_components.recorder.gpu import EventPairs, TraceWindow


def _layer_bytes(mgr: Any, idx: int) -> int:
    total = 0
    for table in ("_consolidated_cpu_weights", "_strided_cpu_weights", "_mapped_cpu_weights"):
        entry = (getattr(mgr, table, None) or {}).get(idx) or {}
        for tensor in entry.values():
            with contextlib.suppress(Exception):
                total += int(tensor.numel()) * int(tensor.element_size())
    return total


class DitInstrumentation:
    def __init__(self, rec: Recorder, *, sigmas: list[float] | None = None) -> None:
        import torch

        self.torch = torch
        self.rec = rec
        cfg = rec.config
        self.gpu = torch.cuda.is_available() and bool(cfg.get("gpu_event_timing", True)) and rec.mode != "off"
        self.pairs = EventPairs(max_pending=int(cfg.get("cuda_pending_event_pairs", 4096)), enabled=self.gpu)
        self.trace = TraceWindow(rec, name="dit-denoise")
        self.sigmas = sigmas or []
        self.block_spans = rec.detailed and (bool(cfg.get("parts")) or rec.mode == "trace")
        self.current_step: int | None = None
        self.step_rows: dict[int, dict[str, Any]] = {}
        self.blocks: dict[str, dict[str, Any]] = collections.defaultdict(
            lambda: {"forwards": 0, "host_ms": 0.0, "gpu_ms": 0.0, "gpu_missing": 0, "wait_ms": 0.0, "wait_missing": 0}
        )
        self.forwards = 0
        self.forwards_in_step: dict[int, int] = collections.Counter()
        self.handles: list[Any] = []
        self.patched: list[tuple[Any, str, Any]] = []
        self.managers: dict[str, Any] = {}
        self.courier_submits = 0
        self.attached = False

    # ------------------------------------------------------------------ step profiler
    def wrap_step_profiler(self, original: Any) -> Any:
        """Wrap the denoise loop's step profiler (``dit_trace.wrapped_step_profiler`` hands it in)."""

        def step_profiler() -> Any:
            inner = original() if callable(original) else None

            @contextlib.contextmanager
            def profile(step: int) -> Iterator[None]:
                self.current_step = step
                t0 = time.perf_counter_ns()
                start = self.pairs.record()
                with self.trace.step(step), inner(step) if inner is not None else contextlib.nullcontext():
                    yield
                end = self.pairs.record()
                host_ms = (time.perf_counter_ns() - t0) / 1e6
                row = self.step_rows.setdefault(step, {"host_ms": host_ms, "gpu_ms": None})
                row["host_ms"] = host_ms
                self.pairs.pair(start, end, lambda ms, r=row: r.__setitem__("gpu_ms", ms))
                self.pairs.poll()

            return profile

        return step_profiler

    # ------------------------------------------------------------------ install
    @contextlib.contextmanager
    def attach(self, module: Any, *, manager_attrs: tuple[str, ...] = ()) -> Iterator[None]:
        """Hook one use of the DiT; ``manager_attrs`` are the private layerwise-manager fields the hooks
        read (the host passes the pinned list), checked before any manager is wrapped."""
        try:
            self._install(module, manager_attrs)
            yield
        finally:
            self._uninstall()
            self._finish()

    def _install(self, model: Any, manager_attrs: tuple[str, ...]) -> None:
        self.handles.append(model.register_forward_hook(self._model_forward_hook))
        managers = self._usable_managers(getattr(model, "layerwise_offload_managers", None) or [], manager_attrs)
        self.managers = managers
        for attr in ("blocks", "token_refiner.blocks"):
            layers = self._get_attr(model, attr)
            if layers is None:
                continue
            mgr = managers.get(attr)
            for idx, layer in enumerate(layers):
                part = f"transformer.{attr}.{idx}"
                self.handles.append(layer.register_forward_pre_hook(self._make_pre_first(part, mgr, idx), prepend=True))
                self.handles.append(layer.register_forward_pre_hook(self._make_pre_last(part)))
                self.handles.append(layer.register_forward_hook(self._make_post(part)))
        for attr, mgr in managers.items():
            self._wrap_manager(f"transformer.{attr}", mgr)
        self.rec.declare("scheduler_steps_completed", "denoiser_forwards_completed", "block_forward_count")
        if managers:
            self.rec.declare(
                "block_load_count",
                "device_discard_count",
                "offload_cycle_count",
                "prefetch_hit_count",
                "prefetch_miss_count",
                "resident_hit_count",
            )
            self.rec.declare("weight_d2h_submitted_count")  # 逐層串流丟棄 GPU 副本，不回寫 host
        self.attached = True

    def _usable_managers(self, found: list[Any], manager_attrs: tuple[str, ...]) -> dict[str, Any]:
        """Layerwise managers that still have the private SGLang fields the hooks read.

        A manager without them is not hooked: its weight-streaming counts would silently read 0, so
        the recording says that coverage is partial instead."""
        from phasyn_components.upstream import missing_attrs

        usable: dict[str, Any] = {}
        for mgr in found:
            name = str(getattr(mgr, "layers_attr_str", "") or "?")
            missing = missing_attrs(mgr, manager_attrs)
            if missing:
                reason = f"逐層 offload 管理器 {name} 缺少釘版 SGLang 的 {', '.join(missing)}；不記它的權重串流計數"
                self.rec.set_coverage("partial", reason)
                self.rec.note(reason)
            else:
                usable[name] = mgr
        return usable

    @staticmethod
    def _get_attr(model: Any, dotted: str) -> Any:
        cur = model
        for name in dotted.split("."):
            cur = getattr(cur, name, None)
            if cur is None:
                return None
        return cur

    def _uninstall(self) -> None:
        for handle in self.handles:
            with contextlib.suppress(Exception):
                handle.remove()
        self.handles.clear()
        for owner, name, original in reversed(self.patched):
            with contextlib.suppress(Exception):
                if name.startswith("instance:"):
                    delattr(owner, name.split(":", 1)[1])
                else:
                    setattr(owner, name, original)
        self.patched.clear()

    # ------------------------------------------------------------------ hooks
    def _model_forward_hook(self, _module: Any, _args: Any, _out: Any) -> None:
        self.forwards += 1
        if self.current_step is not None:
            self.forwards_in_step[self.current_step] += 1

    def _make_pre_first(self, part: str, mgr: Any, idx: int) -> Any:
        def hook(module: Any, _args: Any) -> None:
            if mgr is not None:
                if idx in getattr(mgr, "_resident_set", ()):
                    self.rec.count("resident_hit_count", part=part)
                elif idx in getattr(mgr, "_gpu_layers", ()):
                    self.rec.count("prefetch_hit_count", part=part)
                else:
                    self.rec.count("prefetch_miss_count", part=part)
            module._phasyn_state = {"t0": time.perf_counter_ns(), "a": self.pairs.record(), "b": None}

        return hook

    def _make_pre_last(self, part: str) -> Any:
        def hook(module: Any, _args: Any) -> None:
            state = getattr(module, "_phasyn_state", None)
            if state is not None:
                state["b"] = self.pairs.record()

        return hook

    def _make_post(self, part: str) -> Any:
        def hook(module: Any, _args: Any, _out: Any) -> None:
            state = getattr(module, "_phasyn_state", None)
            if state is None:
                return
            c = self.pairs.record()
            host_ms = (time.perf_counter_ns() - state["t0"]) / 1e6
            agg = self.blocks[part]
            agg["forwards"] += 1
            agg["host_ms"] += host_ms
            step = self.current_step

            def wait_cb(ms: float | None, a: dict[str, Any] = agg) -> None:
                if ms is None:
                    a["wait_missing"] += 1
                else:
                    a["wait_ms"] += ms

            def compute_cb(ms: float | None, a: dict[str, Any] = agg, h: float = host_ms, s: int | None = step) -> None:
                if ms is None:
                    a["gpu_missing"] += 1
                else:
                    a["gpu_ms"] += ms
                if self.block_spans and self.rec.part_selected(part) and self.rec.step_selected(s):
                    now = time.monotonic_ns()
                    self.rec.add_span(
                        "dit.block",
                        start_ns=now - int(h * 1e6),
                        end_ns=now,
                        part=part,
                        step_index=s,
                        gpu_event_ms=ms,
                        reason=None if ms is not None else "CUDA event 未解（佇列已滿或失敗）",
                    )

            self.pairs.pair(state["a"], state["b"], wait_cb)
            self.pairs.pair(state["b"], c, compute_cb)
            module._phasyn_state = None

        return hook

    def _wrap_manager(self, prefix: str, mgr: Any) -> None:
        orig_prefetch = mgr.prefetch_layer
        orig_release = mgr.release_layer
        stream = getattr(mgr, "copy_stream", None)
        loaded: set[int] = set()

        def prefetch_layer(layer_idx: int, non_blocking: bool = True) -> Any:
            gpu_layers: set[int] = mgr._gpu_layers  # present: checked by _usable_managers
            inflight: set[int] = mgr._courier_inflight
            if layer_idx in gpu_layers or layer_idx in inflight:
                return orig_prefetch(layer_idx, non_blocking=non_blocking)
            nbytes = _layer_bytes(mgr, layer_idx)
            start = self.pairs.record(stream) if stream is not None else None
            t0 = time.perf_counter_ns()
            result = orig_prefetch(layer_idx, non_blocking=non_blocking)
            submit_ms = (time.perf_counter_ns() - t0) / 1e6
            part = f"{prefix}.{layer_idx}"
            if layer_idx in getattr(mgr, "_courier_inflight", set()):
                self.courier_submits += 1
                self.rec.transfer(
                    "weight_h2d",
                    direction="H2D",
                    submitted_bytes=nbytes,
                    completion_status="submitted",
                    part=part,
                    step_index=self.current_step,
                    host_submit_ms=submit_ms,
                    src="mapped_file",
                    dst="device",
                    src_memory_kind="mapped",
                    dst_memory_kind="device",
                    reason="mapped courier 路徑在背景執行緒完成，無完成事件可對應",
                )
                self.rec.count("block_load_count", part=part)
                loaded.add(layer_idx)
            elif layer_idx in getattr(mgr, "_gpu_layers", set()) and nbytes:
                end = self.pairs.record(stream) if stream is not None else None
                tid = self.rec.transfer(
                    "weight_h2d",
                    direction="H2D",
                    submitted_bytes=nbytes,
                    completion_status="submitted",
                    part=part,
                    step_index=self.current_step,
                    host_submit_ms=submit_ms,
                    src="pinned_host",
                    dst="device",
                    src_memory_kind="pinned",
                    dst_memory_kind="device",
                )
                self.pairs.pair(
                    start,
                    end,
                    lambda ms, t=tid, n=nbytes: self.rec.transfer_completed(t, completed_bytes=n, gpu_event_ms=ms),
                )
                self.rec.count("block_load_count", part=part)
                loaded.add(layer_idx)
            return result

        def release_layer(layer_idx: int, force: bool = False) -> Any:
            was = layer_idx in getattr(mgr, "_gpu_layers", set())
            result = orig_release(layer_idx, force=force)
            if was and layer_idx not in getattr(mgr, "_gpu_layers", set()):
                part = f"{prefix}.{layer_idx}"
                self.rec.count("device_discard_count", part=part)  # GPU 副本丟棄；host 原權重仍在，沒有 D2H
                if layer_idx in loaded:
                    self.rec.count("offload_cycle_count", part=part)
                    loaded.discard(layer_idx)
            return result

        mgr.prefetch_layer = prefetch_layer
        mgr.release_layer = release_layer
        self.patched.append((mgr, "instance:prefetch_layer", None))
        self.patched.append((mgr, "instance:release_layer", None))

    # ------------------------------------------------------------------ finish
    def _finish(self) -> None:
        if not self.attached:
            return
        self.pairs.drain(wait=True)  # recipe 已在迴圈後同步；這裡不另做 device-wide sync
        rec = self.rec
        for step in sorted(self.step_rows):
            row = self.step_rows[step]
            sigma = self.sigmas[step] if step < len(self.sigmas) else None
            forwards = self.forwards_in_step.get(step, 0)
            rec.step(
                step,
                host_ms=row["host_ms"],
                gpu_event_ms=row["gpu_ms"],
                scheduler_update_index=step,
                forward_index=forwards or None,
                cfg_branch="positive（CFG-distilled 單一分支）",
                sigma=sigma,
            )
        rec.count("scheduler_steps_completed", len(self.step_rows))
        rec.count("denoiser_forwards_completed", self.forwards)
        rec.count("cfg_branch_forward_count", self.forwards)
        total_block = 0
        for part, agg in sorted(self.blocks.items()):
            total_block += agg["forwards"]
            gpu = None if agg["gpu_missing"] else agg["gpu_ms"]
            rec.part_call(part, host_ms=agg["host_ms"], gpu_event_ms=gpu, calls=agg["forwards"])
            if self.managers:
                rec.part_value(
                    part,
                    "prefetch_wait_gpu_ms",
                    None if agg["wait_missing"] else agg["wait_ms"],
                    unit="ms",
                    method="cuda_event: pre-hook(prepend)→pre-hook(after wait_event)",
                )
        rec.count("block_forward_count", total_block)
        total_wait = sum(a["wait_ms"] for a in self.blocks.values())
        if self.managers and all(not a["wait_missing"] for a in self.blocks.values()):
            rec.set_metric(
                "prefetch_wait_ms",
                total_wait,
                quality="instrumented",
                scope="compute_stream_wait_for_copy",
                method="cuda_event_pre_hook_interval",
            )
        elif self.managers:
            rec.set_metric(
                "prefetch_wait_ms", None, quality="unavailable", reason="部分 block event 未解（佇列上限或失敗）"
            )
        if self.pairs.dropped:
            rec.notice(
                "DETAIL_TRUNCATED",
                f"CUDA event pair 達上限 {self.pairs.max_pending}，{self.pairs.dropped} 個區間未記錄",
                dropped_events=self.pairs.dropped,
            )
            rec.set_coverage("partial", "部分 CUDA event 區間因待解上限未記錄")
        if self.courier_submits:
            rec.set_coverage("partial", f"{self.courier_submits} 次 mapped courier 傳輸只有 submitted，完成量未知")
        if not self.managers:
            rec.note("DiT 未使用逐層串流（offload≠block）；沒有 layerwise 搬運可計")
        rec.note(
            "block 時間為 compute stream 上的 CUDA event 區間（含等待與空隙），不是 kernel active time；kernel 數只來自 trace"
        )
        if self.trace.enabled:
            rec.note(f"trace 狀態：{self.trace.status}{'（' + self.trace.reason + '）' if self.trace.reason else ''}")


__all__ = ["DitInstrumentation"]
