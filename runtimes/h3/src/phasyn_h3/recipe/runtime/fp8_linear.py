"""FP8 e4m3 W8A8 GEMM for the online-FP8 DiT on SM 12.0 (torch + triton; actor only, imported lazily).

Operands are exactly the pinned online ``Fp8LinearMethod``'s: a per-output-channel
E4M3 weight stored as the transposed view ``weight = qweight.t()`` [K, N] with ``weight_scale`` [1, N] FP32
(``layers/quantization/fp8.py:301-314``), and a per-token dynamic E4M3 activation from the same
``sglang_per_token_quant_fp8`` kernel ``apply_fp8_linear`` uses (``srt/layers/quantization/fp8_utils.py:2376-2378``).
Only the GEMM differs.  On SM 12.0 GPUs the pinned path's row/column-scaled GEMMs — sgl_kernel CUTLASS
``fp8_scaled_mm`` and ``torch._scaled_mm`` with ``[M,1]``/``[1,N]`` scales (PyTorch's own CUTLASS
``f8f8bf16_rowwise``) — are much slower than cuBLASLt's tensor-wise FP8 GEMM (NVJet
``nvjet_sm120_qqtst``), which accumulates in FP32 (its product matches Triton's FP32-accumulating MMA
bit for bit).  So the GEMM runs with unit tensor-wise scales into a BF16 product and one Triton pass
applies the scales (and the bias) in FP32:

    out[m, n] = round(float(acc_bf16[m, n]) * s_x[m] * s_w[n] + bias[n])

The BF16 product cannot overflow (|acc| <= 448² · K < 3e9 << 3.4e38); its extra rounding is small next to
the E4M3 quantization error of the operands.
"""

from __future__ import annotations

import functools
from typing import Any


_MATRIX_RANK = 2


KERNEL_ID = "cublaslt_tensorwise_unit+triton_rowwise_epilogue"
# compute capabilities whose speed/accuracy this kernel was measured on (others keep the upstream
# ``apply_fp8_linear``: CUTLASS fp8_scaled_mm, or Torch NVJet rowwise on SM90)
VALIDATED_CAPABILITIES: tuple[tuple[int, int], ...] = ((12, 0),)
_ALIGN = 16  # cuBLASLt FP8: K and N multiples of 16 (every H3 DiT linear qualifies)


@functools.cache
def _epilogue_kernel() -> Any:
    import triton  # type: ignore[import-untyped]
    import triton.language as tl  # type: ignore[import-untyped]

    @triton.jit  # type: ignore[untyped-decorator]
    def _rowwise_scale_bias(
        buffers: tl.tuple,
        matrix: tl.tuple,
        has_bias: tl.constexpr,
        block_rows: tl.constexpr,
        block_cols: tl.constexpr,
    ) -> None:
        in_ptr, out_ptr, sx_ptr, sw_ptr, bias_ptr = buffers
        rows, cols, stride_in, stride_out = matrix
        pid_m = tl.program_id(0)
        pid_n = tl.program_id(1)
        rm = pid_m * block_rows + tl.arange(0, block_rows)
        rn = pid_n * block_cols + tl.arange(0, block_cols)
        mask = (rm[:, None] < rows) & (rn[None, :] < cols)
        sx = tl.load(sx_ptr + rm, mask=rm < rows, other=0.0)
        sw = tl.load(sw_ptr + rn, mask=rn < cols, other=0.0)
        acc = tl.load(
            in_ptr + rm[:, None].to(tl.int64) * stride_in + rn[None, :],
            mask=mask,
            other=0.0,
        )
        val = acc.to(tl.float32) * sx[:, None] * sw[None, :]
        if has_bias:
            val += tl.load(bias_ptr + rn, mask=rn < cols, other=0.0).to(tl.float32)[
                None, :
            ]
        tl.store(
            out_ptr + rm[:, None].to(tl.int64) * stride_out + rn[None, :],
            val.to(out_ptr.dtype.element_ty),
            mask=mask,
        )

    return _rowwise_scale_bias


def rowwise_scale_(
    acc: Any, x_scale: Any, w_scale: Any, bias: Any = None, out: Any = None
) -> Any:
    """``out = acc · x_scale[:, None] · w_scale[None, :] (+ bias)`` in one pass (in place when ``out`` is None)."""
    import triton

    rows, cols = int(acc.shape[0]), int(acc.shape[1])
    dst = acc if out is None else out
    if rows == 0 or cols == 0:
        return dst
    kernel = _epilogue_kernel()
    grid = (triton.cdiv(rows, 64), triton.cdiv(cols, 128))
    kernel[grid](
        (acc, dst, x_scale, w_scale, bias if bias is not None else w_scale),
        (rows, cols, acc.stride(0), dst.stride(0)),
        has_bias=bias is not None,
        block_rows=64,
        block_cols=128,
    )
    return dst


@functools.cache
def _unit_scale(device: Any) -> Any:
    import torch

    return torch.ones((), device=device, dtype=torch.float32)


def supports(layer: Any) -> bool:
    """The layer's FP8 operands fit this GEMM (otherwise the caller keeps the upstream apply)."""
    weight = getattr(layer, "weight", None)
    scale = getattr(layer, "weight_scale", None)
    if weight is None or scale is None or weight.dim() != _MATRIX_RANK:
        return False
    k, n = int(weight.shape[0]), int(weight.shape[1])
    return (
        str(weight.dtype) == "torch.float8_e4m3fn"
        and weight.stride(0) == 1
        and weight.stride(1)
        == k  # the transposed view of a row-major [N, K] (fp8.py:313)
        and k % _ALIGN == 0
        and n % _ALIGN == 0
        and int(scale.numel()) == n
    )


def fp8_linear(layer: Any, x: Any, bias: Any = None) -> Any:
    """``Fp8LinearMethod.apply`` for a layer quantized by the shim's per-layer path."""
    import torch
    from sglang.kernels.ops.quantization.fp8_kernel import sglang_per_token_quant_fp8  # type: ignore[import-untyped]

    if x.dtype not in (torch.bfloat16, torch.float16):
        raise ValueError(
            f"FP8 linear ({KERNEL_ID}) expects a BF16/FP16 activation, got {x.dtype}"
        )
    if (
        not x.is_contiguous()
    ):  # the per-token quant kernel asserts row-major input (fp8.py:391-396)
        x = x.contiguous()
    weight = layer.weight
    if (
        weight.stride(0) != 1
    ):  # a host/device round trip that lost the transposed layout: fail, never guess
        raise ValueError(
            f"FP8 weight lost its column-major layout (shape {tuple(weight.shape)}, {weight.stride()})"
        )
    rows = x.reshape(-1, x.shape[-1])
    out_shape = (*x.shape[:-1], int(weight.shape[1]))
    if rows.shape[0] == 0:
        return x.new_empty(out_shape)
    q, x_scale = sglang_per_token_quant_fp8(rows)
    one = _unit_scale(x.device)
    # BF16 product even for an FP16 activation: the unit-scale sum overflows FP16 (448² · K)
    acc = torch._scaled_mm(
        q, weight, scale_a=one, scale_b=one, out_dtype=torch.bfloat16
    )
    target = None if x.dtype == torch.bfloat16 else torch.empty_like(acc, dtype=x.dtype)
    out = rowwise_scale_(
        acc, x_scale.view(-1), layer.weight_scale.view(-1), bias, target
    )
    layer._phasyn_fp8_calls = int(getattr(layer, "_phasyn_fp8_calls", 0)) + 1
    return out.view(out_shape)


def call_counts(module: Any) -> int:
    """Sum of shim FP8 GEMM calls over every layer of ``module`` (provenance: the kernel really ran)."""
    return sum(int(getattr(sub, "_phasyn_fp8_calls", 0)) for sub in module.modules())


__all__ = [
    "KERNEL_ID",
    "VALIDATED_CAPABILITIES",
    "call_counts",
    "fp8_linear",
    "rowwise_scale_",
    "supports",
]
