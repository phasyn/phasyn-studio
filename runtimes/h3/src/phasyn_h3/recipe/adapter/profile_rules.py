"""H3 semantic rules for runtime profiles (field paths are profile-relative).

Rule sources:

* AdaLN x quantization: SGR:runtime/models/dits/minimax_h3.py:2154-2159 (cache needs
  unquantized weights), :2160-2165 (pruned curve checkpoints cannot use a separate AdaLN cache),
  :1880-1895 (cache modes reject LoRA deltas on ``adaln_proj``).  The LoRA half
  needs registry facts and lives in ``lora_rules`` (plan time).
* prefetch: SGR:runtime/managers/memory_managers/layerwise_offload.py:1034-1038
  (CUDA clamps prefetch 0 -> 1; we reject instead of clamping).
* CUDA graphs vs dynamic offload (default reject).
* VAE tiles: tile/overlap are pixels divided by ``vae_ratio`` 16
  (SGR:runtime/models/vaes/minimax_h3_video_vae/klvae.py:219-247,441-446;
  H3:FL2VA/video_vae/source/config.json ``vae_ratio``).
* residency map: pinned layerwise offload only knows ``leading``/``strided``
  residency and silently clamps ``resident_layers`` (layerwise_offload.py:67-111,1043).
* temporal chunk.
* quantized / pruned / LoRA / approximate runs are never ``mode=exact``.
* registered extensions: ``PROFILE_EXTENSION_SCHEMAS`` is this build's trusted schema for
  ``phasyn.sglang_h3.checkpoint``, ``phasyn.sglang_h3.lora``, ``phasyn.sglang_h3.residency`` and
  ``phasyn.sglang_h3.ref_kv_cache`` (``ref_kv_rules``); the control plane checks namespace, exact
  ``schema_digest`` and values.
* Video VAE decode precision: the released VAE weights are FP32, so ``video_vae.compute_dtype``
  ``fp32`` is native (exact); ``fp16`` is the pinned pipeline's FP16-autocast decode recipe
  (SGR:configs/pipeline_configs/minimax_h3.py:57-58, loader/component_loaders/vae_loader.py:267-311)
  and therefore approximate.
* Attention deny rules are bound to the upstream versions they were read from.

Rule identifiers refer to  (anchor = lower-case identifier).
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass
from typing import Any

from . import acceleration_rules, constants, ref_kv_rules
from ._diag import INVALID, UNSUPPORTED, err, warn
from .geometry import RUNTIME_BOUNDS
from .loras import DEFAULT_DYNAMIC_CHUNK_TOKENS, MAX_DYNAMIC_CHUNK_TOKENS


_MIN_SM_DIGITS = 2


COMPONENT_PLACEMENT = {
    "text_encoder": "conditioning",
    "transformer": "dit",
    "video_vae": "video_vae",
    "audio_vae": "audio_vae",
}
# block counts with layer-index semantics; VAEs have none
COMPONENT_LAYERS = {
    "text_encoder": constants.TEXT_SELECTED_LAYER,
    "transformer": constants.DIT_NUM_LAYERS,
}


@dataclass(frozen=True)
class AttentionDenyRule:
    """Identify a hardware and attention configuration that cannot run."""

    rule_id: str
    provider: str
    kernel_variant_contains: str | None
    allowed_sm_major: tuple[
        int, ...
    ]  # compute-capability major numbers that may use it
    bound_to: str
    reason_zh: str


ATTENTION_DENY_RULES: tuple[AttentionDenyRule, ...] = (
    AttentionDenyRule(
        rule_id="DENY-ATTN-FA3-HOPPER-ONLY",
        provider="flash_attention_3",
        kernel_variant_contains=None,
        allowed_sm_major=(9,),
        bound_to="Dao-AILab/flash-attention FA3 (hopper/) as read 2026-10-10",
        reason_zh="FlashAttention-3 是 Hopper（sm90）專用路徑；sm120、sm121、sm86 等其他世代不適用",
    ),
    AttentionDenyRule(
        rule_id="DENY-ATTN-FA4-FP8-SM10X",
        provider="flash_attention_4",
        kernel_variant_contains="fp8",
        allowed_sm_major=(10,),
        bound_to="flash-attention main flash_attn/cute/interface.py as read 2026-10-10",
        reason_zh="FA4 的 FP8-input 分支只限 SM10.x；不能因 SM12 有 FP8 硬體而開啟",
    ),
)


def _sm_major(sm: Any) -> int | None:
    text = str(sm or "").strip().lower().removeprefix("sm").removeprefix("_")
    if not text.isdigit() or len(text) < _MIN_SM_DIGITS:
        return None
    return int(text[:-1])


def attention_diagnostics(
    profile: Mapping[str, Any], device_sms: Mapping[str, Any] | None
) -> list[dict[str, Any]]:
    """Report unsupported attention combinations."""
    attention = profile.get("attention") or {}
    provider = str(attention.get("provider", "auto_exact"))
    variant = str(attention.get("kernel_variant") or "").lower()
    out: list[dict[str, Any]] = []
    if profile.get("mode") == "exact" and provider.startswith("sageattention"):
        out.append(
            err(
                UNSUPPORTED,
                "SageAttention 是近似 attention，不能用於 mode=exact（/026）",
                "mode",
                "attention.provider",
            )
        )
    for rule in ATTENTION_DENY_RULES:
        if provider != rule.provider:
            continue
        if rule.kernel_variant_contains and rule.kernel_variant_contains not in variant:
            continue
        sms = {k: v for k, v in (device_sms or {}).items() if v is not None}
        if not sms:
            out.append(
                warn(
                    rule.rule_id,
                    f"{rule.reason_zh}；目前沒有裝置架構資訊，放置時會再檢查（依據：{rule.bound_to}）",
                    "attention.provider",
                )
            )
            continue
        for role, sm in sorted(sms.items()):
            if _sm_major(sm) not in rule.allowed_sm_major:
                out.append(
                    err(
                        UNSUPPORTED,
                        f"{rule.reason_zh}（{role} 裝置 sm{sm}；規則 {rule.rule_id}，依據：{rule.bound_to}）；"
                        "不擅自替換成其他 kernel，可改選 auto_exact",
                        "attention.provider",
                        "attention.kernel_variant",
                        expected="auto_exact",
                        actual=f"{provider}@sm{sm}",
                    )
                )
    return out


def _residency_diagnostics(
    name: str, comp: Mapping[str, Any], *, sglang: bool
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    base = f"components.{name}"
    layers = COMPONENT_LAYERS.get(name)
    policy = comp.get("residency_policy", "prefix")
    indices = list(comp.get("resident_layer_indices") or [])
    resident = int(comp.get("resident_layers", 0))
    if policy != "explicit" and indices:
        out.append(
            err(
                INVALID,
                "residency_policy 不是 explicit 時不可帶 resident_layer_indices（不保留會被忽略的隱藏值）",
                f"{base}.resident_layer_indices",
            )
        )
    if layers is not None and resident > layers:
        out.append(
            err(
                INVALID,
                f"resident_layers {resident} 超過 {name} 的 {layers} 個 block（釘版會默默 clamp，本產品拒絕）",
                f"{base}.resident_layers",
                expected=f"<= {layers}",
                actual=resident,
            )
        )
    if policy == "explicit":
        if layers is None:
            out.append(
                err(
                    UNSUPPORTED,
                    f"{name} 沒有 block 索引語意，不能用 explicit residency",
                    f"{base}.residency_policy",
                )
            )
        else:
            if len(set(indices)) != len(indices):
                out.append(
                    err(
                        INVALID,
                        "resident_layer_indices 不可重複",
                        f"{base}.resident_layer_indices",
                    )
                )
            if len(indices) != resident:
                out.append(
                    err(
                        INVALID,
                        "explicit residency 的索引數量必須等於 resident_layers",
                        f"{base}.resident_layer_indices",
                        f"{base}.resident_layers",
                        expected=resident,
                        actual=len(indices),
                    )
                )
            bad = [i for i in indices if not 0 <= int(i) < layers]
            if bad:
                out.append(
                    err(
                        INVALID,
                        f"resident_layer_indices 必須介於 0..{layers - 1}",
                        f"{base}.resident_layer_indices",
                        actual=bad,
                    )
                )
    if sglang and comp.get("offload") in constants.STREAMED_OFFLOADS and resident > 0:
        leading = policy == "prefix" or (
            policy == "explicit" and sorted(indices) == list(range(resident))
        )
        if not leading:
            out.append(
                err(
                    UNSUPPORTED,
                    "釘版 SGLang layerwise offload 只實作 leading／strided residency；"
                    "suffix 或非前綴 explicit 需另外驗證的 runtime 能力",
                    f"{base}.residency_policy",
                )
            )
    return out


def validate_profile(
    profile: Mapping[str, Any],
    *,
    device_sms: Mapping[str, Any] | None = None,
    capabilities: Collection[str] = (),
    model: Mapping[str, Any] | None = None,
    model_facts: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """H3 semantic diagnostics for a schema-valid runtime profile (profile-relative paths).

    ``device_sms`` maps placement roles (``dit``, ``conditioning`` ...) to node-inventory
    ``sm`` strings when known; ``capabilities`` lists validated capability ids that lift
    default rejections (``cuda_graphs.dynamic_offload``, ``vae.validated_chunk``,
    ``parallelism.<mode>``, ``parallelism.fsdp``).
    """
    out: list[dict[str, Any]] = []
    runtime = str(profile.get("runtime_provider"))
    sglang = runtime == constants.RUNTIME_SGLANG
    exact = profile.get("mode") == "exact"
    _check_runtime_revision(profile, runtime, sglang=sglang, out=out)

    _check_components(profile, exact=exact, sglang=sglang, out=out)
    out.extend(residency_extension_diagnostics(profile))

    _check_execution_mode(profile, capabilities, exact=exact, out=out)

    _check_vae_policy(profile, capabilities, exact=exact, out=out)
    approximation = profile.get("approximation") or {}
    if exact and approximation.get("algorithm", "none") != "none":
        out.append(
            err(
                UNSUPPORTED,
                "denoise cache 近似加速不能用於 mode=exact",
                "mode",
                "approximation.algorithm",
            )
        )

    out.extend(attention_diagnostics(profile, device_sms))
    out.extend(acceleration_rules.diagnostics(profile, device_sms))
    out.extend(ref_kv_rules.diagnostics(profile, model=model))

    _check_parallelism(profile, capabilities, out)

    if model_facts:
        out.extend(validate_model_facts(profile, model_facts, model=model))
    return _dedupe(out)


def _component_kinds(model: Mapping[str, Any] | None) -> dict[str, str]:
    kinds: dict[str, str] = {}
    for comp in (model or {}).get("components") or []:
        if isinstance(comp, Mapping) and comp.get("component_id") and comp.get("kind"):
            kinds[str(comp["component_id"])] = str(comp["kind"])
    return kinds


def facts_by_kind(
    model_facts: Mapping[str, Mapping[str, Any]] | None, model: Mapping[str, Any] | None
) -> dict[str, dict[str, Any]]:
    """Map ``component_id -> facts`` onto component kinds via the manifest (fallback: facts.kind / id suffix)."""
    kinds = _component_kinds(model)
    out: dict[str, dict[str, Any]] = {}
    raw_facts: Mapping[str, object] = model_facts or {}
    for cid, facts in sorted(raw_facts.items()):
        if not isinstance(facts, Mapping):
            continue
        kind = kinds.get(str(cid)) or facts.get("kind")
        if not kind:
            kind = next(
                (
                    k
                    for k in (
                        "text_encoder",
                        "transformer",
                        "video_vae",
                        "audio_vae",
                        "processor",
                        "tokenizer",
                    )
                    if str(cid).endswith(k)
                ),
                None,
            )
        if kind:
            out[str(kind)] = {**dict(facts), "component_id": str(cid)}
    return out


SGLANG_CHECKPOINT_EXTENSION = "phasyn.sglang_h3.checkpoint"
# Facts a checkpoint header cannot prove.  Consumed by the runtime shim
# (phasyn_h3.recipe.runtime.policy / checkpoint_inspect); editing this document changes
# its digest, so every profile that declares it must be re-saved.
SGLANG_CHECKPOINT_EXTENSION_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": SGLANG_CHECKPOINT_EXTENSION,
    "description": "header 無法證明的 checkpoint 事實（釘版 SGLang H3 路徑）",
    "type": "object",
    "properties": {
        "transformer_qkv_layout": {
            "type": "string",
            "enum": ["concat", "grouped"],
            "description": "DiT qkv_proj 列順序：concat=[q_all,k_all,v_all]；預量化 4-bit 權重只接受 concat",
        },
        "transformer_architecture": {
            "type": "string",
            "enum": ["dense", "pruned_curve"],
            "description": "DiT AdaLN 架構；與檔案標頭不符時 runtime 拒絕",
        },
    },
    "minProperties": 1,
    "additionalProperties": False,
}
SGLANG_LORA_EXTENSION = "phasyn.sglang_h3.lora"
# How the runtime applies plan LoRAs: dynamic is the default and the
# only mode for quantized or streamed DiTs; merge exists only as the BF16 comparison arm.  The
# dynamic term is accumulated into the base output in place, ``dynamic_chunk_tokens`` rows at a
# time (phasyn_h3.recipe.runtime.lora_inplace; default loras.DEFAULT_DYNAMIC_CHUNK_TOKENS).
SGLANG_LORA_EXTENSION_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": SGLANG_LORA_EXTENSION,
    "description": "LoRA 套用方式：dynamic（forward 時另算 LoRA 項，預設）或 merge（只作 BF16 對照組）；"
    "dynamic 項以原地 addmm_ 沿 token 維分塊累加到 base 輸出",
    "type": "object",
    "properties": {
        "merge_mode": {
            "type": "string",
            "enum": ["dynamic", "merge"],
            "description": "merge 只允許未量化、常駐（offload none/component）的 BF16 DiT，作對照組",
        },
        "dynamic_chunk_tokens": {
            "type": "integer",
            "minimum": 0,
            "maximum": MAX_DYNAMIC_CHUNK_TOKENS,
            "description": "dynamic LoRA 每塊 token 數（暫存 [塊, r]，不另配置 [N, out] 輸出）；"
            f"0\N{FULLWIDTH EQUALS SIGN}整段一次（仍原地累加）；未設定\N{FULLWIDTH EQUALS SIGN}{DEFAULT_DYNAMIC_CHUNK_TOKENS}",
        },
    },
    "minProperties": 1,
    "additionalProperties": False,
}
SGLANG_RESIDENCY_EXTENSION = "phasyn.sglang_h3.residency"
RESIDENCY_AFTER_USE = ("device", "host", "drop")
# offload -> between-use placement when a component is not listed (runtime default)
RESIDENCY_DEFAULT_AFTER_USE = {"none": "device", "component": "host", "block": "device"}
MAX_IDLE_UNLOAD_SECONDS = 7 * 24 * 3600


def _residency_component_schema(name: str) -> dict[str, Any]:
    return {
        "type": "object",
        "description": f"{name} 兩次使用之間的權重位置",
        "properties": {
            "after_use": {
                "type": "string",
                "enum": list(RESIDENCY_AFTER_USE),
                "description": "device=留在 GPU（元件程序保留）；"
                "host=stage 後釋放 GPU 副本、權重留在主記憶體（max_pinned_bytes 內為 pinned），"
                "host 放不下時改為釋放；drop=完全釋放，下次從 checkpoint 重讀",
            },
            "idle_unload_seconds": {
                "anyOf": [
                    {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_IDLE_UNLOAD_SECONDS,
                    },
                    {"type": "null"},
                ],
                "description": "持有此元件的程序閒置多久後卸載（phasyn_h3 不使用）；null=持有期間不卸載；未設定=預設",
            },
        },
        "required": ["after_use"],
        "additionalProperties": False,
    }


# Between-use residency per component (consumed by phasyn_h3.recipe.runtime.policy); editing it
# changes its digest (phasyn_h3.config.EXTENSION_DIGESTS, test_h3_extension_digests).
SGLANG_RESIDENCY_EXTENSION_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": SGLANG_RESIDENCY_EXTENSION,
    "description": "sglang_h3 元件在兩次使用之間的駐留位置與閒置卸載（未列出的元件依 offload 推得："
    "none→device、component→host、block→device）",
    "type": "object",
    "properties": {
        name: _residency_component_schema(name)
        for name in ("text_encoder", "transformer", "video_vae", "audio_vae")
    },
    "minProperties": 1,
    "additionalProperties": False,
}
PROFILE_EXTENSION_SCHEMAS: Mapping[str, Mapping[str, Any]] = {
    SGLANG_CHECKPOINT_EXTENSION: SGLANG_CHECKPOINT_EXTENSION_SCHEMA,
    SGLANG_LORA_EXTENSION: SGLANG_LORA_EXTENSION_SCHEMA,
    SGLANG_RESIDENCY_EXTENSION: SGLANG_RESIDENCY_EXTENSION_SCHEMA,
    ref_kv_rules.EXTENSION: ref_kv_rules.EXTENSION_SCHEMA,
}


def lora_extension(profile: Mapping[str, Any]) -> Mapping[str, Any]:
    """Values of the profile's ``phasyn.sglang_h3.lora`` extension ({} when absent)."""
    for ext in profile.get("extensions") or ():
        if isinstance(ext, Mapping) and ext.get("namespace") == SGLANG_LORA_EXTENSION:
            values = ext.get("values")
            return values if isinstance(values, Mapping) else {}
    return {}


def residency_declaration(profile: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Values of the profile's ``phasyn.sglang_h3.residency`` extension, if declared."""
    for ext in profile.get("extensions") or ():
        if (
            isinstance(ext, Mapping)
            and ext.get("namespace") == SGLANG_RESIDENCY_EXTENSION
        ):
            values = ext.get("values")
            return values if isinstance(values, Mapping) else {}
    return None


def after_use(profile: Mapping[str, Any], kind: str) -> str:
    """Effective between-use placement of one component (declared or offload default)."""
    declared = (residency_declaration(profile) or {}).get(kind)
    if (
        isinstance(declared, Mapping)
        and declared.get("after_use") in RESIDENCY_AFTER_USE
    ):
        return str(declared["after_use"])
    offload = str(
        ((profile.get("components") or {}).get(kind) or {}).get("offload", "none")
    )
    return RESIDENCY_DEFAULT_AFTER_USE.get(offload, "device")


HOST_RESIDENT_QUANT = frozenset(
    {("int8_convrot", "sglang_native"), ("fp8_e4m3", "sglang_native")}
)


def host_residency_refusal(kind: str, scheme: str, provider: str) -> str | None:
    """Why a quantized component cannot stay in host memory between uses (None: it can).

    Shared with the runtime residency rule (``phasyn_h3.recipe.runtime.policy``).  The online 1-byte DiTs
    keep their whole quantized state in plain parameters, created once at load and read only through
    them by ``apply``: convrot_int8 (``int8_convrot``/``sglang_native``) an INT8 ``weight`` + FP32
    ``weight_scale`` (SGR:runtime/layers/quantization/convrot_int8_jit.py:228-248, 260-275), online FP8
    (``fp8_e4m3``/``sglang_native``, quantized one layer at a time by the runtime patch
    fp8_layerwise_quant.v1) an E4M3 ``weight`` stored as the transposed view ``qweight.t`` + FP32
    ``weight_scale`` [1, N] (fp8.py:301-314) — the host store keeps a dense view's strides, so the view
    comes back as it left.  The host store parks those 1-byte weights (pinned up to the cap) and the next
    use copies them straight back: no re-quantization, no checkpoint read.  bitsandbytes 4-bit hangs its
    quant states on parameters as Python objects (bitsandbytes.py:307-321); that round trip is not validated.
    """
    if scheme == "none" or (scheme, provider) in HOST_RESIDENT_QUANT:
        return None
    if (scheme, provider) == ("nf4", "bitsandbytes"):
        return (
            f"{kind} 為 bitsandbytes 4-bit：quant state 是掛在參數上的 Python 物件，搬到 host 再搬回未經驗證；"
            "請用 after_use=drop（或 device）"
        )
    return f"{kind} 的量化格式 {scheme}/{provider} 沒有驗證過的 host 駐留路徑；請用 after_use=drop（或 device）"


def residency_extension_diagnostics(profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Combinations the sglang_h3 runtime rejects at stage start, reported at plan time."""
    out: list[dict[str, Any]] = []
    values = residency_declaration(profile)
    if not values:
        return out
    components = profile.get("components") or {}
    base = f"extensions[{SGLANG_RESIDENCY_EXTENSION}]"
    for kind, settings in values.items():
        if not isinstance(settings, Mapping):
            continue
        comp = components.get(kind) or {}
        chosen = settings.get("after_use")
        quant = comp.get("quantization") or {}
        refusal = (
            host_residency_refusal(
                kind,
                str(quant.get("scheme", "none")),
                str(quant.get("provider", "native")),
            )
            if chosen == "host"
            else None
        )
        if refusal is not None:
            out.append(
                err(
                    UNSUPPORTED,
                    refusal,
                    f"{base}.{kind}.after_use",
                    f"components.{kind}.quantization.scheme",
                )
            )
        if chosen == "device" and comp.get("offload") == "component":
            out.append(
                err(
                    INVALID,
                    f"{kind}.offload=component 的權重在兩次使用之間本來就放在 host；after_use=device 自相矛盾",
                    f"{base}.{kind}.after_use",
                    f"components.{kind}.offload",
                )
            )
        if chosen == "drop" and "idle_unload_seconds" in settings:
            out.append(
                err(
                    INVALID,
                    f"{kind}.after_use=drop 不保留權重，idle_unload_seconds 無作用（不保留會被忽略的隱藏值）",
                    f"{base}.{kind}.idle_unload_seconds",
                )
            )
    return out


def checkpoint_declaration(profile: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Values of the profile's ``phasyn.sglang_h3.checkpoint`` extension, if declared."""
    for ext in profile.get("extensions") or ():
        if (
            isinstance(ext, Mapping)
            and ext.get("namespace") == SGLANG_CHECKPOINT_EXTENSION
        ):
            values = ext.get("values")
            return values if isinstance(values, Mapping) else {}
    return None


def detected_scheme(facts: Mapping[str, Any]) -> str:
    """Return the quantization scheme detected for the selected profile."""
    return str(((facts.get("quantization") or {}).get("scheme")) or "none")


def is_pruned(facts: Mapping[str, Any]) -> bool:
    """Check whether the configured transformer uses a pruned schedule."""
    return (facts.get("architecture") or {}).get("adaln") == "pruned_curve"


def validate_model_facts(
    profile: Mapping[str, Any],
    model_facts: Mapping[str, Mapping[str, Any]],
    *,
    model: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Profile vs detected checkpoint facts (never pretend quantized/pruned weights are native BF16)."""
    out: list[dict[str, Any]] = []
    components = profile.get("components") or {}
    adaln_mode = (profile.get("adaln") or {}).get("mode", "off")
    for kind, facts in facts_by_kind(model_facts, model).items():
        comp = components.get(kind)
        if not isinstance(comp, Mapping):
            continue  # processor/tokenizer carry no quantization
        base = f"components.{kind}"
        scheme = detected_scheme(facts)
        provider = (facts.get("quantization") or {}).get("provider")
        pruned = is_pruned(facts)
        if kind == "transformer" and pruned and adaln_mode != "off":
            out.append(
                err(
                    UNSUPPORTED,
                    "偵測到 AdaLN-pruned curve DiT：釘版 SGLang 不允許再套 AdaLN cache"
                    "（minimax_h3.py:2160-2165），adaln.mode 必須為 off",
                    "adaln.mode",
                    expected="off",
                    actual=adaln_mode,
                )
            )
        if (scheme != "none" or pruned) and profile.get("mode") == "exact":
            what = "量化" if scheme != "none" else "pruned"
            out.append(
                err(
                    UNSUPPORTED,
                    f"{kind} 權重為{what}格式（{scheme if scheme != 'none' else 'pruned_curve'}），"
                    "只能以 approximate／experimental 執行，不得稱數學等價",
                    "mode",
                    expected="approximate|experimental",
                    actual="exact",
                )
            )
        if (
            kind == "transformer"
            and scheme != "none"
            and profile.get("runtime_provider") == "sglang_h3"
        ):
            _check_prequantized_layout(profile, scheme, base, out)
        requested = comp.get("quantization") or {}
        online = (
            scheme == "none" and not pruned and acceleration_rules.is_online_quant(comp)
        )
        if (
            requested.get("scheme", "none") != scheme and not online
        ):  # online quant of native BF16 is allowed
            out.append(
                err(
                    UNSUPPORTED,
                    f"{kind} profile 量化 {requested.get('scheme', 'none')} 與實際權重 {scheme} 不符；"
                    "不假裝成原生 BF16，也不默默轉換",
                    f"{base}.quantization.scheme",
                    expected=scheme,
                    actual=requested.get("scheme", "none"),
                )
            )
        elif scheme != "none" and provider and requested.get("provider") != provider:
            out.append(
                err(
                    UNSUPPORTED,
                    f"{kind} 量化 provider 必須與權重格式相符",
                    f"{base}.quantization.provider",
                    expected=provider,
                    actual=requested.get("provider"),
                )
            )
        fmt = facts.get("format")
        weight_format = comp.get("weight_format", "native")
        if (
            fmt
            and weight_format != fmt
            and (weight_format != "native" or scheme != "none" or pruned)
        ):
            out.append(
                err(
                    UNSUPPORTED,
                    f"{kind} weight_format 必須反映實際檔案格式",
                    f"{base}.weight_format",
                    expected=fmt,
                    actual=weight_format,
                )
            )
    return out


def _dedupe(diags: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    out = []
    for d in diags:
        key = (d["code"], d["message"], tuple(d["field_paths"]))
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def _check_runtime_revision(
    profile: Mapping[str, Any], runtime: str, *, sglang: bool, out: list[dict[str, Any]]
) -> None:
    if runtime not in RUNTIME_BOUNDS:
        out.append(
            err(
                UNSUPPORTED,
                f"H3 adapter 未登記 runtime「{runtime}」；可用："
                + "、".join(sorted(RUNTIME_BOUNDS)),
                "runtime_provider",
            )
        )
    elif sglang and profile.get("runtime_source_revision") != constants.SGLANG_REVISION:
        out.append(
            err(
                UNSUPPORTED,
                f"H3 adapter 的規則綁定釘版 SGLang {constants.SGLANG_REVISION[:12]}；其他 revision 需重新審核後才可用",
                "runtime_source_revision",
                expected=constants.SGLANG_REVISION,
                actual=profile.get("runtime_source_revision"),
            )
        )
    elif runtime == constants.RUNTIME_DIFFUSERS:
        out.append(
            warn(
                "RUNTIME_UNPINNED",
                "Diffusers H3 路徑尚未釘定可安裝 commit；能力需 operator probe 後才可用",
                "runtime_provider",
            )
        )


def _check_components(
    profile: Mapping[str, Any], *, exact: bool, sglang: bool, out: list[dict[str, Any]]
) -> None:
    components = profile.get("components") or {}
    placements = profile.get("placements") or {}
    for name in ("text_encoder", "transformer", "video_vae", "audio_vae"):
        comp = components.get(name)
        if not isinstance(comp, Mapping):
            continue
        base = f"components.{name}"
        scheme = (comp.get("quantization") or {}).get("scheme", "none")
        if exact and scheme != "none":
            out.append(
                err(
                    UNSUPPORTED,
                    f"{name} 量化（{scheme}）屬 approximate run，不能標為 mode=exact",
                    "mode",
                    f"{base}.quantization.scheme",
                )
            )
        native_dtypes = (
            ("native", "fp32") if name in ("video_vae", "audio_vae") else ("native",)
        )
        if exact and comp.get("compute_dtype", "native") not in native_dtypes:
            out.append(
                err(
                    UNSUPPORTED,
                    f"{name} 全域改 compute_dtype 不是原生數值（H3 有 FP32 island），不能標為 mode=exact",
                    "mode",
                    f"{base}.compute_dtype",
                )
            )
        role = (placements.get(COMPONENT_PLACEMENT[name]) or {}).get("role")
        offload = comp.get("offload")
        if (
            sglang
            and offload in constants.STREAMED_OFFLOADS
            and role != "cpu"
            and int(comp.get("prefetch_depth", 1)) < 1
        ):
            out.append(
                err(
                    UNSUPPORTED,
                    f"釘版 SGLang CUDA layerwise offload 會把 prefetch 0 改成 1；"
                    f"{name} 的 {offload} offload 必須 prefetch_depth ≥ 1，不默默 clamp",
                    f"{base}.prefetch_depth",
                    f"{base}.offload",
                    expected=">= 1",
                    actual=comp.get("prefetch_depth"),
                )
            )
        quant = comp.get("quantization") or {}
        if (
            sglang
            and name == "transformer"
            and (quant.get("scheme"), quant.get("provider")) == ("nf4", "bitsandbytes")
            and offload not in (None, "none")
        ):
            out.append(
                err(
                    UNSUPPORTED,
                    "bitsandbytes NF4 DiT 在釘版 SGLang 由 _BitsAndBytes4BitAdapter 強制常駐，"
                    "quant state 不在 layerwise offload 的位元組帳內；未經目標 tuple probe 前只接受 offload=none"
                    "（transformer_load_utils.py:446-511）",
                    f"{base}.offload",
                    expected="none",
                    actual=offload,
                )
            )
        out.extend(_residency_diagnostics(name, comp, sglang=sglang))


def _check_execution_mode(
    profile: Mapping[str, Any],
    capabilities: Collection[str],
    *,
    exact: bool,
    out: list[dict[str, Any]],
) -> None:
    components = profile.get("components") or {}
    adaln = profile.get("adaln") or {}
    adaln_mode = adaln.get("mode", "off")
    transformer_scheme = (
        (components.get("transformer") or {}).get("quantization") or {}
    ).get("scheme", "none")
    lora = list(profile.get("lora") or [])
    # : online int8_convrot/fp8_e4m3 of a native BF16 DiT keeps adaln_proj
    # BF16 and is admitted by the shim's runtime patch (acceleration_rules)
    if (
        adaln_mode != "off"
        and transformer_scheme != "none"
        and not acceleration_rules.adaln_quant_relaxable(profile)
    ):
        out.append(
            err(
                UNSUPPORTED,
                "釘版 SGLang 的 AdaLN cache／online 只接受未量化的 transformer（quant_config 必須為 None）；請擇一"
                "（例外：原生 BF16 checkpoint 的線上 int8_convrot／fp8_e4m3，provider=sglang_native）",
                "adaln.mode",
                "components.transformer.quantization.scheme",
                expected="adaln.mode=off 或 quantization.scheme=none",
                actual=f"{adaln_mode} + {transformer_scheme}",
            )
        )
    if adaln_mode == "fixed" and not adaln.get("cache_ref"):
        out.append(
            err(
                INVALID,
                "AdaLN fixed 模式必須指定 cache_ref（cache 未涵蓋的 schedule 會 ADALN_CACHE_MISS）",
                "adaln.cache_ref",
            )
        )
    # AdaLN × LoRA needs the registry facts (touches_adaln), so lora_rules decides it
    # at plan time; a profile alone cannot tell a Turbo LoRA (shares the base cache) from PDD.
    if exact and lora:
        out.append(
            err(
                UNSUPPORTED,
                "LoRA 改變數值，屬 approximate run",
                "mode",
                "lora",
            )
        )

    graphs = profile.get("cuda_graphs") or {}
    if (
        graphs.get("mode") == "static_bucket"
        and "cuda_graphs.dynamic_offload" not in capabilities
    ):
        offloaded = [
            name
            for name in ("text_encoder", "transformer", "video_vae", "audio_vae")
            if (components.get(name) or {}).get("offload", "none") != "none"
        ]
        if offloaded:
            out.append(
                err(
                    UNSUPPORTED,
                    "CUDA graph static_bucket 需要固定位址，與動態 offload 衝突；需另有已驗證的相容能力",
                    "cuda_graphs.mode",
                    *[f"components.{name}.offload" for name in offloaded],
                )
            )


def _check_vae_policy(
    profile: Mapping[str, Any],
    capabilities: Collection[str],
    *,
    exact: bool,
    out: list[dict[str, Any]],
) -> None:
    vae = profile.get("vae") or {}
    _check_spatial_tile(vae, out)
    temporal = vae.get("temporal_policy", "native")
    chunk = vae.get("temporal_chunk_frames")
    t_overlap = int(vae.get("temporal_overlap_frames", 0) or 0)
    if temporal == "native":
        if chunk is not None:
            out.append(
                err(
                    INVALID,
                    "temporal_policy=native 不可設定 temporal_chunk_frames",
                    "vae.temporal_chunk_frames",
                )
            )
        if t_overlap:
            out.append(
                err(
                    INVALID,
                    "temporal_policy=native 不可設定 temporal_overlap_frames",
                    "vae.temporal_overlap_frames",
                )
            )
    else:
        if chunk is None:
            out.append(
                err(
                    INVALID,
                    "validated_chunk 需要 temporal_chunk_frames",
                    "vae.temporal_chunk_frames",
                )
            )
        elif t_overlap >= int(chunk):
            out.append(
                err(
                    INVALID,
                    "temporal_overlap_frames 必須小於 temporal_chunk_frames",
                    "vae.temporal_overlap_frames",
                )
            )
        if "vae.validated_chunk" not in capabilities:
            out.append(
                err(
                    UNSUPPORTED,
                    "釘版 provider 沒有受驗證的 VAE temporal chunk 能力；草稿保留，但 resolve 拒絕",
                    "vae.temporal_policy",
                )
            )
    if exact and vae.get("transfer_dtype") == "bf16":
        out.append(
            err(
                UNSUPPORTED,
                "BF16 latent 傳輸屬 approximate；原生基準是 FP32",
                "mode",
                "vae.transfer_dtype",
            )
        )


def _check_parallelism(
    profile: Mapping[str, Any], capabilities: Collection[str], out: list[dict[str, Any]]
) -> None:
    parallel = profile.get("parallelism") or {}
    par_mode = parallel.get("mode", "stage_only")
    degrees = [
        int(parallel.get(k, 1))
        for k in ("tensor_degree", "ulysses_degree", "ring_degree")
    ]
    if par_mode == "stage_only":
        if any(d != 1 for d in degrees):
            out.append(
                err(
                    INVALID,
                    "stage_only 時各 parallel degree 必須為 1",
                    "parallelism.mode",
                )
            )
    elif f"parallelism.{par_mode}" not in capabilities:
        out.append(
            err(
                UNSUPPORTED,
                f"多卡模式 {par_mode} 沒有同質 group 的 capability evidence；首期只支援 stage_only",
                "parallelism.mode",
            )
        )
    if parallel.get("fsdp_inference") and "parallelism.fsdp" not in capabilities:
        out.append(err(UNSUPPORTED, "FSDP 推論未經驗證", "parallelism.fsdp_inference"))


def _check_prequantized_layout(
    profile: Mapping[str, Any], scheme: str, base: str, out: list[dict[str, Any]]
) -> None:
    layout = (checkpoint_declaration(profile) or {}).get("transformer_qkv_layout")
    if layout is None:
        out.append(
            err(
                UNSUPPORTED,
                f"預量化 DiT（{scheme}）的 qkv_proj 列順序無法由 header 判定，4-bit 打包權重也不能在載入時重排；"
                f"需在 profile extension {SGLANG_CHECKPOINT_EXTENSION} 宣告 transformer_qkv_layout"
                "（minimax_h3.py:991-1005）",
                "extensions",
                f"{base}.quantization.scheme",
            )
        )
    elif layout != "concat":
        out.append(
            err(
                UNSUPPORTED,
                f"transformer_qkv_layout={layout}：預量化 4-bit 權重不能逐列重排成 concat，釘版 SGLang 無法載入",
                "extensions",
                expected="concat",
                actual=layout,
            )
        )


def _check_spatial_tile(vae: Mapping[str, Any], out: list[dict[str, Any]]) -> None:
    tile = int(vae.get("spatial_tile", constants.VAE_DEFAULT_TILE))
    overlap = int(vae.get("spatial_overlap", constants.VAE_DEFAULT_TILE_OVERLAP))
    if overlap >= tile:
        out.append(
            err(
                INVALID,
                "VAE spatial_overlap 必須小於 spatial_tile",
                "vae.spatial_overlap",
                "vae.spatial_tile",
                expected=f"< {tile}",
                actual=overlap,
            )
        )
    if tile % constants.VAE_SPATIAL_FACTOR:
        out.append(
            err(
                INVALID,
                f"spatial_tile 必須是 VAE 空間倍率 {constants.VAE_SPATIAL_FACTOR} 的倍數",
                "vae.spatial_tile",
                actual=tile,
            )
        )
    if overlap % constants.VAE_SPATIAL_FACTOR:
        out.append(
            err(
                INVALID,
                f"spatial_overlap 必須是 {constants.VAE_SPATIAL_FACTOR} 的倍數（釘版以整除換算 latent overlap）",
                "vae.spatial_overlap",
                actual=overlap,
            )
        )
