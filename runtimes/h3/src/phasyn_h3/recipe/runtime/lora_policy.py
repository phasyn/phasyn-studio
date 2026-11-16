"""LoRA runtime policy for one H3 stage (pure Python + numpy, no torch).

The plan carries the LoRA registry facts frozen at compile time (``plan.loras[]``,
``lora-binding.schema.json``); the runtime never queries the registry.  This module
re-validates them against the effective profile before any GPU work and decides how the
DiT component applies them:

* LoRA is always dynamic: the base GEMM (BF16 or quantized) runs untouched and the LoRA
  term ``(x·Aᵀ)·Bᵀ·α/r·scale`` is accumulated into its output in place, ``dynamic_chunk_tokens``
  rows at a time (``lora_inplace``; upstream adds a second full-size output,
  ``SGR:runtime/layers/lora/linear.py:682-727, 784-846``); ``merge`` exists only as the BF16
  comparison arm (profile extension ``phasyn.sglang_h3.lora``), never for quantized or streamed
  (layerwise) DiTs;
* a LoRA touching ``adaln_proj`` (PDD) is applied dynamically with AdaLN off, or comes
  from a fixed sidecar built with the LoRA and signed with :func:`adaln_lora_signature`
online AdaLN would rebuild from base weights → rejected;
* steps and shifts are contracts (``check_lora_schedule``); PDD additionally needs the
  plan's sigma grid to equal the training block boundaries (``pdd.check_pdd_schedule``), or the
  boundaries of the manifest's non-uniform ``pdd.blocks``.

Reason codes: LORA_FACTS_MISSING, LORA_FACTS_MISMATCH, LORA_COUNT_UNSUPPORTED,
LORA_NOT_VERIFIED, LORA_FORMAT_UNSUPPORTED, LORA_VARIANT_MISMATCH, LORA_ALPHA_CONFLICT,
LORA_PDD_SCALE_FIXED, LORA_NOT_APPROXIMATE, LORA_PRUNED_ADALN, LORA_PRUNED_EXPERIMENTAL_ONLY,
LORA_ADALN_ONLINE_UNSUPPORTED, LORA_MERGE_QUANTIZED, LORA_MERGE_OFFLOAD_UNSUPPORTED,
LORA_MERGE_SIDECAR_UNSUPPORTED, LORA_SCHEDULE_MISMATCH.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from phasyn_h3.recipe.adapter.loras import (
    DEFAULT_DYNAMIC_CHUNK_TOKENS,
    LORA_FORMAT_PDD,
    LORA_FORMATS,
    MAX_DYNAMIC_CHUNK_TOKENS,
    adaln_lora_signature,
    adapters_signature,
    pdd_blocks,
    pdd_blocks_problems,
)

from .errors import UnsupportedCombination

LORA_EXTENSION_NAMESPACE = "phasyn.sglang_h3.lora"
LORA_EXTENSION_KEYS = ("merge_mode", "dynamic_chunk_tokens")
# arithmetic of the dynamic term (lora_inplace): recorded in run metadata and in LoRA-signed AdaLN
# sidecars (metadata ``lora_accumulate``) so a sidecar can be matched with the runtime's dynamic path
LORA_ACCUMULATE = "inplace_addmm"
SIDECAR_LORA_ACCUMULATE_KEY = "lora_accumulate"
MERGE_MODES = ("dynamic", "merge")
MAX_LORAS = 1
FAMILY = "minimax_h3"


@dataclass(frozen=True)
class LoraSpec:
    """One plan LoRA as the actor applies it."""

    lora_id: str
    revision: str
    relative_path: str
    sha256: str
    size_bytes: int
    format: str
    rank: int
    alpha: float
    alpha_source: str
    scale: float
    touches_adaln: bool
    targets: tuple[str, ...]
    pdd_num_steps: int | None
    pdd_block_size: int | None
    steps: tuple[int, ...]
    video_shift: float
    audio_shift: float
    # "dynamic": adaln_proj gets a LoRA wrapper (AdaLN off); "sidecar": the fixed AdaLN cache
    # was built with this LoRA (its adaln factors are not attached); "none": no adaln factors
    adaln_handling: str
    # non-uniform PDD grouping (manifest ``pdd.blocks``: intervals per fused head); None = uniform by block_size
    pdd_blocks: tuple[int, ...] | None = None

    @property
    def is_pdd(self) -> bool:
        return self.format == LORA_FORMAT_PDD

    @property
    def pdd_steps(self) -> int | None:
        if self.pdd_num_steps is None or self.pdd_block_size is None:
            return None
        if self.pdd_blocks is not None:
            return len(self.pdd_blocks)
        return self.pdd_num_steps // self.pdd_block_size

    @property
    def effective_scale(self) -> float:
        """What multiplies B·A·x: scale × alpha ／ rank (linear.py:713-717)."""
        return self.scale * self.alpha / self.rank

    def as_dict(self) -> dict[str, Any]:
        return {
            "lora_id": self.lora_id,
            "revision": self.revision,
            "sha256": self.sha256,
            "format": self.format,
            "rank": self.rank,
            "alpha": self.alpha,
            "alpha_source": self.alpha_source,
            "scale": self.scale,
            "effective_scale": self.effective_scale,
            "touches_adaln": self.touches_adaln,
            "adaln_handling": self.adaln_handling,
            "pdd": None
            if self.pdd_num_steps is None
            else {
                "num_steps": self.pdd_num_steps,
                "block_size": self.pdd_block_size,
                **({} if self.pdd_blocks is None else {"blocks": list(self.pdd_blocks)}),
            },
            "sampling_contract": {
                "steps": list(self.steps),
                "video_shift": self.video_shift,
                "audio_shift": self.audio_shift,
            },
        }


@dataclass(frozen=True)
class LoraPolicy:
    specs: tuple[LoraSpec, ...]
    merge_mode: str
    adapters_signature: str
    adaln_signature: str
    # rows per in-place chunk of the dynamic term (lora_inplace; 0 = whole sequence at once)
    chunk_tokens: int = DEFAULT_DYNAMIC_CHUNK_TOKENS

    def as_dict(self) -> dict[str, Any]:
        return {
            "lora_merge_mode": self.merge_mode,
            "adapters_signature": self.adapters_signature,
            "adaln_lora_signature": self.adaln_signature,
            "dynamic_chunk_tokens": self.chunk_tokens if self.merge_mode == "dynamic" else None,
            "loras": [spec.as_dict() for spec in self.specs],
        }


def _reject(reason: str, message: str, field_path: str | None = None, **kwargs: Any) -> UnsupportedCombination:
    return UnsupportedCombination(reason, message, field_path=field_path, **kwargs)


def lora_extension_values(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Validated values of the profile's ``phasyn.sglang_h3.lora`` extension ({} when absent)."""
    for ext in profile.get("extensions") or ():
        if ext.get("namespace") != LORA_EXTENSION_NAMESPACE:
            continue
        values = dict(ext.get("values") or {})
        unknown = set(values) - set(LORA_EXTENSION_KEYS)
        if unknown:
            raise _reject(
                "EXTENSION_UNKNOWN_KEYS",
                f"{LORA_EXTENSION_NAMESPACE} 有未登記欄位：{sorted(unknown)}（RULE-034）",
                "extensions",
            )
        mode = str(values.get("merge_mode", "dynamic"))
        if mode not in MERGE_MODES:
            raise _reject("EXTENSION_VALUE_INVALID", f"merge_mode={mode!r} 不合法", "extensions")
        chunk = values.get("dynamic_chunk_tokens", DEFAULT_DYNAMIC_CHUNK_TOKENS)
        if isinstance(chunk, bool) or not isinstance(chunk, int) or not 0 <= chunk <= MAX_DYNAMIC_CHUNK_TOKENS:
            raise _reject(
                "EXTENSION_VALUE_INVALID",
                f"dynamic_chunk_tokens={chunk!r} 必須是 0..{MAX_DYNAMIC_CHUNK_TOKENS} 的整數（0＝不分塊）",
                "extensions",
            )
        return values
    return {}


def lora_merge_mode(profile: Mapping[str, Any]) -> str:
    return str(lora_extension_values(profile).get("merge_mode", "dynamic"))


def lora_chunk_tokens(profile: Mapping[str, Any]) -> int:
    """Rows per in-place chunk of the dynamic LoRA term (0 = the whole sequence in one ``addmm_``)."""
    return int(lora_extension_values(profile).get("dynamic_chunk_tokens", DEFAULT_DYNAMIC_CHUNK_TOKENS))


def resolve_lora_policy(
    plan: Mapping[str, Any],
    profile: Mapping[str, Any],
    *,
    adaln_mode: str,
    pruned_curve: bool = False,
) -> LoraPolicy | None:
    """Validate ``profile.lora[]`` against ``plan.loras[]``; None when the profile has no LoRA."""
    entries = list(profile.get("lora") or [])
    bindings = list(plan.get("loras") or [])
    merge_mode = lora_merge_mode(profile)
    if not entries:
        if bindings:
            raise _reject("LORA_FACTS_MISMATCH", "plan 帶有 LoRA 綁定，但 profile 沒有 lora[]", "lora")
        return None
    if len(entries) > MAX_LORAS:
        raise _reject(
            "LORA_COUNT_UNSUPPORTED",
            f"一次只能套用 {MAX_LORAS} 個 LoRA（釘版 dynamic LoRA 每個 target 一個 adapter，pipeline.py:1175-1179）",
            "lora",
            expected=MAX_LORAS,
            actual=len(entries),
        )
    if len(bindings) != len(entries):
        raise _reject(
            "LORA_FACTS_MISSING",
            "plan 缺少 LoRA registry 事實（plan.loras）；runtime 不猜 LoRA 目標或 alpha",
            "lora",
            expected=len(entries),
            actual=len(bindings),
        )
    mode = str(profile.get("mode", "exact"))
    if mode == "exact":
        raise _reject("LORA_NOT_APPROXIMATE", "LoRA 改變數值，屬 approximate run（REQ-021）", "mode")
    components = profile.get("components") or {}
    transformer = components.get("transformer") or {}
    quantized = str((transformer.get("quantization") or {}).get("scheme", "none")) != "none"
    offload = str(transformer.get("offload", "block"))
    variant = str((plan.get("model") or {}).get("variant", "")).lower()
    specs: list[LoraSpec] = []
    for index, (entry, binding) in enumerate(zip(entries, bindings, strict=True)):
        path = f"lora[{index}]"
        manifest = binding.get("manifest") or {}
        if (binding.get("lora_id"), binding.get("revision")) != (entry.get("model_id"), entry.get("revision")) or float(
            binding.get("scale", 0.0)
        ) != float(entry.get("scale", 0.0)):
            raise _reject("LORA_FACTS_MISMATCH", f"plan.loras[{index}] 與 profile {path} 不一致", path)
        name = str(entry.get("model_id"))
        if manifest.get("family") != FAMILY or manifest.get("lora_id") != binding.get("lora_id"):
            raise _reject("LORA_FACTS_MISMATCH", f"LoRA {name} 的 manifest 不屬於 MiniMax H3／此 id", path)
        if manifest.get("status") != "verified":
            raise _reject("LORA_NOT_VERIFIED", f"LoRA {name} 未 verify（status={manifest.get('status')}）", path)
        fmt = str(manifest.get("format"))
        if fmt not in LORA_FORMATS:
            raise _reject("LORA_FORMAT_UNSUPPORTED", f"LoRA 格式 {fmt} 未接入", path)
        if variant not in (manifest.get("variants") or []):
            raise _reject(
                "LORA_VARIANT_MISMATCH",
                f"LoRA {name} 只適用 {manifest.get('variants')}，模型是 {variant}",
                path,
                expected=manifest.get("variants"),
                actual=variant,
            )
        alpha = float(manifest["alpha"])
        if entry.get("alpha") is not None and float(entry["alpha"]) != alpha:
            raise _reject(
                "LORA_ALPHA_CONFLICT",
                f"lora[].alpha={entry['alpha']} 與 registry alpha={alpha} 衝突",
                f"{path}.alpha",
                expected=alpha,
                actual=entry["alpha"],
            )
        scale = float(entry["scale"])
        fixed = manifest.get("fixed_scale")
        if fixed is not None and scale != float(fixed):
            raise _reject(
                "LORA_PDD_SCALE_FIXED",
                f"LoRA {name} 的強度固定為 {fixed}",
                f"{path}.scale",
                expected=fixed,
                actual=scale,
            )
        touches_adaln = bool(manifest.get("touches_adaln"))
        if pruned_curve:
            if touches_adaln:
                raise _reject(
                    "LORA_PRUNED_ADALN",
                    f"LoRA {name} 含 adaln_proj，pruned-curve checkpoint 沒有 adaln_basis 可投影",
                    path,
                )
            if mode != "experimental":
                raise _reject(
                    "LORA_PRUNED_EXPERIMENTAL_ONLY",
                    "LoRA 在未剪枝 BF16 上訓練；套到 pruned-curve checkpoint 只能 mode=experimental",
                    "mode",
                )
        if touches_adaln and adaln_mode == "online":
            raise _reject(
                "LORA_ADALN_ONLINE_UNSUPPORTED",
                f"LoRA {name} 觸及 adaln_proj；online AdaLN 從基礎權重重算會丟掉它（minimax_h3.py:1880-1895, RULE-006）",
                "adaln.mode",
            )
        handling = "none"
        if touches_adaln:
            handling = "sidecar" if adaln_mode == "fixed" else "dynamic"
        if merge_mode == "merge":
            if quantized:
                raise _reject("LORA_MERGE_QUANTIZED", "量化 DiT 只能 dynamic LoRA（pipeline.py:735-739）", "extensions")
            if offload not in ("none", "component"):
                raise _reject(
                    "LORA_MERGE_OFFLOAD_UNSUPPORTED",
                    f"merge 會把 {offload} offload 的映射權重變成匿名記憶體；只接受 none/component",
                    "extensions",
                )
            if handling == "sidecar":
                raise _reject(
                    "LORA_MERGE_SIDECAR_UNSUPPORTED",
                    "AdaLN sidecar 以 dynamic LoRA 建置；merge 對照組用 adaln off",
                    "extensions",
                )
        pdd = manifest.get("pdd") or None
        blocks_problems = pdd_blocks_problems(manifest)
        if blocks_problems:
            raise _reject(
                "LORA_FACTS_MISMATCH", f"LoRA {name} 的 pdd.blocks 不能執行：{'；'.join(blocks_problems)}", path
            )
        contract = manifest.get("sampling_contract") or {}
        file = manifest.get("file") or {}
        specs.append(
            LoraSpec(
                lora_id=str(binding["lora_id"]),
                revision=str(binding["revision"]),
                relative_path=str(file.get("relative_path")),
                sha256=str(file.get("sha256")),
                size_bytes=int(file.get("size_bytes", 0)),
                format=fmt,
                rank=int(manifest["rank"]),
                alpha=alpha,
                alpha_source=str(manifest.get("alpha_source")),
                scale=scale,
                touches_adaln=touches_adaln,
                targets=tuple(manifest.get("targets") or ()),
                pdd_num_steps=None if pdd is None else int(pdd["num_steps"]),
                pdd_block_size=None if pdd is None else int(pdd["block_size"]),
                steps=tuple(int(s) for s in contract.get("steps") or ()),
                video_shift=float(contract.get("video_shift", 0.0)),
                audio_shift=float(contract.get("audio_shift", 0.0)),
                adaln_handling=handling,
                pdd_blocks=pdd_blocks(manifest),
            )
        )
    return LoraPolicy(
        specs=tuple(specs),
        merge_mode=merge_mode,
        adapters_signature=adapters_signature(bindings, merge_mode=merge_mode),
        adaln_signature=adaln_lora_signature(bindings),
        chunk_tokens=lora_chunk_tokens(profile),
    )


def check_lora_schedule(policy: LoraPolicy | None, *, updates: int, schedule: Mapping[str, Any]) -> None:
    """Steps and shifts are contracts: the plan's grid must be the one the LoRA was trained on."""
    if policy is None:
        return
    for spec in policy.specs:
        problems: list[str] = []
        if updates not in spec.steps:
            problems.append(f"steps={updates} ∉ {list(spec.steps)}")
        for key, want in (("video_shift", spec.video_shift), ("audio_shift", spec.audio_shift)):
            have = schedule.get(key)
            if have is None or float(have) != want:
                problems.append(f"{key}={have} ≠ {want}")
        if problems:
            raise _reject(
                "LORA_SCHEDULE_MISMATCH",
                f"LoRA {spec.lora_id} 的採樣合約不符：{'；'.join(problems)}（不是建議值，是訓練時的 sigma 網格）",
                "schedule",
            )


def adaln_signature_of(policy: LoraPolicy | None) -> str:
    return "none" if policy is None else policy.adaln_signature


def specs_of(policy: LoraPolicy | None) -> Sequence[LoraSpec]:
    return () if policy is None else policy.specs


__all__ = [
    "LORA_ACCUMULATE",
    "LORA_EXTENSION_KEYS",
    "LORA_EXTENSION_NAMESPACE",
    "MAX_LORAS",
    "MERGE_MODES",
    "SIDECAR_LORA_ACCUMULATE_KEY",
    "LoraPolicy",
    "LoraSpec",
    "adaln_signature_of",
    "check_lora_schedule",
    "lora_chunk_tokens",
    "lora_extension_values",
    "lora_merge_mode",
    "resolve_lora_policy",
    "specs_of",
]
