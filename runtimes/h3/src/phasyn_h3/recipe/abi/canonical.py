"""Canonical JSON and digests.

UTF-8, keys sorted, no whitespace, no NaN/Infinity, text kept verbatim (no
implicit Unicode normalization).  The backend canonicalizer is the only plan
digest producer; the frontend never recomputes plan digests.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

SHA256_HEX_LENGTH = 64


def canonical_json_bytes(value: Any) -> bytes:
    """Serialize ``value`` canonically; raises ValueError on NaN/Infinity."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_digest(value: Any) -> str:
    """Lower-case SHA-256 hex of the canonical JSON form."""
    return sha256_hex(canonical_json_bytes(value))


def artifact_id_for(sha256: str) -> str:
    return f"sha256:{sha256}"


def artifact_ref(data: bytes, media_type: str) -> dict[str, Any]:
    """Build an artifact-ref document for an in-memory payload."""
    digest = sha256_hex(data)
    return {
        "artifact_id": artifact_id_for(digest),
        "sha256": digest,
        "size_bytes": len(data),
        "media_type": media_type,
    }


def is_sha256_hex(value: object) -> bool:
    return isinstance(value, str) and len(value) == SHA256_HEX_LENGTH and all(c in "0123456789abcdef" for c in value)
