"""記憶體容量預檢（權重+KV 上限+activation 預留+保留），一律回報.

需求=權重+KV 上限（2×layers×tokens×kv_heads×head_dim×2 bytes）+activation 預留+安全保留。
可用量來自共用 helper ``phasyn_qimg.memory``（記憶體模型由 ``memory_model`` 設定或 is_integrated 決定）：

- 獨立 GPU（discrete）：min(mem_get_info free, MemAvailable)；MemAvailable 量不到時
  只用 mem_get_info free 並寫明原因。
- 整合／統一記憶體（UMA）GPU（unified）：MemAvailable - unified_reserve_bytes。mem_get_info 的 free 在 UMA 上
  只接近 MemFree、不含可回收的 page cache，取 min 會擋掉放得下的模型，所以只回報不採用。

已載入的本元件權重已經佔用記憶體，所以加回 resident。報告寫出採用的數字（``available_basis``）、理由
（``available_note``）與全部原始值（``memory``：mem_get_info、MemTotal／MemFree／MemAvailable／SwapFree、
is_integrated；量不到 → null+原因）。

結果寫進 load 的 observed 與每次 op 的 ``result.capacity``，也記在 recording。``capacity_check`` 是明確設定：
``enforce``=估計放不下（GPU_MEMORY_INSUFFICIENT；只有 MemAvailable 那一邊不夠時 HOST_MEMORY_INSUFFICIENT）或量測不到
（UNSUPPORTED_SETTING）就在載入／生成前回明確錯誤（不降精度、不換模型、不縮圖）；``report``=只回報、照常執行
（OOM 時回 GPU_OOM）。預檢從不被用來默默略過任何工作。
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.errors import (
    ComponentError,
    gpu_memory_insufficient,
    host_memory_insufficient,
)

from ..memory import DISCRETE_BASIS, DeviceMemory, format_gib


GIB = 1024**3
# Qwen3-VL-4B at max_pixels 262144 (a 608×416 image, 2,507 tokens) peaked just under 1 GiB of activations;
# the default reserve is 1 GiB. Measure 8B/32B models or larger images yourself and set it explicitly.
DEFAULT_ACTIVATION_RESERVE_BYTES = GIB
DEFAULT_RESERVE_BYTES = GIB
DISCRETE_HOST_BOUND_BASIS = "min(mem_get_info.free, MemAvailable)"


def kv_upper_bound(configuration: Mapping[str, Any], context_tokens: int) -> int:
    """KV cache 上限（bytes，bf16）；設定不足以計算 → 元件未設定（不猜）."""
    text = configuration.get("text_config", configuration)
    try:
        layers = int(text["num_hidden_layers"])
        kv_heads = int(text.get("num_key_value_heads", text["num_attention_heads"]))
        head_dim = int(
            text.get(
                "head_dim", int(text["hidden_size"]) // int(text["num_attention_heads"])
            )
        )
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED", "模型 config.json 不足以計算 KV 上限"
        ) from exc
    if min(layers, kv_heads, head_dim, context_tokens) <= 0:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED", "模型 config.json 的 KV 維度無效"
        )
    return 2 * layers * int(context_tokens) * kv_heads * head_dim * 2


def weight_files(model_path: Path) -> list[Path]:
    """List the model weight files used for capacity estimation."""
    return sorted(path for path in model_path.glob("*.safetensors") if path.is_file())


def weight_bytes(model_path: Path) -> int:
    """Count the bytes occupied by the weight files."""
    return sum(path.stat().st_size for path in weight_files(model_path))


def available_memory(
    memory: DeviceMemory,
) -> tuple[int | None, str | None, str | None, str]:
    """(可用, 依據, 原因, 說明)。unified：helper 的 MemAvailable - 保留；discrete：再取 MemAvailable 的較小者（原規則）."""
    free = memory.available_bytes
    if memory.memory_model != "discrete" or free is None:
        return free, memory.basis, memory.reason, memory.describe()
    host = memory.host.available_bytes
    if host is None:
        reason = f"量測不到 OS 可用記憶體（{memory.host.reason or '原因不明'}）；只以裝置可用記憶體判斷"
        return free, DISCRETE_BASIS, reason, memory.describe()
    note = f"min(mem_get_info free {format_gib(free)}, MemAvailable {format_gib(host)})（{memory.model_source}）"
    return min(free, host), DISCRETE_HOST_BOUND_BASIS, None, note


def capacity_report(  # noqa: PLR0913 - Keep the published runtime API.
    *,
    stage: str,
    mode: str,
    memory: DeviceMemory,
    weights_bytes: int,
    resident_weights_bytes: int,
    kv_bytes: int,
    kv_tokens: int,
    activation_reserve_bytes: int,
    reserve_bytes: int,
) -> dict[str, Any]:
    """Report observed capacity and estimated model requirements."""
    need = weights_bytes + kv_bytes + activation_reserve_bytes + reserve_bytes
    available, basis, reason, note = available_memory(memory)
    fits = None if available is None else available + resident_weights_bytes >= need
    return {
        "stage": stage,
        "mode": mode,
        "fits": fits,
        "reason": reason,
        "need_bytes": need,
        "available_bytes": available,
        "available_basis": basis,
        "available_note": note,
        "memory_model": memory.memory_model,
        "weights_bytes": weights_bytes,
        "resident_weights_bytes": resident_weights_bytes,
        "kv_bytes": kv_bytes,
        "kv_tokens": kv_tokens,
        "activation_reserve_bytes": activation_reserve_bytes,
        "reserve_bytes": reserve_bytes,
        "memory": memory.to_dict(),
    }


def _host_limited(report: Mapping[str, Any]) -> bool:
    """A discrete GPU's available amount is min(GPU free, MemAvailable): True when the GPU's own free memory would fit and only the host's MemAvailable falls short."""
    if report["available_basis"] != DISCRETE_HOST_BOUND_BASIS:
        return False
    gpu_free = report["memory"][
        "available_bytes"
    ]  # mem_get_info free on a discrete GPU
    return (
        gpu_free is not None
        and gpu_free + report["resident_weights_bytes"] >= report["need_bytes"]
    )


def enforce(report: Mapping[str, Any]) -> None:
    """``mode=enforce``: refuse before loading or generating, with the full estimate in ``details.capacity``.

    Does not fit → GPU_MEMORY_INSUFFICIENT, or HOST_MEMORY_INSUFFICIENT when only the host bound falls short
    (``_host_limited``); cannot be judged → UNSUPPORTED_SETTING (the reason names what to set, or switch to
    ``report``). ``mode=report`` never blocks.
    """
    if report["mode"] != "enforce" or report["fits"] is True:
        return
    if report["fits"] is None:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            f"記憶體預檢無法判斷（{report['stage']}）：{report['reason']}；capacity_check=enforce 不推測容量"
            "（可改 report 只回報）",
            details={"capacity": dict(report)},
        )
    gib = format_gib
    refuse = (
        host_memory_insufficient if _host_limited(report) else gpu_memory_insufficient
    )
    raise refuse(
        f"記憶體預檢不足（{report['stage']}）：需要 {gib(report['need_bytes'])}（權重 {gib(report['weights_bytes'])}\N{FULLWIDTH PLUS SIGN}KV "
        f"{gib(report['kv_bytes'])}\N{FULLWIDTH PLUS SIGN}activation {gib(report['activation_reserve_bytes'])}\N{FULLWIDTH PLUS SIGN}保留 "
        f"{gib(report['reserve_bytes'])}），可用 {gib(report['available_bytes'])}\N{FULLWIDTH PLUS SIGN}已載入權重 "
        f"{gib(report['resident_weights_bytes'])}；可用量\N{FULLWIDTH EQUALS SIGN}{report['available_note']}；不降精度、不換模型、不縮圖",
        details={"capacity": dict(report)},
    )


__all__ = [
    "DEFAULT_ACTIVATION_RESERVE_BYTES",
    "DEFAULT_RESERVE_BYTES",
    "DISCRETE_HOST_BOUND_BASIS",
    "GIB",
    "available_memory",
    "capacity_report",
    "enforce",
    "kv_upper_bound",
    "weight_bytes",
    "weight_files",
]
