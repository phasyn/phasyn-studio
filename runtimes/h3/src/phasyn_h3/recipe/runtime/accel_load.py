"""DiT load hooks for online quantization and AdaLN x quant (torch/SGLang, actor only).

Called by ``loaders.SglangComponentBackend.load`` around the transformer load:

* ``dit_load_context`` — before any weight is read: FP8 capability / resident-size
  gate, convrot JIT toolchain + kernel build (so a missing ``nvcc``/``ninja`` fails
  in seconds, not after streaming 40 GB), and arming of the AdaLN x online-quant
  patch and of the per-layer FP8 quantization patch (``upstream_patches``) for
  exactly this load;
* ``finalize_dit_facts`` — after the load: what SGLang really built (quantized
  vs BF16 linears per method, convrot backend split, FP8 per-layer quantization
  and GEMM per layer, adaln_proj never quantized, AdaLN precomputed flag) plus a
  signature the denoise stage compares against a resident DiT before reusing it.
"""

from __future__ import annotations

import contextlib
import importlib
from collections import Counter
from collections.abc import Iterator, Mapping
from typing import Any

from phasyn_h3.recipe.abi.canonical import canonical_digest

from .acceleration import (
    CONVROT_JIT_CAPABILITIES,
    FP8_W8A8_MIN_CAPABILITY,
    attention_plan,
    effective_summary,
    quant_plan,
)
from .backend import H3_DIT_BF16_DEVICE_BYTES, RuntimeFacts
from .errors import UnsupportedCombination
from .policy import StagePolicy


def _transformer_profile(policy: StagePolicy) -> Mapping[str, Any]:
    return (policy.effective_profile.get("components") or {}).get("transformer") or {}


def load_signature(policy: StagePolicy) -> str:
    """Identity of everything that changes the *built* DiT beyond the component key."""
    plan = quant_plan(_transformer_profile(policy))
    return canonical_digest(
        {
            "quantization": None if plan is None else plan.as_dict(),
            "adaln_mode": policy.adaln_mode,
            "adaln_cache_ref": (policy.effective_profile.get("adaln") or {}).get("cache_ref")
            if policy.adaln_mode == "fixed"
            else None,
        }
    )


def summary(policy: StagePolicy) -> dict[str, Any]:
    return effective_summary(
        transformer_component=_transformer_profile(policy),
        attention=attention_plan(
            policy.attention_provider_effective, policy.sglang_attention_backend, policy.effective_profile
        ),
        adaln_mode=policy.adaln_mode,
    )


def _check_fp8_device(policy: StagePolicy, facts: RuntimeFacts) -> None:
    """FP8 W8A8 needs E4M3 tensor cores; a resident (offload=none) FP8 DiT still loads BF16 on the device."""
    if facts.sm is None or tuple(facts.sm) < FP8_W8A8_MIN_CAPABILITY:
        raise UnsupportedCombination(
            "FP8_W8A8_CAPABILITY_UNSUPPORTED",
            f"E4M3 張量核心從 compute capability {FP8_W8A8_MIN_CAPABILITY[0]}.{FP8_W8A8_MIN_CAPABILITY[1]} 起才有；"
            f"此裝置 {facts.sm}。釘版 Fp8LinearMethod 在 8.0–8.8 會改走 Marlin weight-only FP8（W8A16，"
            "fp8_utils.py can_auto_enable_marlin_fp8），不是 profile 要求的 W8A8，shim 不接受",
            field_path="components.transformer.quantization",
            expected=">= 8.9",
            actual=None if facts.sm is None else f"{facts.sm[0]}.{facts.sm[1]}",
        )
    comp = policy.components.get("transformer")
    if facts.integrated or comp is None or comp.offload != "none":
        return  # block offload: per-layer quantization (fp8_layerwise_quant.v1), checkpoint stays on the CPU
    total = facts.total_memory_bytes
    if total is None or total < H3_DIT_BF16_DEVICE_BYTES:
        raise UnsupportedCombination(
            "FP8_DEVICE_POSTPROCESS_OOM",
            "常駐（offload=none）的 DiT 由 SGLang 直接把 BF16 checkpoint 載到裝置（component 不從 CPU 開始，"
            "transformer_loader.py:54-65, 484-498）再逐層量化；"
            f"H3 DiT 不含 AdaLN 仍約 {H3_DIT_BF16_DEVICE_BYTES / 1e9:.0f} GB，此裝置 "
            f"{'未知' if total is None else f'{total / 1e9:.1f} GB'} 且非統一記憶體 → 必定 OOM。"
            "請用 offload=block（checkpoint 留在 CPU，逐層量化成 1-byte 權重後串流，fp8_layerwise_quant.v1）",
            field_path="components.transformer.offload",
            expected=f"block, or >= {H3_DIT_BF16_DEVICE_BYTES} bytes / UMA",
            actual=total,
        )


def _prepare_convrot(facts: RuntimeFacts) -> dict[str, Any]:
    from .toolchain import require_jit_toolchain

    if facts.sm is None or tuple(facts.sm) not in CONVROT_JIT_CAPABILITIES:
        raise UnsupportedCombination(
            "CONVROT_JIT_CAPABILITY_UNSUPPORTED",
            f"convrot_int8 JIT ops 只支援 CC {list(CONVROT_JIT_CAPABILITIES)}；此裝置 {facts.sm}",
            field_path="components.transformer.quantization",
        )
    toolchain = require_jit_toolchain("int8_convrot（SGLang convrot_int8 JIT）")
    jit = importlib.import_module("sglang.multimodal_gen.runtime.layers.quantization.convrot_int8_jit")
    reason = jit.jit_convrot_unavailable_reason()  # builds/loads the cached module once per process
    if reason is not None:
        raise UnsupportedCombination(
            "CONVROT_JIT_UNAVAILABLE",
            f"SGLang convrot_int8 JIT backend 無法使用：{reason}"[:1500],
            field_path="components.transformer.quantization",
        )
    return {"jit_toolchain": toolchain.as_dict(), "jit_ready": True}


def fp8_gemm_for(facts: RuntimeFacts) -> str | None:
    """The shim's FP8 GEMM on capabilities it was measured on; None keeps upstream ``apply_fp8_linear``."""
    from .fp8_linear import KERNEL_ID, VALIDATED_CAPABILITIES

    return KERNEL_ID if facts.sm is not None and tuple(facts.sm) in VALIDATED_CAPABILITIES else None


@contextlib.contextmanager
def dit_load_context(policy: StagePolicy, facts: RuntimeFacts, device: Any = None) -> Iterator[dict[str, Any]]:
    """Gate/prepare the DiT load; yields the facts dict the loader records.

    ``device`` (torch.device) is where an online-FP8 load stages each layer for quantization.
    """
    out: dict[str, Any] = {"effective": summary(policy), "signature": load_signature(policy)}
    attention = attention_plan(
        policy.attention_provider_effective, policy.sglang_attention_backend, policy.effective_profile
    )
    if attention.approximate and facts.sm is not None:
        from .attention_runtime import preflight_attention

        out["attention_preflight"] = preflight_attention(attention)  # before ServerArgs resolve it
    plan = quant_plan(_transformer_profile(policy))
    if plan is None:
        yield out
        return
    if plan.sglang_method == "fp8":
        _check_fp8_device(policy, facts)
        if device is None or getattr(device, "type", "cpu") != "cuda":
            raise UnsupportedCombination(
                "FP8_NEEDS_CUDA_DEVICE", "線上 FP8 逐層量化需要 CUDA 裝置（每層在裝置上量化後回到 host）"
            )
    if plan.requires_jit_toolchain:
        out.update(_prepare_convrot(facts))
    from .upstream_patches import armed_adaln_online_quant, armed_fp8_layerwise_quant, patch_state

    with contextlib.ExitStack() as stack:
        arming = None
        if plan.sglang_method == "fp8":
            arming = stack.enter_context(armed_fp8_layerwise_quant(device, gemm=fp8_gemm_for(facts)))
        if policy.adaln_mode != "off":
            admitted = stack.enter_context(armed_adaln_online_quant({plan.sglang_method}))
            out["adaln_relaxation"] = {"admitted": admitted, "patches": patch_state()}
        try:
            yield out
        finally:
            if arming is not None:
                out["fp8_layerwise"] = arming.facts()
                _release_staging(device)


def _release_staging(device: Any) -> None:
    """Return the per-layer staging blocks to the driver (the GPU is shared with other actors)."""
    import torch

    torch.cuda.synchronize(device)
    torch.cuda.empty_cache()


def _method_name(module: Any) -> str | None:
    method = getattr(module, "quant_method", None)
    return None if method is None else type(method).__name__


def _fp8_facts(module: Any, layerwise: Mapping[str, Any] | None, expected_layers: int) -> dict[str, Any]:
    """Every ``Fp8LinearMethod`` layer went through the per-layer path and holds E4M3 weights."""
    from .upstream_patches import UPSTREAM_FP8_GEMM

    done = int((layerwise or {}).get("quantized_layers", 0))
    if done != expected_layers:
        raise UnsupportedCombination(
            "FP8_LAYERWISE_NOT_APPLIED",
            f"線上 FP8 應由 fp8_layerwise_quant.v1 逐層量化 {expected_layers} 層，實際 {done} 層"
            "（patch 未生效時釘版會把整份 DiT 搬上裝置）；不交付",
            expected=expected_layers,
            actual=done,
        )
    dtypes: Counter[str] = Counter()
    gemms: Counter[str] = Counter()
    for _name, sub in module.named_modules():
        if _method_name(sub) != "Fp8LinearMethod":
            continue
        dtypes[str(getattr(getattr(sub, "weight", None), "dtype", None))] += 1
        gemms[str(getattr(sub, "_phasyn_fp8_gemm", None) or UPSTREAM_FP8_GEMM)] += 1
    if set(dtypes) != {"torch.float8_e4m3fn"}:
        raise UnsupportedCombination("FP8_WEIGHTS_NOT_E4M3", f"FP8 層的權重 dtype 不是 float8_e4m3fn：{dict(dtypes)}")
    return {
        **dict(layerwise or {}),
        "weight_scale": "per_output_channel_fp32",
        "activation_scale": "per_token_dynamic",
        "weight_dtypes": dict(dtypes),
        "gemm": dict(sorted(gemms.items())),
    }


def finalize_dit_facts(module: Any, policy: StagePolicy, facts: dict[str, Any]) -> dict[str, Any]:
    """What SGLang actually built; fails if the requested quantization did not apply."""
    plan = quant_plan(_transformer_profile(policy))
    methods: Counter[str] = Counter()
    adaln_quantized: list[str] = []
    configs: dict[int, Any] = {}
    for name, sub in module.named_modules():
        method = getattr(sub, "quant_method", None)
        if method is None:
            continue
        kind = type(method).__name__
        methods[kind] += 1
        config = getattr(method, "quant_config", None)
        if config is not None:
            configs[id(config)] = config
        if ".adaln_proj" in f".{name}" and kind != "UnquantizedLinearMethod":
            adaln_quantized.append(name)
    built: dict[str, Any] = {
        "linear_methods": dict(sorted(methods.items())),
        "adaln_precomputed": bool(getattr(module, "_adaln_precomputed", False)),
    }
    if plan is not None and adaln_quantized:
        raise UnsupportedCombination(
            "ADALN_PROJ_QUANTIZED",
            f"adaln_proj 被量化（{adaln_quantized[:3]}…）；shim 要求 AdaLN 投影保持 BF16",
        )
    if plan is not None:
        expected_method = {"convrot_int8": "ConvRotInt8JitLinearMethod", "fp8": "Fp8LinearMethod"}[plan.sglang_method]
        if methods.get(expected_method, 0) == 0:
            raise UnsupportedCombination(
                "ONLINE_QUANT_NOT_APPLIED",
                f"要求 {plan.sglang_method}，但 DiT 沒有任何 {expected_method} 層（實際 {dict(methods)}）；不交付未量化結果",
            )
        if plan.sglang_method == "fp8":
            built["fp8"] = _fp8_facts(module, facts.get("fp8_layerwise"), methods.get(expected_method, 0))
        for config in configs.values():
            by_backend = getattr(config, "selected_by_backend", None)
            if by_backend is not None:
                built["backend_split"] = {k: len(v) for k, v in by_backend.items()}
                built["group_size"] = getattr(config, "group_size", None)
                built["backend"] = getattr(config, "backend", None)
                built["kept_bf16"] = [str(s) for s in getattr(config, "skipped", [])][:32]
                if by_backend.get("comfy_kitchen"):
                    raise UnsupportedCombination(
                        "CONVROT_BACKEND_MISMATCH", "convrot_int8 有層走 comfy_kitchen；shim 只允許 JIT backend"
                    )
            ignored = getattr(config, "ignored_layers", None)
            if ignored is not None:
                built["ignored_layers"] = list(ignored)
    if policy.adaln_mode != "off" and not built["adaln_precomputed"]:
        raise UnsupportedCombination(
            "ADALN_MODE_NOT_APPLIED", f"adaln.mode={policy.adaln_mode}，但 DiT 不是 AdaLN precomputed 版本"
        )
    return {**facts, "built": built}


def check_resident_dit(handle_facts: Mapping[str, Any] | None, policy: StagePolicy) -> None:
    """A resident DiT reused by another job must have been built for the same quant/AdaLN choice."""
    recorded = ((handle_facts or {}).get("acceleration") or {}).get("signature")
    expected = load_signature(policy)
    if recorded is not None and recorded != expected:
        raise UnsupportedCombination(
            "RESIDENT_DIT_ACCELERATION_MISMATCH",
            "已常駐的 DiT 是以不同的量化／AdaLN 設定建構（與 component variant key 不一致的載入）；"
            "請先釋放該元件（release directive）後重試，shim 不重用不同設定的模型",
            expected=expected,
            actual=recorded,
        )


__all__ = [
    "check_resident_dit",
    "dit_load_context",
    "finalize_dit_facts",
    "fp8_gemm_for",
    "load_signature",
    "summary",
]
