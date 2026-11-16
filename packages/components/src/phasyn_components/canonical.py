"""Canonical JSON and SHA-256 helpers. Metadata never allows NaN or Infinity."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .errors import ComponentError
from .fs import atomic_write_json  # re-exported: the historical home of the atomic JSON writer


def canonical_json(obj: Any) -> bytes:
    try:
        return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode(
            "utf-8"
        )
    except ValueError as exc:  # NaN/Infinity
        raise ComponentError("INVALID_ARGUMENT", f"JSON 不允許 NaN 或 Infinity：{exc}") from exc


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(obj: Any) -> str:
    return sha256_hex(canonical_json(obj))


def dumps(obj: Any) -> str:
    """一般輸出（排版不重要但不得含 NaN）。"""
    return json.dumps(obj, ensure_ascii=False, allow_nan=False)


def read_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


__all__ = ["atomic_write_json", "canonical_json", "digest", "dumps", "read_json", "sha256_hex"]
