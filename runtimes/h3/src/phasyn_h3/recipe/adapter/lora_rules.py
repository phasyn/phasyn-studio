"""Plan-time LoRA rules for H3.

Inputs are the profile's ``lora[]`` entries and the bindings the control plane resolved
from the LoRA registry (``lora-binding.schema.json``: entry + frozen manifest).  Field paths
are already rooted: ``profile.<path>`` for profile fields, bare request paths otherwise.

Rules:

* at most one LoRA (pinned SGLang dynamic LoRA allows one adapter per target,
  ``SGR:runtime/pipelines_core/lora/pipeline.py:1175-1179``);
* the manifest must be verified, of family ``minimax_h3`` and list the model variant;
* the sampling contract is a contract, not a hint: ``sampling.steps`` ∈ contract steps,
  video/audio shift and scheduler equal (PDD 8 & 12/3; Turbo fl2v 6/3; Turbo ref2v 12/3);
* a PDD manifest may group its intervals non-uniformly (``pdd.blocks``, e.g. [8, 16, 8] of 32 → 3 steps):
  positive integers summing to ``pdd.num_steps``, contract steps ``[len(blocks)]``;
* ``lora[].alpha`` null means "the manifest alpha"; a value must equal it;
  ``fixed_scale`` (PDD 1.0) pins ``lora[].scale``;
* LoRA runs are approximate (``mode=exact`` rejected by profile_rules); a pruned-curve
  checkpoint cannot take an AdaLN LoRA (no ``adaln_basis``) and any other LoRA on it is
  out of distribution → ``experimental`` only;
* a LoRA that touches ``adaln_proj`` works with AdaLN off (dynamic) or a fixed
  sidecar carrying its LoRA signature (checked by the runtime before the DiT loads);
  ``online`` rebuilds from base weights and is rejected; Turbo shares the base cache;
* merge mode (profile extension ``phasyn.sglang_h3.lora``) defaults to ``dynamic``; ``merge`` is
  only the BF16 comparison arm: unquantized, resident (offload none/component), never with a
  signed AdaLN sidecar.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from . import constants as C
from ._diag import INVALID, UNSUPPORTED, err, info
from .loras import (
    DEFAULT_DYNAMIC_CHUNK_TOKENS,
    LORA_FORMATS,
    adaln_lora_signature,
    adapters_signature,
    pdd_blocks_problems,
)
from .profile_rules import (
    checkpoint_declaration,
    detected_scheme,
    facts_by_kind,
    is_pruned,
    lora_extension,
)

MERGE_MODES = ("dynamic", "merge")
MAX_LORAS = 1


def lora_merge_mode(profile: Mapping[str, Any]) -> str:
    return str(lora_extension(profile).get("merge_mode", "dynamic"))


def lora_chunk_tokens(profile: Mapping[str, Any]) -> int:
    """Rows per in-place chunk of the dynamic LoRA term (0 = whole sequence; schema-validated)."""
    value = lora_extension(profile).get("dynamic_chunk_tokens", DEFAULT_DYNAMIC_CHUNK_TOKENS)
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else DEFAULT_DYNAMIC_CHUNK_TOKENS


def _transformer_pruned(
    profile: Mapping[str, Any], model: Mapping[str, Any] | None, model_facts: Mapping[str, Mapping[str, Any]] | None
) -> bool:
    facts = facts_by_kind(model_facts, model).get("transformer") or {}
    declared = (checkpoint_declaration(profile) or {}).get("transformer_architecture")
    return is_pruned(facts) or declared == "pruned_curve"


def _transformer_quantized(profile: Mapping[str, Any], facts: Mapping[str, Any]) -> bool:
    transformer = (profile.get("components") or {}).get("transformer") or {}
    requested = str((transformer.get("quantization") or {}).get("scheme", "none"))
    return requested != "none" or detected_scheme(facts) != "none"


def validate_lora_bindings(
    profile: Mapping[str, Any],
    bindings: Sequence[Mapping[str, Any]] | None,
    *,
    request: Mapping[str, Any],
    model: Mapping[str, Any] | None = None,
    model_facts: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Diagnostics for the plan's LoRA bindings (empty list when the profile has no LoRA)."""
    entries = list(profile.get("lora") or [])
    bindings = list(bindings or [])
    out: list[dict[str, Any]] = []
    merge_mode = lora_merge_mode(profile)
    ext_path = "profile.extensions"
    if merge_mode not in MERGE_MODES:
        out.append(err(INVALID, f"merge_mode={merge_mode} 不合法（dynamic|merge）", ext_path))
    if not entries:
        if bindings:
            out.append(err(INVALID, "plan 帶有 LoRA 綁定，但 profile 沒有 lora[]", "profile.lora"))
        return out
    if len(entries) > MAX_LORAS:
        out.append(
            err(
                UNSUPPORTED,
                f"此 runtime 一次只能套用 {MAX_LORAS} 個 LoRA（釘版 dynamic LoRA 每個 target 只允許一個 adapter，"
                "pipeline.py:1175-1179）",
                "profile.lora",
                expected=f"<= {MAX_LORAS}",
                actual=len(entries),
            )
        )
    if len(bindings) != len(entries):
        out.append(
            err(
                UNSUPPORTED,
                "profile 的 lora[] 沒有對應的 registry 事實（LORA_FACTS_MISSING）；不猜 LoRA 目標或 alpha",
                "profile.lora",
                expected=len(entries),
                actual=len(bindings),
            )
        )
        return out

    sampling = request.get("sampling") or {}
    variant = str((model or {}).get("variant", ""))
    adaln_mode = str((profile.get("adaln") or {}).get("mode", "off"))
    transformer = (profile.get("components") or {}).get("transformer") or {}
    offload = str(transformer.get("offload", "block"))
    dit_facts = facts_by_kind(model_facts, model).get("transformer") or {}
    quantized = _transformer_quantized(profile, dit_facts)
    pruned = _transformer_pruned(profile, model, model_facts)
    mode = str(profile.get("mode", "exact"))
    for index, (entry, binding) in enumerate(zip(entries, bindings, strict=True)):
        base = f"profile.lora[{index}]"
        manifest = binding.get("manifest") or {}
        name = str(entry.get("model_id"))
        if (binding.get("lora_id"), binding.get("revision")) != (entry.get("model_id"), entry.get("revision")):
            out.append(
                err(
                    INVALID,
                    f"LoRA 綁定 {binding.get('lora_id')}@{binding.get('revision')} 與 profile 項目不符",
                    f"{base}.model_id",
                    f"{base}.revision",
                )
            )
            continue
        if float(binding.get("scale", 0.0)) != float(entry.get("scale", 0.0)):
            out.append(err(INVALID, "LoRA 綁定的 scale 與 profile 不符", f"{base}.scale"))
        if manifest.get("family") != C.FAMILY:
            out.append(
                err(UNSUPPORTED, f"LoRA {name} 屬於 {manifest.get('family')}，不是 MiniMax H3", f"{base}.model_id")
            )
            continue
        if manifest.get("format") not in LORA_FORMATS:
            out.append(err(UNSUPPORTED, f"LoRA 格式 {manifest.get('format')} 未接入", f"{base}.model_id"))
        if manifest.get("status") != "verified":
            out.append(
                err(
                    UNSUPPORTED,
                    f"LoRA {name} 狀態為 {manifest.get('status')}；未以 sha256 與 header verify 的 LoRA 不能生成",
                    f"{base}.model_id",
                )
            )
        if variant not in (manifest.get("variants") or []):
            out.append(
                err(
                    UNSUPPORTED,
                    f"LoRA {name} 只適用 {manifest.get('variants')}，目前模型是 {variant}（FL2VA 與 Ref2VA 不互換）",
                    f"{base}.model_id",
                    "model_id",
                    expected=manifest.get("variants"),
                    actual=variant,
                )
            )
        alpha = entry.get("alpha")
        if alpha is not None and float(alpha) != float(manifest.get("alpha", -1)):
            out.append(
                err(
                    UNSUPPORTED,
                    f"lora[].alpha={alpha} 與 registry 的 alpha={manifest.get('alpha')}（{manifest.get('alpha_source')}）"
                    "衝突；null 代表使用 registry 值",
                    f"{base}.alpha",
                    expected=manifest.get("alpha"),
                    actual=alpha,
                )
            )
        fixed = manifest.get("fixed_scale")
        scale = float(entry.get("scale", 0.0))
        if fixed is not None and scale != float(fixed):
            out.append(
                err(
                    UNSUPPORTED,
                    f"LoRA {name} 的強度固定為 {fixed}（PDD 輸出頭依訓練時的 backbone 融合）",
                    f"{base}.scale",
                    expected=fixed,
                    actual=scale,
                )
            )
        elif scale == 0.0:
            out.append(err(INVALID, "LoRA scale 0 等於沒有 LoRA；請移除該項目", f"{base}.scale"))

        for problem in pdd_blocks_problems(manifest):
            out.append(err(INVALID, f"LoRA {name} 的 manifest：{problem}", f"{base}.model_id"))
        contract = manifest.get("sampling_contract") or {}
        steps = sampling.get("steps")
        if steps not in (contract.get("steps") or []):
            out.append(
                err(
                    UNSUPPORTED,
                    f"LoRA {name} 的採樣合約要求 steps ∈ {contract.get('steps')}（DiT 更新數），收到 {steps}",
                    "sampling.steps",
                    f"{base}.model_id",
                    expected=contract.get("steps"),
                    actual=steps,
                )
            )
        for key in ("video_shift", "audio_shift"):
            want, have = contract.get(key), sampling.get(key)
            if want is None or have is None or float(have) != float(want):
                out.append(
                    err(
                        UNSUPPORTED,
                        f"LoRA {name} 的採樣合約要求 {key}={want}，收到 {have}（不是建議值，是訓練時的 sigma 網格）",
                        f"sampling.{key}",
                        f"{base}.model_id",
                        expected=want,
                        actual=have,
                    )
                )
        if sampling.get("scheduler", C.SCHEDULER_ID) != contract.get("scheduler", C.SCHEDULER_ID):
            out.append(
                err(UNSUPPORTED, f"LoRA {name} 需要 scheduler {contract.get('scheduler')}", "sampling.scheduler")
            )

        touches_adaln = bool(manifest.get("touches_adaln"))
        if pruned:
            if touches_adaln:
                out.append(
                    err(
                        UNSUPPORTED,
                        f"LoRA {name} 含 adaln_proj（輸入寬 {C.DIT_TIME_EMBED_DIM}），pruned-curve checkpoint 沒有 "
                        "adaln_basis／adaln_mean，無法投影（LORA_PRUNED_ADALN）",
                        f"{base}.model_id",
                        "model_id",
                    )
                )
            elif mode != "experimental":
                out.append(
                    err(
                        UNSUPPORTED,
                        f"LoRA {name} 在未剪枝 BF16 上訓練，套到 pruned-curve checkpoint 屬分佈外，只能 mode=experimental",
                        "profile.mode",
                        f"{base}.model_id",
                        expected="experimental",
                        actual=mode,
                    )
                )
        if touches_adaln and adaln_mode == "online":
            out.append(
                err(
                    UNSUPPORTED,
                    f"LoRA {name} 觸及 adaln_proj：online AdaLN 從基礎權重重算，會丟掉 LoRA（RULE-006，"
                    "minimax_h3.py:1880-1895）；改用 adaln.mode=off 或帶 LoRA 簽章的 fixed sidecar",
                    "profile.adaln.mode",
                    f"{base}.model_id",
                    expected="off|fixed",
                    actual=adaln_mode,
                )
            )
        if touches_adaln and adaln_mode == "fixed":
            out.append(
                info(
                    "LORA_SIGNED_ADALN_SIDECAR",
                    f"adaln.mode=fixed：sidecar metadata lora_signature 必須是 {adaln_lora_signature([binding])}"
                    "（以 phasyn_h3.recipe.runtime.adaln_sidecar 對基礎權重＋此 LoRA 建置），runtime 載入 DiT 前驗證",
                    "profile.adaln.cache_ref",
                )
            )
        if merge_mode == "merge":
            if quantized:
                out.append(
                    err(
                        UNSUPPORTED,
                        "量化 DiT 只能 dynamic LoRA（量化權重不能就地合併，pipeline.py:735-739）",
                        ext_path,
                        "profile.components.transformer.quantization.scheme",
                    )
                )
            if offload not in ("none", "component"):
                out.append(
                    err(
                        UNSUPPORTED,
                        f"merge 會把 {offload} offload 的映射權重改成匿名記憶體（約 40–64 GB，§5.4）；只接受 none/component",
                        ext_path,
                        "profile.components.transformer.offload",
                    )
                )
            if touches_adaln and adaln_mode == "fixed":
                out.append(
                    err(
                        UNSUPPORTED,
                        "AdaLN sidecar 以 dynamic LoRA 建置；merge 對照組請用 adaln.mode=off",
                        ext_path,
                        "profile.adaln.mode",
                    )
                )
            out.append(
                info(
                    "LORA_MERGE_REFERENCE",
                    "merge 只作 BF16 對照組：合併後 BF16 捨入會丟掉 PDD 14–44%、Turbo 約 99% 的更新（§5.1）",
                    ext_path,
                )
            )
    return out


def lora_plan_facts(profile: Mapping[str, Any], bindings: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
    """What the plan facts / estimates need: merge mode, signatures, device bytes, PDD."""
    bindings = list(bindings or [])
    merge_mode = lora_merge_mode(profile)
    return {
        "lora_merge_mode": merge_mode if bindings else None,
        # in-place chunk rows of the dynamic term (dynamic mode only; estimates and provenance)
        "dynamic_chunk_tokens": lora_chunk_tokens(profile) if bindings and merge_mode == "dynamic" else None,
        "adapters_signature": adapters_signature(bindings, merge_mode=merge_mode),
        "adaln_lora_signature": adaln_lora_signature(bindings),
        "items": [
            {
                "lora_id": b["lora_id"],
                "revision": b["revision"],
                "format": b["manifest"]["format"],
                "rank": b["manifest"]["rank"],
                "alpha": b["manifest"]["alpha"],
                "alpha_source": b["manifest"]["alpha_source"],
                "scale": b["scale"],
                "effective_scale": float(b["scale"]) * float(b["manifest"]["alpha"]) / int(b["manifest"]["rank"]),
                "touches_adaln": b["manifest"]["touches_adaln"],
                "pdd": b["manifest"]["pdd"],
                # LoRA factors live on the DiT device next to the layers (dynamic mode); the PDD
                # heads (≈66 MB) are part of the file and stay on the host — an upper bound
                "device_bytes": int(b["manifest"]["file"]["size_bytes"]),
            }
            for b in bindings
        ],
    }


__all__ = [
    "MAX_LORAS",
    "MERGE_MODES",
    "lora_chunk_tokens",
    "lora_merge_mode",
    "lora_plan_facts",
    "validate_lora_bindings",
]
