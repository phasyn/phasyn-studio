"""DiT acceleration choices the pinned SGLang can honour (pure Python, no torch).

Three families, all ``approximate`` — every one changes numerics:

* **Online quantization of a native BF16 DiT**:
  ``int8_convrot``/``sglang_native`` → SGLang ``--quantization convrot_int8``
  (``ConvRotInt8Config``, JIT backend, group 256: W8A8 with a group-wise Hadamard
  rotation, ``layers/quantization/configs/convrot_int8_config.py``) and
  ``fp8_e4m3``/``sglang_native`` → ``--quantization fp8`` (``Fp8Config``,
  per-output-channel E4M3 weights × per-token dynamic E4M3 activations,
  ``layers/quantization/fp8.py:296-316``), quantized one layer at a time by the
  shim's runtime patch ``fp8_layerwise_quant.v1``.
  ``adaln_proj`` always stays BF16 (``quantization_ignored_layers``).
* **Approximate DiT attention**: ``fp8_fa_sm120`` (SM 12.0
  only, ``platforms/cuda.py:520-547``) and ``subblock_sparse_attn`` (SM 9.0/10.0/
  12.0, ``backends/subblock_sparse_attn.py``) — selected for the transformer only
  (``component_attention_backends``) so the text encoder and VAEs keep SDPA.
* **AdaLN cache/online × online quantization**: allowed by the shim's runtime
  patch of ``minimax_h3.py:2154-2159``, never for
  pre-quantized checkpoints.

Everything here only validates and describes; ``upstream_patches``,
``attention_runtime`` and ``accel_load`` do the torch/SGLang work.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .errors import UnsupportedCombination


# (profile scheme, profile provider) -> SGLang ``--quantization`` method name.
ONLINE_QUANT_METHODS: Mapping[tuple[str, str], str] = {
    ("int8_convrot", "sglang_native"): "convrot_int8",
    ("fp8_e4m3", "sglang_native"): "fp8",
}
# ``--quantization convrot_int8`` builds ``ConvRotInt8Config(ignored_layers=...)``
# with its default group size (transformer_load_utils.py:1059-1065); the CLI path
# has no group-size knob, so the profile may only state the default.
CONVROT_GROUP_SIZE = 256
# The shim pins the JIT backend (env SGLANG_DIFFUSION_CONVROT_INT8_BACKEND) so
# ``auto`` can never fall back to comfy_kitchen or BF16 without a word.
CONVROT_BACKEND = "jit"
# Exact capabilities the convrot_int8 JIT ops carry code for
# (sglang/kernels/ops/gemm/convrot_int8.py SUPPORTED_CAPABILITIES).
CONVROT_JIT_CAPABILITIES: tuple[tuple[int, int], ...] = (
    (9, 0),
    (10, 0),
    (12, 0),
    (12, 1),
)
# E4M3 tensor cores start at CC 8.9; below it the pinned Fp8LinearMethod switches to Marlin weight-only
# FP8 (W8A16, fp8_utils.py can_auto_enable_marlin_fp8), which is not the W8A8 the profile asks for.
FP8_W8A8_MIN_CAPABILITY = (8, 9)
FP8_PATCH_ID = (
    "fp8_layerwise_quant.v1"  # upstream_patches (torch-free copy for provenance)
)
# Modules that are never quantized by the shim (module-path patterns as matched by
# srt ``is_layer_skipped``): the AdaLN projections must stay BF16 so a cache /
# online rebuild from the BF16 checkpoint reproduces them exactly.
ALWAYS_EXCLUDED_MODULES: tuple[str, ...] = ("adaln_proj",)
ONLINE_QUANT_OFFLOADS = ("none", "block")
_PATTERN_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.]*$")


@dataclass(frozen=True)
class AttentionSpec:
    """Describe the requested attention backend and its parameters."""

    provider: str
    sglang_backend: str  # AttentionBackendEnum name, lower case
    capabilities: tuple[tuple[int, int], ...]
    takes_params: bool
    reason_code: str


APPROXIMATE_ATTENTION: Mapping[str, AttentionSpec] = {
    "fp8_fa_sm120": AttentionSpec(
        provider="fp8_fa_sm120",
        sglang_backend="fp8_fa_sm120",
        capabilities=((12, 0),),
        takes_params=False,
        reason_code="FP8_FA_SM120_ONLY",
    ),
    "subblock_sparse_attn": AttentionSpec(
        provider="subblock_sparse_attn",
        sglang_backend="subblock_sparse_attn",
        capabilities=((9, 0), (10, 0), (12, 0)),
        takes_params=True,
        reason_code="SUBBLOCK_SM_UNSUPPORTED",
    ),
}
# Providers whose dense fallback / excluded region runs Torch SDPA, so the MATH
# kernel guard (reject_quadratic_materialization) must cover them too.
SDPA_BACKED_PROVIDERS = ("pytorch_sdpa", "fp8_fa_sm120", "subblock_sparse_attn")

# SubBlock schedule keys (SubBlockSparseSchedule, subblock_sparse_attn.py:405-454).
SUBBLOCK_KEYS = (
    "sparsity",
    "skip_first_steps",
    "skip_first_layers",
    "n_k",
    "n_q",
    "min_seq_len",
    "compute_mode",
)
SUBBLOCK_COMPUTE_MODES = ("bf16", "sage_fp8")
SUBBLOCK_POWERS = (1, 2, 4, 8)


def _reject(
    reason: str, message: str, field_path: str | None = None, **kwargs: Any
) -> UnsupportedCombination:
    return UnsupportedCombination(reason, message, field_path=field_path, **kwargs)


# ---------------------------------------------------------------------------
# online quantization


def online_quant_method(scheme: str, provider: str) -> str | None:
    """Return the online weight quantization method."""
    return ONLINE_QUANT_METHODS.get((str(scheme), str(provider)))


def quantization_ignored_layers(excluded: Sequence[str] | None) -> tuple[str, ...]:
    """Profile ``excluded_modules`` plus the mandatory BF16 modules (sorted, unique)."""
    patterns = set(ALWAYS_EXCLUDED_MODULES)
    for item in excluded or ():
        text = str(item).strip()
        if not _PATTERN_RE.match(text):
            raise _reject(
                "QUANT_EXCLUDED_MODULE_INVALID",
                f"excluded_modules 項目 {item!r} 不是模組路徑（只接受 a.b.c 形式，按 SGLang is_layer_skipped 比對）",
                "components.transformer.quantization.excluded_modules",
            )
        patterns.add(text)
    return tuple(sorted(patterns))


def validate_online_quant(
    component: str, profile_component: Mapping[str, Any], *, mode: str
) -> str:
    """Validate an online-quantization request; returns the SGLang method name."""
    path = f"components.{component}"
    quant = profile_component.get("quantization") or {}
    scheme = str(quant.get("scheme", "none"))
    provider = str(quant.get("provider", "native"))
    method = online_quant_method(scheme, provider)
    if method is None:
        raise _reject(
            "QUANT_SCHEME_NOT_WIRED",
            f"{component}: {scheme}/{provider} 不是線上量化路徑",
            f"{path}.quantization",
        )
    if component != "transformer":
        raise _reject(
            "ONLINE_QUANT_TRANSFORMER_ONLY",
            f"{scheme}/{provider} 只接到 DiT（SGLang --quantization 只作用於 transformer loader）；{component} 不可用",
            f"{path}.quantization",
        )
    if mode == "exact":
        raise _reject(
            "ONLINE_QUANT_NOT_EXACT",
            f"{scheme} 是近似量化（W8A8／FP8），只能用於 mode=approximate|experimental",
            "mode",
        )
    if str(profile_component.get("weight_format", "native")) != "native":
        raise _reject(
            "ONLINE_QUANT_NEEDS_NATIVE_WEIGHTS",
            "線上量化只接受原生 BF16 checkpoint（weight_format=native）；預量化／單檔權重請用對應格式",
            f"{path}.weight_format",
        )
    for key in ("weights_ref", "calibration_ref"):
        if quant.get(key) is not None:
            raise _reject(
                "ONLINE_QUANT_REF_UNSUPPORTED",
                f"線上量化沒有 {key}（權重在載入時由 BF16 量化，不讀外部檔）",
                f"{path}.quantization.{key}",
            )
    group = quant.get("group_size")
    if method == "convrot_int8" and group not in (None, CONVROT_GROUP_SIZE):
        raise _reject(
            "CONVROT_GROUP_SIZE_UNSUPPORTED",
            f"釘版 SGLang 的 --quantization convrot_int8 固定 group {CONVROT_GROUP_SIZE}"
            "（transformer_load_utils.py:1059-1065 不傳 group_size）；其他 group 不默默改寫",
            f"{path}.quantization.group_size",
            expected=CONVROT_GROUP_SIZE,
            actual=group,
        )
    if method == "fp8" and group is not None:
        raise _reject(
            "FP8_GROUP_SIZE_UNSUPPORTED",
            "釘版線上 FP8 是 per-channel（fp8.py:300-313），沒有 group_size",
            f"{path}.quantization.group_size",
        )
    offload = str(profile_component.get("offload", "block"))
    if offload not in ONLINE_QUANT_OFFLOADS:
        raise _reject(
            "ONLINE_QUANT_OFFLOAD_UNSUPPORTED",
            f"線上量化 DiT 只驗證 offload=none|block（cookbook 配方為 layerwise）；收到 {offload}",
            f"{path}.offload",
        )
    quantization_ignored_layers(quant.get("excluded_modules"))
    return method


@dataclass(frozen=True)
class QuantPlan:
    """Effective online quantization of the DiT (recorded in provenance)."""

    scheme: str
    provider: str
    sglang_method: str
    group_size: int | None
    backend: str | None
    ignored_layers: tuple[str, ...]
    requires_jit_toolchain: bool
    # True would mean the whole DiT is moved to the device to quantize (transformer_load_utils.py:820-837);
    # convrot never does, online FP8 does not under the shim's fp8_layerwise_quant.v1
    device_postprocess: bool
    runtime_patch: str | None = None

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {
            "scheme": self.scheme,
            "provider": self.provider,
            "sglang_quantization": self.sglang_method,
            "group_size": self.group_size,
            "backend": self.backend,
            "ignored_layers": list(self.ignored_layers),
            "requires_jit_toolchain": self.requires_jit_toolchain,
            "device_postprocess": self.device_postprocess,
            "runtime_patch": self.runtime_patch,
        }


def quant_plan(profile_component: Mapping[str, Any] | None) -> QuantPlan | None:
    """Resolve the quantization policy to apply during model loading."""
    quant = (profile_component or {}).get("quantization") or {}
    scheme = str(quant.get("scheme", "none"))
    provider = str(quant.get("provider", "native"))
    method = online_quant_method(scheme, provider)
    if method is None:
        return None
    convrot = method == "convrot_int8"
    return QuantPlan(
        scheme=scheme,
        provider=provider,
        sglang_method=method,
        group_size=CONVROT_GROUP_SIZE if convrot else None,
        backend=CONVROT_BACKEND if convrot else None,
        ignored_layers=quantization_ignored_layers(quant.get("excluded_modules")),
        requires_jit_toolchain=convrot,
        device_postprocess=False,  # convrot: own per-layer round trip; fp8: fp8_layerwise_quant.v1
        runtime_patch=None if convrot else FP8_PATCH_ID,
    )


def quant_variant(profile_component: Mapping[str, Any] | None) -> str:
    """``ComponentLoadSpec.variant_key`` part for an online-quantized DiT ("" otherwise).

    scheme/provider are already in the single-flight key; the BF16-kept layers are not,
    so a DiT built with other ``excluded_modules`` must not be reused.
    """
    plan = quant_plan(profile_component)
    if plan is None:
        return ""
    return f"quant={plan.sglang_method}:{','.join(plan.ignored_layers)}"


# ---------------------------------------------------------------------------
# attention


def attention_spec(provider: str) -> AttentionSpec | None:
    """Read the requested attention backend from the profile."""
    return APPROXIMATE_ATTENTION.get(str(provider))


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def validate_subblock_params(raw: Any) -> dict[str, Any]:
    """Explicit SubBlock schedule from ``attention.subblock_sparse`` (no hidden defaults)."""
    base = "attention.subblock_sparse"
    if not isinstance(raw, Mapping):
        raise _reject(
            "SUBBLOCK_PARAMS_MISSING",
            "subblock_sparse_attn 需要 attention.subblock_sparse（sparsity、skip_first_steps、skip_first_layers、"
            "n_k、n_q、min_seq_len、compute_mode 全部明示；不套用 SGLang 隱含預設）",
            base,
        )
    missing = [k for k in SUBBLOCK_KEYS if k not in raw]
    unknown = sorted(set(raw) - set(SUBBLOCK_KEYS))
    if missing or unknown:
        raise _reject(
            "SUBBLOCK_PARAMS_INVALID",
            f"attention.subblock_sparse 欄位不完整或有未知欄位（缺 {missing}，未知 {unknown}）",
            base,
        )
    sparsity = _number(raw["sparsity"])
    if sparsity is None or not math.isfinite(sparsity) or not 0.0 <= sparsity < 1.0:
        raise _reject(
            "SUBBLOCK_PARAMS_INVALID", "sparsity 必須在 [0, 1)", f"{base}.sparsity"
        )
    out: dict[str, Any] = {"sparsity": sparsity}
    for key in ("skip_first_steps", "skip_first_layers", "min_seq_len"):
        value = raw[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise _reject(
                "SUBBLOCK_PARAMS_INVALID", f"{key} 必須是非負整數", f"{base}.{key}"
            )
        out[key] = int(value)
    for key in ("n_k", "n_q"):
        value = raw[key]
        if isinstance(value, bool) or value not in SUBBLOCK_POWERS:
            raise _reject(
                "SUBBLOCK_PARAMS_INVALID", f"{key} 必須是 1、2、4 或 8", f"{base}.{key}"
            )
        out[key] = int(value)
    mode = raw["compute_mode"]
    if mode not in SUBBLOCK_COMPUTE_MODES:
        raise _reject(
            "SUBBLOCK_PARAMS_INVALID",
            "compute_mode 必須是 bf16 或 sage_fp8",
            f"{base}.compute_mode",
        )
    out["compute_mode"] = str(mode)
    return out


@dataclass(frozen=True)
class AttentionPlan:
    """Record which attention backend will serve the configured model."""

    provider: str
    sglang_backend: str
    approximate: bool
    backend_config: Mapping[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {
            "provider": self.provider,
            "sglang_backend": self.sglang_backend,
            "approximate": self.approximate,
            "backend_config": dict(self.backend_config),
        }


def validate_approximate_attention(
    profile: Mapping[str, Any],
    provider: str,
    *,
    sm: tuple[int, int] | None,
    sm_major: int | None,
    check_device: bool = True,
) -> AttentionPlan:
    """Rules for an approximate DiT attention provider; returns its plan.

    ``check_device`` is False for stages that never run the DiT attention (text
    encoder, VAEs, CPU stages): the provider is a DiT setting and those stages
    keep exact SDPA, so only the profile-level rules apply there.
    """
    spec = APPROXIMATE_ATTENTION[provider]
    attention = profile.get("attention") or {}
    if str(profile.get("mode", "exact")) == "exact":
        raise _reject(
            "APPROXIMATE_ATTENTION_NOT_EXACT",
            f"{provider} 是近似 attention（FP8 量化或區塊稀疏），只能用於 mode=approximate|experimental（/026）",
            "mode",
        )
    if attention.get("kernel_variant") is not None:
        raise _reject(
            "ATTENTION_KERNEL_VARIANT_UNSUPPORTED",
            f"{provider} 沒有 kernel_variant 選項（不默默忽略使用者值）；SubBlock 的計算模式用 subblock_sparse.compute_mode",
            "attention.kernel_variant",
        )
    allowed_majors = sorted({major for major, _ in spec.capabilities})
    if not check_device:
        pass
    elif sm is not None:
        if tuple(sm) not in spec.capabilities:
            raise _reject(
                spec.reason_code,
                f"{provider} 在釘版 SGLang 只支援 compute capability {list(spec.capabilities)}；"
                f"此裝置 {tuple(sm)}（resolver 會默默改走 cuDNN SDPA 或直接報錯，shim 先拒絕）",
                "attention.provider",
                expected=[f"{a}.{b}" for a, b in spec.capabilities],
                actual=f"{sm[0]}.{sm[1]}",
            )
    elif sm_major is None or sm_major not in allowed_majors:
        raise _reject(
            spec.reason_code,
            f"{provider} 需要已知且受支援的 compute capability {list(spec.capabilities)}（未知 SM 一律拒絕）",
            "attention.provider",
            expected=[f"{a}.{b}" for a, b in spec.capabilities],
            actual=sm_major,
        )
    params = attention.get("subblock_sparse")
    config: dict[str, Any] = {}
    if spec.takes_params:
        config = validate_subblock_params(params)
    elif params is not None:
        raise _reject(
            "ATTENTION_PARAMS_UNEXPECTED",
            f"attention.subblock_sparse 只屬於 subblock_sparse_attn；{provider} 不接受（不默默忽略）",
            "attention.subblock_sparse",
        )
    return AttentionPlan(
        provider=provider,
        sglang_backend=spec.sglang_backend,
        approximate=True,
        backend_config=config,
    )


def reject_stray_attention_params(profile: Mapping[str, Any], provider: str) -> None:
    """Reject parameters outside the selected attention configuration."""
    if (
        provider not in APPROXIMATE_ATTENTION
        and (profile.get("attention") or {}).get("subblock_sparse") is not None
    ):
        raise _reject(
            "ATTENTION_PARAMS_UNEXPECTED",
            f"attention.subblock_sparse 只屬於 subblock_sparse_attn；provider={provider} 時必須為 null",
            "attention.subblock_sparse",
        )


def attention_plan(
    provider_effective: str, sglang_backend: str, profile: Mapping[str, Any]
) -> AttentionPlan:
    """Plan for an already-validated stage policy (re-reads the frozen profile)."""
    spec = attention_spec(provider_effective)
    if spec is None:
        return AttentionPlan(
            provider=provider_effective,
            sglang_backend=sglang_backend,
            approximate=False,
        )
    config = (
        validate_subblock_params(
            (profile.get("attention") or {}).get("subblock_sparse")
        )
        if spec.takes_params
        else {}
    )
    return AttentionPlan(
        provider=spec.provider,
        sglang_backend=spec.sglang_backend,
        approximate=True,
        backend_config=config,
    )


# ---------------------------------------------------------------------------
# AdaLN x quantization


def adaln_quant_method(profile_component: Mapping[str, Any] | None) -> str | None:
    """SGLang method the AdaLN relaxation may admit, or None (upstream rejection stands)."""
    plan = quant_plan(profile_component)
    return None if plan is None else plan.sglang_method


# ---------------------------------------------------------------------------
# ServerArgs knobs


def server_args_overrides(
    *,
    transformer_component: Mapping[str, Any] | None,
    attention: AttentionPlan,
    dit_stage: bool = True,
) -> dict[str, Any]:
    """Explicit ServerArgs entries for the effective acceleration (empty when inactive).

    Only DiT stages carry them: H3's ``validate_server_args`` resolves the
    transformer attention backend on the *current* device when ServerArgs are
    built (``configs/pipeline_configs/minimax_h3.py:248-318``), so a VAE stage on
    another GPU generation would otherwise fail on a SubBlock / sage_fp8 request it never runs.
    """
    out: dict[str, Any] = {}
    if not dit_stage:
        # the DiT kernel never runs here; the text encoder / VAEs keep exact SDPA
        return {"attention_backend": "torch_sdpa"} if attention.approximate else out
    plan = quant_plan(transformer_component)
    if plan is not None:
        out["quantization"] = plan.sglang_method
        out["quantization_ignored_layers"] = list(plan.ignored_layers)
    if attention.approximate:
        # global stays exact SDPA; only the DiT gets the approximate kernel (the H3
        # DiT keeps a deferred component override, minimax_h3.py:2300-2303, 2395-2421)
        out["attention_backend"] = "torch_sdpa"
        out["component_attention_backends"] = {"transformer": attention.sglang_backend}
        if attention.backend_config:
            out["attention_backend_config"] = dict(attention.backend_config)
    return out


def effective_summary(
    *,
    transformer_component: Mapping[str, Any] | None,
    attention: AttentionPlan,
    adaln_mode: str,
) -> dict[str, Any]:
    """Provenance record of what the shim asks SGLang to run (approximate knobs only)."""
    plan = quant_plan(transformer_component)
    return {
        "quantization": None if plan is None else plan.as_dict(),
        "attention": attention.as_dict(),
        "adaln": {
            "mode": adaln_mode,
            "with_online_quant": adaln_mode != "off" and plan is not None,
            "deviation": "" if adaln_mode != "off" and plan is not None else None,
        },
    }


__all__ = [
    "ALWAYS_EXCLUDED_MODULES",
    "APPROXIMATE_ATTENTION",
    "CONVROT_BACKEND",
    "CONVROT_GROUP_SIZE",
    "CONVROT_JIT_CAPABILITIES",
    "FP8_PATCH_ID",
    "FP8_W8A8_MIN_CAPABILITY",
    "ONLINE_QUANT_METHODS",
    "SDPA_BACKED_PROVIDERS",
    "SUBBLOCK_KEYS",
    "AttentionPlan",
    "AttentionSpec",
    "QuantPlan",
    "adaln_quant_method",
    "attention_plan",
    "attention_spec",
    "effective_summary",
    "online_quant_method",
    "quant_plan",
    "quant_variant",
    "quantization_ignored_layers",
    "reject_stray_attention_params",
    "server_args_overrides",
    "validate_approximate_attention",
    "validate_online_quant",
    "validate_subblock_params",
]
