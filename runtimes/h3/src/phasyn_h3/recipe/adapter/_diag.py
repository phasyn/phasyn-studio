"""Small diagnostic helpers (diagnostic.schema.json documents, 繁中訊息)."""

from __future__ import annotations

import copy
from collections.abc import Iterable, Mapping
from typing import Any

from phasyn_h3.recipe.abi.errors import diagnostic

INVALID = "INVALID_ARGUMENT"
UNSUPPORTED = "UNSUPPORTED_COMBINATION"


def err(code: str, message: str, *paths: str, expected: Any = None, actual: Any = None) -> dict[str, Any]:
    return diagnostic(
        code,
        message,
        field_paths=[p for p in paths if p],
        severity="error",
        expected=None if expected is None else str(expected),
        actual=None if actual is None else str(actual),
    )


def warn(code: str, message: str, *paths: str) -> dict[str, Any]:
    return diagnostic(code, message, field_paths=[p for p in paths if p], severity="warning")


def info(code: str, message: str, *paths: str) -> dict[str, Any]:
    return diagnostic(code, message, field_paths=[p for p in paths if p], severity="info")


def errors(diagnostics: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [dict(d) for d in diagnostics if d.get("severity") == "error"]


def non_errors(diagnostics: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [dict(d) for d in diagnostics if d.get("severity") != "error"]


def prefixed(diagnostics: Iterable[Mapping[str, Any]], prefix: str) -> list[dict[str, Any]]:
    """Re-root field paths (e.g. profile-relative -> ``profile.<path>``)."""
    out = []
    for d in diagnostics:
        doc = copy.deepcopy(dict(d))
        doc["field_paths"] = [
            (p if p.startswith(prefix + ".") else f"{prefix}.{p}")[:512] for p in doc.get("field_paths", [])
        ]
        out.append(doc)
    return out
