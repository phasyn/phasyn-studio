"""DiT attention binding, verification and per-run accounting (torch, actor only).

The H3 DiT resolves its attention backend lazily on the first forward and keeps
it on the module (``minimax_h3.py:2395-2421``); a resident DiT is reused across
jobs whose profiles may ask for different providers, and the fp8_fa_sm120
resolver silently degrades to cuDNN SDPA off SM 12.0 (``cuda.py:520-547``).  So
before every denoise loop the shim:

1. re-binds every ``MiniMaxH3Attention`` to the backend this run's frozen policy
   names (explicit selection, never the global default), with the SubBlock
   schedule taken from the plan (``attention.subblock_sparse``), not from
   whatever ServerArgs another stage left behind;
2. fails (``ATTENTION_BACKEND_FALLBACK``) unless SGLang resolved exactly that
   backend, and checks the SubBlock schedule every layer actually got;
3. counts kernel vs fallback/dense calls so each run records the attention that
   really ran (fp8 kernel calls, cuDNN fallbacks with reasons, SubBlock sparse
   calls and dense segments).
"""

from __future__ import annotations

import contextlib
import functools
import importlib
import threading
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any

from .acceleration import attention_plan
from .errors import UnsupportedCombination
from .policy import StagePolicy
from .upstream_patches import ensure_uuid_device_ids


_COUNTS: Counter[str] = Counter()
_REASONS: Counter[str] = Counter()
_COUNT_LOCK = threading.Lock()
_INSTRUMENTED: set[str] = set()

SAGE_FP8_HINT = (
    "SM120 的 SubBlock sage_fp8 需要 FlashInfer 的 CuTe-DSL SM120 Sage backend 與 quantize_sage_qkv_sm120"
    "（FlashInfer PR #4691，SGLang README 指定 flashinfer@6a84331eb6013e5e61018dc2be532ae90520d30f）；"
    "本 runtime lock 的 flashinfer-python 0.7.0.post1 沒有這些 API"
)


def _bump(key: str, reason: str | None = None) -> None:
    with _COUNT_LOCK:
        _COUNTS[key] += 1
        if reason:
            _REASONS[reason[:200]] += 1


def _counting(method: Any, key: str, *, reason_arg: bool = False) -> Any:
    @functools.wraps(method)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        _bump(key, str(args[0]) if reason_arg and args else None)
        return method(self, *args, **kwargs)

    wrapper._phasyn_counting = key  # type: ignore[attr-defined]
    return wrapper


def _instrument(provider: str) -> None:
    """Wrap the backend impl methods with counters (process-wide, idempotent, no behaviour change)."""
    if provider in _INSTRUMENTED:
        return
    if provider == "fp8_fa_sm120":
        mod = importlib.import_module(
            "sglang.multimodal_gen.runtime.layers.attention.backends.fp8_fa_sm120_attn"
        )
        impl = mod.FP8FlashAttentionSM120Impl
        impl._run = _counting(impl._run, "fp8_kernel_calls")
        impl._report_fallback = _counting(
            impl._report_fallback, "fp8_fallback_calls", reason_arg=True
        )
    elif provider == "subblock_sparse_attn":
        mod = importlib.import_module(
            "sglang.multimodal_gen.runtime.layers.attention.backends.subblock_sparse_attn"
        )
        impl = mod.SubBlockSparseAttentionImpl
        impl.forward_varlen = _counting(impl.forward_varlen, "subblock_varlen_calls")
        impl._sparse_attention_heads = _counting(
            impl._sparse_attention_heads, "subblock_sparse_calls"
        )
        impl._dense_segment = _counting(impl._dense_segment, "subblock_dense_segments")
    _INSTRUMENTED.add(provider)


def _snapshot() -> tuple[Counter[str], Counter[str]]:
    with _COUNT_LOCK:
        return Counter(_COUNTS), Counter(_REASONS)


@contextlib.contextmanager
def _attention_backend_config(config: Mapping[str, Any]) -> Iterator[None]:
    """SubBlock reads its schedule from the global ServerArgs at impl construction (``SubBlockSparseSchedule.from_server_args``); pin it to this run's plan."""
    server_args_mod = importlib.import_module(
        "sglang.multimodal_gen.runtime.server_args"
    )
    args = server_args_mod.get_global_server_args()
    if args is None:
        raise UnsupportedCombination(
            "SERVER_ARGS_UNAVAILABLE",
            "SubBlock schedule 需要已建立的 SGLang ServerArgs（DiT 尚未經 shim 載入）",
        )
    previous = args.attention_backend_config
    factory = type(previous) if isinstance(previous, dict) else dict
    args.attention_backend_config = factory(dict(config))
    try:
        yield
    finally:
        args.attention_backend_config = previous


def _check_runtime_availability(plan: Any, device: Any) -> None:
    if plan.provider != "subblock_sparse_attn":
        return
    mode = str(plan.backend_config.get("compute_mode", "bf16"))
    sb = importlib.import_module(
        "sglang.multimodal_gen.runtime.layers.attention.backends.subblock_sparse_attn"
    )
    try:
        sb._get_subblock_sparse_attention_runner(device, mode)
    except (RuntimeError, ValueError) as exc:
        raise UnsupportedCombination(
            "SUBBLOCK_MODE_UNSUPPORTED",
            f"SubBlock compute_mode={mode} 在此裝置不可用：{exc}"[:1500],
        ) from exc
    import torch

    if mode == "sage_fp8" and torch.cuda.get_device_capability(device) == (12, 0):
        try:
            sb._load_sm120_sage_ops()
        except ImportError as exc:
            raise UnsupportedCombination(
                "SUBBLOCK_SAGE_FP8_UNAVAILABLE",
                SAGE_FP8_HINT,
                field_path="attention.subblock_sparse.compute_mode",
            ) from exc


BACKEND_CLASSES = {
    "fp8_fa_sm120": "FP8FlashAttentionSM120Backend",
    "subblock_sparse_attn": "SubBlockSparseAttentionBackend",
}


def preflight_attention(plan: Any) -> dict[str, Any]:
    """Before ServerArgs / the DiT load: the approximate backend must resolve to itself here.

    H3's ``validate_server_args`` already resolves it while ServerArgs are built
    (``configs/pipeline_configs/minimax_h3.py:248-318``), with an ImportError or a
    silent cuDNN fallback as the only signals; this turns both into diagnostics.
    """
    if not plan.approximate:
        return {}
    import torch
    from sglang.multimodal_gen.runtime.platforms import (  # type: ignore[import-untyped]
        AttentionBackendEnum,
        current_platform,
    )

    ensure_uuid_device_ids()
    device = torch.device("cuda", torch.cuda.current_device())
    _check_runtime_availability(plan, device)
    cls = str(
        current_platform.get_attn_backend_cls_str(
            AttentionBackendEnum[plan.sglang_backend.upper()], 128, torch.bfloat16
        )
    )
    if not cls.endswith(BACKEND_CLASSES[plan.provider]):
        raise UnsupportedCombination(
            "ATTENTION_BACKEND_FALLBACK",
            f"{plan.provider} 在此裝置解析為 {cls}（不接受默默 fallback）",
            field_path="attention.provider",
        )
    return {"resolved_class": cls}


@dataclass
class AttentionSession:
    """Track the backend used during each attention call."""

    requested: str
    effective: str
    sglang_backend: str
    approximate: bool
    backend_config: Mapping[str, Any]
    previous_backend: str | None
    resolved_backend: str | None
    impl_classes: list[str]
    rebound: bool
    start_counts: Counter[str] = field(default_factory=Counter)
    start_reasons: Counter[str] = field(default_factory=Counter)
    patches: Mapping[str, Any] = field(default_factory=dict)
    loop_counts: Counter[str] | None = None

    def deltas(self) -> tuple[dict[str, int], dict[str, int]]:
        """Return the observations recorded since the last snapshot."""
        counts, reasons = _snapshot()
        delta = {
            k: counts[k] - self.start_counts.get(k, 0)
            for k in counts
            if counts[k] - self.start_counts.get(k, 0)
        }
        reason_delta = {
            k: reasons[k] - self.start_reasons.get(k, 0)
            for k in reasons
            if reasons[k] - self.start_reasons.get(k, 0)
        }
        return delta, reason_delta

    def mark_loop_start(self) -> None:
        """Snapshot right before the denoise loop (the prompt refiner already ran)."""
        self.loop_counts, _ = _snapshot()

    def after_forward(self, step: int) -> None:
        """Fail fast when the requested FP8 kernel never engaged on the first DiT forward."""
        if self.effective != "fp8_fa_sm120" or step != 0:
            return
        counts, reasons = _snapshot()
        base = self.loop_counts if self.loop_counts is not None else self.start_counts
        if counts["fp8_kernel_calls"] - base.get("fp8_kernel_calls", 0) == 0:
            raise UnsupportedCombination(
                "ATTENTION_KERNEL_NOT_ENGAGED",
                "fp8_fa_sm120 在第一次 DiT forward 沒有執行任何 FP8 kernel（全部退回 cuDNN SDPA："
                f"{sorted(reasons)[:3]}）；不把 SDPA 結果當成 FP8 attention 交付",
            )

    def report(self) -> dict[str, Any]:
        """Report attention dispatch measurements."""
        delta, reasons = self.deltas()
        doc: dict[str, Any] = {
            "requested": self.requested,
            "effective": self.effective,
            "sglang_backend": self.sglang_backend,
            "approximate": self.approximate,
            "resolved_backend": self.resolved_backend,
            "impl": sorted(set(self.impl_classes)),
            "rebound": self.rebound,
            "previous_backend": self.previous_backend,
            "calls": delta,
        }
        if self.backend_config:
            doc["backend_config"] = dict(self.backend_config)
        if reasons:
            doc["fallback_reasons"] = reasons
        if self.patches:
            doc["patches"] = dict(self.patches)
        return doc

    def warnings(self, planned_updates: int) -> list[str]:
        """Return the warnings accumulated during execution."""
        delta, _ = self.deltas()
        out = []
        if self.effective == "fp8_fa_sm120" and delta.get("fp8_fallback_calls", 0):
            out.append(
                f"fp8_fa_sm120 有 {delta['fp8_fallback_calls']} 次呼叫退回 cuDNN SDPA（見 fallback_reasons）"
            )
        if self.effective == "subblock_sparse_attn" and not delta.get(
            "subblock_sparse_calls", 0
        ):
            skip = int(self.backend_config.get("skip_first_steps", 0))
            out.append(
                f"SubBlock 整個 run 都是 dense（planned_updates={planned_updates}，skip_first_steps={skip}，"
                f"min_seq_len={self.backend_config.get('min_seq_len')}）；結果等同 dense attention"
            )
        return out


def prepare_dit_attention(
    model: Any, policy: StagePolicy, device: Any
) -> AttentionSession:
    """Bind the DiT to this run's attention backend and verify SGLang resolved exactly it."""
    from sglang.multimodal_gen.runtime.platforms import AttentionBackendEnum

    plan = attention_plan(
        policy.attention_provider_effective,
        policy.sglang_attention_backend,
        policy.effective_profile,
    )
    patches = {"uuid_device_ids": ensure_uuid_device_ids()}
    expected = AttentionBackendEnum[plan.sglang_backend.upper()]
    if plan.approximate:
        _check_runtime_availability(plan, device)
        _instrument(plan.provider)
    dit = importlib.import_module(
        "sglang.multimodal_gen.runtime.models.dits.minimax_h3"
    )
    attention_modules = [
        m for m in model.modules() if isinstance(m, dit.MiniMaxH3Attention)
    ]
    if not attention_modules or not hasattr(model, "_resolve_attention_backend_once"):
        raise UnsupportedCombination(
            "ATTENTION_BIND_UNSUPPORTED",
            "DiT 沒有可綁定的 MiniMaxH3Attention（非釘版模型？）",
        )
    previous = getattr(model, "_resolved_attention_backend", None)
    previous_name = (
        None if previous is None else str(getattr(previous, "name", previous))
    )
    stale = any(
        getattr(m, "_attention_backend_enum", None) not in (None, expected)
        for m in attention_modules
    )
    rebound = previous is not expected or stale or plan.approximate
    if rebound:
        model._resolved_attention_backend = None
        model._component_attention_backend_override = expected
        for module in attention_modules:
            module._selected_attention_backend = expected
            module._attention_impl = None
            module._attention_backend_enum = None
        config_ctx = (
            _attention_backend_config(plan.backend_config)
            if plan.backend_config
            else contextlib.nullcontext()
        )
        with config_ctx:
            model._resolve_attention_backend_once()
    resolved = getattr(model, "_resolved_attention_backend", None)
    resolved_name = (
        None if resolved is None else str(getattr(resolved, "name", resolved))
    )
    bound = {getattr(m, "_attention_backend_enum", None) for m in attention_modules}
    if resolved is not expected or bound != {expected}:
        raise UnsupportedCombination(
            "ATTENTION_BACKEND_FALLBACK",
            f"要求 {plan.sglang_backend}，SGLang 實際解析為 {resolved_name}（各層 {sorted(str(b) for b in bound)}）；"
            "不接受默默 fallback",
            field_path="attention.provider",
            expected=expected.name,
            actual=resolved_name,
        )
    impls = [type(m._attention_impl).__name__ for m in attention_modules]
    if plan.provider == "subblock_sparse_attn":
        for module in attention_modules:
            schedule = module._attention_impl.schedule
            got = {key: getattr(schedule, key) for key in plan.backend_config}
            if got != dict(plan.backend_config):
                raise UnsupportedCombination(
                    "SUBBLOCK_SCHEDULE_MISMATCH",
                    f"{module.prefix} 的 SubBlock schedule {got} ≠ plan {dict(plan.backend_config)}",
                    field_path="attention.subblock_sparse",
                )
    counts, reasons = _snapshot()
    return AttentionSession(
        requested=policy.attention_provider_requested,
        effective=policy.attention_provider_effective,
        sglang_backend=plan.sglang_backend,
        approximate=plan.approximate,
        backend_config=dict(plan.backend_config),
        previous_backend=previous_name,
        resolved_backend=resolved_name,
        impl_classes=impls,
        rebound=rebound,
        start_counts=counts,
        start_reasons=reasons,
        patches=patches,
    )


def subblock_video_query_indices(
    packed: Mapping[str, Any], text_video_token_mask: Any
) -> Any:
    """Rows eligible for SubBlock sparsity (upstream helper, ``S/denoise_loop.py:40-58``)."""
    loop = importlib.import_module(
        "sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.denoise_loop"
    )
    return loop._minimax_h3_subblock_video_query_indices(
        dict(packed), text_video_token_mask
    )


__all__ = [
    "SAGE_FP8_HINT",
    "AttentionSession",
    "prepare_dit_attention",
    "subblock_video_query_indices",
]
