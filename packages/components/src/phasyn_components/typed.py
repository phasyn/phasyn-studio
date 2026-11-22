"""TypedValue 與 FileRef 的局部檢查.

只檢查 wire 結構、inline 大小與 metadata 大小；型別語意（shape／latent space）由 consumer
元件自行檢查，不在這裡猜轉換。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import contracts
from .canonical import canonical_json
from .errors import ComponentError


INLINE_MAX_BYTES = 256 * 1024
FILEREF_METADATA_MAX_BYTES = 64 * 1024
LINKS_KEY = "links"


def check_typed_value(value: Any, *, where: str) -> dict[str, Any]:
    """Validate a typed input or output value."""
    contracts.validate("TypedValue", value, what=where)
    if "value" in value:
        size = len(canonical_json(value["value"]))
        if size > INLINE_MAX_BYTES:
            raise ComponentError(
                "INPUT_TOO_LARGE",
                f"{where} 的 inline JSON 為 {size} bytes，超過 256 KiB；大內容必須用 FileRef",
                details={"bytes": size, "limit": INLINE_MAX_BYTES},
            )
    else:
        check_fileref(value["file"], where=where)
    return dict(value)


def check_fileref(ref: Any, *, where: str) -> dict[str, Any]:
    """Validate an immutable file reference."""
    contracts.validate("FileRef", ref, what=where)
    meta_size = len(canonical_json(ref.get("metadata") or {}))
    if meta_size > FILEREF_METADATA_MAX_BYTES:
        raise ComponentError(
            "INPUT_TOO_LARGE",
            f"{where} 的 FileRef.metadata 為 {meta_size} bytes；metadata 只放 shape／layout 等小資料，禁止 base64 tensor",
            details={"bytes": meta_size, "limit": FILEREF_METADATA_MAX_BYTES},
        )
    for name, link in file_links(ref).items():
        contracts.validate("FileRef", link, what=f"{where}.metadata.links.{name}")
    return dict(ref)


def is_fileref(value: Any) -> bool:
    """Check whether the value is a valid file reference."""
    return isinstance(value, Mapping) and {
        "node_id",
        "file_id",
        "sha256",
        "size_bytes",
    } <= set(value)


def file_links(ref: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """FileRef.metadata.links：同一份產物附帶的其他已發布檔（例如 latent manifest 的 blob）."""
    links = (ref.get("metadata") or {}).get(LINKS_KEY) or {}
    if not isinstance(links, Mapping):
        return {}
    return {str(k): dict(v) for k, v in links.items() if is_fileref(v)}


__all__ = [
    "FILEREF_METADATA_MAX_BYTES",
    "INLINE_MAX_BYTES",
    "LINKS_KEY",
    "check_fileref",
    "check_typed_value",
    "file_links",
    "is_fileref",
]
