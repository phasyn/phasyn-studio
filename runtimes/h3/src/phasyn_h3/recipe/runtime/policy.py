"""Effective runtime policy for one H3 stage (pure Python, no torch).

Turns the frozen ``plan["effective_profile"]`` plus the exact-memory fallback
level into the knobs the pinned SGLang runtime can honour — and rejects, with a
reason code, every request it cannot honour exactly instead of letting SGLang
clamp or auto-tune it.

"""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, NamedTuple, TypedDict, Unpack

from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.adapter import ref_kv_rules
from phasyn_h3.recipe.adapter.profile_rules import host_residency_refusal

from . import SGLANG_SOURCE_REVISION, denoise_cache_rules, regional_compile_rules
from ._arguments import validate_keywords
from .acceleration import (
    APPROXIMATE_ATTENTION,
    adaln_quant_method,
    online_quant_method,
    reject_stray_attention_params,
    validate_approximate_attention,
    validate_online_quant,
)
from .errors import UnsupportedCombination
from .lora_policy import LoraPolicy, resolve_lora_policy


class _StageOverrides(TypedDict, total=False):
    memory_level: int
    adapter_overrides: Mapping[str, Mapping[str, Any]] | None
    sm_major: int | None
    sm: tuple[int, int] | None


COMPONENT_KEYS = ("text_encoder", "transformer", "video_vae", "audio_vae")

# Which profile component a stage kind loads (None: no model component).
STAGE_PRIMARY_COMPONENT: dict[str, str | None] = {
    "prepare_media": None,
    "encode_conditioning": "text_encoder",
    "encode_references": "video_vae",
    "prepare_adaln": "transformer",
    "load_dit": "transformer",
    "assemble_inputs": None,
    "denoise_av": "transformer",
    "decode_video": "video_vae",
    "decode_audio": "audio_vae",
}
# Components validated up-front; encode_references validates audio_vae only when
# the prepared materials actually contain audio references.
STAGE_COMPONENTS: dict[str, tuple[str, ...]] = {
    "prepare_media": (),
    "encode_conditioning": ("text_encoder",),
    "encode_references": ("video_vae",),
    "prepare_adaln": (),
    "load_dit": ("transformer",),
    "assemble_inputs": (),
    "denoise_av": ("transformer",),
    "decode_video": ("video_vae",),
    "decode_audio": ("audio_vae",),
}

# Native compute dtypes of the pinned pipeline (configs/pipeline_configs/minimax_h3.py:53-65).
NATIVE_COMPUTE_DTYPE = {
    "text_encoder": "bf16",
    "transformer": "bf16",
    "video_vae": "fp32",
    "audio_vae": "fp32",
}
# Video VAE decode precision (components.video_vae.compute_dtype).  The released
# weights are FP32 (official precision): ``native``/``fp32`` decode without
# autocast and keep every decoder weight FP32 (exact).  ``fp16`` is the pinned
# pipeline's speed recipe (``vae_decode_precision="fp16"``: decoder linears
# rounded to FP16 at load, vae_loader.py:267-311, FP16 autocast decode,
# decoding.py:467-477); only an approximate/experimental profile may ask for it.
# Encoding always runs FP32 (keyframe_encoding.py:77-95), except the opt-in
# frame-streaming reference-video encode of an approximate ``fp16`` encode
# component (stages/vae_frame_streaming.py; ``encode_references`` refuses fp16
# without it).
VIDEO_VAE_DECODE_DTYPES = ("fp32", "fp16")

# Layer groups the pinned layerwise offload manager can stream
# (minimax_h3.py:2270-2274, vaes/minimax_h3.py:20-24, 91-100).
LAYERWISE_GROUPS = {
    "transformer": ("blocks", "token_refiner.blocks"),
    "video_vae": ("decoder.transformer_blocks",),
    "audio_vae": (
        "encoder.block",
        "decoder.resblocks",
        *(f"decoder.ups.{i}" for i in range(7)),
    ),
    "text_encoder": ("model.language_model.layers", "model.visual.blocks"),
}
DIT_NUM_LAYERS = 50

SUPPORTED_OFFLOADS = ("none", "component", "block")

# Where a component's weights live *between* uses (profile extension
# ``phasyn.sglang_h3.residency``).  ``device``: stay on the GPU (the component
# process keeps it); ``host``: the GPU copy is released after the stage
# and the weights stay in host memory -- pinned up to ``max_pinned_bytes``, the
# rest pageable -- for a fast reload; when the host cannot hold them they are
# dropped instead (reported, never silent); ``drop``: released completely, the
# next use reloads from the checkpoint (page cache / mmap).
RESIDENCY_EXTENSION = "phasyn.sglang_h3.residency"
AFTER_USE_CHOICES = ("device", "host", "drop")
DEFAULT_AFTER_USE = {"none": "device", "component": "host", "block": "device"}
MAX_IDLE_UNLOAD_SECONDS = 7 * 24 * 3600
ATTENTION_EXECUTABLE = {
    # profile provider -> SGLang AttentionBackendEnum name (lower-case CLI form)
    "pytorch_sdpa": "torch_sdpa",
    "flash_attention_3": "fa",
    "flash_attention_4": "fa",
    # approximate, DiT-only; SM/mode/params gated by
    # acceleration.validate_approximate_attention
    "fp8_fa_sm120": "fp8_fa_sm120",
    "subblock_sparse_attn": "subblock_sparse_attn",
}
# Pinned SGLang decides which FlashAttention generation its single `fa` backend
# runs from the SM major: FA3 by default (flash_attn.py:303), FA4 only after
# set_fa_ver(4) on SM10.x (cuda.py:724-744, is_blackwell == major 10), and SDPA
# on SM12.x (cuda.py:507-517).  A provider is executable only where `fa` really
# is that generation.
FA_GENERATION_SM_MAJOR = {"flash_attention_3": (8, 9), "flash_attention_4": (10,)}
EXTENSION_NAMESPACE = "phasyn.sglang_h3.checkpoint"


@dataclass(frozen=True)
class ResidencyPolicy:
    """Between-use placement of one component (``phasyn.sglang_h3.residency``)."""

    after_use: str  # device | host | drop
    source: str  # "extension" | "offload_default"
    # idle unload of the process holding this component (profile value, not used by phasyn_h3): only
    # meaningful when ``idle_override``; then None means "never unload while held".
    idle_unload_seconds: int | None = None
    idle_override: bool = False

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        doc: dict[str, Any] = {"after_use": self.after_use, "source": self.source}
        if self.idle_override:
            doc["idle_unload_seconds"] = self.idle_unload_seconds
        return doc


DEFAULT_RESIDENCY = ResidencyPolicy("device", "offload_default")


@dataclass(frozen=True)
class ComponentPolicy:
    """Specify how one component is placed, streamed or quantized."""

    component: str
    compute_dtype: str  # resolved, e.g. "bf16"
    weight_format: str
    quant_scheme: str
    quant_provider: str
    offload: str
    resident_layers: int
    prefetch_depth: int
    max_pinned_bytes: int
    sglang_residency_policy: str  # "leading"
    excluded_modules: tuple[str, ...] = ()
    residency: ResidencyPolicy = DEFAULT_RESIDENCY

    @property
    def layerwise(self) -> bool:
        """Check whether the component streams weights by layer."""
        return self.offload == "block"

    @property
    def component_cpu_offload(self) -> bool:
        """Check whether this component offloads its weights to the CPU."""
        return self.offload == "component"

    @property
    def quantized(self) -> bool:
        """Check whether this component uses quantized weights."""
        return self.quant_scheme != "none"

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {
            "component": self.component,
            "compute_dtype": self.compute_dtype,
            "weight_format": self.weight_format,
            "quantization": {
                "scheme": self.quant_scheme,
                "provider": self.quant_provider,
            },
            "offload": self.offload,
            "resident_layers": self.resident_layers,
            "prefetch_depth": self.prefetch_depth,
            "max_pinned_bytes": self.max_pinned_bytes,
            "sglang_residency_policy": self.sglang_residency_policy,
            "residency": self.residency.as_dict(),
        }


@dataclass(frozen=True)
class CheckpointDeclaration:
    """Facts a checkpoint header cannot prove, declared via the profile extension."""

    transformer_qkv_layout: str | None = None  # "concat" | "grouped"
    transformer_architecture: str | None = None  # "dense" | "pruned_curve"


@dataclass(frozen=True)
class StagePolicy:
    """Specify the execution and residency choices for a stage."""

    stage_kind: str
    mode: str
    attention_provider_requested: str
    attention_provider_effective: str
    sglang_attention_backend: str
    reject_quadratic_materialization: bool
    adaln_mode: str
    adaln_host_cache_bytes: int
    vae: Mapping[str, Any]
    limits: Mapping[str, Any]
    components: Mapping[str, ComponentPolicy]
    declaration: CheckpointDeclaration
    memory_level: int
    applied_overrides: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    effective_profile: Mapping[str, Any] = field(default_factory=dict)
    lora: LoraPolicy | None = (
        None  # plan LoRAs as the DiT actor applies them (lora_policy.py)
    )
    # parsed ``phasyn.sglang_h3.residency`` values (component -> settings)
    residency_values: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # ``phasyn.sglang_h3.ref_kv_cache`` (reference-row K/V cache, mode skip); None = off (no extension)
    ref_kv_cache: ref_kv_rules.RefKvCachePolicy | None = None

    @property
    def active_profile_digest(self) -> str:
        """Identify the exact active execution profile."""
        return canonical_digest(self.effective_profile)


def _reject(
    reason: str, message: str, field_path: str | None = None, **kwargs: Any
) -> UnsupportedCombination:
    return UnsupportedCombination(reason, message, field_path=field_path, **kwargs)


# ---------------------------------------------------------------------------
# exact-memory fallback (same dtype & math; resident→block, prefetch↓)


def exact_memory_ladder(component_profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Deterministic exact-memory candidates after level 0 for one component.

    Only residency/prefetch change; dtype, quantization, geometry and steps never
    do.  ``leaf``/``nvme`` are not offered because the pinned runtime
    has no such path.
    """
    offload = component_profile.get("offload", "block")
    resident = int(component_profile.get("resident_layers", 0))
    prefetch = int(component_profile.get("prefetch_depth", 1))
    quantized = (component_profile.get("quantization") or {}).get(
        "scheme", "none"
    ) != "none"
    if quantized:
        return []  # bnb DiT must stay resident (transformer_load_utils.py:446-511)
    ladder: list[dict[str, Any]] = []
    if offload in ("none", "component"):
        ladder.append({"offload": "block", "resident_layers": 0, "prefetch_depth": 1})
        return ladder
    if offload == "block":
        if resident > 0:
            ladder.append({"resident_layers": 0})
        if prefetch > 1:
            ladder.append({"prefetch_depth": 1})
    return ladder


def overrides_for_level(
    component_profile: Mapping[str, Any],
    level: int,
    adapter_overrides: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Cumulative overrides for ``level`` (0 = none).

    ``adapter_overrides`` wins when the adapter publishes the frozen candidate for
    this level; the built-in ladder is the deterministic fallback.
    """
    if level < 0:
        raise _reject("MEMORY_LEVEL_INVALID", f"memory_level 必須 >= 0，收到 {level}")
    if level == 0:
        return dict(adapter_overrides or {})
    if adapter_overrides is not None:
        return dict(adapter_overrides)
    ladder = exact_memory_ladder(component_profile)
    if level > len(ladder):
        raise _reject(
            "NO_EXACT_MEMORY_FALLBACK",
            f"exact_memory_only 沒有第 {level} 級候選（只有 {len(ladder)} 級可用）；不改 dtype/幾何/步數",
            "fallback_policy",
        )
    merged: dict[str, Any] = {}
    for step in ladder[:level]:
        merged.update(step)
    return merged


# ---------------------------------------------------------------------------
# component policy


def _resolve_dtype(component: str, requested: str, mode: str = "exact") -> str:
    native = NATIVE_COMPUTE_DTYPE[component]
    if requested in ("native", native):
        return native
    if component == "video_vae" and requested in VIDEO_VAE_DECODE_DTYPES:
        if mode == "exact":
            raise _reject(
                "VAE_FP16_DECODE_NOT_EXACT",
                "video_vae compute_dtype=fp16 是 FP16 autocast 解碼（decoder linear 以 FP16 存放），"
                "不是官方 FP32 精度；exact profile 只接受 native／fp32",
                f"components.{component}.compute_dtype",
                expected="native | fp32",
                actual=requested,
            )
        return requested
    raise _reject(
        "COMPUTE_DTYPE_OVERRIDE_UNSUPPORTED",
        f"{component} compute_dtype={requested} 與釘版原生 {native} 不同；shim 不實作 dtype 改寫",
        f"components.{component}.compute_dtype",
    )


def _resolve_residency(
    component: str,
    values: Mapping[str, Any] | None,
    *,
    offload: str,
    quant_scheme: str = "none",
    quant_provider: str = "native",
) -> ResidencyPolicy:
    """Between-use placement; ``values`` come from the residency extension."""
    path = f"extensions[{RESIDENCY_EXTENSION}].{component}"
    if values is None:
        return ResidencyPolicy(
            DEFAULT_AFTER_USE.get(offload, "device"), "offload_default"
        )
    after_use = values.get("after_use")
    if after_use not in AFTER_USE_CHOICES:
        raise _reject(
            "RESIDENCY_VALUE_INVALID",
            f"{component}.after_use={after_use!r} 不合法（只接受 {', '.join(AFTER_USE_CHOICES)}）",
            f"{path}.after_use",
        )
    refusal = (
        host_residency_refusal(component, quant_scheme, quant_provider)
        if after_use == "host"
        else None
    )
    if refusal is not None:
        raise _reject(
            "HOST_RESIDENCY_QUANTIZED_UNVALIDATED", refusal, f"{path}.after_use"
        )
    if offload == "component" and after_use == "device":
        raise _reject(
            "AFTER_USE_CONFLICTS_WITH_OFFLOAD",
            f"{component}.offload=component 的權重在兩次使用之間本來就放在 host；after_use=device 自相矛盾",
            f"{path}.after_use",
        )
    override = "idle_unload_seconds" in values
    idle = values.get("idle_unload_seconds")
    if override:
        if after_use == "drop":
            raise _reject(
                "RESIDENCY_IDLE_WITHOUT_RESIDENCY",
                f"{component}.after_use=drop 不保留權重，idle_unload_seconds 無作用（不默默忽略）",
                f"{path}.idle_unload_seconds",
            )
        if idle is not None and (
            isinstance(idle, bool)
            or not isinstance(idle, int)
            or not 0 <= idle <= MAX_IDLE_UNLOAD_SECONDS
        ):
            raise _reject(
                "RESIDENCY_VALUE_INVALID",
                f"{component}.idle_unload_seconds 必須是 0..{MAX_IDLE_UNLOAD_SECONDS} 的整數或 null（永不卸載）",
                f"{path}.idle_unload_seconds",
            )
    return ResidencyPolicy(
        str(after_use), "extension", idle if override else None, override
    )


def resolve_component_policy(
    component: str,
    profile_component: Mapping[str, Any],
    *,
    mode: str,
    manifest_format: str | None = None,
    residency: Mapping[str, Any] | None = None,
) -> ComponentPolicy:
    """Resolve residency and precision settings for the component."""
    path = f"components.{component}"
    quant = profile_component.get("quantization") or {}
    scheme = str(quant.get("scheme", "none"))
    provider = str(quant.get("provider", "native"))
    weight_format = str(profile_component.get("weight_format", "native"))
    offload = str(profile_component.get("offload", "block"))
    resident = int(profile_component.get("resident_layers", 0))
    blocks_per_group = int(profile_component.get("blocks_per_group", 1))
    prefetch = int(profile_component.get("prefetch_depth", 1))
    max_pinned = int(profile_component.get("max_pinned_bytes", 8 * 1024**3))
    residency_policy = str(profile_component.get("residency_policy", "prefix"))
    indices = list(profile_component.get("resident_layer_indices") or [])
    dtype = _resolve_dtype(
        component, str(profile_component.get("compute_dtype", "native")), mode
    )

    # ---- weight format / quantization (/020) ----
    _check_quantization(
        _CheckQuantizationInputs(
            weight_format,
            manifest_format,
            component,
            path,
            scheme,
            provider,
            mode,
            offload,
            profile_component,
        )
    )

    # ---- offload / residency ----
    if offload not in SUPPORTED_OFFLOADS:
        reason = (
            "OFFLOAD_LEAF_UNSUPPORTED"
            if offload == "leaf"
            else "OFFLOAD_NVME_UNSUPPORTED"
        )
        raise _reject(
            reason,
            f"{component}: offload={offload} 在釘版 SGLang 沒有對應路徑（只有 component 與 layerwise block）",
            f"{path}.offload",
        )
    sglang_policy = _block_residency(
        _BlockResidencyInputs(
            offload,
            prefetch,
            path,
            blocks_per_group,
            residency_policy,
            indices,
            component,
            resident,
        )
    )
    return ComponentPolicy(
        component=component,
        compute_dtype=dtype,
        weight_format=weight_format,
        quant_scheme=scheme,
        quant_provider=provider,
        offload=offload,
        resident_layers=resident,
        prefetch_depth=prefetch,
        max_pinned_bytes=max_pinned,
        sglang_residency_policy=sglang_policy,
        excluded_modules=tuple(quant.get("excluded_modules") or ()),
        residency=_resolve_residency(
            component,
            residency,
            offload=offload,
            quant_scheme=scheme,
            quant_provider=provider,
        ),
    )


# ---------------------------------------------------------------------------
# pinned memory plan for layerwise offload


@dataclass(frozen=True)
class PinnedPlan:
    """Identify the host memory policy applied to the model."""

    cap_bytes: int
    courier_reserve_bytes: int
    layer_budget_bytes: int
    # layer group -> its courier reserve (two slots of the group's largest layer)
    courier_groups: Mapping[str, int] = field(default_factory=dict)


COURIER_SLOTS = 2  # MappedLayerCourier._NUM_SLOTS (layerwise_offload.py:703)
COURIER_ALIGN = 4096  # _DIRECT_ALIGN (layerwise_offload.py:395)


def courier_slot_bytes(layer_bytes: int, tensor_count: int) -> int:
    """Upper bound of one courier staging slot for a layer (layerwise_offload.py:759-771)."""
    raw = layer_bytes + tensor_count * 2 * COURIER_ALIGN
    return (raw + COURIER_ALIGN - 1) // COURIER_ALIGN * COURIER_ALIGN


def plan_pinned_budget(
    max_pinned_bytes: int,
    layers: Sequence[int | tuple[int, int]]
    | Mapping[str, Sequence[int | tuple[int, int]]],
    *,
    cuda: bool = True,
) -> PinnedPlan:
    """Split the profile's pinned cap between per-layer pins and courier slots.

    Every layer group has its own ``LayerwiseOffloadManager`` and with it its own
    ``MappedLayerCourier``, which allocates two pinned staging slots of the
    group's largest mapped layer outside ``HostPinBudget``
    (layerwise_offload.py:686-785, 2186-2212) — the DiT has two groups, ``blocks``
    and ``token_refiner.blocks``.  Reserving two slots *per group* up-front keeps
    the *total* pinned bytes within the cap in every hosting outcome; when the
    cap cannot even hold the slots the profile is unsupported (the helper would
    not honour the cap).  ``layers`` maps a group name to its per-layer byte
    totals or ``(bytes, tensor_count)`` pairs; a plain sequence is one group.
    """
    if max_pinned_bytes < 0:
        raise _reject("PINNED_CAP_INVALID", "max_pinned_bytes 不可為負")
    groups = dict(layers) if isinstance(layers, Mapping) else {"layers": layers}
    courier: dict[str, int] = {}
    for name, items in groups.items():
        slots = [
            courier_slot_bytes(*item)
            if isinstance(item, tuple)
            else courier_slot_bytes(int(item), 0)
            for item in items
        ]
        if slots and cuda:
            courier[str(name)] = COURIER_SLOTS * max(slots)
    reserve = sum(courier.values())
    if max_pinned_bytes < reserve:
        detail = "\N{FULLWIDTH PLUS SIGN}".join(
            f"{name} {size}" for name, size in courier.items()
        )
        raise _reject(
            "PINNED_CAP_BELOW_COURIER_SLOTS",
            f"max_pinned_bytes={max_pinned_bytes} 小於每個 layer group 兩個 pinned courier staging slot 的合計 "
            f"{reserve} bytes（{detail}）；釘版 helper 無法遵守此上限，profile 不支援",
            "components.*.max_pinned_bytes",
            expected=f">= {reserve}",
            actual=str(max_pinned_bytes),
        )
    return PinnedPlan(
        cap_bytes=max_pinned_bytes,
        courier_reserve_bytes=reserve,
        layer_budget_bytes=max_pinned_bytes - reserve,
        courier_groups=courier,
    )


# ---------------------------------------------------------------------------
# stage policy


def _declaration(profile: Mapping[str, Any]) -> CheckpointDeclaration:
    for ext in profile.get("extensions") or ():
        if ext.get("namespace") == EXTENSION_NAMESPACE:
            values = ext.get("values") or {}
            unknown = set(values) - {
                "transformer_qkv_layout",
                "transformer_architecture",
            }
            if unknown:
                raise _reject(
                    "EXTENSION_UNKNOWN_KEYS",
                    f"{EXTENSION_NAMESPACE} 有未登記欄位：{sorted(unknown)}",
                    "extensions",
                )
            qkv = values.get("transformer_qkv_layout")
            arch = values.get("transformer_architecture")
            if qkv is not None and qkv not in ("concat", "grouped"):
                raise _reject(
                    "EXTENSION_VALUE_INVALID",
                    f"transformer_qkv_layout={qkv!r} 不合法",
                    "extensions",
                )
            if arch is not None and arch not in ("dense", "pruned_curve"):
                raise _reject(
                    "EXTENSION_VALUE_INVALID",
                    f"transformer_architecture={arch!r} 不合法",
                    "extensions",
                )
            return CheckpointDeclaration(
                transformer_qkv_layout=qkv, transformer_architecture=arch
            )
    return CheckpointDeclaration()


def residency_values(profile: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    """Values of the profile's ``phasyn.sglang_h3.residency`` extension (component -> settings)."""
    for ext in profile.get("extensions") or ():
        if ext.get("namespace") != RESIDENCY_EXTENSION:
            continue
        values = ext.get("values") or {}
        unknown = set(values) - set(COMPONENT_KEYS)
        if unknown:
            raise _reject(
                "EXTENSION_UNKNOWN_KEYS",
                f"{RESIDENCY_EXTENSION} 有未登記欄位：{sorted(unknown)}",
                "extensions",
            )
        out: dict[str, Mapping[str, Any]] = {}
        for component, settings in values.items():
            if not isinstance(settings, Mapping):
                raise _reject(
                    "EXTENSION_VALUE_INVALID",
                    f"{RESIDENCY_EXTENSION}.{component} 必須是 object",
                    "extensions",
                )
            extra = set(settings) - {"after_use", "idle_unload_seconds"}
            if extra:
                raise _reject(
                    "EXTENSION_UNKNOWN_KEYS",
                    f"{RESIDENCY_EXTENSION}.{component} 有未登記欄位：{sorted(extra)}",
                    "extensions",
                )
            out[str(component)] = dict(settings)
        return out
    return {}


def component_policy_for(policy: StagePolicy, component: str) -> ComponentPolicy:
    """Policy of a component a stage loads besides its validated ones (the audio VAE encoder inside ``encode_references``), resolved with the same residency."""
    existing = policy.components.get(component)
    if existing is not None:
        return existing
    return resolve_component_policy(
        component,
        (policy.effective_profile.get("components") or {}).get(component) or {},
        mode=policy.mode,
        residency=policy.residency_values.get(component),
    )


def _check_global_profile(
    profile: Mapping[str, Any], *, uses_transformer: bool
) -> None:
    del uses_transformer
    regional_compile_rules.validate(profile)
    graphs = profile.get("cuda_graphs") or {}
    if graphs.get("mode", "off") != "off":
        offloading = any(
            (profile.get("components") or {}).get(c, {}).get("offload", "none")
            != "none"
            for c in COMPONENT_KEYS
        )
        reason = (
            "CUDA_GRAPHS_DYNAMIC_OFFLOAD" if offloading else "CUDA_GRAPHS_NOT_WIRED"
        )
        raise _reject(
            reason,
            "cuda_graphs.static_bucket 需已驗證的 graph capability；與動態 offload 預設拒絕",
            "cuda_graphs.mode",
        )
    denoise_cache_rules.validate(profile)
    par = profile.get("parallelism") or {}
    if (
        par.get("mode", "stage_only") != "stage_only"
        or any(
            int(par.get(k, 1)) != 1
            for k in ("tensor_degree", "ulysses_degree", "ring_degree")
        )
        or par.get("fsdp_inference", False)
    ):
        raise _reject(
            "PARALLELISM_UNSUPPORTED",
            "首期只支援 stage_only 單卡（ARCHITECTURE/CONTRACTS）",
            "parallelism",
        )
    vae = profile.get("vae") or {}
    tile = int(vae.get("spatial_tile", 256))
    overlap = int(vae.get("spatial_overlap", 64))
    if tile % 16 or overlap >= tile:
        raise _reject(
            "VAE_TILE_INVALID",
            "spatial_tile 必須可被 16 整除且 overlap < tile",
            "vae.spatial_tile",
        )
    if vae.get("temporal_policy", "native") != "native":
        raise _reject(
            "TEMPORAL_CHUNK_UNSUPPORTED",
            "validated_chunk 需要模型時間上下文規則與實測 capability",
            "vae.temporal_policy",
        )
    if (
        vae.get("temporal_chunk_frames") is not None
        or int(vae.get("temporal_overlap_frames", 0)) != 0
    ):
        raise _reject(
            "TEMPORAL_CHUNK_UNSUPPORTED",
            "native temporal policy 不接受自訂 chunk/overlap",
            "vae",
        )
    if vae.get("transfer_dtype", "native") not in ("native", "fp32"):
        raise _reject(
            "TRANSFER_DTYPE_NOT_EXACT",
            "跨 stage latent 必須保持 FP32（原生 dtype）",
            "vae.transfer_dtype",
        )


def _resolve_attention(
    profile: Mapping[str, Any],
    *,
    sm_major: int | None,
    sm: tuple[int, int] | None = None,
    dit_stage: bool = True,
) -> tuple[str, str, str, bool]:
    att = profile.get("attention") or {}
    requested = str(att.get("provider", "auto_exact"))
    reject_quadratic = bool(att.get("reject_quadratic_materialization", True))
    # The exact, available default on the pinned SM12.x environment is SDPA.
    effective = "pytorch_sdpa" if requested == "auto_exact" else requested
    if effective not in ATTENTION_EXECUTABLE:
        raise _reject(
            "ATTENTION_PROVIDER_NOT_EXECUTABLE",
            f"attention.provider={requested} 無法在此 runtime 執行（未安裝、近似或未接入）",
            "attention.provider",
        )
    routed = FA_GENERATION_SM_MAJOR.get(effective)
    if routed is not None and sm_major not in routed:
        # unknown SM fails closed too: the generation `fa` runs cannot be known
        if effective == "flash_attention_3":
            raise _reject(
                "FA3_HOPPER_PATH_ONLY",
                "FlashAttention 3 只在 SM8x/9x 是 SGLang fa 後端的實際 kernel（_is_fa3_supported, "
                "flash_attention_v3.py:84-97）；SM10.x 改用 FA4、SM12.x 改走 SDPA（cuda.py:507-517）",
                "attention.provider",
                expected=list(routed),
                actual=sm_major,
            )
        raise _reject(
            "FA4_SM10X_PATH_ONLY",
            "釘版 SGLang 只在 SM10.x 讓 fa 後端執行 FA4（cuda.py:724-744）；其他 SM 的 fa 不是 FA4",
            "attention.provider",
            expected=list(routed),
            actual=sm_major,
        )
    if effective in APPROXIMATE_ATTENTION:
        validate_approximate_attention(
            profile, effective, sm=sm, sm_major=sm_major, check_device=dit_stage
        )
    else:
        reject_stray_attention_params(profile, effective)
    return requested, effective, ATTENTION_EXECUTABLE[effective], reject_quadratic


def _ref_kv_cache_policy(
    profile: Mapping[str, Any], *, mode: str, attention_effective: str
) -> ref_kv_rules.RefKvCachePolicy | None:
    """The profile's ``phasyn.sglang_h3.ref_kv_cache`` (validated again here: the control plane may be older)."""
    path = f"extensions[{ref_kv_rules.EXTENSION}]"
    try:
        values = ref_kv_rules.find_extension(profile)
        if values is None:
            return None
        policy = ref_kv_rules.parse_extension(values)
    except ref_kv_rules.OptionError as exc:
        raise _reject(
            "EXTENSION_VALUE_INVALID",
            f"{ref_kv_rules.EXTENSION}：{exc.message}",
            "extensions",
        ) from exc
    if mode == "exact":
        raise _reject(
            "REF_KV_CACHE_NOT_EXACT",
            "ref_kv_cache skip 讓略過步沿用快取的參考列 K/V，屬 approximate run，不能用於 mode=exact",
            "mode",
        )
    reason = ref_kv_rules.attention_refusal(attention_effective)
    if reason is not None:
        raise _reject(
            "REF_KV_CACHE_ATTENTION_UNSUPPORTED",
            reason,
            path,
            actual=attention_effective,
        )
    return policy


def resolve_stage_policy(
    plan: Mapping[str, Any], stage_kind: str, **arguments: Unpack[_StageOverrides]
) -> StagePolicy:
    """Validate the frozen profile for ``stage_kind`` and apply ``memory_level``.

    ``sm`` is the exact compute capability when known (approximate attention
    kernels are gated on (major, minor), e.g. fp8_fa_sm120 runs on 12.0 only).
    """
    validate_keywords(arguments, _StageOverrides)
    memory_level = arguments.get("memory_level", 0)
    adapter_overrides = arguments.get("adapter_overrides")
    sm_major = arguments.get("sm_major")
    sm = arguments.get("sm")
    if sm is not None and sm_major is None:
        sm_major = int(sm[0])
    if stage_kind not in STAGE_PRIMARY_COMPONENT:
        raise _reject(
            "STAGE_KIND_NOT_RUNTIME", f"stage kind {stage_kind} 不由 sglang_h3 執行"
        )
    profile = copy.deepcopy(dict(plan.get("effective_profile") or {}))
    _check_profile_source(profile)
    mode = str(profile.get("mode", "exact"))
    primary = STAGE_PRIMARY_COMPONENT[stage_kind]
    applied: dict[str, dict[str, Any]] = {}
    components_profile = profile.setdefault("components", {})
    _apply_stage_overrides(
        _ApplyStageOverridesInputs(
            primary,
            components_profile,
            memory_level,
            adapter_overrides,
            applied,
            stage_kind,
        )
    )

    _check_global_profile(profile, uses_transformer=primary == "transformer")
    adaln = profile.get("adaln") or {}
    adaln_mode = str(adaln.get("mode", "off"))
    requested, effective, backend, reject_quadratic = _resolve_attention(
        profile, sm_major=sm_major, sm=sm, dit_stage=primary == "transformer"
    )

    manifest_components = {
        c.get("kind"): c for c in (plan.get("model") or {}).get("components", [])
    }
    residency = residency_values(profile)
    resolved: dict[str, ComponentPolicy] = {}
    for component in STAGE_COMPONENTS[stage_kind] + (
        (primary,) if primary and primary not in STAGE_COMPONENTS[stage_kind] else ()
    ):
        comp_profile = components_profile.get(component)
        if comp_profile is None:
            raise _reject(
                "PROFILE_COMPONENT_MISSING", f"profile 缺少 components.{component}"
            )
        manifest_format = (manifest_components.get(component) or {}).get("format")
        resolved[component] = resolve_component_policy(
            component,
            comp_profile,
            mode=mode,
            manifest_format=manifest_format,
            residency=residency.get(component),
        )

    _check_adaln_policy(adaln_mode, components_profile, profile, adaln)
    lora = resolve_lora_policy(
        plan,
        profile,
        adaln_mode=adaln_mode,
        pruned_curve=_declaration(profile).transformer_architecture == "pruned_curve",
    )
    ref_kv_cache = _ref_kv_cache_policy(
        profile, mode=mode, attention_effective=effective
    )

    return StagePolicy(
        stage_kind=stage_kind,
        mode=mode,
        attention_provider_requested=requested,
        attention_provider_effective=effective,
        sglang_attention_backend=backend,
        reject_quadratic_materialization=reject_quadratic,
        adaln_mode=adaln_mode,
        adaln_host_cache_bytes=int(adaln.get("host_cache_bytes", 8 * 1024**3)),
        vae=dict(profile.get("vae") or {}),
        limits=dict(profile.get("limits") or {}),
        components=resolved,
        declaration=_declaration(profile),
        memory_level=int(memory_level),
        applied_overrides=applied,
        effective_profile=profile,
        lora=lora,
        residency_values=residency,
        ref_kv_cache=ref_kv_cache,
    )


__all__ = [
    "AFTER_USE_CHOICES",
    "ATTENTION_EXECUTABLE",
    "COMPONENT_KEYS",
    "COURIER_ALIGN",
    "COURIER_SLOTS",
    "DEFAULT_AFTER_USE",
    "DEFAULT_RESIDENCY",
    "DIT_NUM_LAYERS",
    "EXTENSION_NAMESPACE",
    "FA_GENERATION_SM_MAJOR",
    "LAYERWISE_GROUPS",
    "MAX_IDLE_UNLOAD_SECONDS",
    "NATIVE_COMPUTE_DTYPE",
    "RESIDENCY_EXTENSION",
    "STAGE_COMPONENTS",
    "STAGE_PRIMARY_COMPONENT",
    "VIDEO_VAE_DECODE_DTYPES",
    "CheckpointDeclaration",
    "ComponentPolicy",
    "PinnedPlan",
    "ResidencyPolicy",
    "StagePolicy",
    "component_policy_for",
    "courier_slot_bytes",
    "exact_memory_ladder",
    "host_residency_refusal",
    "overrides_for_level",
    "plan_pinned_budget",
    "residency_values",
    "resolve_component_policy",
    "resolve_stage_policy",
]


class _CheckQuantizationInputs(NamedTuple):
    weight_format: Any
    manifest_format: str | None
    component: str
    path: Any
    scheme: Any
    provider: Any
    mode: str
    offload: Any
    profile_component: Mapping[str, Any]


def _check_quantization(inputs: _CheckQuantizationInputs) -> None:
    (
        weight_format,
        manifest_format,
        component,
        path,
        scheme,
        provider,
        mode,
        offload,
        profile_component,
    ) = inputs
    if weight_format == "gguf" or manifest_format == "gguf":
        raise _reject(
            "GGUF_NOT_WIRED",
            f"{component}: GGUF 權重未接入此 shim",
            f"{path}.weight_format",
        )
    if scheme == "none":
        if provider not in ("native", "sglang_native"):
            raise _reject(
                "QUANT_PROVIDER_WITHOUT_SCHEME",
                f"{component}: quantization.scheme=none 卻指定 provider={provider}",
                f"{path}.quantization.provider",
            )
    elif scheme == "nf4" and provider == "bitsandbytes":
        _check_nf4_component(component, path, mode, offload, weight_format)
    elif online_quant_method(scheme, provider) is not None:
        validate_online_quant(component, profile_component, mode=mode)
    else:
        raise _reject(
            "QUANT_SCHEME_NOT_WIRED",
            f"{component}: quantization {scheme}/{provider} 未接入此 shim（只有 none、transformer nf4/bitsandbytes、"
            "transformer int8_convrot|fp8_e4m3/sglang_native 線上量化）",
            f"{path}.quantization",
        )


class _BlockResidencyInputs(NamedTuple):
    offload: Any
    prefetch: Any
    path: Any
    blocks_per_group: Any
    residency_policy: Any
    indices: Any
    component: str
    resident: Any


def _block_residency(inputs: _BlockResidencyInputs) -> Any:
    (
        offload,
        prefetch,
        path,
        blocks_per_group,
        residency_policy,
        indices,
        component,
        resident,
    ) = inputs
    sglang_policy = "leading"
    if offload == "block":
        if prefetch < 1:
            raise _reject(
                "PREFETCH_ZERO_REJECTED",
                "CUDA layerwise offload 的 prefetch_depth 必須 >= 1；釘版 SGLang 會把 0 默默改成 1"
                "（layerwise_offload.py:1034-1038），因此直接拒絕",
                f"{path}.prefetch_depth",
            )
        if blocks_per_group != 1:
            raise _reject(
                "BLOCKS_PER_GROUP_UNSUPPORTED",
                "釘版 layerwise offload 每個 hook 只搬一層，沒有 blocks_per_group 參數",
                f"{path}.blocks_per_group",
            )
        if residency_policy == "prefix":
            sglang_policy = "leading"
        else:
            raise _reject(
                "RESIDENCY_POLICY_UNSUPPORTED",
                f"residency_policy={residency_policy} 無對應（釘版只有 leading/strided，layerwise_offload.py:67-114）",
                f"{path}.residency_policy",
            )
        if indices:
            raise _reject(
                "RESIDENT_LAYER_INDICES_IGNORED",
                "非 explicit residency 不接受 resident_layer_indices（不得藏使用者值）",
                f"{path}.resident_layer_indices",
            )
        if component == "transformer" and resident > DIT_NUM_LAYERS:
            raise _reject(
                "RESIDENT_LAYERS_OUT_OF_RANGE",
                f"resident_layers={resident} 超過 DiT 層數 {DIT_NUM_LAYERS}",
                f"{path}.resident_layers",
            )
    # values that only mean something for block offload must be at their
    # neutral settings so nothing user-set is silently ignored
    elif resident != 0 or indices:
        raise _reject(
            "RESIDENT_LAYERS_WITHOUT_BLOCK_OFFLOAD",
            f"{component}: offload={offload} 時 resident_layers/indices 無作用，不默默忽略",
            f"{path}.resident_layers",
        )
    return sglang_policy


def _check_profile_source(profile: Any) -> None:
    if not profile:
        raise _reject("PROFILE_MISSING", "plan 缺少 effective_profile")
    if profile.get("runtime_provider") not in (None, "sglang_h3"):
        raise _reject(
            "RUNTIME_PROVIDER_MISMATCH",
            f"profile runtime_provider={profile.get('runtime_provider')} 不是 sglang_h3",
            "runtime_provider",
        )

    if profile.get("runtime_source_revision") not in (None, SGLANG_SOURCE_REVISION):
        raise _reject(
            "RUNTIME_SOURCE_REVISION_MISMATCH",
            f"profile 要求 SGLang {profile.get('runtime_source_revision')}，此環境釘版 {SGLANG_SOURCE_REVISION}",
            "runtime_source_revision",
        )


class _ApplyStageOverridesInputs(NamedTuple):
    primary: Any
    components_profile: Any
    memory_level: Any
    adapter_overrides: Any
    applied: dict[str, dict[str, Any]]
    stage_kind: str


def _apply_stage_overrides(inputs: _ApplyStageOverridesInputs) -> None:
    (
        primary,
        components_profile,
        memory_level,
        adapter_overrides,
        applied,
        stage_kind,
    ) = inputs
    if primary is not None:
        base = dict(components_profile.get(primary) or {})
        overrides = overrides_for_level(
            base,
            int(memory_level),
            (adapter_overrides or {}).get(primary) if adapter_overrides else None,
        )
        if overrides:
            base.update(overrides)
            components_profile[primary] = base
            applied[primary] = overrides
    elif memory_level:
        raise _reject(
            "NO_EXACT_MEMORY_FALLBACK",
            f"{stage_kind} 不載入模型元件，沒有 memory fallback",
        )


def _check_adaln_policy(
    adaln_mode: Any, components_profile: Any, profile: Any, adaln: Any
) -> None:
    if adaln_mode != "off":
        transformer = components_profile.get("transformer") or {}
        quant_scheme = (transformer.get("quantization") or {}).get("scheme", "none")
        # Only online quantization of a native BF16 checkpoint with adaln_proj kept
        # BF16 passes, through the shim's runtime patch of minimax_h3.py:2154-2159
        # ; pre-quantized weights keep the upstream rejection.
        if quant_scheme != "none" and adaln_quant_method(transformer) is None:
            raise _reject(
                "ADALN_QUANT_INCOMPATIBLE",
                "釘版 AdaLN cache/online 拒絕 quant_config（minimax_h3.py:2154-2159）；"
                "只有原生 BF16 checkpoint 的線上量化（int8_convrot|fp8_e4m3/sglang_native，adaln_proj 保持 BF16）例外",
                "adaln.mode",
            )
        if _declaration(profile).transformer_architecture == "pruned_curve":
            raise _reject(
                "ADALN_PRUNED_INCOMPATIBLE",
                "pruned curve checkpoint 不能再套 AdaLN cache（minimax_h3.py:2160-2165）",
                "adaln.mode",
            )
        if adaln_mode == "fixed" and not adaln.get("cache_ref"):
            raise _reject(
                "ADALN_CACHE_REF_MISSING",
                "adaln.mode=fixed 需要 cache_ref（sidecar）",
                "adaln.cache_ref",
            )
        transformer_offload = (components_profile.get("transformer") or {}).get(
            "offload"
        )
        if adaln_mode == "online" and transformer_offload not in ("none", "block"):
            raise _reject(
                "ADALN_OFFLOAD_UNSUPPORTED",
                "online AdaLN 只配合 none/block offload",
                "adaln.mode",
            )


def _check_nf4_component(
    component: Any, path: Any, mode: Any, offload: Any, weight_format: Any
) -> None:
    if component == "text_encoder":
        raise _reject(
            "NF4_TEXT_ENCODER_UNSUPPORTED",
            "釘版 SGLang 對 bitsandbytes text encoder 交給 Transformers 載入，產物沒有 H3 encode_ids；"
            "MiniMaxH3Qwen3VLEncoder 無 bnb 載入路徑",
            f"{path}.quantization",
        )
    if component in ("video_vae", "audio_vae"):
        raise _reject(
            "NF4_VAE_UNSUPPORTED",
            "釘版 SGLang VAE loader 無法還原 bitsandbytes 4-bit 序列化狀態（vae_loader.py:62-100）；"
            f"{component} 不可用 NF4",
            f"{path}.quantization",
        )
    if mode == "exact":
        raise _reject(
            "NF4_NOT_EXACT",
            "NF4 為近似權重格式（bnb matmul 以 bf16 計算），exact profile 不可使用",
            "mode",
        )
    if offload != "none":
        raise _reject(
            "NF4_OFFLOAD_UNVALIDATED",
            "bitsandbytes 4-bit DiT 在釘版 SGLang 必須常駐（component offload/FSDP 被關閉）；"
            "layerwise + bnb 未經 probe 驗證，只接受 offload=none",
            f"{path}.offload",
        )
    if weight_format not in ("safetensors", "native"):
        raise _reject(
            "NF4_FORMAT_UNSUPPORTED",
            f"NF4 需 safetensors 單檔，收到 {weight_format}",
            f"{path}.weight_format",
        )
