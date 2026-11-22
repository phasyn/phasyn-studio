"""Validation and formatting helpers shared by the pure media modules (effects, scenes, soundtrack)."""

from __future__ import annotations

import math
from typing import Any, TypeGuard

from .errors import MediaError


def invalid(path: str, message: str) -> MediaError:
    """``INVALID_ARGUMENT`` for the field at ``path`` (the path is both in the message and the field paths)."""
    return MediaError("INVALID_ARGUMENT", f"{path}：{message}", field_paths=[path])


def number(value: Any, path: str, lo: float, hi: float) -> float:
    """A finite number within ``[lo, hi]`` (``bool`` is not a number here)."""
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
    ):
        raise invalid(path, "必須是數字")
    if not lo <= value <= hi:
        raise invalid(path, f"必須在 {lo:g}\u2013{hi:g} 之間（目前 {value:g}）")
    return float(value)


def filter_number(value: float) -> str:
    """A number for an FFmpeg filtergraph: six decimals at most, no trailing zeros (``0`` for zero)."""
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


__all__ = ["filter_number", "invalid", "number"]


def integer_value(value: object) -> TypeGuard[int]:
    """Recognize a runtime integer excluding booleans."""
    return isinstance(value, int) and not isinstance(value, bool)


def numeric_value(value: object) -> TypeGuard[int | float]:
    """Recognize a runtime real scalar excluding booleans."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)
