"""Reference-row K/V cache across denoise steps (``provider_options.ref_kv_cache``): rules, step plan, sizes.

Pure Python (adapter layer). The runtime counterpart is ``phasyn_h3.recipe.runtime.ref_kv_cache``; the profile
carries the option as the extension ``phasyn.sglang_h3.ref_kv_cache`` (absent when the option is off, so an off
profile is the profile of today, byte for byte).

What ``mode: skip`` does (Ref2VA only, approximate):

* In the packed Ref2VA sequence the reference rows (reference video/image VAE latents, reference audio) are one
  contiguous range between the text and the target rows (``S/packed_sequence.py:399-420``). Their input rows and
  their AdaLN timestep never change between steps (``S/denoise_loop.py:437-438`` pins them to 0.999 / 1.0).
* A *fill* step runs every row and keeps each block's post-RoPE reference K/V (the tensors the attention core
  receives). A *skip* step does not run the reference rows through the blocks at all: the other rows (text, Qwen
  vision tokens, target audio and video) attend over their own K/V plus the cached reference K/V.
* For the non-reference rows this equals "compute every row, then overwrite the reference rows' K/V with the
  cache": outside attention every block operation is row-wise, so the reference rows reach the other rows only
  through their K/V (the CPU test checks it).

Step plan (:func:`step_plan`): step ``s`` is skipped when ``s >= start_step`` and ``s`` is not a refresh step; every
other step runs the full sequence, and the full step right before each run of skipped steps (re)fills the cache.
The cache therefore always holds the reference K/V of the most recent full step. With the default
``start_step = 1`` and no refresh, step 0 fills the cache and steps 1… reuse it.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from ._diag import INVALID, UNSUPPORTED, err

OPTION = "ref_kv_cache"  # provider_options key (h3.dit)
EXTENSION = "phasyn.sglang_h3.ref_kv_cache"
MODES = ("off", "skip")
CACHE_DTYPES = ("fp8", "bf16")
CACHE_DTYPE_BYTES = {"fp8": 1, "bf16": 2}
DEFAULT_START_STEP = 1
DEFAULT_CACHE_DTYPE = "fp8"  # per-head E4M3; half the memory of bf16
MAX_STEP_INDEX = 199  # invoke.steps <= 200 (phasyn_h3.config.INVOKE_PROPS)
MAX_REFRESH_STEPS = 64
FIELDS = ("mode", "start_step", "cache_dtype", "refresh_steps", "max_cache_bytes")
# The FP8 cache stores E4M3 with one absmax scale per head.
FP8_MAX = 448.0
# Attention providers whose kernel takes a query sequence shorter than its key sequence. ``auto_exact`` resolves
# to ``pytorch_sdpa`` (runtime policy._resolve_attention).
SKIP_ATTENTION_PROVIDERS = ("auto_exact", "pytorch_sdpa", "flash_attention_3", "flash_attention_4")
ATTENTION_REFUSALS: Mapping[str, str] = {
    "fp8_fa_sm120": (
        "fp8_fa_sm120 的 kernel 只接受形狀相同的 Q/K/V（kernels/ops/attention/fp8_fa_sm120/plan.py validate_inputs）；"
        "略過參考列時 Q 比 K 短，backend 會整段改走 cuDNN BF16（fp8_fa_sm120_attn.py _fallback_reason），不默默換 kernel"
    ),
    "subblock_sparse_attn": (
        "subblock_sparse_attn 的 query block mask 以完整 packed 序列的 64 列區塊計算（denoise_loop.py:61-99），"
        "稀疏 kernel 也要 Q 與 K 等長；略過參考列後區塊對不上"
    ),
}

_STEP_ITEM = {"type": "integer", "minimum": 1, "maximum": MAX_STEP_INDEX}
# provider_options.ref_kv_cache of h3.dit (phasyn_h3.config.provider_options_schema)
OPTION_SCHEMA: dict[str, Any] = {
    "anyOf": [
        {"type": "null"},
        {
            "type": "object",
            "properties": {
                "mode": {
                    "enum": list(MODES),
                    "description": "off＝不使用（預設，與未設定相同）；skip＝快取步的參考列不進 DiT block，"
                    "其他列改用快取的參考列 K/V（近似，只限 Ref2VA）",
                },
                "start_step": {
                    **_STEP_ITEM,
                    "description": "從第幾步（0 起算）開始略過參考列；之前的步完整計算，最後一個完整步填快取（預設 1）",
                },
                "cache_dtype": {
                    "enum": list(CACHE_DTYPES),
                    "description": "fp8＝E4M3、每 head 一個 absmax scale（預設）；bf16＝原值（記憶體 2 倍）",
                },
                "refresh_steps": {
                    "type": "array",
                    "items": dict(_STEP_ITEM),
                    "uniqueItems": True,
                    "maxItems": MAX_REFRESH_STEPS,
                    "description": "這些步（>= start_step）重新完整計算所有列，並在下一個略過步之前重填快取",
                },
                "max_cache_bytes": {
                    "type": ["integer", "null"],
                    "minimum": 0,
                    "description": "快取位元組上限；第 0 步前估計值超過就拒絕（null＝不設上限）",
                },
            },
            "required": ["mode"],
            "additionalProperties": False,
        },
    ],
    "description": "參考列 K/V 跨步快取：快取 50 層 × K,V × 參考列 × 56 heads × 128 × "
    "（fp8 1 B／bf16 2 B）；短邊 448 的換角段落約 10.5 GB（fp8）",
}
# Profile extension (registered in profile_rules.PROFILE_EXTENSION_SCHEMAS); editing it changes its digest
# (phasyn_h3.config.EXTENSION_DIGESTS, test_h3_extension_digests).
EXTENSION_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": EXTENSION,
    "description": "Ref2VA 參考列 K/V 跨步快取：略過步的參考列不進 DiT block，其他列讀各層快取的參考列 K/V（RoPE 之後）；"
    "全部欄位明示（off 時不帶此 extension）",
    "type": "object",
    "properties": {
        "mode": {"type": "string", "enum": ["skip"]},
        "start_step": dict(_STEP_ITEM),
        "cache_dtype": {"type": "string", "enum": list(CACHE_DTYPES)},
        "refresh_steps": {
            "type": "array",
            "items": dict(_STEP_ITEM),
            "uniqueItems": True,
            "maxItems": MAX_REFRESH_STEPS,
        },
        "max_cache_bytes": {"anyOf": [{"type": "integer", "minimum": 0}, {"type": "null"}]},
    },
    "required": list(FIELDS),
    "additionalProperties": False,
}


class OptionError(ValueError):
    """A ``ref_kv_cache`` value the rules reject; ``field`` is relative to the option (``start_step`` …)."""

    def __init__(self, message: str, field: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.field = field


@dataclass(frozen=True)
class RefKvCachePolicy:
    """The effective ``mode: skip`` settings (``mode: off`` is represented by no policy at all)."""

    start_step: int
    cache_dtype: str
    refresh_steps: tuple[int, ...]
    max_cache_bytes: int | None

    @property
    def mode(self) -> str:
        return "skip"

    def plan(self, steps: int) -> tuple[str, ...]:
        return step_plan(steps, start_step=self.start_step, refresh_steps=self.refresh_steps)

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "start_step": self.start_step,
            "cache_dtype": self.cache_dtype,
            "refresh_steps": list(self.refresh_steps),
            "max_cache_bytes": self.max_cache_bytes,
        }


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _build(raw: Mapping[str, Any]) -> RefKvCachePolicy:
    start = raw.get("start_step", DEFAULT_START_STEP)
    if not _is_int(start) or not 1 <= start <= MAX_STEP_INDEX:
        raise OptionError(
            f"start_step 必須是 1..{MAX_STEP_INDEX} 的整數（第 0 步一定完整計算並填快取），收到 {start!r}", "start_step"
        )
    dtype = raw.get("cache_dtype", DEFAULT_CACHE_DTYPE)
    if dtype not in CACHE_DTYPES:
        raise OptionError(f"cache_dtype 必須是 {' 或 '.join(CACHE_DTYPES)}，收到 {dtype!r}", "cache_dtype")
    refresh = raw.get("refresh_steps", [])
    if not isinstance(refresh, (list, tuple)) or not all(_is_int(s) for s in refresh):
        raise OptionError(f"refresh_steps 必須是整數陣列，收到 {refresh!r}", "refresh_steps")
    if len(set(refresh)) != len(refresh) or len(refresh) > MAX_REFRESH_STEPS:
        raise OptionError(f"refresh_steps 不可重複，最多 {MAX_REFRESH_STEPS} 個", "refresh_steps")
    early = sorted(s for s in refresh if not start <= s <= MAX_STEP_INDEX)
    if early:
        raise OptionError(
            f"refresh_steps {early} 必須在 start_step={start}..{MAX_STEP_INDEX} 之間"
            "（start_step 之前的步本來就完整計算，不默默忽略）",
            "refresh_steps",
        )
    cap = raw.get("max_cache_bytes")
    if cap is not None and (not _is_int(cap) or cap < 0):
        raise OptionError(f"max_cache_bytes 必須是非負整數或 null，收到 {cap!r}", "max_cache_bytes")
    return RefKvCachePolicy(
        start_step=int(start), cache_dtype=str(dtype), refresh_steps=tuple(sorted(refresh)), max_cache_bytes=cap
    )


def parse_option(raw: Any) -> RefKvCachePolicy | None:
    """``provider_options.ref_kv_cache`` -> the policy; None for ``null``, absent or ``mode: off``."""
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise OptionError(f"ref_kv_cache 必須是 object 或 null，收到 {type(raw).__name__}")
    unknown = sorted(set(raw) - set(FIELDS))
    if unknown:
        raise OptionError(f"ref_kv_cache 有未知欄位 {unknown}", unknown[0])
    mode = raw.get("mode")
    if mode not in MODES:
        raise OptionError(f"ref_kv_cache.mode 必須是 off 或 skip，收到 {mode!r}", "mode")
    if mode == "off":
        extra = sorted(k for k in raw if k != "mode")
        if extra:
            raise OptionError(f"ref_kv_cache.mode=off 時 {extra} 沒有作用（不默默忽略）", extra[0])
        return None
    return _build(raw)


def parse_extension(values: Any) -> RefKvCachePolicy:
    """The extension's values (every field explicit, ``mode`` is ``skip``) -> the policy."""
    if not isinstance(values, Mapping):
        raise OptionError(f"{EXTENSION} 的 values 必須是 object")
    unknown = sorted(set(values) - set(FIELDS))
    missing = [k for k in FIELDS if k not in values]
    if unknown or missing:
        raise OptionError(
            f"{EXTENSION} 欄位不完整或有未知欄位（缺 {missing}，未知 {unknown}）", (missing or unknown)[0]
        )
    if values.get("mode") != "skip":
        raise OptionError(f"{EXTENSION}.mode 只能是 skip（off 不帶此 extension），收到 {values.get('mode')!r}", "mode")
    return _build(values)


def extension_values(policy: RefKvCachePolicy) -> dict[str, Any]:
    """The explicit extension values of a policy (no hidden defaults)."""
    return policy.as_dict()


def find_extension(profile: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Values of the profile's ``phasyn.sglang_h3.ref_kv_cache`` extension, None when absent."""
    found = [e for e in profile.get("extensions") or () if isinstance(e, Mapping) and e.get("namespace") == EXTENSION]
    if len(found) > 1:
        raise OptionError(f"{EXTENSION} 出現 {len(found)} 次")
    if not found:
        return None
    values = found[0].get("values")
    return values if isinstance(values, Mapping) else {}


def attention_refusal(provider: str) -> str | None:
    """Why ``mode: skip`` cannot run on this attention provider (requested or effective name), None when it can."""
    provider = str(provider)
    if provider in SKIP_ATTENTION_PROVIDERS:
        return None
    return ATTENTION_REFUSALS.get(
        provider,
        f"attention.provider={provider} 沒有驗證過 Q 比 K 短的呼叫；ref_kv_cache skip 只接受 {', '.join(SKIP_ATTENTION_PROVIDERS)}",
    )


def step_plan(steps: int, *, start_step: int, refresh_steps: Iterable[int] = ()) -> tuple[str, ...]:
    """Per denoise step: ``skip`` (reference rows skipped), ``fill`` (full sequence, then the cache is (re)filled from
    this step's K/V) or ``full`` (full sequence, cache untouched). A skip step is never the first step, and the step
    before every run of skip steps is a fill step."""
    refresh = {int(s) for s in refresh_steps}
    skip = [s >= int(start_step) and s not in refresh for s in range(int(steps))]
    plan: list[str] = []
    for s in range(int(steps)):
        if skip[s]:
            plan.append("skip")
        elif s + 1 < len(skip) and skip[s + 1]:
            plan.append("fill")
        else:
            plan.append("full")
    return tuple(plan)


def cache_bytes(*, layers: int, ref_rows: int, heads: int, head_dim: int, cache_dtype: str) -> int:
    """Device bytes of the cache: layers × (K, V) × reference rows × heads × head_dim × dtype bytes (+ the FP8
    per-head scales, FP32)."""
    per = CACHE_DTYPE_BYTES[cache_dtype]
    data = int(layers) * 2 * int(ref_rows) * int(heads) * int(head_dim) * per
    scales = int(layers) * 2 * int(heads) * 4 if cache_dtype == "fp8" else 0
    return data + scales


def kv_buffer_bytes(*, used_rows: int, heads: int, head_dim: int, dtype_bytes: int = 2) -> int:
    """Transient bytes of one skip forward: the BF16 K and V of every live row, rebuilt per layer in one buffer pair
    (freed after the forward; the reduced activations of that forward are smaller by more than this)."""
    return 2 * int(used_rows) * int(heads) * int(head_dim) * int(dtype_bytes)


def diagnostics(profile: Mapping[str, Any], model: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """Plan-time diagnostics of the extension (the runtime policy re-checks the same rules)."""
    base = f"extensions[{EXTENSION}]"
    try:
        values = find_extension(profile)
        if values is None:
            return []
        parse_extension(values)
    except OptionError as exc:
        return [err(INVALID, exc.message, f"{base}.{exc.field}" if exc.field else base)]
    out: list[dict[str, Any]] = []
    if profile.get("mode") == "exact":
        out.append(
            err(
                UNSUPPORTED,
                "ref_kv_cache skip 讓略過步沿用快取的參考列 K/V，屬 approximate run，不能用於 mode=exact（REQ-021）",
                "mode",
                base,
            )
        )
    provider = str((profile.get("attention") or {}).get("provider", "auto_exact"))
    reason = attention_refusal(provider)
    if reason is not None:
        out.append(err(UNSUPPORTED, reason, "attention.provider", base))
    variant = (model or {}).get("variant")
    if variant is not None and variant != "ref2va":
        out.append(
            err(
                UNSUPPORTED,
                f"ref_kv_cache 只用於 Ref2VA DiT（參考列只存在於 ref2va 的 packed 序列）；此模型 variant={variant}",
                base,
                expected="ref2va",
                actual=variant,
            )
        )
    return out


__all__ = [
    "ATTENTION_REFUSALS",
    "CACHE_DTYPES",
    "CACHE_DTYPE_BYTES",
    "DEFAULT_CACHE_DTYPE",
    "DEFAULT_START_STEP",
    "EXTENSION",
    "EXTENSION_SCHEMA",
    "FIELDS",
    "FP8_MAX",
    "MAX_REFRESH_STEPS",
    "MAX_STEP_INDEX",
    "MODES",
    "OPTION",
    "OPTION_SCHEMA",
    "SKIP_ATTENTION_PROVIDERS",
    "OptionError",
    "RefKvCachePolicy",
    "attention_refusal",
    "cache_bytes",
    "diagnostics",
    "extension_values",
    "find_extension",
    "kv_buffer_bytes",
    "parse_extension",
    "parse_option",
    "step_plan",
]
