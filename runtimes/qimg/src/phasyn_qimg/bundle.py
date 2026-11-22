"""qimg bundle：小 JSON 文件（主檔）+一個 safetensors payload 附檔（與 H3 bundle 相同的 links.payload 機制）.

主檔 media type ``application/vnd.phasyn.qimg-bundle+json``，內容是 canonical JSON::

    {"schema": "phasyn_qimg.bundle.v1", "kind": "<kind>", "meta": {...},
     "payload": {"format": "safetensors", "media_type": "application/x-safetensors",
                 "sha256": "<hex>", "size_bytes": N},
     "tensors": {"<name>": {"dtype": "BF16", "shape": [...]}, ...}}

主檔的 FileRef.metadata.links.payload 指向 payload 附檔（node 會把兩個檔一起物化給 consumer）。
讀取時檢查 kind、links 宣告的 SHA-256／大小與主檔一致，並對 payload 實際內容重算 SHA-256，最後核對
tensor 名稱／dtype／shape 與主檔宣告一致；任何不一致都拒絕（不猜、不轉換）。

同樣的輸入產生逐位元相同的主檔與 payload：meta 由呼叫端決定（不得放時間或隨機 id），JSON 以
canonical 形式寫出，safetensors 依 dtype／名稱排序序列化。
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from phasyn_components.canonical import canonical_json, sha256_hex
from phasyn_components.errors import ComponentError
from phasyn_components.provider import RunContext
from phasyn_components.timeutil import mono_ns

from . import KIND_BY_TYPE


if TYPE_CHECKING:  # pragma: no cover - 只給型別檢查
    import numpy as np
    import torch

_SAFETENSOR_LENGTH_BYTES = 8

BUNDLE_MEDIA_TYPE = "application/vnd.phasyn.qimg-bundle+json"
PAYLOAD_MEDIA_TYPE = "application/x-safetensors"
BUNDLE_SCHEMA = "phasyn_qimg.bundle.v1"
MAX_BUNDLE_DOC_BYTES = 16 * 1024 * 1024
_TENSOR_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _is_torch_tensor(value: Any) -> bool:
    return type(value).__module__.split(".", 1)[0] == "torch"


def _header(data: bytes) -> dict[str, Any]:
    if len(data) < _SAFETENSOR_LENGTH_BYTES:
        raise ComponentError("FILE_TRUNCATED", "safetensors payload 太短")
    size = int.from_bytes(data[:8], "little")
    if size <= 0 or 8 + size > len(data):
        raise ComponentError("FILE_TRUNCATED", "safetensors header 長度不合法")
    try:
        header = json.loads(data[8 : 8 + size])
    except ValueError as exc:
        raise ComponentError(
            "LATENT_MISMATCH", f"safetensors header 無法解析：{exc}"
        ) from exc
    if not isinstance(header, dict):
        raise ComponentError("LATENT_MISMATCH", "safetensors header 不是 object")
    header.pop("__metadata__", None)
    return header


def _valid_tensor_name(name: object) -> bool:
    return isinstance(name, str) and bool(_TENSOR_NAME.match(name))


def serialize_tensors(
    tensors: Mapping[str, Any],
) -> tuple[bytes, dict[str, dict[str, Any]]]:
    """tensors（torch.Tensor 或 numpy.ndarray）→ (safetensors bytes, {name: {dtype, shape}}).

    有任何 torch tensor 時整批以 ``safetensors.torch`` 序列化（numpy 先轉 torch，不改 dtype）；全部是 numpy 時
    以 ``safetensors.numpy`` 序列化（不需要 torch）。兩條路徑對同樣內容產生相同位元組。
    """
    if not tensors:
        raise ComponentError("RUNTIME_ERROR", "bundle 至少要有一個 tensor")
    for name in tensors:
        if not _valid_tensor_name(name):
            raise ComponentError("RUNTIME_ERROR", f"tensor 名稱不合法：{name!r}")
    import numpy as np  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.

    if any(_is_torch_tensor(t) for t in tensors.values()):
        import torch
        from safetensors.torch import save as save_torch

        converted: dict[str, torch.Tensor] = {}
        for name, value in tensors.items():
            tensor = (
                torch.from_numpy(np.ascontiguousarray(value))
                if isinstance(value, np.ndarray)
                else value
            )
            # clone：避免兩個項目共用 storage（safetensors.torch 會拒絕），也與呼叫端的 tensor 脫鉤
            converted[name] = tensor.detach().to("cpu").contiguous().clone()
        data = save_torch(converted)
    else:
        from safetensors.numpy import save as save_numpy

        data = save_numpy(
            {name: np.ascontiguousarray(value) for name, value in tensors.items()}
        )
    header = _header(data)
    manifest = {
        name: {
            "dtype": str(header[name]["dtype"]),
            "shape": [int(x) for x in header[name]["shape"]],
        }
        for name in sorted(header)
    }
    return data, manifest


def write_bundle(
    ctx: RunContext,
    port: str,
    *,
    kind: str,
    meta: dict[str, Any],
    tensors: Mapping[str, torch.Tensor | np.ndarray],
) -> None:
    """寫出 payload 附檔與 bundle 主檔，並把主檔設為 ``port`` 的輸出."""
    declared = ctx.output_type(port)
    if declared is not None and KIND_BY_TYPE.get(declared, kind) != kind:
        raise ComponentError(
            "RUNTIME_ERROR",
            f"輸出 {port} 宣告為 {declared}，不能寫 kind={kind} 的 bundle",
        )
    data, manifest = serialize_tensors(tensors)
    payload_sha = sha256_hex(data)
    payload = ctx.new_file(
        None,
        PAYLOAD_MEDIA_TYPE,
        {"role": f"{kind}.payload", "kind": kind},
        type_id="file.attachment.v1",
    )
    payload.write(data)
    payload.finish()
    doc = {
        "schema": BUNDLE_SCHEMA,
        "kind": kind,
        "meta": dict(meta),
        "payload": {
            "format": "safetensors",
            "media_type": PAYLOAD_MEDIA_TYPE,
            "sha256": payload_sha,
            "size_bytes": len(data),
        },
        "tensors": manifest,
    }
    body = canonical_json(doc)
    out = ctx.new_file(
        port,
        BUNDLE_MEDIA_TYPE,
        {
            "kind": kind,
            "schema": BUNDLE_SCHEMA,
            "payload_sha256": payload_sha,
            "links": {"payload": ctx.file_ref(payload)},
        },
    )
    out.write(body)
    ctx.set_file_output(port, out)


def read_bundle(
    ctx: RunContext, port: str, *, kind: str
) -> tuple[dict[str, Any], dict[str, torch.Tensor]]:
    """Bundle 輸入 → (meta, tensors)。檢查 kind、links 與主檔宣告、payload 實際 SHA-256 與 tensor 清單."""
    item = ctx.input(port)
    path = item.require_path(port)
    ref = item.file or {}
    if ref.get("media_type") != BUNDLE_MEDIA_TYPE:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"輸入 {port} 不是 qimg bundle（media_type={ref.get('media_type')}）",
        )
    size = path.stat().st_size
    if size > MAX_BUNDLE_DOC_BYTES:
        raise ComponentError(
            "INPUT_TOO_LARGE", f"輸入 {port} 的 bundle 主檔 {size} bytes 超過上限"
        )
    try:
        doc = json.loads(path.read_bytes())
    except ValueError as exc:
        raise ComponentError(
            "INVALID_ARGUMENT", f"輸入 {port} 的 bundle 主檔不是有效 JSON：{exc}"
        ) from exc
    if not isinstance(doc, dict) or doc.get("schema") != BUNDLE_SCHEMA:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"輸入 {port} 不是 {BUNDLE_SCHEMA}（schema={doc.get('schema')}）",
        )
    if doc.get("kind") != kind:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"輸入 {port} 是 kind={doc.get('kind')} 的 bundle，此元件需要 kind={kind}",
            details={"expected_kind": kind, "got_kind": doc.get("kind")},
        )
    declared = doc.get("payload") or {}
    link = item.links.get("payload")
    if link is None:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"輸入 {port} 缺少 payload 附檔（metadata.links.payload）",
        )
    link_ref, payload_path = link
    if link_ref.get("sha256") != declared.get("sha256") or int(
        link_ref.get("size_bytes", -1)
    ) != int(declared.get("size_bytes", -2)):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"輸入 {port} 的 payload 附檔與 bundle 宣告不同（不可誤用另一份資料）",
            details={
                "declared_sha256": declared.get("sha256"),
                "linked_sha256": link_ref.get("sha256"),
            },
        )
    t0 = mono_ns()
    data = payload_path.read_bytes()
    ctx.recorder.transfer(
        "disk_read",
        direction="DISK_IN",
        submitted_bytes=len(data),
        host_ms=(mono_ns() - t0) / 1e6,
        byte_basis="logical_file",
        owner="consumer",
        src=f"file:{link_ref.get('file_id')}",
        dst="process",
        src_memory_kind="disk",
        dst_memory_kind="host",
    )
    _verify_payload(data, declared, doc, port)
    from safetensors.torch import load as load_torch

    meta = doc.get("meta")
    return (dict(meta) if isinstance(meta, dict) else {}), load_torch(data)


def _verify_payload(
    data: bytes, declared: Mapping[str, Any], doc: Mapping[str, Any], port: str
) -> None:
    if len(data) != int(declared.get("size_bytes", -1)):
        raise ComponentError(
            "FILE_TRUNCATED", f"輸入 {port} 的 payload 長度 {len(data)} 與宣告不同"
        )
    actual = sha256_hex(data)
    if actual != declared.get("sha256"):
        raise ComponentError(
            "FILE_HASH_MISMATCH",
            f"輸入 {port} 的 payload 內容 SHA-256 與宣告不同",
            details={
                "declared_sha256": declared.get("sha256"),
                "actual_sha256": actual,
            },
        )
    header = _header(data)
    manifest = doc.get("tensors") or {}
    found = {
        name: {"dtype": str(h["dtype"]), "shape": [int(x) for x in h["shape"]]}
        for name, h in header.items()
    }
    if found != manifest:
        raise ComponentError(
            "LATENT_MISMATCH",
            f"輸入 {port} 的 payload tensor 與 bundle 宣告不同",
            details={"declared": sorted(manifest), "found": sorted(found)},
        )


def input_identity(ctx: RunContext, port: str) -> dict[str, Any] | None:
    """已接上的 bundle 輸入的身分（主檔與 payload 的 SHA-256），供下游記錄來源；沒接上時 None."""
    item = ctx.optional_input(port)
    if item is None or item.file is None:
        return None
    link = item.links.get("payload")
    return {
        "bundle_sha256": item.file.get("sha256"),
        "payload_sha256": link[0].get("sha256") if link else None,
        "kind": (item.file.get("metadata") or {}).get("kind"),
    }


__all__ = [
    "BUNDLE_MEDIA_TYPE",
    "BUNDLE_SCHEMA",
    "PAYLOAD_MEDIA_TYPE",
    "input_identity",
    "read_bundle",
    "serialize_tensors",
    "write_bundle",
]
