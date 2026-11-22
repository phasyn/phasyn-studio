"""Available device memory: the helper shared by the qimg.vision capacity check and the qimg.dit VRAM admission (torch-free at import time; torch is imported lazily).

Why it exists: an integrated/unified-memory (UMA) GPU shares one DRAM with the CPU, and the free value of
``torch.cuda.mem_get_info`` only tracks MemFree from /proc/meminfo, excluding page cache the kernel can reclaim at
any time (a few GiB "free" while MemAvailable is tens of GiB). Judging by it refuses models that fit. Dropping
the page cache to pass the check (posix_fadvise/drop_caches) is not an option.

Rules (explicit, overridable, always reported):

- ``memory_model``: ``unified``/``discrete`` = set explicitly (the setting wins over the device report, which is
  still recorded); ``auto`` = ``torch.cuda.get_device_properties(device).is_integrated``; unreadable → undecided
  (available is null with a reason, never guessed).
- ``unified``: available = MemAvailable - ``unified_reserve_bytes`` (left for the OS and other processes). Swap
  does not count; when MemAvailable cannot be read the value is null with a reason, never the (underestimating)
  ``mem_get_info`` free.
- ``discrete``: available = ``mem_get_info`` free (after releasing this process's idle caching-allocator blocks).
- The raw mem_get_info free/total, MemTotal/MemFree/MemAvailable/SwapFree and is_integrated are always reported;
  unreadable fields are null with a reason. The numbers are never added together.

This module only measures and reports; whether to refuse is decided by the caller's explicit setting
(vision ``capacity_check``, dit admission).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError


_MEMINFO_FIELDS_WITH_UNIT = 2

GIB = 1024**3
MEMINFO = Path("/proc/meminfo")
MEMORY_MODELS = ("auto", "discrete", "unified")
# 統一記憶體時留給 OS 與其他程序的量：保守的政策預設（不是量測值），以 unified_reserve_bytes 明確調整
DEFAULT_UNIFIED_RESERVE_BYTES = 4 * GIB
UNIFIED_BASIS = "MemAvailable \N{MINUS SIGN} unified_reserve_bytes"
DISCRETE_BASIS = "mem_get_info.free"
_MEMINFO_FIELDS = {
    "MemTotal": "total_bytes",
    "MemFree": "free_bytes",
    "MemAvailable": "available_bytes",
    "SwapFree": "swap_free_bytes",
}


def process_rss_bytes() -> int | None:
    """Resident set size of this process from /proc/self/statm; None when it cannot be read."""
    try:
        pages = int(Path("/proc/self/statm").read_text().split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return pages * os.sysconf("SC_PAGE_SIZE")


def format_gib(value: int | None) -> str:
    """Format a byte count in GiB."""
    return "未知" if value is None else f"{int(value) / GIB:.2f} GiB"


def _error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:300]


def parse_settings(memory_model: Any, unified_reserve_bytes: Any) -> tuple[str, int]:
    """設定值檢查（不合法 → 422 UNSUPPORTED_SETTING，不默默改值）；回傳 (memory_model, unified_reserve_bytes)."""
    if memory_model not in MEMORY_MODELS:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            f"memory_model 必須是 {'／'.join(MEMORY_MODELS)}，收到 {memory_model!r}",
            details={"memory_model": memory_model},
        )
    reserve = unified_reserve_bytes
    integral = isinstance(reserve, int) or (
        isinstance(reserve, float) and reserve.is_integer()
    )
    if isinstance(reserve, bool) or not integral or reserve < 0:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            f"unified_reserve_bytes 必須是 ≥ 0 的整數，收到 {unified_reserve_bytes!r}",
            details={"unified_reserve_bytes": unified_reserve_bytes},
        )
    return str(memory_model), int(reserve)


# ----------------------------------------------------------------------------------------------- /proc/meminfo
@dataclass(frozen=True)
class HostMemory:
    """/proc/meminfo 的原始值（bytes）。讀不到或缺欄位 → None，``reason`` 說明."""

    total_bytes: int | None = None
    free_bytes: int | None = None
    available_bytes: int | None = None
    swap_free_bytes: int | None = None
    reason: str | None = None


def parse_meminfo(text: str, *, source: str = str(MEMINFO)) -> HostMemory:
    """只認 ``<欄位>: <整數> kB``；缺少或格式不符的欄位是 None（原因列出是哪幾個）."""
    values: dict[str, int] = {}
    for line in text.splitlines():
        key, sep, rest = line.partition(":")
        name = _MEMINFO_FIELDS.get(key.strip())
        parts = rest.split()
        if (
            sep
            and name is not None
            and len(parts) == _MEMINFO_FIELDS_WITH_UNIT
            and parts[1] == "kB"
            and parts[0].isdigit()
        ):
            values[name] = int(parts[0]) * 1024
    missing = [key for key, name in _MEMINFO_FIELDS.items() if name not in values]
    return HostMemory(
        total_bytes=values.get("total_bytes"),
        free_bytes=values.get("free_bytes"),
        available_bytes=values.get("available_bytes"),
        swap_free_bytes=values.get("swap_free_bytes"),
        reason=f"{source} 沒有可解析的 {'、'.join(missing)}" if missing else None,
    )


def read_meminfo(path: Path | None = None) -> HostMemory:
    """Read Linux host memory counters."""
    target = MEMINFO if path is None else path
    try:
        text = target.read_text(encoding="ascii", errors="replace")
    except OSError as exc:
        return HostMemory(reason=f"無法讀取 {target}：{_error(exc)}")
    return parse_meminfo(text, source=str(target))


# ----------------------------------------------------------------------------------------------- torch.cuda
@dataclass(frozen=True)
class CudaMemory:
    """torch 量到的原始值；mem_get_info 與 is_integrated 各自獨立，量不到 → None+原因."""

    free_bytes: int | None = None
    total_bytes: int | None = None
    reason: str | None = None
    is_integrated: bool | None = None
    integrated_reason: str | None = None


def _cuda() -> Any:
    """``torch.cuda``（延遲匯入；測試以假物件替換這個函式）."""
    import torch

    return torch.cuda


def measure_cuda(device: Any = 0, *, empty_cache: bool = True) -> CudaMemory:
    """先釋放本程序 caching allocator 的閒置區塊（常駐權重不動），再量 mem_get_info 與 is_integrated."""
    try:
        cuda = _cuda()
    except Exception as exc:  # noqa: BLE001 - Optional instrumentation failures must not change generation.
        missing = f"無法匯入 torch.cuda：{_error(exc)}"
        return CudaMemory(reason=missing, integrated_reason=missing)
    free: int | None = None
    total: int | None = None
    reason: str | None = None
    try:
        if empty_cache:
            with cuda.device(device):
                cuda.empty_cache()
        raw_free, raw_total = cuda.mem_get_info(device)
        free, total = int(raw_free), int(raw_total)
    except Exception as exc:  # noqa: BLE001 - Optional instrumentation failures must not change generation.
        reason = f"torch.cuda empty_cache／mem_get_info 失敗：{_error(exc)}"
    integrated: bool | None = None
    integrated_reason: str | None = None
    try:
        value = getattr(cuda.get_device_properties(device), "is_integrated", None)
        if value is None:
            integrated_reason = "此 torch 的 device properties 沒有 is_integrated"
        else:
            integrated = bool(value)
    except Exception as exc:  # noqa: BLE001 - Optional instrumentation failures must not change generation.
        integrated_reason = f"torch.cuda.get_device_properties 失敗：{_error(exc)}"
    return CudaMemory(free, total, reason, integrated, integrated_reason)


# ----------------------------------------------------------------------------------------------- 決定可用量
@dataclass(frozen=True)
class DeviceMemory:
    """一次量測的結果：採用的記憶體模型與理由、可用量與依據，以及全部原始值."""

    memory_model: str | None  # "unified" | "discrete"；None=無法判斷
    model_source: str  # 為什麼是這個模型（設定或 is_integrated）
    available_bytes: int | None
    basis: str | None  # 可用量用的是哪個數字
    reason: str | None  # available_bytes 為 None 的原因
    unified_reserve_bytes: int
    cuda: CudaMemory = field(default_factory=CudaMemory)
    host: HostMemory = field(default_factory=HostMemory)

    def to_dict(self) -> dict[str, Any]:
        """Serialize this value for the runtime contract."""
        return {
            "memory_model": self.memory_model,
            "memory_model_source": self.model_source,
            "available_bytes": self.available_bytes,
            "available_basis": self.basis,
            "reason": self.reason,
            "unified_reserve_bytes": self.unified_reserve_bytes,
            "is_integrated": self.cuda.is_integrated,
            "is_integrated_reason": self.cuda.integrated_reason,
            "cuda_free_bytes": self.cuda.free_bytes,
            "cuda_total_bytes": self.cuda.total_bytes,
            "cuda_reason": self.cuda.reason,
            "mem_total_bytes": self.host.total_bytes,
            "mem_free_bytes": self.host.free_bytes,
            "mem_available_bytes": self.host.available_bytes,
            "swap_free_bytes": self.host.swap_free_bytes,
            "meminfo_reason": self.host.reason,
        }

    def describe(self) -> str:
        """訊息用的一句話：可用量用了哪個數字、為什麼；沒採用的那個數字也寫出來（不隱藏）."""
        if self.memory_model == "unified":
            unused = (
                "mem_get_info 量不到"
                if self.cuda.free_bytes is None
                else f"mem_get_info free {format_gib(self.cuda.free_bytes)} 不含可回收的 page cache，不採用"
            )
            return (
                f"MemAvailable {format_gib(self.host.available_bytes)} \N{MINUS SIGN} 保留 {format_gib(self.unified_reserve_bytes)}"
                f"（{self.model_source}；{unused}）"
            )
        if self.memory_model == "discrete":
            return f"mem_get_info free {format_gib(self.cuda.free_bytes)}（{self.model_source}）"
        return f"無法判斷記憶體模型（{self.model_source}）"


def resolve(
    cuda: CudaMemory,
    host: HostMemory,
    *,
    memory_model: str = "auto",
    unified_reserve_bytes: int = DEFAULT_UNIFIED_RESERVE_BYTES,
) -> DeviceMemory:
    """依記憶體模型決定可用量（純函式；量測由 ``device_memory`` 負責）."""
    requested, reserve = parse_settings(memory_model, unified_reserve_bytes)
    integrated = cuda.is_integrated
    model: str | None
    if requested != "auto":
        model = requested
        observed = (
            "讀不到裝置的 is_integrated"
            if integrated is None
            else f"裝置回報 is_integrated={integrated}"
        )
        source = f"設定 memory_model={requested}（{observed}）"
    elif integrated is None:
        model = None
        source = f"memory_model=auto 但讀不到 is_integrated（{cuda.integrated_reason or '原因不明'}）"
    elif integrated:
        model, source = (
            "unified",
            "memory_model=auto：is_integrated=True，整合 GPU 與 CPU 共用 DRAM",
        )
    else:
        model, source = "discrete", "memory_model=auto：is_integrated=False，獨立 GPU"

    def result(
        available: int | None, basis: str | None, reason: str | None
    ) -> DeviceMemory:
        return DeviceMemory(
            model, source, available, basis, reason, reserve, cuda, host
        )

    if model is None:
        return result(
            None,
            None,
            f"無法判斷是否為統一記憶體 GPU：{source}；請明確設定 memory_model（unified／discrete）",
        )
    if model == "unified":
        if host.available_bytes is None:
            return result(
                None,
                UNIFIED_BASIS,
                f"統一記憶體（{source}）的可用量需要 /proc/meminfo 的 MemAvailable，但量測不到"
                f"（{host.reason or '原因不明'}）；不改用 mem_get_info 的 free（不含可回收的 page cache，會低估）",
            )
        return result(max(0, host.available_bytes - reserve), UNIFIED_BASIS, None)
    if cuda.free_bytes is None:
        return result(
            None,
            DISCRETE_BASIS,
            f"量測不到 CUDA 裝置可用記憶體（{cuda.reason or '原因不明'}）",
        )
    return result(cuda.free_bytes, DISCRETE_BASIS, None)


def device_memory(
    device: Any = 0,
    *,
    memory_model: str = "auto",
    unified_reserve_bytes: int = DEFAULT_UNIFIED_RESERVE_BYTES,
    meminfo: Path | None = None,
) -> DeviceMemory:
    """量測並決定可用量：先 empty_cache 再量 mem_get_info／is_integrated，之後讀 /proc/meminfo（釋放後的值）."""
    requested, reserve = parse_settings(memory_model, unified_reserve_bytes)
    cuda = measure_cuda(device)
    host = read_meminfo(meminfo)
    return resolve(cuda, host, memory_model=requested, unified_reserve_bytes=reserve)


__all__ = [
    "DEFAULT_UNIFIED_RESERVE_BYTES",
    "DISCRETE_BASIS",
    "GIB",
    "MEMINFO",
    "MEMORY_MODELS",
    "UNIFIED_BASIS",
    "CudaMemory",
    "DeviceMemory",
    "HostMemory",
    "device_memory",
    "format_gib",
    "measure_cuda",
    "parse_meminfo",
    "parse_settings",
    "process_rss_bytes",
    "read_meminfo",
    "resolve",
]
