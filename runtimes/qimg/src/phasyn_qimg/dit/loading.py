"""Transformer loading: native BF16, a transformer override (recipe), GGUF Q4_K_M, and LoRA/slider adapters.

- BF16 and override: ``QwenImage21Transformer2DModel.from_pretrained(dir, local_files_only=True,
  torch_dtype=bf16, use_safetensors=True)``; the ABI is checked before loading
  (``options.configuration_problem``) and again against the loaded module's config.
- GGUF: BF16 entries are dequantized into plain BF16 tensors, Q4/Q6 entries stay packed;
  ``DIFFUSERS_GGUF_CUDA_KERNELS`` is refused.
- Adapters: equivalent to ``pipe.load_lora_weights(dir, weight_name=…, adapter_name=…)`` followed by
  ``pipe.set_adapters(names, adapter_weights=scales)`` without a pipeline object; safetensors only (never a
  pickle fallback).

Heavy imports (torch/diffusers/gguf) are deferred into the functions.
"""

from __future__ import annotations

import contextlib
import inspect
from collections.abc import Callable
from pathlib import Path
from typing import Any

from phasyn_components import model_identity as identity
from phasyn_components import upstream
from phasyn_components.errors import ComponentError

from ..config import DIFFUSERS_COMMIT
from .options import TRANSFORMER_CLASS, DitOptions, abi_problems, gguf_kernels_requested, read_config


def tensor_storage_bytes(module: Any) -> int:
    """Actual parameter + buffer bytes (mixed dtypes and packed GGUF tensors count their real storage)."""
    seen: set[int] = set()
    size = 0
    for tensor in (*module.parameters(), *module.buffers()):
        if id(tensor) not in seen:
            seen.add(id(tensor))
            size += int(tensor.numel() * tensor.element_size())
    return size


def parameter_dtypes(module: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    for p in module.parameters():
        key = str(p.dtype).replace("torch.", "")
        quant = getattr(p, "quant_type", None)
        if quant is not None:
            key = f"gguf:{getattr(quant, 'name', quant)}"
        out[key] = out.get(key, 0) + int(p.numel())
    return out


def block_layout(transformer: Any) -> dict[str, Any]:
    """每個 block 的 bytes 與非 block（常駐於 group_stream 的 unmatched group）bytes。"""
    blocks = [tensor_storage_bytes(b) for b in transformer.transformer_blocks]
    total = tensor_storage_bytes(transformer)
    return {
        "num_blocks": len(blocks),
        "block_bytes": blocks,
        "max_block_bytes": max(blocks, default=0),
        "non_block_bytes": total - sum(blocks),
        "total_bytes": total,
    }


def largest_quantized_matrix(transformer: Any) -> int:
    """in×out of the largest GGUF-quantized linear layer (sizes the dequantization scratch)."""
    return max(
        (
            int(m.in_features) * int(m.out_features)
            for m in transformer.modules()
            if hasattr(getattr(m, "weight", None), "quant_type") and hasattr(m, "in_features")
        ),
        default=0,
    )


def checkpoint_bytes(opts: DitOptions) -> int:
    """載入前的 checkpoint 大小（RAM 准入用）：BF16 = transformer 目錄的 safetensors；GGUF = 檔案大小；加上 adapter。"""
    total = 0
    if opts.variant == "gguf_q4km":
        gguf = opts.gguf_path
        total += gguf.stat().st_size if gguf is not None and gguf.is_file() else 0
    else:
        total += sum(p.stat().st_size for p in opts.transformer_dir.glob("*.safetensors"))
    for adapter in opts.adapters:
        with contextlib.suppress(OSError):
            total += opts.adapter_path(adapter).stat().st_size
    return total


def model_identity(opts: DitOptions) -> dict[str, Any]:
    """Path-free identity (``phasyn_components.model_identity``): transformer, scheduler config, GGUF, adapters."""
    root = opts.model_root
    components = {"transformer": opts.transformer_dir, "scheduler_config": opts.scheduler_config_path}
    if opts.gguf_path is not None:
        components["gguf"] = opts.gguf_path
    return identity.model_identity(
        root,
        components,
        variant=opts.variant,
        base=opts.base,
        transformer_class=TRANSFORMER_CLASS,
        transformer_override=opts.transformer_override,
        adapters=[{**a.to_dict(), "file": identity.path_stat(opts.adapter_path(a), root)} for a in opts.adapters],
    )


def check_abi(opts: DitOptions, transformer_config: dict[str, Any] | None = None) -> None:
    root = opts.model_root
    config = (
        transformer_config
        if transformer_config is not None
        else read_config(opts.transformer_dir / "config.json", root)
    )
    problems = abi_problems(
        config, read_config(opts.text_encoder_config_path, root), read_config(opts.vae_dir / "config.json", root)
    )
    if problems:
        raise ComponentError("MODEL_INCOMPATIBLE", "；".join(problems), details={"problems": problems})


def load_qwen_gguf(path: Path, config: Path, dtype: Any, *, root: Path | None = None) -> Any:
    """Local GGUF → QwenImage21Transformer2DModel (BF16 entries dequantized, Q4/Q6 kept packed).

    ``root`` (``load.model_path``) only shapes error messages, which never show absolute paths.
    """
    if gguf_kernels_requested():
        raise ComponentError("UNSUPPORTED_SETTING", "GGUF 載入只使用本機 PyTorch；請停用 DIFFUSERS_GGUF_CUDA_KERNELS")
    if not path.is_file() or path.suffix.lower() != ".gguf":
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED", f"找不到本機 GGUF Transformer：{identity.display_path(path, root)}"
        )
    if not (config / "config.json").is_file():
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED",
            f"找不到 GGUF 基底模型的 Transformer config.json：{identity.display_path(config, root)}",
        )

    import gguf
    import torch
    from diffusers import GGUFQuantizationConfig, QwenImage21Transformer2DModel
    from diffusers.models.model_loading_utils import load_gguf_checkpoint
    from diffusers.quantizers.gguf.utils import dequantize_gguf_tensor

    read_checkpoint: Callable[[str], dict[str, Any]] = load_gguf_checkpoint
    dequantize: Callable[[Any], Any] = dequantize_gguf_tensor
    checkpoint = read_checkpoint(str(path))
    try:
        for name, value in checkpoint.items():
            if getattr(value, "quant_type", None) == gguf.GGMLQuantizationType.BF16:
                checkpoint[name] = dequantize(value).to(torch.bfloat16)
        return QwenImage21Transformer2DModel.from_single_file(
            checkpoint,
            config=str(config),
            local_files_only=True,
            torch_dtype=dtype,
            quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
            low_cpu_mem_usage=True,
            device="cpu",
        )
    finally:
        checkpoint.clear()


def load_transformer(opts: DitOptions, *, dtype: Any) -> Any:
    """CPU 上的 fresh Transformer（尚未套用 placement）。"""
    from diffusers import QwenImage21Transformer2DModel

    check_abi(opts)  # 只讀 config：不相容時在配置任何權重之前就拒絕
    if opts.variant == "gguf_q4km":
        gguf = opts.gguf_path
        assert gguf is not None
        transformer = load_qwen_gguf(gguf, opts.base_dir / "transformer", dtype, root=opts.model_root)
    else:
        transformer = QwenImage21Transformer2DModel.from_pretrained(
            str(opts.transformer_dir), local_files_only=True, torch_dtype=dtype, use_safetensors=True
        )
    if type(transformer).__name__ != TRANSFORMER_CLASS:
        raise ComponentError(
            "MODEL_INCOMPATIBLE", f"載入的類別是 {type(transformer).__name__}，不是 {TRANSFORMER_CLASS}"
        )
    # 實際模組的 config 再檢一次（類別已在上面以型別確認；記憶體中的 config 不一定帶 _class_name）
    check_abi(opts, {**dict(transformer.config), "_class_name": type(transformer).__name__})
    transformer.eval()
    return transformer


def lora_loader() -> tuple[Any, Any]:
    """diffusers' QwenImage LoRA loader and its private ``low_cpu_mem_usage`` default, checked first.

    Loading without a pipeline object relies on two private details of the pinned diffusers build
    (``_LOW_CPU_MEM_USAGE_DEFAULT_LORA`` and the ``_pipeline`` keyword); a build without them is refused with
    ``UPSTREAM_PATCH_SOURCE_MISMATCH`` instead of loading adapters some other way.
    """
    from diffusers.loaders import lora_pipeline

    missing = upstream.missing_attrs(
        lora_pipeline,
        (
            "_LOW_CPU_MEM_USAGE_DEFAULT_LORA",
            "QwenImageLoraLoaderMixin.lora_state_dict",
            "QwenImageLoraLoaderMixin.load_lora_into_transformer",
        ),
    )
    mixin = getattr(lora_pipeline, "QwenImageLoraLoaderMixin", None)
    loader = getattr(mixin, "load_lora_into_transformer", None)
    if loader is not None and "_pipeline" not in inspect.signature(loader).parameters:
        missing.append("QwenImageLoraLoaderMixin.load_lora_into_transformer(_pipeline=…)")
    if missing:
        raise ComponentError(
            "UPSTREAM_PATCH_SOURCE_MISMATCH",
            f"diffusers 的 LoRA 載入介面與釘版 {DIFFUSERS_COMMIT[:7]} 不同（缺少 {'、'.join(missing)}）；"
            "請使用 qimg-x86_64 runtime 環境",
            details={"missing": missing},
        )
    return mixin, lora_pipeline._LOW_CPU_MEM_USAGE_DEFAULT_LORA


def load_adapters(transformer: Any, opts: DitOptions) -> list[dict[str, Any]]:
    """依序載入 LoRA／slider 並以各自 scale 啟用（等同 pipeline 的 load_lora_weights＋set_adapters）。"""
    if not opts.adapters:
        return []
    if opts.variant != "bf16":
        raise ComponentError("UNSUPPORTED_SETTING", "GGUF 模型不支援 Adapter")
    loader, low_cpu_mem_usage = lora_loader()
    loaded: list[dict[str, Any]] = []
    before = {id(p) for p in transformer.parameters()}
    for adapter in opts.adapters:
        path = opts.adapter_path(adapter)
        if path.suffix != ".safetensors" or not path.is_file():
            raise ComponentError(
                "COMPONENT_NOT_CONFIGURED",
                f"Adapter 必須是存在的 safetensors：{identity.display_path(path, opts.model_root)}",
            )
        state_dict, metadata = loader.lora_state_dict(
            str(path.parent),
            weight_name=path.name,
            local_files_only=True,
            use_safetensors=True,
            return_lora_metadata=True,
        )
        if not all("lora" in key for key in state_dict):
            raise ComponentError(
                "MODEL_INCOMPATIBLE", f"Adapter {adapter.name} 不是 LoRA checkpoint（所有鍵名都必須含 lora）"
            )
        keys = len(state_dict)
        loader.load_lora_into_transformer(
            state_dict,
            transformer=transformer,
            adapter_name=adapter.name,
            metadata=metadata,
            _pipeline=None,
            low_cpu_mem_usage=low_cpu_mem_usage,
        )
        loaded.append({**adapter.to_dict(), "tensors": keys})
    transformer.set_adapters([a.name for a in opts.adapters], weights=[a.scale for a in opts.adapters])
    added = [p for p in transformer.parameters() if id(p) not in before]
    added_bytes = sum(int(p.numel() * p.element_size()) for p in added)
    for entry in loaded:
        entry["lora_parameter_bytes_total"] = added_bytes
    return loaded


__all__ = [
    "block_layout",
    "check_abi",
    "checkpoint_bytes",
    "largest_quantized_matrix",
    "load_adapters",
    "load_qwen_gguf",
    "load_transformer",
    "lora_loader",
    "model_identity",
    "parameter_dtypes",
    "tensor_storage_bytes",
]
