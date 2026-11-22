"""H3 rules for the DiT acceleration knobs (pure Python; mirrors the runtime shim).

Rule sources (pinned SGLang ``de487f80``; runtime counterpart
``phasyn_h3.recipe.runtime.acceleration``, /§15):

* online DiT quantization of a native BF16 checkpoint — ``int8_convrot`` /
  ``sglang_native`` (SGLang ``--quantization convrot_int8``: W8A8 + group-wise
  Hadamard, JIT backend, group 256 only through the CLI path,
  ``transformer_load_utils.py:1059-1065``) and ``fp8_e4m3`` / ``sglang_native``
  (``--quantization fp8``: per-output-channel E4M3 weights × per-token E4M3
  activations, ``fp8.py:296-316``; the runtime quantizes it one layer at a time,
  runtime patch ``fp8_layerwise_quant.v1``, and needs E4M3 tensor cores, CC >= 8.9);
  DiT only, never ``exact``, ``adaln_proj`` always stays BF16;
* approximate DiT attention — ``fp8_fa_sm120`` (compute capability 12.0 only,
  ``platforms/cuda.py:520-547``) and ``subblock_sparse_attn`` (9.0 / 10.0 / 12.0,
  ``cuda.py:432-480``) with an explicit ``attention.subblock_sparse`` schedule;
* AdaLN cache/online may combine with the online quantization above, never
  with pre-quantized or pruned checkpoints.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from ._diag import UNSUPPORTED, err, warn


_MIN_SM_DIGITS = 2


ONLINE_QUANT: frozenset[tuple[str, str]] = frozenset(
    {("int8_convrot", "sglang_native"), ("fp8_e4m3", "sglang_native")}
)
ONLINE_QUANT_SCHEMES = frozenset(scheme for scheme, _ in ONLINE_QUANT)
CONVROT_GROUP_SIZE = 256
ONLINE_QUANT_OFFLOADS = ("none", "block")
FP8_W8A8_MIN_SM = (
    89  # E4M3 tensor cores (runtime: acceleration.FP8_W8A8_MIN_CAPABILITY)
)
# exact compute capabilities ("<major><minor>" like node-inventory ``sm``)
APPROXIMATE_ATTENTION_SM: Mapping[str, tuple[str, ...]] = {
    "fp8_fa_sm120": ("120",),
    "subblock_sparse_attn": ("90", "100", "120"),
}
SUBBLOCK_KEYS = (
    "sparsity",
    "skip_first_steps",
    "skip_first_layers",
    "n_k",
    "n_q",
    "min_seq_len",
    "compute_mode",
)


def _quant(comp: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return (comp or {}).get("quantization") or {}


def is_online_quant(comp: Mapping[str, Any] | None) -> bool:
    """Check whether the requested scheme quantizes weights during loading."""
    quant = _quant(comp)
    return (
        str(quant.get("scheme", "none")),
        str(quant.get("provider", "native")),
    ) in ONLINE_QUANT


def adaln_quant_relaxable(profile: Mapping[str, Any]) -> bool:
    """True when the AdaLN cache/online may combine with the DiT quantization."""
    return is_online_quant((profile.get("components") or {}).get("transformer"))


def _sm_text(sm: Any) -> str | None:
    text = (
        str(sm or "")
        .strip()
        .lower()
        .removeprefix("sm")
        .removeprefix("_")
        .replace(".", "")
    )
    return text if text.isdigit() and len(text) >= _MIN_SM_DIGITS else None


def _quant_diagnostics(
    profile: Mapping[str, Any], device_sms: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name, comp in (profile.get("components") or {}).items():
        if not isinstance(comp, Mapping):
            continue
        base = f"components.{name}"
        quant = _quant(comp)
        scheme = str(quant.get("scheme", "none"))
        provider = str(quant.get("provider", "native"))
        if scheme == "int8_convrot" and provider != "sglang_native":
            out.append(
                err(
                    UNSUPPORTED,
                    "int8_convrot 只由 SGLang 原生 convrot_int8（provider=sglang_native）實作",
                    f"{base}.quantization.provider",
                    expected="sglang_native",
                    actual=provider,
                )
            )
        if (scheme, provider) not in ONLINE_QUANT:
            continue
        if name != "transformer":
            out.append(
                err(
                    UNSUPPORTED,
                    f"{scheme}/{provider} 是 DiT 線上量化（SGLang --quantization 只作用於 transformer）；{name} 不可用",
                    f"{base}.quantization.scheme",
                )
            )
            continue
        _online_weight_settings(comp, scheme, quant, base, out)
        if scheme == "fp8_e4m3":
            if comp.get("offload", "block") == "none":
                out.append(
                    warn(
                        "FP8_DEVICE_POSTPROCESS",
                        "常駐（offload=none）的 FP8 DiT 會先把整份 BF16 checkpoint（不含 AdaLN 約 40 GB）載到裝置再量化；"
                        "只適合統一記憶體（UMA）GPU 或大記憶體卡，16 GB 級的卡會在 runtime 以 FP8_DEVICE_POSTPROCESS_OOM 拒絕；"
                        "offload=block 逐層量化，不受此限",
                        f"{base}.offload",
                    )
                )
            dit_sm = _sm_text((device_sms or {}).get("dit"))
            if dit_sm is not None and int(dit_sm) < FP8_W8A8_MIN_SM:
                out.append(
                    err(
                        UNSUPPORTED,
                        f"FP8 W8A8 需要 E4M3 張量核心（compute capability ≥ 8.9）；DiT 裝置 sm{dit_sm}"
                        "（釘版會改走 Marlin weight-only FP8，不擅自替換）",
                        f"{base}.quantization.scheme",
                        expected=f">= {FP8_W8A8_MIN_SM}",
                        actual=dit_sm,
                    )
                )
    return out


def _subblock_problems(raw: Any) -> list[tuple[str, str]]:
    """(field path, message) for an ``attention.subblock_sparse`` value."""
    base = "attention.subblock_sparse"
    if not isinstance(raw, Mapping):
        return [
            (
                base,
                "subblock_sparse_attn 需要完整的 attention.subblock_sparse（不套用 SGLang 隱含預設）",
            )
        ]
    problems = [(f"{base}.{k}", f"缺少 {k}") for k in SUBBLOCK_KEYS if k not in raw]
    problems += [
        (f"{base}.{k}", f"未知欄位 {k}") for k in sorted(set(raw) - set(SUBBLOCK_KEYS))
    ]
    sparsity = raw.get("sparsity")
    if "sparsity" in raw and (
        isinstance(sparsity, bool)
        or not isinstance(sparsity, (int, float))
        or not math.isfinite(float(sparsity))
        or not 0 <= float(sparsity) < 1
    ):
        problems.append((f"{base}.sparsity", "sparsity 必須在 [0, 1)"))
    for key in ("n_k", "n_q"):
        if key in raw and (isinstance(raw[key], bool) or raw[key] not in (1, 2, 4, 8)):
            problems.append((f"{base}.{key}", f"{key} 必須是 1、2、4 或 8"))
    for key in ("skip_first_steps", "skip_first_layers", "min_seq_len"):
        value = raw.get(key)
        if key in raw and (
            isinstance(value, bool) or not isinstance(value, int) or value < 0
        ):
            problems.append((f"{base}.{key}", f"{key} 必須是非負整數"))
    if "compute_mode" in raw and raw["compute_mode"] not in ("bf16", "sage_fp8"):
        problems.append(
            (f"{base}.compute_mode", "compute_mode 必須是 bf16 或 sage_fp8")
        )
    return problems


def _attention_diagnostics(
    profile: Mapping[str, Any], device_sms: Mapping[str, Any] | None
) -> list[dict[str, Any]]:
    attention = profile.get("attention") or {}
    provider = str(attention.get("provider", "auto_exact"))
    params = attention.get("subblock_sparse")
    allowed = APPROXIMATE_ATTENTION_SM.get(provider)
    out: list[dict[str, Any]] = []
    if allowed is None:
        if params is not None:
            out.append(
                err(
                    UNSUPPORTED,
                    f"attention.subblock_sparse 只屬於 subblock_sparse_attn；provider={provider} 時必須為 null",
                    "attention.subblock_sparse",
                )
            )
        return out
    if profile.get("mode") == "exact":
        out.append(
            err(
                UNSUPPORTED,
                f"{provider} 是近似 attention（FP8 量化或區塊稀疏），不能用於 mode=exact（/026）",
                "mode",
                "attention.provider",
            )
        )
    if attention.get("kernel_variant") is not None:
        out.append(
            err(
                UNSUPPORTED,
                f"{provider} 沒有 kernel_variant 選項（不默默忽略）",
                "attention.kernel_variant",
            )
        )
    if provider == "subblock_sparse_attn":
        out.extend(
            err(UNSUPPORTED, message, path)
            for path, message in _subblock_problems(params)
        )
        if isinstance(params, Mapping) and params.get("compute_mode") == "sage_fp8":
            out.append(
                warn(
                    "SUBBLOCK_SAGE_FP8_PIN",
                    "SM120 的 sage_fp8 需要 FlashInfer PR #4691（flashinfer@6a84331e）；目前 runtime lock 的 "
                    "flashinfer-python 0.7.0.post1 沒有，runtime 會以 SUBBLOCK_SAGE_FP8_UNAVAILABLE 拒絕",
                    "attention.subblock_sparse.compute_mode",
                )
            )
    elif params is not None:
        out.append(
            err(
                UNSUPPORTED,
                f"{provider} 不接受 attention.subblock_sparse（不默默忽略）",
                "attention.subblock_sparse",
            )
        )
    dit_sm = _sm_text((device_sms or {}).get("dit"))
    if dit_sm is None:
        out.append(
            warn(
                "APPROXIMATE_ATTENTION_SM",
                f"{provider} 只支援 compute capability {list(allowed)}；目前沒有 DiT 裝置架構資訊，放置時再檢查",
                "attention.provider",
            )
        )
    elif dit_sm not in allowed:
        out.append(
            err(
                UNSUPPORTED,
                f"{provider} 只支援 compute capability {list(allowed)}；DiT 裝置 sm{dit_sm}"
                "（釘版 resolver 會默默改走 cuDNN 或直接報錯，不擅自替換）",
                "attention.provider",
                expected="|".join(allowed),
                actual=dit_sm,
            )
        )
    return out


def diagnostics(
    profile: Mapping[str, Any], device_sms: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Report incompatible acceleration options."""
    return _quant_diagnostics(profile, device_sms) + _attention_diagnostics(
        profile, device_sms
    )


__all__ = [
    "APPROXIMATE_ATTENTION_SM",
    "ONLINE_QUANT",
    "ONLINE_QUANT_SCHEMES",
    "adaln_quant_relaxable",
    "diagnostics",
    "is_online_quant",
]


def _online_weight_settings(
    comp: Mapping[str, Any],
    scheme: str,
    quant: Mapping[str, Any],
    base: str,
    out: list[dict[str, Any]],
) -> None:
    group = quant.get("group_size")
    if scheme == "int8_convrot" and group not in (None, CONVROT_GROUP_SIZE):
        out.append(
            err(
                UNSUPPORTED,
                f"釘版 --quantization convrot_int8 固定 group {CONVROT_GROUP_SIZE}（transformer_load_utils.py:1059-1065）",
                f"{base}.quantization.group_size",
                expected=CONVROT_GROUP_SIZE,
                actual=group,
            )
        )
    if scheme == "fp8_e4m3" and group is not None:
        out.append(
            err(
                UNSUPPORTED,
                "線上 FP8 是 per-channel，沒有 group_size",
                f"{base}.quantization.group_size",
            )
        )
    out.extend(
        err(UNSUPPORTED, f"線上量化不讀 {key}", f"{base}.quantization.{key}")
        for key in ("weights_ref", "calibration_ref")
        if quant.get(key) is not None
    )
    if comp.get("weight_format", "native") != "native":
        out.append(
            err(
                UNSUPPORTED,
                "線上量化只接受原生 BF16 checkpoint（weight_format=native）",
                f"{base}.weight_format",
                expected="native",
                actual=comp.get("weight_format"),
            )
        )
    if comp.get("offload", "block") not in ONLINE_QUANT_OFFLOADS:
        out.append(
            err(
                UNSUPPORTED,
                "線上量化 DiT 只驗證 offload=none|block（上游 cookbook 配方為 layerwise）",
                f"{base}.offload",
                expected="none|block",
                actual=comp.get("offload"),
            )
        )
