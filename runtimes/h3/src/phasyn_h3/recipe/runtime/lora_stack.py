"""Several LoRAs on one DiT layer as one dynamic adapter (torch; imported lazily in the actor).

Pinned SGLang keeps one adapter per wrapped layer (``SGR:runtime/pipelines_core/lora/pipeline.py:1175-1179``),
and the shim's in-place wrappers (``lora_inplace``) add ``e·(x·Aᵀ)·Bᵀ`` with one effective scale
``e = strength·alpha/rank``.  A stack of LoRAs is the sum of their terms, which is one LoRA of the summed rank::

    Σᵢ eᵢ·(x·Aᵢᵀ)·Bᵢᵀ = (x·[A₁; A₂; …]ᵀ)·[e₁B₁, e₂B₂, …]ᵀ

so per layer the members' ``A`` rows and ``B`` columns are concatenated in configured order
(``loras.STACK_ALGORITHM`` = ``rank_concat_v1``) and the wrapper runs exactly as for one LoRA: the same
in-place ``addmm_`` per token chunk, one projection ``[chunk, Σr]`` instead of ``[chunk, r]``, no second
full-size output.  Stacked q/k/v factors (3-D ``[G, r, in]`` / ``[G, out/G, r]``) concatenate along their
rank axis.

Numerics:

* a layer only one member touches keeps that member's factors, rank, alpha and strength as is — bit for bit
  the single-LoRA path (e.g. ``adaln_proj`` of PDD next to a LoRA without AdaLN factors);
* members with equal effective scales keep their factors unchanged and share the scale (``folded=False``);
* otherwise each ``Bᵢ`` is multiplied by its ``eᵢ`` in FP32 and rounded once to the factor dtype
  (``folded=True``): one extra rounding of the (small) LoRA factors, the same as an offline rank-concatenated
  merge file.

Output offsets (pruned-curve AdaLN LoRA) do not stack: a layer two members touch must not carry one.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .errors import UnsupportedCombination


_MATRIX_RANK = 2
_GROUPED_WEIGHT_RANK = 3


@dataclass(frozen=True)
class Contribution:
    """One member's factors for one layer (native names, after SGLang's mapping)."""

    lora_id: str
    a: Any  # [r, in] or [G, r, in]
    b: Any  # [out, r] or [G, out/G, r]
    rank: int
    alpha: float
    scale: float
    offset: Any = None

    @property
    def effective_scale(self) -> float:
        """What multiplies B·A·x: scale × alpha ／ rank."""
        return float(self.scale) * float(self.alpha) / int(self.rank)


@dataclass(frozen=True)
class StackedFactors:
    """The adapter one wrapper gets: ``e = strength·alpha/rank`` applies to ``(x·Aᵀ)·Bᵀ``."""

    a: Any
    b: Any
    rank: int
    alpha: float
    strength: float
    offset: Any
    sources: tuple[str, ...]
    folded: bool


def _reject(reason: str, message: str) -> UnsupportedCombination:
    return UnsupportedCombination(reason, message, field_path="lora")


def _rank_axis(tensor: Any, *, half: str) -> int:
    """Rank axis of A (rows of ``[r, in]``; axis 1 of ``[G, r, in]``) or B (last axis)."""
    if half == "A":
        return 0 if tensor.dim() == _MATRIX_RANK else 1
    return int(tensor.dim()) - 1


def _check_compatible(layer: str, parts: Sequence[Contribution]) -> None:
    first = parts[0]
    for part in parts[1:]:
        if part.a.dim() != first.a.dim() or part.b.dim() != first.b.dim():
            raise _reject(
                "LORA_STACK_SHAPE",
                f"{layer}: {first.lora_id} 與 {part.lora_id} 的因子維度不同（{first.a.dim()}-D／{part.a.dim()}-D），不能拼接",
            )
        a_axis = _rank_axis(first.a, half="A")
        b_axis = _rank_axis(first.b, half="B")
        same_a = [d for i, d in enumerate(first.a.shape) if i != a_axis] == [
            d for i, d in enumerate(part.a.shape) if i != a_axis
        ]
        same_b = [d for i, d in enumerate(first.b.shape) if i != b_axis] == [
            d for i, d in enumerate(part.b.shape) if i != b_axis
        ]
        if not (same_a and same_b):
            raise _reject(
                "LORA_STACK_SHAPE",
                f"{layer}: {first.lora_id} A{list(first.a.shape)}／B{list(first.b.shape)} 與 "
                f"{part.lora_id} A{list(part.a.shape)}／B{list(part.b.shape)} 除 rank 外的形狀不同",
            )
    with_offset = [p.lora_id for p in parts if p.offset is not None]
    if with_offset:
        raise _reject(
            "LORA_STACK_OFFSET_UNSUPPORTED",
            f"{layer}: {'、'.join(with_offset)} 帶 lora_output_offset（pruned-curve AdaLN），不能與其他 LoRA 疊在同一層",
        )


def stack_factors(parts: Sequence[Contribution], *, layer: str) -> StackedFactors:
    """One adapter for ``layer`` from its members' factors, in configured order (see the module docstring)."""
    if not parts:
        raise ValueError(f"{layer}: no LoRA factors to stack")
    if len(parts) == 1:
        only = parts[0]
        return StackedFactors(
            a=only.a,
            b=only.b,
            rank=int(only.rank),
            alpha=float(only.alpha),
            strength=float(only.scale),
            offset=only.offset,
            sources=(only.lora_id,),
            folded=False,
        )
    import torch

    _check_compatible(layer, parts)
    dtype = parts[0].a.dtype
    b_dtype = parts[0].b.dtype
    a_axis = _rank_axis(parts[0].a, half="A")
    b_axis = _rank_axis(parts[0].b, half="B")
    rank = sum(int(p.a.shape[a_axis]) for p in parts)
    scales = [p.effective_scale for p in parts]
    folded = len(set(scales)) > 1
    with torch.no_grad():
        a = torch.cat([p.a.to(dtype) for p in parts], dim=a_axis).contiguous()
        if folded:
            b = torch.cat(
                [
                    (p.b.to(torch.float32) * s).to(b_dtype)
                    for p, s in zip(parts, scales, strict=True)
                ],
                dim=b_axis,
            ).contiguous()
            strength = 1.0
        else:
            b = torch.cat([p.b.to(b_dtype) for p in parts], dim=b_axis).contiguous()
            strength = scales[0]
    # alpha == rank: the wrapper multiplies by strength only (lora_inplace._inplace_scale)
    return StackedFactors(
        a=a,
        b=b,
        rank=rank,
        alpha=float(rank),
        strength=float(strength),
        offset=None,
        sources=tuple(p.lora_id for p in parts),
        folded=folded,
    )


__all__ = ["Contribution", "StackedFactors", "stack_factors"]
