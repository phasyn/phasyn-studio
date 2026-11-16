"""Torch-side helpers for verified payloads (imported only inside the actor)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_h3.recipe.abi.tensors import file_sha256, read_header_from_file

from ..errors import IntegrityMismatch, InvalidStageInput

_TORCH_DTYPE_NAMES = {
    "F32": "float32",
    "BF16": "bfloat16",
    "I64": "int64",
    "I32": "int32",
    "BOOL": "bool",
    "U8": "uint8",
}


def verified_payload(document: Mapping[str, Any], attachments: Mapping[str, Path], *, field: str = "payload") -> Path:
    ref = document.get(field)
    if not ref:
        raise InvalidStageInput("PAYLOAD_REF_MISSING", f"文件缺少 {field}")
    path = attachments.get(ref["artifact_id"])
    if path is None:
        raise InvalidStageInput("PAYLOAD_ATTACHMENT_MISSING", f"缺少附件 {ref['artifact_id']}")
    digest, size = file_sha256(path)
    if digest != ref["sha256"] or size != ref["size_bytes"]:
        raise IntegrityMismatch(
            "PAYLOAD_HASH_MISMATCH", f"{ref['artifact_id']} 內容雜湊不符", expected=ref["sha256"], actual=digest
        )
    read_header_from_file(path)  # bounded structural validation before any tensor is materialized
    return Path(path)


def load_tensors(path: Path, names: list[str] | None = None) -> dict[str, Any]:
    """Load named tensors from a verified safetensors payload (CPU, no pickle)."""
    from safetensors import safe_open

    out: dict[str, Any] = {}
    with safe_open(str(path), framework="pt", device="cpu") as handle:
        keys = list(handle.keys())
        for name in names if names is not None else keys:
            if name not in keys:
                raise InvalidStageInput("TENSOR_MISSING", f"{path.name} 缺少 tensor {name}")
            out[name] = handle.get_tensor(name)
    return out


def tensor_bytes(tensor: Any) -> bytes:
    """Little-endian raw bytes of a CPU tensor (bf16 via a uint16 view)."""
    import torch

    t = tensor.detach().to("cpu").contiguous()
    if t.dtype == torch.bfloat16:
        return t.view(torch.int16).numpy().tobytes()
    if t.dtype == torch.bool:
        return t.to(torch.uint8).numpy().tobytes()
    return t.numpy().tobytes()


__all__ = ["load_tensors", "tensor_bytes", "verified_payload"]
