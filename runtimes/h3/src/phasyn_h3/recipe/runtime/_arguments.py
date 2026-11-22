"""Validate closed keyword options at Python call boundaries."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def validate_keywords(options: Mapping[str, object], schema: Any) -> None:
    """Reject missing and unknown arguments before starting any work."""
    missing = schema.__required_keys__.difference(options)
    unexpected = options.keys() - schema.__annotations__.keys()
    if missing:
        raise TypeError(
            f"Missing required keyword arguments: {', '.join(sorted(missing))}"
        )
    if unexpected:
        raise TypeError(
            f"Unexpected keyword arguments: {', '.join(sorted(unexpected))}"
        )
