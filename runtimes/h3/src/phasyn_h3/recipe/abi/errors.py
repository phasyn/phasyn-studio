"""Recipe diagnostics and the plan-time rule errors (messages are Traditional Chinese; no secrets or prompts).

Diagnostics are small documents (``code``, ``message``, ``field_paths``, ``severity``) that stages and rules
return; the component layer (``phasyn_h3.host``, ``phasyn_h3.plan``) turns them into ``ComponentError``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def diagnostic(
    code: str,
    message: str,
    *,
    field_paths: list[str] | tuple[str, ...] = (),
    severity: str = "error",
    retryable: bool = False,
    expected: str | None = None,
    actual: str | None = None,
) -> dict[str, Any]:
    """A diagnostic document (bounded message and field paths)."""
    doc: dict[str, Any] = {
        "code": code,
        "message": message[:2048],
        "field_paths": [p[:512] for p in field_paths][:20],
        "severity": severity,
        "retryable": retryable,
    }
    if expected is not None:
        doc["expected"] = str(expected)[:2048]
    if actual is not None:
        doc["actual"] = str(actual)[:2048]
    return doc


@dataclass
class ApiError(Exception):
    """A rule error carrying the first failing field path and the full diagnostic list."""

    code: str
    message: str
    field_path: str | None = None
    details: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        Exception.__init__(self, f"{self.code}: {self.message}")


class SemanticError(ApiError):
    """Raised by the adapter rules when a request is schema-valid but illegal."""

    def __init__(self, diagnostics: list[dict[str, Any]], message: str = "設定組合不合法") -> None:
        first = diagnostics[0] if diagnostics else {}
        field_paths = first.get("field_paths") or [None]
        code = (
            "UNSUPPORTED_COMBINATION"
            if any(d.get("code") == "UNSUPPORTED_COMBINATION" for d in diagnostics)
            else "INVALID_ARGUMENT"
        )
        super().__init__(code=code, message=message, field_path=field_paths[0], details=diagnostics)


__all__ = ["ApiError", "SemanticError", "diagnostic"]
