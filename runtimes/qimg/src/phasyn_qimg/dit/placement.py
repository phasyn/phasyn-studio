"""Transformer placement (each mode is an explicit setting; one that does not fit is refused, never switched silently).

- ``none``: the whole transformer stays resident on the GPU from load time.
- ``phase``/``gguf_phase``: the transformer stays on the CPU after load; each invoke runs the VRAM admission
  check, moves the whole module to the GPU (dtype unchanged) and, when the loop ends (including failure or
  cancellation), moves it back to the CPU and releases the CUDA cache. These are two explicit steps around
  the invoke, not forward hooks.
- ``group_stream``: diffusers block-level group offload (one block per group, side stream + record_stream;
  ``low_cpu_mem_usage`` follows ``pin_memory`` explicitly); a static pin must first pass the RAM admission.

Available VRAM for admission comes from the shared helper (``admission.fill_device_memory`` →
``phasyn_qimg.memory``): ``mem_get_info`` free on a discrete GPU, MemAvailable − reserve on an
integrated/unified-memory GPU (``memory_model`` or ``is_integrated``).
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from phasyn_components.errors import ComponentError

from ..memory import DEFAULT_UNIFIED_RESERVE_BYTES
from . import admission

GROUP_HOOK = "group_offloading"


@dataclass
class PlacementState:
    mode: str
    device: Any
    pin_memory: str | None
    layout: dict[str, Any]
    facts: dict[str, Any] = field(default_factory=dict)
    groups: list[Any] = field(default_factory=list)
    memory_model: str = "auto"  # VRAM 准入的記憶體模型（provider_options.memory_model）
    unified_reserve_bytes: int = DEFAULT_UNIFIED_RESERVE_BYTES

    @property
    def weight_bytes(self) -> int:
        return int(self.layout["total_bytes"])


def _has_placement_hooks(module: Any) -> str | None:
    for name, sub in module.named_modules():
        if hasattr(sub, "_hf_hook") or hasattr(sub, "_diffusers_hook"):
            return name or "<root>"
    return None


def _fill_vram(est: admission.Estimate, state: PlacementState) -> admission.Estimate:
    """共用 helper 量測可用量（先釋放此程序未使用的 CUDA 快取；含其他程序與顯示用量）；量不到 → None＋原因。"""
    return admission.fill_device_memory(
        est, state.device, memory_model=state.memory_model, unified_reserve_bytes=state.unified_reserve_bytes
    )


def find_groups(transformer: Any) -> list[Any]:
    """group offload 的 ModuleGroup（block 與非 block 的 unmatched group），依出現順序去重。"""
    groups: list[Any] = []
    seen: set[int] = set()
    for module in transformer.modules():
        registry = getattr(module, "_diffusers_hook", None)
        if registry is None:
            continue
        hook = registry.get_hook(GROUP_HOOK)
        group = getattr(hook, "group", None)
        if group is not None and id(group) not in seen:
            seen.add(id(group))
            groups.append(group)
    return groups


def apply_load_placement(
    transformer: Any,
    *,
    mode: str,
    device: Any,
    pin_memory: str | None,
    rec: Any,
    memory_model: str = "auto",
    unified_reserve_bytes: int = DEFAULT_UNIFIED_RESERVE_BYTES,
) -> PlacementState:
    """load 階段：依 placement 放置 fresh CPU Transformer；回傳之後 invoke 需要的狀態。"""
    import torch

    from .loading import block_layout

    hooked = _has_placement_hooks(transformer)
    if hooked is not None:
        raise ComponentError("RUNTIME_ERROR", f"Transformer 已有 placement hook（{hooked}）；placement 只能套用一次")
    if any(p.device.type != "cpu" for p in transformer.parameters()):
        raise ComponentError("RUNTIME_ERROR", "placement 需要尚未搬移的 CPU Transformer")
    layout = block_layout(transformer)
    state = PlacementState(
        mode=mode,
        device=device,
        pin_memory=pin_memory,
        layout=layout,
        memory_model=memory_model,
        unified_reserve_bytes=unified_reserve_bytes,
    )
    state.facts.update(
        {
            "placement": mode,
            "transformer_weight_bytes": layout["total_bytes"],
            "max_block_bytes": layout["max_block_bytes"],
            "non_block_bytes": layout["non_block_bytes"],
            "num_blocks": layout["num_blocks"],
            "precision_changed": False,
        }
    )
    on_cuda = getattr(device, "type", None) == "cuda"
    if mode in ("phase", "gguf_phase", "group_stream") and not on_cuda:
        raise ComponentError("UNSUPPORTED_SETTING", f"placement={mode} 需要 CUDA 裝置")
    if mode == "none":
        if on_cuda:
            est = _fill_vram(admission.load_vram_estimate(mode, weight_bytes=layout["total_bytes"]), state)
            state.facts["load_admission"] = est.to_dict()
            admission.require(est)
        t0 = time.perf_counter()
        transformer.to(device)
        state.facts["load_move_host_ms"] = (time.perf_counter() - t0) * 1000
        state.facts["resident"] = "device"
    elif mode in ("phase", "gguf_phase"):
        state.facts["resident"] = "host（每次呼叫移入 GPU、結束移回）"
    elif mode == "group_stream":
        if pin_memory == "static":
            est = admission.pin_ram_estimate(weight_bytes=layout["total_bytes"])
            est.available = admission.available_ram_bytes()
            est.reason = None if est.available is not None else "無法讀取 /proc/meminfo"
            state.facts["pin_admission"] = est.to_dict()
            admission.require(est)
        transformer.enable_group_offload(
            onload_device=device,
            offload_device=torch.device("cpu"),
            offload_type="block_level",
            num_blocks_per_group=1,
            non_blocking=True,
            use_stream=True,
            record_stream=True,
            low_cpu_mem_usage=pin_memory != "static",
        )
        state.groups = find_groups(transformer)
        if not state.groups:
            raise ComponentError(
                "UPSTREAM_PATCH_SOURCE_MISMATCH",
                "group offload 沒有安裝任何 ModuleGroup（diffusers 的 group_offloading hook 介面與釘版不同）；"
                "請使用 qimg-x86_64 runtime 環境",
            )
        state.facts.update(
            {
                "resident": "group offload（逐 block 串流）",
                "group_blocks": 1,
                "use_stream": True,
                "record_stream": True,
                "pin_memory": pin_memory,
                "static_cpu_pinning": pin_memory == "static",
                "groups": len(state.groups),
            }
        )
    else:
        raise ComponentError("UNSUPPORTED_SETTING", f"不支援的 placement {mode}")
    rec.note(f"qimg.dit placement={mode}" + (f"（pin_memory={pin_memory}）" if pin_memory else ""))
    return state


def invoke_admission(
    state: PlacementState,
    *,
    dims: admission.ModelDims,
    branches: list[admission.BranchShape],
    dequant_bytes: int = 0,
) -> admission.Estimate:
    """VRAM admission before the call (estimate + the shared helper's measurement), with the full breakdown:
    too little → GPU_MEMORY_INSUFFICIENT, not measurable → UNSUPPORTED_SETTING (``admission.require``)."""
    est = admission.invoke_vram_estimate(
        state.mode,
        dims=dims,
        branches=branches,
        weight_bytes=state.weight_bytes,
        stream_resident_bytes=int(state.layout["non_block_bytes"]),
        max_block_bytes=int(state.layout["max_block_bytes"]),
        dequant_bytes=dequant_bytes,
    )
    if getattr(state.device, "type", None) != "cuda":
        est.reason = "CPU 裝置（只用於測試）：不做 VRAM 准入"
        est.available = est.required
        return est
    admission.require(_fill_vram(est, state))
    return est


@contextlib.contextmanager
def invoke_placement(
    state: PlacementState, transformer: Any, *, rec: Any, pairs: Any = None
) -> Iterator[dict[str, Any]]:
    """phase／gguf_phase：呼叫期間整個 Transformer 在 GPU；結束（含例外）移回 CPU。其他 placement 不動。"""
    info: dict[str, Any] = {}
    if state.mode not in ("phase", "gguf_phase"):
        yield info
        return
    import torch

    moved = False
    nbytes = state.weight_bytes
    try:
        start = pairs.record() if pairs is not None else None
        t0 = time.perf_counter()
        moved = True
        transformer.to(device=state.device)  # dtype 不變（BF16／packed GGUF 原樣）
        host_ms = (time.perf_counter() - t0) * 1000
        end = pairs.record() if pairs is not None else None
        tid = rec.transfer(
            "weight_h2d",
            direction="H2D",
            submitted_bytes=nbytes,
            completion_status="submitted",
            part="transformer",
            host_submit_ms=host_ms,
            src="host",
            dst="device",
            src_memory_kind="pageable",
            dst_memory_kind="device",
            byte_basis="logical_tensor",
            reason=f"{state.mode}：呼叫前整個 Transformer 移入 GPU",
        )
        if pairs is not None:
            pairs.pair(start, end, lambda ms, t=tid: rec.transfer_completed(t, completed_bytes=nbytes, gpu_event_ms=ms))
        info["h2d_host_ms"] = host_ms
        yield info
    finally:
        if moved:
            t0 = time.perf_counter()
            try:
                # module.to("cpu") is a real D2H copy; the GPU copy is released afterwards
                transformer.to(device="cpu")
                with torch.cuda.device(state.device):
                    torch.cuda.empty_cache()
            finally:
                host_ms = (time.perf_counter() - t0) * 1000
                info["d2h_host_ms"] = host_ms
                rec.transfer(
                    "weight_d2h",
                    direction="D2H",
                    submitted_bytes=nbytes,
                    completed_bytes=nbytes,
                    part="transformer",
                    host_ms=host_ms,
                    src="device",
                    dst="host",
                    src_memory_kind="device",
                    dst_memory_kind="pageable",
                    byte_basis="logical_tensor",
                    reason=f"{state.mode}：呼叫結束移回 CPU（同步複製；host 時間含 empty_cache）",
                )
                rec.count("offload_cycle_count", part="transformer")


__all__ = ["PlacementState", "apply_load_placement", "find_groups", "invoke_admission", "invoke_placement"]
