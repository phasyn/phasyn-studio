# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/layers/lora/linear.py (ColumnParallelLinearWithLoRA / RowParallelLinearWithLoRA.forward)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0; that SGLang file is itself adapted from hao-ai-lab/FastVideo (Apache-2.0).
# Modified by the Phasyn Studio authors: the LoRA term is accumulated in place in token chunks.
"""In-place, token-chunked dynamic LoRA term (torch + pinned SGLang; imported lazily in the actor).

Pinned SGLang adds the dynamic term out of place (``SGR:runtime/layers/lora/linear.py:701-720,
810-829``): ``delta = (x·Aᵀ)·Bᵀ``, ``delta *= α/r``, ``delta = delta·strength·runtime_scale``,
``out = out + delta`` — while the last product evaluates, three tensors the size of the layer
output are alive next to the base output.  For the H3 DiT at 768p (N ≈ 38k packed tokens) the
fc1 output alone is [38016, 28672] BF16 = 2.03 GiB, enough to run a 16 GB GPU out of memory.

The shim's wrappers (subclasses of SGLang's, so everything else — factor storage, slicing, merge
comparison arm, output offsets — stays upstream) accumulate the term into the base output
instead, ``chunk_tokens`` rows at a time::

    out[i:j].addmm_(x[i:j] @ Aᵀ, Bᵀ, alpha=scale)        # cuBLAS beta = 1: no second output

so the only temporaries are the ``[chunk, groups·r]`` projection (plus a ``[chunk, in]`` cast when
the input dtype is not the LoRA dtype, and a ``[chunk, out]`` product when the output dtype is
not).  Stacked q/k/v factors (3-D,
``_store_fused_lora_groups``) write every group into its column slice of the output.  The base
GEMM is untouched — BF16 ``F.linear`` or a quantized ``quant_method.apply`` (convrot_int8, bnb) —
so the term rides on a quantized linear's output exactly the same way.

Numerics: one rounding of ``out + scale·(x·Aᵀ)·Bᵀ`` (accumulated in FP32 by the GEMM) instead of
upstream's three BF16 roundings of the delta, so results differ from upstream by BF16 rounding of
the (small) LoRA term only.  Row chunks are independent rows of the same GEMMs.
"""

from __future__ import annotations

import functools
from typing import Any

from phasyn_h3.recipe.adapter.loras import DEFAULT_DYNAMIC_CHUNK_TOKENS


def add_lora_(out: Any, x: Any, lora_a: Any, lora_b: Any, *, scale: float, chunk_tokens: int) -> int:
    """Accumulate ``scale·(x·Aᵀ)·Bᵀ`` into ``out`` in place, chunk by chunk; returns the chunk count.

    ``out`` [..., out_features] must be a tensor whose 2-D row view aliases it (2-D, or contiguous);
    ``x`` [..., in_features] with the same leading shape.  ``lora_a``/``lora_b`` are 2-D
    ``[r, in]``/``[out, r]`` or stacked 3-D ``[G, r, in]``/``[G, out/G, r]`` (already sliced to this rank).
    """
    import torch

    rows_out = out if out.dim() == 2 else out.view(-1, out.shape[-1])
    rows_in = x if x.dim() == 2 else x.reshape(-1, x.shape[-1])
    total = int(rows_out.shape[0])
    if int(rows_in.shape[0]) != total:
        raise ValueError(f"LoRA input rows {int(rows_in.shape[0])} ≠ output rows {total}")
    step = total if chunk_tokens <= 0 else min(total, int(chunk_tokens))
    if total == 0 or step == 0:
        return 0
    dtype = lora_a.dtype
    stacked = lora_a.dim() == 3
    if stacked:
        groups, rank, fan_in = (int(d) for d in lora_a.shape)
        width = int(lora_b.shape[1])
        a_rows = lora_a.reshape(groups * rank, fan_in)
        b_t = [lora_b[g].t() for g in range(groups)]
    else:
        a_rows = lora_a
        b_full_t = lora_b.t()
    chunks = 0
    with torch.no_grad():
        for start in range(0, total, step):
            stop = min(total, start + step)
            xc = rows_in[start:stop]
            if xc.dtype != dtype:
                xc = xc.to(dtype)
            hidden = xc @ a_rows.t()  # [chunk, groups·r]
            dst = rows_out[start:stop]
            if stacked:
                for g in range(groups):
                    _accumulate_(
                        dst[:, g * width : (g + 1) * width], hidden[:, g * rank : (g + 1) * rank], b_t[g], scale
                    )
            else:
                _accumulate_(dst, hidden, b_full_t, scale)
            del hidden, xc
            chunks += 1
    return chunks


def _accumulate_(dst: Any, hidden: Any, b_t: Any, scale: float) -> None:
    if dst.dtype == hidden.dtype == b_t.dtype:
        dst.addmm_(hidden, b_t, alpha=scale)  # beta = 1: accumulates into the base output
    else:  # mixed dtypes cannot fuse: one [chunk, out] product in the LoRA dtype
        dst.add_((hidden @ b_t).to(dst.dtype), alpha=scale)


def _row_view_safe(out: Any) -> Any:
    """``out`` itself when its 2-D row view aliases it, else a contiguous copy (returned to the caller)."""
    return out if out.dim() == 2 or out.is_contiguous() else out.contiguous()


@functools.cache
def inplace_wrapper_classes() -> dict[str, Any]:
    """The shim's LoRA wrapper classes, keyed by the upstream class they extend."""
    # module handle for the TP helpers: looked up at call time (tests patch them on this module)
    import sglang.multimodal_gen.runtime.layers.lora.linear as upstream
    from sglang.multimodal_gen.runtime.layers.lora.linear import (
        ColumnParallelLinearWithLoRA,
        MergedColumnParallelLinearWithLoRA,
        RowParallelLinearWithLoRA,
    )
    from torch.distributed.tensor import DTensor

    class _InplaceLoRAMixin:
        """Dynamic term accumulated in place; disabled/merged layers keep the upstream forward."""

        chunk_tokens: int = DEFAULT_DYNAMIC_CHUNK_TOKENS
        inplace_calls: int = 0

        def _inplace_factors(self, device: Any) -> tuple[Any, Any]:
            lora_a, lora_b = self.lora_A, self.lora_B  # type: ignore[attr-defined]
            if isinstance(lora_b, DTensor):
                lora_a, lora_b = lora_a.to_local(), lora_b.to_local()
            lora_a = lora_a.to(device=device, non_blocking=True)
            lora_b = lora_b.to(device=device, non_blocking=True)
            if int(getattr(self.base_layer, "tp_size", 1)) == 1:  # type: ignore[attr-defined]
                return lora_a, lora_b  # unsharded: upstream's slices are the whole factors
            return self.slice_lora_a_weights(lora_a), self.slice_lora_b_weights(lora_b)  # type: ignore[attr-defined]

        def _inplace_scale(self, runtime_scale: float) -> float:
            scale = float(self.strength) * float(runtime_scale)  # type: ignore[attr-defined]
            if self.lora_alpha != self.lora_rank:  # type: ignore[attr-defined]
                scale *= self.lora_alpha / self.lora_rank  # type: ignore[attr-defined]
            return scale

        def _add_term_(self, out: Any, x: Any, runtime_scale: float) -> None:
            lora_a, lora_b = self._inplace_factors(x.device)
            add_lora_(
                out, x, lora_a, lora_b, scale=self._inplace_scale(runtime_scale), chunk_tokens=int(self.chunk_tokens)
            )
            self.inplace_calls = int(self.inplace_calls) + 1

        def _add_offset_(self, out: Any) -> Any:
            """``_add_lora_output_offset`` in place (pruned-curve AdaLN LoRA only)."""
            offset = self._active_lora_output_offset()  # type: ignore[attr-defined]
            if offset is None:
                return out
            offset = offset * self._runtime_lora_scale()  # type: ignore[attr-defined]
            return out.add_(offset.to(device=out.device, dtype=out.dtype))

    class _InplaceColumnForward(_InplaceLoRAMixin):
        def forward(self, input_: Any) -> Any:  # ColumnParallelLinearWithLoRA.forward (linear.py:683-727)
            if self.disable_lora or self.merged:  # type: ignore[attr-defined]
                return super().forward(input_)  # type: ignore[misc]
            runtime_scale = self._runtime_lora_scale()  # type: ignore[attr-defined]
            base = self.base_layer  # type: ignore[attr-defined]
            if runtime_scale == 0.0:
                return base(input_)
            bias = base.bias if not base.skip_bias_add else None
            out = _row_view_safe(base.quant_method.apply(base, input_, bias))
            self._add_term_(out, input_, runtime_scale)
            out = self._add_offset_(out)
            output = upstream.tensor_model_parallel_all_gather(out) if base.gather_output else out
            return output, (base.bias if base.skip_bias_add else None)

    class InplaceColumnParallelLinearWithLoRA(_InplaceColumnForward, ColumnParallelLinearWithLoRA):
        pass

    class InplaceMergedColumnParallelLinearWithLoRA(_InplaceColumnForward, MergedColumnParallelLinearWithLoRA):
        pass

    class InplaceRowParallelLinearWithLoRA(_InplaceLoRAMixin, RowParallelLinearWithLoRA):
        def forward(self, input_: Any) -> Any:  # RowParallelLinearWithLoRA.forward (linear.py:785-846)
            if self.disable_lora or self.merged:
                return super().forward(input_)
            runtime_scale = self._runtime_lora_scale()
            base = self.base_layer
            if runtime_scale == 0.0:
                return base(input_)
            if base.input_is_parallel:
                input_parallel = input_
            else:
                split = upstream.split_tensor_along_last_dim(input_, num_partitions=base.tp_size)
                input_parallel = split[upstream.get_tp_rank()].contiguous()
            out = _row_view_safe(base.quant_method.apply(base, input_parallel))
            self._add_term_(out, input_parallel, runtime_scale)
            if base.reduce_results and base.tp_size > 1:
                out = upstream.tensor_model_parallel_all_reduce(out)
            output_bias = None
            if base.skip_bias_add:
                output_bias = base.bias
            elif base.bias is not None:
                out = out.add_(base.bias)
            return self._add_offset_(out), output_bias

    return {
        "ColumnParallelLinearWithLoRA": InplaceColumnParallelLinearWithLoRA,
        "MergedColumnParallelLinearWithLoRA": InplaceMergedColumnParallelLinearWithLoRA,
        "RowParallelLinearWithLoRA": InplaceRowParallelLinearWithLoRA,
    }


def inplace_wrappers(module: Any) -> list[tuple[str, Any]]:
    """(name, wrapper) of every in-place LoRA wrapper inside ``module``."""
    classes = tuple(inplace_wrapper_classes().values())
    return [(name, sub) for name, sub in module.named_modules() if isinstance(sub, classes)]


def set_chunk_tokens(module: Any, chunk_tokens: int) -> int:
    """Set the chunk rows on every in-place wrapper (a resident DiT serves jobs with other profiles)."""
    found = inplace_wrappers(module)
    for _name, wrapper in found:
        wrapper.chunk_tokens = int(chunk_tokens)
    return len(found)


def call_counts(module: Any) -> int:
    """Sum of in-place term evaluations over every wrapper (provenance: the path really ran)."""
    return sum(int(getattr(wrapper, "inplace_calls", 0)) for _name, wrapper in inplace_wrappers(module))


__all__ = ["add_lora_", "call_counts", "inplace_wrapper_classes", "inplace_wrappers", "set_chunk_tokens"]
