"""Tensor-bundle / conditioning-bundle payloads and manifests (torch-free).

Layout of a bundle output named ``<name>``:

* ``<name>.payload.safetensors`` — the binary payload, returned as an extra
  ``OutputFile`` named ``<name>.payload`` (published as the bundle's payload attachment);
* ``<name>.json`` — the manifest (tensor-bundle or conditioning-bundle schema),
  returned under the declared output name.

Payloads are written by :class:`SafetensorsStreamWriter`, which emits exactly the
header format of ``phasyn_h3.recipe.abi.tensors.write_safetensors`` (sorted names,
contiguous offsets, 8-byte padded header) but streams tensor bytes in order, so
large frame chunks never accumulate in RAM.  Every payload is re-read with the
bounded header parser before a manifest is produced.
"""

from __future__ import annotations

import json
import os
import struct
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from phasyn_h3.recipe.abi import media_types
from phasyn_h3.recipe.abi.canonical import artifact_ref, canonical_digest, canonical_json_bytes
from phasyn_h3.recipe.abi.contracts import validate
from phasyn_h3.recipe.abi.stage import OutputFile
from phasyn_h3.recipe.abi.tensors import (
    DTYPE_SIZES,
    WIRE_DTYPES,
    file_sha256,
    read_header_from_file,
    tensor_specs,
    verify_conditioning_bundle,
    verify_tensor_specs,
)

from .errors import EncoderContractMismatch, IntegrityMismatch

PAYLOAD_SUFFIX = ".payload"
# safetensors ``__metadata__`` key carrying the canonical JSON of the bundle's
# typed facts; the manifest's ``metadata_digest`` is its canonical digest.
METADATA_KEY = "phasyn.metadata"


def payload_metadata(metadata: Mapping[str, Any], **extra: str) -> dict[str, str]:
    """``__metadata__`` for a bundle payload (string → string, hashed with the payload)."""
    out = {METADATA_KEY: canonical_json_bytes(dict(metadata)).decode("utf-8")}
    out.update({k: str(v) for k, v in extra.items()})
    return out


def read_bundle_metadata(payload_path: Path, manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Typed facts from a verified payload; must match ``manifest.metadata_digest``."""
    header = read_header_from_file(payload_path)
    raw = header.metadata.get(METADATA_KEY)
    if raw is None:
        raise IntegrityMismatch("BUNDLE_METADATA_MISSING", f"{Path(payload_path).name} 缺少 {METADATA_KEY}")
    doc = json.loads(raw)
    if canonical_digest(doc) != manifest.get("metadata_digest"):
        raise IntegrityMismatch("BUNDLE_METADATA_DIGEST", "payload metadata 與 manifest.metadata_digest 不符")
    return doc


@dataclass(frozen=True)
class TensorDecl:
    name: str
    dtype: str
    shape: tuple[int, ...]
    layout: str

    @property
    def nbytes(self) -> int:
        n = DTYPE_SIZES[self.dtype]
        for d in self.shape:
            n *= int(d)
        return n


class SafetensorsStreamWriter:
    """Write a safetensors file whose tensors arrive later, in name order."""

    def __init__(self, path: str | Path, tensors: Sequence[TensorDecl], metadata: Mapping[str, str] | None = None):
        if not tensors:
            raise ValueError("safetensors payload needs at least one tensor")
        for t in tensors:
            if t.dtype not in WIRE_DTYPES:
                raise ValueError(f"{t.name}: dtype {t.dtype} not allowed on the wire")
            if not t.shape or any(int(d) <= 0 for d in t.shape) or len(t.shape) > 8:
                raise ValueError(f"{t.name}: illegal shape {t.shape}")
        names = [t.name for t in tensors]
        if len(set(names)) != len(names):
            raise ValueError("duplicate tensor names")
        self._decls = sorted(tensors, key=lambda t: t.name)
        header: dict[str, Any] = {}
        if metadata:
            header["__metadata__"] = {str(k): str(v) for k, v in metadata.items()}
        offset = 0
        for t in self._decls:
            header[t.name] = {
                "dtype": t.dtype,
                "shape": [int(d) for d in t.shape],
                "data_offsets": [offset, offset + t.nbytes],
            }
            offset += t.nbytes
        encoded = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        encoded += b" " * ((8 - len(encoded) % 8) % 8)
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh: BinaryIO | None = self.path.open("wb")
        self._fh.write(struct.pack("<Q", len(encoded)) + encoded)
        self._index = 0
        self._written_in_current = 0
        self.total_bytes = 8 + len(encoded) + offset

    @property
    def expected_order(self) -> list[str]:
        return [t.name for t in self._decls]

    def write(self, name: str, data: bytes | memoryview) -> None:
        """Append bytes for ``name``; a tensor may be written in several calls."""
        if self._fh is None:
            raise ValueError("writer already closed")
        if self._index >= len(self._decls):
            raise ValueError("all tensors already written")
        current = self._decls[self._index]
        if current.name != name:
            raise ValueError(f"tensors must be written in name order: expected {current.name}, got {name}")
        view = memoryview(data).cast("B")
        if self._written_in_current + view.nbytes > current.nbytes:
            raise ValueError(f"{name}: more bytes than declared ({current.nbytes})")
        self._fh.write(view)
        self._written_in_current += view.nbytes
        if self._written_in_current == current.nbytes:
            self._index += 1
            self._written_in_current = 0

    def close(self) -> Path:
        if self._fh is None:
            return self.path
        complete = self._index == len(self._decls)
        self._fh.flush()
        os.fsync(self._fh.fileno())
        self._fh.close()
        self._fh = None
        if not complete:
            missing = self.expected_order[self._index :]
            self.path.unlink(missing_ok=True)
            raise ValueError(f"safetensors payload incomplete; missing {missing}")
        return self.path

    def abort(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        self.path.unlink(missing_ok=True)

    def __enter__(self) -> SafetensorsStreamWriter:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc_type is not None:
            self.abort()
        else:
            self.close()


def write_payload(
    path: str | Path, tensors: Iterable[tuple[TensorDecl, bytes]], metadata: Mapping[str, str] | None = None
) -> Path:
    items = list(tensors)
    with SafetensorsStreamWriter(path, [d for d, _ in items], metadata) as writer:
        for decl, raw in sorted(items, key=lambda item: item[0].name):
            writer.write(decl.name, raw)
    return Path(path)


@dataclass(frozen=True)
class BundleIdentity:
    """Identity fields every tensor bundle manifest carries (tensor-bundle.schema.json)."""

    model_digest: str
    adapter_digest: str
    plan_digest: str
    stage_id: str
    normalization_config_digest: str


def _payload_ref(path: Path) -> dict[str, Any]:
    digest, size = file_sha256(path)
    return {
        "artifact_id": f"sha256:{digest}",
        "sha256": digest,
        "size_bytes": size,
        "media_type": media_types.SAFETENSORS,
    }


def _check_payload(path: Path, decls: Sequence[TensorDecl]) -> list[dict[str, Any]]:
    header = read_header_from_file(path)
    layouts = {d.name: d.layout for d in decls}
    specs = tensor_specs(header, layouts)
    declared = {d.name: d for d in decls}
    if set(declared) != set(header.tensors):
        raise IntegrityMismatch(
            "PAYLOAD_TENSOR_SET", f"payload tensors {sorted(header.tensors)} ≠ declared {sorted(declared)}"
        )
    for spec in specs:
        decl = declared[spec["name"]]
        if spec["dtype"] != decl.dtype or tuple(spec["shape"]) != tuple(decl.shape):
            raise IntegrityMismatch("PAYLOAD_TENSOR_MISMATCH", f"{spec['name']}: header {spec} ≠ declared {decl}")
    return specs


def finalize_tensor_bundle(
    output_dir: Path,
    output_name: str,
    payload_path: Path,
    decls: Sequence[TensorDecl],
    *,
    kind: str,
    identity: BundleIdentity,
    metadata: Mapping[str, Any],
    is_fixture: bool = False,
) -> tuple[list[OutputFile], dict[str, Any]]:
    """Verify a written payload, write its manifest, return the OutputFiles."""
    specs = _check_payload(payload_path, decls)
    embedded = read_header_from_file(payload_path).metadata.get(METADATA_KEY)
    if embedded is None or canonical_digest(json.loads(embedded)) != canonical_digest(dict(metadata)):
        raise IntegrityMismatch(
            "BUNDLE_METADATA_NOT_EMBEDDED", "payload __metadata__ 未嵌入與 manifest 相同的 metadata"
        )
    manifest = {
        "schema_version": "1.0",
        "kind": kind,
        "is_fixture": is_fixture,
        "payload": _payload_ref(payload_path),
        "model_digest": identity.model_digest,
        "adapter_digest": identity.adapter_digest,
        "plan_digest": identity.plan_digest,
        "stage_id": identity.stage_id,
        "normalization_config_digest": identity.normalization_config_digest,
        "tensors": specs,
        "metadata_digest": canonical_digest(dict(metadata)),
    }
    issues = validate(manifest, "tensor-bundle.schema.json")
    if issues:
        raise IntegrityMismatch(
            "TENSOR_BUNDLE_SCHEMA", f"tensor-bundle manifest 不合法：{issues[0].field_path} {issues[0].message}"
        )
    problems = verify_tensor_specs(manifest, read_header_from_file(payload_path))
    if problems:
        raise IntegrityMismatch("TENSOR_BUNDLE_SPECS", "; ".join(problems))
    manifest_path = output_dir / f"{output_name}.json"
    manifest_path.write_bytes(canonical_json_bytes(manifest))
    return (
        [
            OutputFile(
                name=output_name, path=manifest_path, media_type=media_types.TENSOR_BUNDLE, kind="tensor_bundle"
            ),
            OutputFile(
                name=f"{output_name}{PAYLOAD_SUFFIX}",
                path=payload_path,
                media_type=media_types.SAFETENSORS,
                kind="tensor_bundle",
            ),
        ],
        manifest,
    )


def finalize_conditioning_bundle(
    output_dir: Path,
    output_name: str,
    payload_path: Path,
    decls: Sequence[TensorDecl],
    *,
    text_len: int,
    identity_fields: Mapping[str, str],
    max_tokens: int,
    is_fixture: bool = False,
) -> tuple[list[OutputFile], dict[str, Any]]:
    """Write and self-verify an ``h3_conditioning`` bundle."""
    specs = _check_payload(payload_path, decls)
    manifest = {
        "schema_version": "1.0",
        "kind": "h3_conditioning",
        "is_fixture": is_fixture,
        "payload": _payload_ref(payload_path),
        **{
            key: identity_fields[key]
            for key in (
                "encoder_revision",
                "tokenizer_digest",
                "processor_digest",
                "prepared_inputs_digest",
                "presentation_digest",
                "geometry_digest",
                "quant_profile_digest",
                "runtime_fingerprint",
            )
        },
        "tap": {"hidden_states_index": 50, "final_norm_applied": False, "use_cache": False, "hidden_size": 5120},
        "text_len": int(text_len),
        "tensors": specs,
    }
    issues = validate(manifest, "conditioning-bundle.schema.json")
    if issues:
        raise EncoderContractMismatch(
            "CONDITIONING_SCHEMA", f"conditioning manifest 不合法：{issues[0].field_path} {issues[0].message}"
        )
    problems = verify_conditioning_bundle(manifest, payload_path.read_bytes(), max_tokens=max_tokens)
    if problems:
        raise EncoderContractMismatch("CONDITIONING_SELF_CHECK", "; ".join(problems))
    manifest_path = output_dir / f"{output_name}.json"
    manifest_path.write_bytes(canonical_json_bytes(manifest))
    return (
        [
            OutputFile(
                name=output_name, path=manifest_path, media_type=media_types.CONDITIONING_BUNDLE, kind="tensor_bundle"
            ),
            OutputFile(
                name=f"{output_name}{PAYLOAD_SUFFIX}",
                path=payload_path,
                media_type=media_types.SAFETENSORS,
                kind="tensor_bundle",
            ),
        ],
        manifest,
    )


def write_metadata_output(output_dir: Path, output_name: str, document: Mapping[str, Any]) -> OutputFile:
    path = output_dir / f"{output_name}.json"
    path.write_bytes(canonical_json_bytes(dict(document)))
    return OutputFile(name=output_name, path=path, media_type=media_types.METADATA, kind="metadata")


def load_bundle_manifest(path: Path, *, conditioning: bool = False) -> dict[str, Any]:
    from .errors import InvalidStageInput

    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise InvalidStageInput("BUNDLE_MANIFEST_UNREADABLE", f"{path}: {exc}") from exc
    schema = "conditioning-bundle.schema.json" if conditioning else "tensor-bundle.schema.json"
    issues = validate(doc, schema)
    if issues:
        raise InvalidStageInput(
            "BUNDLE_MANIFEST_INVALID", f"{Path(path).name}: {issues[0].field_path} {issues[0].message}"
        )
    return doc


def resolve_payload(manifest: Mapping[str, Any], attachments: Mapping[str, Path]) -> Path:
    """Locate and hash-verify the payload a manifest references."""
    from .errors import InvalidStageInput

    ref = manifest["payload"]
    path = attachments.get(ref["artifact_id"])
    if path is None:
        raise InvalidStageInput("PAYLOAD_ATTACHMENT_MISSING", f"缺少 payload 附件 {ref['artifact_id']}")
    digest, size = file_sha256(path)
    if digest != ref["sha256"] or size != ref["size_bytes"] or ref["artifact_id"] != f"sha256:{digest}":
        raise IntegrityMismatch(
            "PAYLOAD_HASH_MISMATCH",
            f"payload {ref['artifact_id']} 與檔案內容不符",
            expected=ref["sha256"],
            actual=digest,
        )
    problems = verify_tensor_specs(manifest, read_header_from_file(path))
    if problems:
        raise IntegrityMismatch("PAYLOAD_SPECS_MISMATCH", "; ".join(problems))
    return Path(path)


def bytes_digest(data: bytes) -> str:
    return artifact_ref(data, "application/octet-stream")["sha256"]


__all__ = [
    "METADATA_KEY",
    "PAYLOAD_SUFFIX",
    "BundleIdentity",
    "SafetensorsStreamWriter",
    "TensorDecl",
    "bytes_digest",
    "finalize_conditioning_bundle",
    "finalize_tensor_bundle",
    "load_bundle_manifest",
    "payload_metadata",
    "read_bundle_metadata",
    "resolve_payload",
    "write_metadata_output",
    "write_payload",
]
