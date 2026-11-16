"""Memory admission estimates (torch-free formulas); available VRAM is measured by the shared
``phasyn_qimg.memory`` helper (torch is imported lazily).

These are admission *estimates*, not a guarantee against arbitrary CUDA OOMs; every number is recorded
(quality=derived). Available VRAM (``fill_device_memory``): on a discrete GPU it is the ``mem_get_info``
free value; on an integrated/unified-memory (UMA) GPU (``memory_model`` setting or ``is_integrated``) it is
MemAvailable − ``unified_reserve_bytes``, because on UMA ``mem_get_info`` free only tracks MemFree and
excludes reclaimable page cache, which would refuse work that fits. The basis used (``available_basis``),
the reason and all raw readings (``device_memory``) are in ``to_dict()`` and in the message.

Formulas:
- phase/gguf_phase: transformer weights + activation reserve + prefix KV cache (GGUF adds dequantization
  scratch). Reference-image tokens are expanded into the prefix KV (one VLM image slot = 2×2 latent tokens)
  for both variants, because phase may be chosen explicitly for i2i; the activation term grows with the
  sequence length and never drops below a fixed 1.5 GiB.
- group_stream: resident non-block parameters + up to 3 blocks (running, prefetching, and released late by
  ``record_stream``) + activation + prefix KV (the KV cache always lives on the GPU).
- RAM: a static pin needs a full pinned copy of the transformer plus a 6 GiB reserve; phase keeps the
  whole set of weights resident in host memory.

:func:`require` turns an estimate that does not fit into the matching error before anything moves.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError, gpu_memory_insufficient, host_memory_insufficient

from .. import memory as device_mem

GIB = 1024**3
ACTIVATION_RESERVE_BYTES = 1536 * 1024 * 1024
ACTIVATION_PER_TOKEN_FACTOR = 24
GGUF_DEQUANT_FACTOR = 16  # dequantization scratch: largest quantized matrix × 4 FP32-sized copies
PIN_RAM_RESERVE_BYTES = 6 * GIB
STREAM_RESIDENT_BLOCKS = 3
IMG_TOKENS_PER_SLOT = 4
RAM_BASIS = "MemAvailable（cgroup v2 memory.max 有上限時取較小者）"


@dataclass(frozen=True)
class BranchShape:
    """一個 CFG 分支的序列形狀：VLM 序列長度（含影像槽）、影像槽數、目標 latent token 數。"""

    text_len: int
    image_slots: int
    target_tokens: int
    batch: int = 1

    @property
    def prefix_tokens(self) -> int:
        """KV cache 的 prefix：文字 token＋展開後的參考圖 token（L − slots + 4·slots）。"""
        return self.text_len + (IMG_TOKENS_PER_SLOT - 1) * self.image_slots

    @property
    def joint_tokens(self) -> int:
        return self.prefix_tokens + self.target_tokens


@dataclass(frozen=True)
class ModelDims:
    num_layers: int
    hidden: int
    element_size: int = 2


def kv_cache_bytes(dims: ModelDims, branches: Iterable[BranchShape]) -> int:
    """每層 K、V 各一份 (B, prefix, heads, head_dim)；CFG 時兩個分支各自一份（依實際長度相加）。"""
    return sum(dims.num_layers * 2 * b.batch * b.prefix_tokens * dims.hidden * dims.element_size for b in branches)


def activation_bytes(dims: ModelDims, branches: Iterable[BranchShape]) -> int:
    """單次 forward 的 activation 估計：max(1.5 GiB, B·joint·hidden·elem·24)（兩分支依序執行，取最大）。"""
    longest = max((b.batch * b.joint_tokens for b in branches), default=0)
    return max(ACTIVATION_RESERVE_BYTES, longest * dims.hidden * dims.element_size * ACTIVATION_PER_TOKEN_FACTOR)


@dataclass
class Estimate:
    """一次准入判斷的完整拆解（全部 bytes）。``available`` 為 None 時代表無法量測（不可假裝通過）。"""

    placement: str
    memory: str  # "vram" | "ram"
    components: dict[str, int] = field(default_factory=dict)
    available: int | None = None
    total: int | None = None
    reason: str | None = None
    basis: str | None = None  # available 用的是哪個數字
    device_memory: device_mem.DeviceMemory | None = None  # VRAM：共用 helper 的完整量測

    @property
    def required(self) -> int:
        return sum(self.components.values())

    @property
    def ok(self) -> bool:
        return self.available is not None and self.available >= self.required

    def to_dict(self) -> dict[str, Any]:
        mem = self.device_memory
        return {
            "placement": self.placement,
            "memory": self.memory,
            "components": dict(self.components),
            "required_bytes": self.required,
            "available_bytes": self.available,
            "available_basis": self.basis,
            "available_note": None if mem is None else mem.describe(),
            "total_bytes": self.total,
            "ok": self.ok,
            "reason": self.reason,
            "device_memory": None if mem is None else mem.to_dict(),
        }

    def message(self) -> str:
        mem = self.device_memory
        if self.memory != "vram":
            what = "主記憶體（MemAvailable）"
        elif mem is not None and mem.memory_model == "unified":
            what = "統一記憶體可用量"
        else:
            what = "GPU 可用記憶體"
        parts = "、".join(f"{k} {v / GIB:.2f} GiB" for k, v in self.components.items() if v)
        if self.available is None:
            return f"無法量測{what}（{self.reason or '原因不明'}）；placement={self.placement} 需要 {self.required / GIB:.2f} GiB（{parts}）"
        return (
            f"{what}不足以執行 placement={self.placement}：可用 {self.available / GIB:.2f} GiB，"
            f"估計需要 {self.required / GIB:.2f} GiB（{parts}）"
            + ("" if mem is None else f"；可用量＝{mem.describe()}")
        )


def require(estimate: Estimate) -> None:
    """Refuse before anything moves; ``details.admission`` always carries the full estimate.

    Too little measured GPU memory → GPU_MEMORY_INSUFFICIENT, too little host memory → HOST_MEMORY_INSUFFICIENT. A
    reading that is not available stays UNSUPPORTED_SETTING (for example ``memory_model`` must be set explicitly).
    """
    if estimate.ok:
        return
    details = {"admission": estimate.to_dict()}
    if estimate.available is None:
        raise ComponentError("UNSUPPORTED_SETTING", estimate.message(), details=details)
    refuse = gpu_memory_insufficient if estimate.memory == "vram" else host_memory_insufficient
    raise refuse(estimate.message(), details=details)


def fill_device_memory(
    est: Estimate,
    device: Any,
    *,
    memory_model: str = "auto",
    unified_reserve_bytes: int = device_mem.DEFAULT_UNIFIED_RESERVE_BYTES,
) -> Estimate:
    """VRAM 估計填入共用 helper 的量測：可用量、依據、量不到的原因與原始值（free 先釋放本程序 allocator 的閒置區塊）。"""
    mem = device_mem.device_memory(device, memory_model=memory_model, unified_reserve_bytes=unified_reserve_bytes)
    est.available = mem.available_bytes
    est.total = mem.cuda.total_bytes
    est.reason = mem.reason
    est.basis = mem.basis
    est.device_memory = mem
    return est


def invoke_vram_estimate(
    placement: str,
    *,
    dims: ModelDims,
    branches: list[BranchShape],
    weight_bytes: int,
    stream_resident_bytes: int = 0,
    max_block_bytes: int = 0,
    dequant_bytes: int = 0,
) -> Estimate:
    """呼叫前的 VRAM 需求（不含 available；由呼叫端以 ``fill_device_memory`` 填入）。"""
    est = Estimate(placement=placement, memory="vram")
    est.components["prefix_kv_cache"] = kv_cache_bytes(dims, branches)
    est.components["activation_reserve"] = activation_bytes(dims, branches)
    if placement in ("phase", "gguf_phase"):
        est.components["transformer_weights"] = weight_bytes
        if placement == "gguf_phase":
            est.components["gguf_dequant_scratch"] = dequant_bytes
    elif placement == "group_stream":
        est.components["resident_non_block_weights"] = stream_resident_bytes
        est.components["streamed_blocks"] = STREAM_RESIDENT_BLOCKS * max_block_bytes
    elif placement != "none":
        raise ValueError(f"unknown placement {placement}")
    # none：權重已在 load 時常駐（不再重複計入；可用量已扣掉）
    return est


def load_vram_estimate(placement: str, *, weight_bytes: int) -> Estimate:
    """load 時的靜態檢查：none 需要整份權重常駐＋最小 activation reserve。"""
    est = Estimate(placement=placement, memory="vram")
    est.components["transformer_weights"] = weight_bytes
    est.components["activation_reserve"] = ACTIVATION_RESERVE_BYTES
    return est


def preload_ram_estimate(placement: str, *, file_bytes: int) -> Estimate:
    """載入前：權重先完整讀進主記憶體（phase／gguf_phase 之後也一直留在主記憶體）＋保留量。"""
    est = Estimate(placement=placement, memory="ram", basis=RAM_BASIS)
    est.components["transformer_checkpoint"] = file_bytes
    est.components["host_reserve"] = PIN_RAM_RESERVE_BYTES
    return est


def pin_ram_estimate(*, weight_bytes: int) -> Estimate:
    """group_stream + static pin: the weights are already in host memory; add a full pinned copy plus a reserve."""
    est = Estimate(placement="group_stream", memory="ram", basis=RAM_BASIS)
    est.components["pinned_transformer_copy"] = weight_bytes
    est.components["pin_ram_reserve"] = PIN_RAM_RESERVE_BYTES
    return est


def available_ram_bytes(meminfo: Path | None = None, cgroup: Path = Path("/sys/fs/cgroup")) -> int | None:
    """Linux MemAvailable (shared /proc/meminfo parser), capped by a finite cgroup v2 limit when one is set."""
    available = device_mem.read_meminfo(meminfo).available_bytes
    if available is None:
        return None
    try:
        limit = (cgroup / "memory.max").read_text().strip()
        if limit != "max":
            current = int((cgroup / "memory.current").read_text().strip())
            available = min(available, max(0, int(limit) - current))
    except (OSError, ValueError):
        pass
    return available


def branch_shapes(
    *, text_lens: Mapping[str, int], image_slots: Mapping[str, int], target_tokens: int
) -> list[BranchShape]:
    return [
        BranchShape(text_len=int(text_lens[k]), image_slots=int(image_slots.get(k, 0)), target_tokens=target_tokens)
        for k in sorted(text_lens)
    ]


__all__ = [
    "ACTIVATION_RESERVE_BYTES",
    "GIB",
    "PIN_RAM_RESERVE_BYTES",
    "RAM_BASIS",
    "STREAM_RESIDENT_BLOCKS",
    "BranchShape",
    "Estimate",
    "ModelDims",
    "activation_bytes",
    "available_ram_bytes",
    "branch_shapes",
    "fill_device_memory",
    "invoke_vram_estimate",
    "kv_cache_bytes",
    "load_vram_estimate",
    "pin_ram_estimate",
    "preload_ram_estimate",
    "require",
]
