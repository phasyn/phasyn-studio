"""Small value helpers shared by the adapter rules, the runtime stages and plan building."""

from __future__ import annotations

import copy
import re
from collections.abc import Mapping
from typing import Any

UINT64_MAX = 18_446_744_073_709_551_615
_SEED = re.compile(r"^(0|[1-9][0-9]{0,19})$")


def parse_seed(text: object) -> int:
    """canonical decimal uint64 string -> int (no precision loss)."""
    if not isinstance(text, str) or not _SEED.match(text):
        raise ValueError("seed 必須是十進位 uint64 字串（無前導零、無符號）")
    value = int(text)
    if value > UINT64_MAX:
        raise ValueError("seed 超過 2^64-1")
    return value


def get_path(doc: Mapping[str, Any], path: str, default: Any = None) -> Any:
    node: Any = doc
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return default
        node = node[part]
    return node


def set_path(doc: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    node = doc
    for part in parts[:-1]:
        nxt = node.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            node[part] = nxt
        node = nxt
    node[parts[-1]] = value


def deep_merge(base: Mapping[str, Any], overlay: Mapping[str, Any]) -> dict[str, Any]:
    """Objects merge recursively, arrays replace wholesale, an explicit null replaces
    (only legal on nullable fields — checked by the schema)."""
    out = copy.deepcopy(dict(base))
    for key, value in overlay.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), Mapping):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


__all__ = ["UINT64_MAX", "deep_merge", "get_path", "parse_seed", "set_path"]
