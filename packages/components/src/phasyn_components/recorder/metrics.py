"""Metric 建構：每個值帶 unit／quality／scope／method／reason；未知為 null，不是 0."""

from __future__ import annotations

import math
from typing import Any

from ..contracts import metric_catalog


QUALITIES = (
    "instrumented",
    "sampled",
    "trace",
    "derived",
    "unavailable",
    "not_applicable",
    "synthetic",
)


def catalog_entry(name: str) -> dict[str, Any] | None:
    """Look up the canonical metric definition."""
    try:
        return metric_catalog().get(name)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError):
        return None


def _numeric_value(value: object) -> object:
    return int(value) if isinstance(value, bool) else value


def metric(  # noqa: PLR0913 - Keep the published positional and keyword API.
    name: str,
    value: float | None,
    *,
    quality: str = "instrumented",
    unit: str | None = None,
    scope: str | None = None,
    method: str | None = None,
    reason: str | None = None,
    count: int | None = None,
) -> dict[str, Any]:
    """依 metric catalog 補 unit／scope／method；value 非有限數一律轉 null 並附原因."""
    if quality not in QUALITIES:
        raise ValueError(f"invalid quality {quality}")
    entry = catalog_entry(name) or {}
    if isinstance(value, float) and not math.isfinite(value):
        value, reason, quality = None, reason or "非有限數值不輸出", "unavailable"
    if value is None and reason is None:
        reason = "未量測" if quality != "not_applicable" else "不適用於此元件"
    if value is not None and quality in ("unavailable", "not_applicable"):
        quality = "instrumented"
    out: dict[str, Any] = {
        "value": _numeric_value(value),
        "unit": unit or str(entry.get("unit") or ""),
        "quality": quality,
        "scope": scope or str(entry.get("scope") or ""),
        "method": method or str(entry.get("method") or ""),
        "reason": reason,
    }
    if count is not None:
        out["count"] = max(0, int(count))
    return out


def unavailable(name: str, reason: str, **kw: Any) -> dict[str, Any]:
    """Build an unavailable metric with its evidence."""
    return metric(name, None, quality="unavailable", reason=reason, **kw)


def not_applicable(name: str, reason: str, **kw: Any) -> dict[str, Any]:
    """Build a metric that does not apply to this operation."""
    return metric(name, None, quality="not_applicable", reason=reason, **kw)


__all__ = ["QUALITIES", "catalog_entry", "metric", "not_applicable", "unavailable"]
