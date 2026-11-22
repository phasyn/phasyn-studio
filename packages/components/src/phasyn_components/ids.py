"""識別字：UUID 與本地 ID。ID 只作關聯，不具任何授權語意."""

from __future__ import annotations

import re
import uuid

from .errors import ComponentError


LOCAL_ID_RE = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_.:-]*"
)  # use fullmatch: "$" would accept a trailing newline
LOCAL_ID_MAX = 160


def new_id() -> str:
    """Generate a new UUID."""
    return str(uuid.uuid4())


def is_uuid(value: object) -> bool:
    """Check whether a value is a UUID."""
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def require_uuid(value: object, field: str) -> str:
    """Validate and return a UUID."""
    if not is_uuid(value):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"{field} 必須是 UUID：{value!r}",
            details={"field": field},
        )
    return str(value).lower()


def is_local_id(value: object) -> bool:
    """Check whether a name is a valid local identifier."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= LOCAL_ID_MAX
        and bool(LOCAL_ID_RE.fullmatch(value))
    )


def require_local_id(value: object, field: str) -> str:
    """Validate and return a local identifier."""
    if not is_local_id(value):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"{field} 只能使用英數字與 _ . : -，且以英數字開頭（≤160 字）：{value!r}",
            details={"field": field},
        )
    return str(value)


__all__ = [
    "LOCAL_ID_RE",
    "is_local_id",
    "is_uuid",
    "new_id",
    "require_local_id",
    "require_uuid",
]
