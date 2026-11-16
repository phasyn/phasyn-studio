"""Bounded safetensors reader/writer and TensorBundle checks (no torch, no pickle).

TensorBundle contract: the header is checked before any data is
handed to an adapter — header <= 16 MiB, rank <= 8, every dimension > 0, shape
products checked for overflow, offsets legal, contiguous and non-overlapping.
"""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

from .canonical import sha256_hex

MAX_HEADER_BYTES = 16 * 1024 * 1024
MAX_RANK = 8
MAX_DIM = 2_147_483_647
MAX_SAFE_BYTES = 9_007_199_254_740_991

DTYPE_SIZES: dict[str, int] = {
    "BOOL": 1,
    "U8": 1,
    "I8": 1,
    "F8_E4M3": 1,
    "F8_E5M2": 1,
    "BF16": 2,
    "F16": 2,
    "I16": 2,
    "U16": 2,
    "F32": 4,
    "I32": 4,
    "U32": 4,
    "F64": 8,
    "I64": 8,
    "U64": 8,
}

# dtypes allowed on the wire by tensor-bundle / conditioning-bundle schemas
WIRE_DTYPES = ("BF16", "F32", "I64", "I32", "BOOL", "U8")


class TensorFormatError(ValueError):
    """Raised for any malformed or out-of-policy tensor container."""


@dataclass(frozen=True)
class TensorInfo:
    name: str
    dtype: str
    shape: tuple[int, ...]
    start: int
    end: int

    @property
    def byte_length(self) -> int:
        return self.end - self.start


@dataclass
class SafetensorsHeader:
    header_length: int
    tensors: dict[str, TensorInfo]
    metadata: dict[str, str] = field(default_factory=dict)
    data_length: int = 0

    @property
    def data_offset(self) -> int:
        return 8 + self.header_length


def _checked_nbytes(dtype: str, shape: Iterable[int]) -> int:
    if dtype not in DTYPE_SIZES:
        raise TensorFormatError(f"不支援的 dtype：{dtype}")
    dims = list(shape)
    if not 1 <= len(dims) <= MAX_RANK:
        raise TensorFormatError(f"rank 必須介於 1..{MAX_RANK}")
    for d in dims:
        if type(d) is not int or not 0 < d <= MAX_DIM:
            raise TensorFormatError("每個 dimension 必須是正整數且不超過 2^31-1")
    count = math.prod(dims)
    nbytes = count * DTYPE_SIZES[dtype]
    if nbytes > MAX_SAFE_BYTES:
        raise TensorFormatError("tensor 大小超出安全整數範圍")
    return nbytes


def parse_header(prefix: bytes, total_size: int) -> SafetensorsHeader:
    """Parse and validate a safetensors header given the file's first bytes."""
    if total_size < 8 or len(prefix) < 8:
        raise TensorFormatError("檔案過短，缺少 header 長度")
    (header_length,) = struct.unpack("<Q", prefix[:8])
    if not 2 <= header_length <= MAX_HEADER_BYTES:
        raise TensorFormatError("header 長度超出 16 MiB 限制或過短")
    if 8 + header_length > total_size:
        raise TensorFormatError("header 長度超過檔案大小")
    if len(prefix) < 8 + header_length:
        raise TensorFormatError("讀取的 header 不完整")
    raw = prefix[8 : 8 + header_length]
    if raw[:1] != b"{":
        raise TensorFormatError("header 必須是 JSON object")
    try:
        doc = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise TensorFormatError(f"header 不是合法 JSON：{exc}") from exc
    if not isinstance(doc, dict):
        raise TensorFormatError("header 必須是 JSON object")
    metadata = doc.pop("__metadata__", {})
    if not isinstance(metadata, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in metadata.items()
    ):
        raise TensorFormatError("__metadata__ 必須是字串對字串")
    data_length = total_size - 8 - header_length
    tensors: dict[str, TensorInfo] = {}
    for name, entry in doc.items():
        if not isinstance(entry, dict) or set(entry) != {"dtype", "shape", "data_offsets"}:
            raise TensorFormatError(f"tensor header 欄位錯誤：{name}")
        dtype, shape, offsets = entry["dtype"], entry["shape"], entry["data_offsets"]
        if not isinstance(shape, list):
            raise TensorFormatError(f"shape 必須是陣列：{name}")
        nbytes = _checked_nbytes(dtype, shape)
        if not isinstance(offsets, list) or len(offsets) != 2 or not all(type(v) is int for v in offsets):
            raise TensorFormatError(f"data_offsets 非法：{name}")
        start, end = offsets
        if not 0 <= start <= end <= data_length or end - start != nbytes:
            raise TensorFormatError(f"offset 與 shape 長度不一致或越界：{name}")
        tensors[name] = TensorInfo(name, dtype, tuple(shape), start, end)
    cursor = 0
    for info in sorted(tensors.values(), key=lambda t: (t.start, t.end)):
        if info.start != cursor:
            raise TensorFormatError(f"tensor 資料有空洞或重疊：{info.name}")
        cursor = info.end
    if cursor != data_length:
        raise TensorFormatError("檔案尾端有未宣告的資料")
    return SafetensorsHeader(header_length, tensors, metadata, data_length)


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f"重複的 key：{key}")
        out[key] = value
    return out


def read_header_from_file(path: str | Path) -> SafetensorsHeader:
    path = Path(path)
    size = path.stat().st_size
    with path.open("rb") as fh:
        head = fh.read(8)
        if len(head) < 8:
            raise TensorFormatError("檔案過短")
        (length,) = struct.unpack("<Q", head)
        if not 2 <= length <= MAX_HEADER_BYTES:
            raise TensorFormatError("header 長度超出 16 MiB 限制或過短")
        return parse_header(head + fh.read(length), size)


def read_header_from_bytes(data: bytes) -> SafetensorsHeader:
    return parse_header(data, len(data))


def tensor_bytes(data: bytes, header: SafetensorsHeader, name: str) -> bytes:
    info = header.tensors[name]
    base = header.data_offset
    return data[base + info.start : base + info.end]


def write_safetensors(
    tensors: Iterable[tuple[str, str, Iterable[int], bytes]],
    metadata: Mapping[str, str] | None = None,
) -> bytes:
    """Serialize tensors (name, dtype, shape, raw little-endian bytes)."""
    entries = sorted(tensors, key=lambda t: t[0])
    header: dict[str, Any] = {}
    if metadata:
        header["__metadata__"] = {str(k): str(v) for k, v in metadata.items()}
    offset = 0
    payloads: list[bytes] = []
    for name, dtype, shape, raw in entries:
        shape_list = list(shape)
        nbytes = _checked_nbytes(dtype, shape_list)
        if len(raw) != nbytes:
            raise TensorFormatError(f"{name} 資料長度 {len(raw)} 與 shape/dtype {nbytes} 不符")
        header[name] = {"dtype": dtype, "shape": shape_list, "data_offsets": [offset, offset + nbytes]}
        offset += nbytes
        payloads.append(raw)
    encoded = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    pad = (8 - len(encoded) % 8) % 8
    encoded += b" " * pad
    return struct.pack("<Q", len(encoded)) + encoded + b"".join(payloads)


def tensor_specs(header: SafetensorsHeader, layouts: Mapping[str, str]) -> list[dict[str, Any]]:
    """tensor-bundle ``tensors`` entries for every tensor in the header."""
    specs = []
    for name in sorted(header.tensors):
        info = header.tensors[name]
        specs.append(
            {
                "name": name,
                "dtype": info.dtype,
                "shape": list(info.shape),
                "layout": layouts.get(name, "unspecified"),
                "byte_length": info.byte_length,
            }
        )
    return specs


def verify_payload_identity(manifest: Mapping[str, Any], payload: bytes) -> list[str]:
    """payload sha/size and artifact_id agree with the manifest."""
    problems: list[str] = []
    ref = manifest.get("payload", {})
    digest = sha256_hex(payload)
    if ref.get("sha256") != digest:
        problems.append("payload sha256 與 manifest 不符")
    if ref.get("artifact_id") != f"sha256:{ref.get('sha256')}":
        problems.append("artifact_id 與 sha256 不一致")
    if ref.get("size_bytes") != len(payload):
        problems.append("payload 大小與 manifest 不符")
    return problems


def verify_tensor_specs(manifest: Mapping[str, Any], header: SafetensorsHeader) -> list[str]:
    """Every manifest tensor must exist with the same dtype/shape/byte_length."""
    problems: list[str] = []
    declared = {t["name"]: t for t in manifest.get("tensors", [])}
    if len(declared) != len(manifest.get("tensors", [])):
        problems.append("manifest tensor 名稱重複")
    if set(declared) != set(header.tensors):
        problems.append("manifest 與 safetensors 的 tensor 名稱不一致")
    for name, spec in declared.items():
        info = header.tensors.get(name)
        if info is None:
            continue
        expected = _checked_nbytes(spec["dtype"], spec["shape"])
        if spec["byte_length"] != expected:
            problems.append(f"{name}: shape×itemsize ≠ byte_length")
        if info.dtype != spec["dtype"] or list(info.shape) != list(spec["shape"]):
            problems.append(f"{name}: dtype/shape 與 header 不符")
    return problems


CONDITIONING_TAP = {
    "hidden_states_index": 50,
    "final_norm_applied": False,
    "use_cache": False,
    "hidden_size": 5120,
}


def verify_conditioning_bundle(
    manifest: Mapping[str, Any],
    payload: bytes,
    *,
    max_tokens: int,
) -> list[str]:
    """checks for an h3_conditioning bundle (CPU only)."""
    problems = verify_payload_identity(manifest, payload)
    try:
        header = read_header_from_bytes(payload)
    except TensorFormatError as exc:
        return [*problems, str(exc)]
    problems += verify_tensor_specs(manifest, header)
    if manifest.get("tap") != CONDITIONING_TAP:
        problems.append("tap 必須是 hidden_states[50]、未套 final norm、use_cache=false、寬 5120")
    seq = manifest.get("text_len")
    specs = {t["name"]: t for t in manifest.get("tensors", [])}
    if set(specs) != {"hidden_states", "text_token_tags", "text_video_token_mask"}:
        problems.append("conditioning bundle 必須恰有三個 tensor")
        return problems
    hidden = specs["hidden_states"]
    if hidden["dtype"] != "BF16" or hidden["shape"] != [seq, 5120] or hidden["layout"] != "S,H":
        problems.append("hidden_states 必須是 BF16 [S,5120]、layout S,H")
    tags = specs["text_token_tags"]
    if tags["dtype"] not in ("I64", "I32") or tags["shape"] != [seq] or tags["layout"] != "S":
        problems.append("text_token_tags 必須是整數 [S]、layout S")
    mask = specs["text_video_token_mask"]
    if mask["dtype"] != "BOOL" or mask["shape"] != [seq] or mask["layout"] != "S":
        problems.append("text_video_token_mask 必須是 BOOL [S]、layout S")
    if isinstance(seq, int) and seq > max_tokens:
        problems.append(f"S={seq} 超過 encoder_max_tokens={max_tokens}；不默默截斷")
    return problems


def stream_sha256(fh: BinaryIO, chunk: int = 1 << 20) -> tuple[str, int]:
    import hashlib

    h = hashlib.sha256()
    size = 0
    while True:
        block = fh.read(chunk)
        if not block:
            break
        h.update(block)
        size += len(block)
    return h.hexdigest(), size


def file_sha256(path: str | Path) -> tuple[str, int]:
    with Path(path).open("rb") as fh:
        return stream_sha256(fh)
