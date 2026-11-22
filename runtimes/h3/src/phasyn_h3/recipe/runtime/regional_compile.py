"""Request-local H3 MLP linkage and evidence for native regional Inductor compilation."""

from __future__ import annotations

import contextlib
import importlib
from collections import Counter
from collections.abc import Callable, Iterator, Mapping
from types import FunctionType, MethodType
from typing import Any

from . import pins
from .errors import UnsupportedCombination
from .regional_compile_cache import (
    MAX_SIGNATURES,
    REGION,
    RegionBank,
    _clock,
    compiler_failure,
    digest,
    signature,
)


_MATRIX_RANK = 2


class Session:
    """Measure native and compiled gate dispatch for one denoising request."""

    def __init__(
        self, bank: RegionBank, budget: int, attention: str, native: Callable[..., Any]
    ) -> None:
        """Start request-local measurements against the actor-owned compiler cache."""
        self.bank = bank
        self.budget = budget
        self.attention = attention
        self.native = native
        self.samples: dict[str, dict[str, Any]] = {}
        self.reasons: Counter[str] = Counter()
        self.hits = self.misses = self.calls = 0
        self.evictions = bank.trim(budget)

    def fallback(self, reason: str, hidden: Any, *, reuse_input: bool) -> Any:
        """Count this reason and run the original gate on the supplied tensor."""
        self.reasons[reason] += 1
        return self.native(hidden, reuse_input=reuse_input)

    def activate(self, hidden: Any, *, reuse_input: bool) -> Any:
        """Dispatch the gate for this input, retaining the native aliasing contract."""
        import torch

        reason = _unsupported_input(hidden)
        if reason is not None:
            return self.fallback(reason, hidden, reuse_input=reuse_input)
        spec = signature(hidden, self.attention, reuse=reuse_input)
        key = digest(spec)
        if key not in self.samples and len(self.samples) >= MAX_SIGNATURES * 2:
            return self.fallback(
                "request_signature_limit", hidden, reuse_input=reuse_input
            )
        sample = self.samples.setdefault(key, {"signature": spec, "digest": key})
        if reason := sample.get("fallback"):
            return self.fallback(reason, hidden, reuse_input=reuse_input)
        try:
            output, reason = self._dispatch(key, hidden, sample)
        except Exception as exc:
            if (failure := compiler_failure(exc)) is None:
                raise
            if broken := self.bank.entries.pop(key, None):
                broken.close()
            output, reason = None, "compiler_" + failure
        if reason:
            sample["fallback"] = reason
            return self.fallback(reason, hidden, reuse_input=reuse_input)
        self.calls += 1
        if hidden.is_cuda and hidden.dtype == torch.bfloat16 and reuse_input:
            # Preserve native aliasing and row stride. The compiled region never mutates its input.
            view = hidden[..., : hidden.shape[-1] // 2]
            view.copy_(output)
            return view
        return output

    def _dispatch(
        self, key: str, hidden: Any, sample: dict[str, Any]
    ) -> tuple[Any, str | None]:
        if (entry := self.bank.entries.get(key)) is None:
            if "cold_seconds" in sample or "warm_seconds" in sample:
                return None, "evicted_during_request"
            self.misses += 1
            return self._cold(key, hidden, sample)
        self.bank.entries.move_to_end(key)
        self.hits += 1
        if "warm_seconds" in sample:
            return entry.compiled(hidden), None
        started = _clock(hidden)
        output = entry.compiled(hidden)
        sample["warm_seconds"] = _clock(hidden) - started
        return output, None

    def _cold(
        self, key: str, hidden: Any, sample: dict[str, Any]
    ) -> tuple[Any, str | None]:
        if hidden.is_cuda:
            import torch

            free, _ = torch.cuda.mem_get_info(hidden.device)
            if hidden.numel() * hidden.element_size() // 2 > free // 4:
                return None, "insufficient_activation_headroom"
        self.evictions += self.bank.trim(self.budget, adding=True)
        entry, output, seconds = self.bank.build(key, hidden)
        sample["cold_seconds"] = seconds
        sample["artifact_bytes"] = entry.size
        if entry.size > self.budget:
            entry.close()
            return None, "artifact_exceeds_budget"
        self.bank.entries[key] = entry
        self.evictions += self.bank.trim(self.budget)
        return output, None

    def report(self) -> dict[str, Any]:
        """Summarize compiled calls, native fallbacks and cold and warm measurements."""
        return {
            "requested": "regional",
            "effective": ("mixed" if self.reasons else "regional")
            if self.calls
            else ("eager" if self.reasons else "unobserved"),
            "region": REGION,
            "backend": "inductor" if self.calls else None,
            "compiled_calls": self.calls,
            "signature_hits": self.hits,
            "signature_misses": self.misses,
            "evictions": self.evictions,
            "retained_bytes": self.bank.size,
            "max_cache_bytes": self.budget,
            "live_signatures": len(self.bank.entries),
            "max_live_signatures": MAX_SIGNATURES,
            "fallbacks": dict(self.reasons),
            "signatures": list(self.samples),
            "scope": "resident_actor",
            "cuda_graphs": False,
        }


def _restore(mlp: Any) -> None:
    if "forward" in vars(mlp):
        del mlp.forward


@contextlib.contextmanager
def bind(model: Any, cls: type[Any], session: Session) -> Iterator[None]:
    # Rebind the pinned native forward only on this model's MLP instances. The
    # defining module and other components retain their original helper/forward.
    """Replace only the pinned MLP gate and restore every original method at exit."""
    mlps = [m for m in model.modules() if type(m) is cls]
    if not mlps or any("forward" in vars(m) for m in mlps):
        session.reasons["native_mlp_unavailable_or_already_wrapped"] += 1
        yield
        return
    original = cls.forward
    scoped = FunctionType(
        original.__code__,
        {**original.__globals__, "_silu_mul": session.activate},
        original.__name__,
        original.__defaults__,
        original.__closure__,
    )
    with contextlib.ExitStack() as stack:
        for mlp in mlps:
            mlp.forward = MethodType(scoped, mlp)
            stack.callback(_restore, mlp)
        yield


def _supported() -> bool:
    try:
        from torch._dynamo.eval_frame import is_inductor_supported
    except ImportError:
        return False
    return bool(is_inductor_supported())


@contextlib.contextmanager
def active(run: Any, model: Any, option: Mapping[str, Any]) -> Iterator[Session]:
    """Activate regional compilation for the current transformer and request."""
    import torch

    mod = importlib.import_module(
        "sglang.multimodal_gen.runtime.models.dits.minimax_h3"
    )
    bank = run.provider._h3_compile_bank
    if bank is None:
        bank = RegionBank(run.provider.workdir)
        run.provider._h3_compile_bank = bank
    resolved = getattr(
        getattr(model, "_resolved_attention_backend", None), "name", None
    )
    session = Session(
        bank, int(option["max_cache_bytes"]), str(resolved or "unknown"), mod._silu_mul
    )
    if (
        not resolved
        or str(torch.__version__).split("+")[0] != "2.14.1"
        or not _supported()
    ):
        session.reasons["regional_toolchain_or_attention_unavailable"] += 1
        yield session
        return
    try:
        pins.check("regional_compile", what="regional H3 MLP compiler")
    except UnsupportedCombination:
        session.reasons["upstream_source_mismatch"] += 1
        yield session
        return
    with bind(model, mod.MiniMaxH3MLP, session):
        yield session


def _unsupported_input(hidden: Any) -> str | None:
    import torch

    if hidden.device.type not in ("cuda", "cpu") or hidden.dtype not in (
        torch.bfloat16,
        torch.float32,
    ):
        return "unsupported_device_or_dtype"
    if (
        not hidden.numel()
        or not hidden.is_contiguous()
        or hidden.ndim != _MATRIX_RANK
        or hidden.shape[-1] % 16
        or hidden.requires_grad
        or hidden.storage_offset()
    ):
        return "unsupported_layout_or_gradient"
    return None
