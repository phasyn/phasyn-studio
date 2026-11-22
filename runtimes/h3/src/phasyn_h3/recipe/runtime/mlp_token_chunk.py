"""Token-chunked DiT MLP for long sequences (torch; actor only, imported lazily).

A 345-frame 1280x736 Ref2VA call packs about 110k rows. The block MLP (``MiniMaxH3MLP.forward``,
``minimax_h3.py``) materialises the fused fc1 output ``[T, 2 x 14336]`` (BF16, about 6.3 GB) and then the
SiLU-and-mul result ``[T, 14336]`` (about 3.2 GB): on a 16 GB GPU the second allocation fails
(run 90cef62c: ``silu_and_mul_with_activation_rounding`` asked for 2.95 GiB with 2.54 GiB free).

The MLP is row-wise (fc1, SiLU-and-mul and fc2 act on each row alone), so running it over row chunks and
writing each chunk into one output buffer computes the same rows; upstream already does exactly this on MPS
(``_MPS_MLP_TOKEN_CHUNK_SIZE``). The only possible difference is the GEMM kernel cuBLAS picks for a smaller M.
Engagement is therefore automatic and limited to sequences longer than ``ENGAGE_ROWS``: every call at or
below it (107 frames is 37k rows, 209 frames about 70k) keeps the unchanged single call, byte for byte.

The wrapper is an instance attribute on each block's ``mlp`` for the duration of the denoise loop only and is
removed afterwards, also on failure (the ``ref_kv_cache`` proxies follow the same pattern).
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

from . import pins


_MATRIX_RANK = 2


PATCH_ID = "mlp_token_chunk.v1"
ENGAGE_ROWS = 98_304  # longer packed sequences run the MLP in chunks (345 frames at 1280x736 is ~110k rows)
CHUNK_ROWS = 32_768  # fc1 output per chunk: 32768 x 28672 x 2 B = 1.75 GiB
_WHAT = "MLP 依 token 分段"


def _mlps(model: Any) -> list[Any]:
    blocks = getattr(model, "blocks", None)
    if blocks is None:
        return []
    return [b.mlp for b in blocks if getattr(b, "mlp", None) is not None]


def _chunked(forward: Any, chunk_rows: int) -> Any:
    def run(x: Any) -> Any:
        import torch

        if (
            isinstance(x, tuple)
            or x.ndim != _MATRIX_RANK
            or int(x.shape[0]) <= chunk_rows
        ):
            return forward(x)
        rows = int(x.shape[0])
        out: Any = None
        for start in range(0, rows, chunk_rows):
            part = forward(x[start : start + chunk_rows])
            if out is None:
                out = torch.empty(
                    (rows, *part.shape[1:]), dtype=part.dtype, device=part.device
                )
            out[start : start + int(part.shape[0])].copy_(part)
            del part
        return out

    return run


@contextlib.contextmanager
def chunked_mlp(
    model: Any, seq_rows: int, *, chunk_rows: int = CHUNK_ROWS
) -> Iterator[dict[str, Any]]:
    """Run every block MLP in ``chunk_rows`` row chunks while active, only when ``seq_rows > ENGAGE_ROWS``.

    Yields the report (engaged or not, rows, chunk size, blocks wrapped, the pinned upstream source).
    """
    report: dict[str, Any] = {
        "patch": PATCH_ID,
        "engaged": False,
        "seq_rows": int(seq_rows),
        "engage_rows": ENGAGE_ROWS,
        "chunk_rows": int(chunk_rows),
        "blocks": 0,
    }
    if seq_rows <= ENGAGE_ROWS:
        yield report
        return
    report["source_sha256"] = pins.check("mlp_token_chunk", what=_WHAT)
    mlps = _mlps(model)
    installed: list[Any] = []
    try:
        for mlp in mlps:
            mlp.forward = _chunked(mlp.forward, int(chunk_rows))
            installed.append(mlp)
        report.update(engaged=True, blocks=len(installed))
        yield report
    finally:
        for mlp in installed:
            with contextlib.suppress(AttributeError):
                del mlp.forward  # back to the class method


__all__ = ["CHUNK_ROWS", "ENGAGE_ROWS", "PATCH_ID", "chunked_mlp"]
