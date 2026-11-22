"""Trained native factors -> a PEFT LoRA with diffusers names, the format the H3 DiT loads (``peft_diffusers``).

Name and layout mapping (the inverse of the pinned loader's PEFT rewrite):

* ``blocks.N.attn.qkv_proj`` -> ``transformer_blocks.N.attn.to_q`` / ``to_k`` / ``to_v``: ``A`` is shared, ``B``
  is split into thirds (the fused rows are ``[q; k; v]``);
* ``attn.out_proj`` -> ``attn.to_out.0``; ``mlp.fc2`` -> ``ff.net.2``;
* ``mlp.fc1`` -> ``ff.net.0.proj`` with the halves of ``B`` swapped: the fused native rows are ``[gate; value]``,
  PEFT keeps ``[value; gate]`` and the loader swaps them back.

The scale ``alpha / rank`` is not folded in: ``lora_alpha`` and ``lora_rank`` go into the file metadata.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any


_NAME = re.compile(
    r"blocks\.(\d+)\.(attn\.qkv_proj|attn\.out_proj|mlp\.fc1|mlp\.fc2)\.(lora_A|lora_B)"
)
_SINGLE = {
    "attn.out_proj": "attn.to_out.0",
    "mlp.fc2": "ff.net.2",
    "mlp.fc1": "ff.net.0.proj",
}
_QKV = ("attn.to_q", "attn.to_k", "attn.to_v")


def peft_tensors(state: Mapping[str, Any]) -> dict[str, Any]:
    """Diffusers-named PEFT tensors (BF16) from ``model.lora_state`` factors."""
    import torch

    out: dict[str, Any] = {}
    for key, tensor in state.items():
        m = _NAME.fullmatch(key)
        if m is None:
            raise ValueError(f"unexpected LoRA factor {key}")
        block, target, part = m.groups()
        prefix = f"transformer_blocks.{block}."
        t = tensor.detach().float().cpu()
        if target == "attn.qkv_proj":
            pieces = [t] * 3 if part == "lora_A" else list(t.chunk(3, dim=0))
            for name, piece in zip(_QKV, pieces, strict=True):
                out[f"{prefix}{name}.{part}.weight"] = piece.contiguous()
            continue
        if target == "mlp.fc1" and part == "lora_B":
            gate, value = t.chunk(2, dim=0)
            t = torch.cat([value, gate], dim=0)
        out[f"{prefix}{_SINGLE[target]}.{part}.weight"] = t.contiguous()
    return {k: v.to(torch.bfloat16).contiguous() for k, v in sorted(out.items())}


def write_peft(
    state: Mapping[str, Any],
    path: Path,
    *,
    rank: int,
    alpha: float,
    notes: Mapping[str, str],
) -> int:
    """Write the PEFT file atomically; returns its tensor count."""
    from safetensors.torch import save_file

    tensors = peft_tensors(state)
    meta = {
        "lora_rank": str(int(rank)),
        "lora_alpha": str(float(alpha)),
        "adaln_projection": "none",
        **dict(notes),
    }
    tmp = path.with_suffix(".part")
    save_file(tensors, str(tmp), metadata=meta)
    tmp.replace(path)
    return len(tensors)


__all__ = ["peft_tensors", "write_peft"]
