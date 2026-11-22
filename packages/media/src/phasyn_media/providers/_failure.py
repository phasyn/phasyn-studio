"""Mapping media failures onto the component error contract (shared by the CPU media providers)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from phasyn_components.errors import Cancelled, ComponentError

from ..errors import MediaError


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext

# phasyn_media taxonomy -> component error codes (anything else is a tool failure)
_CODES = {
    "INVALID_ARGUMENT": "INVALID_ARGUMENT",
    "UNSUPPORTED_COMBINATION": "UNSUPPORTED_SETTING",
    "RESOURCE_EXHAUSTED": "INPUT_TOO_LARGE",
    "INTEGRITY_MISMATCH": "MEDIA_INCOMPLETE",
    "MEDIA_INCOMPLETE": "MEDIA_INCOMPLETE",
}


def media_failure(ctx: RunContext, exc: MediaError, *, what: str) -> ComponentError:
    """The component error for a failed media step, prefixed with ``what``.

    A cancelled step raises instead of returning: past the call deadline it is ``CALL_TIMEOUT``,
    otherwise :class:`~phasyn_components.errors.Cancelled` (a user cancel).
    """
    if exc.code == "CANCELLED":
        ctx.check_cancelled()
        raise Cancelled(exc.message)
    details = {"field_paths": list(exc.field_paths)} if exc.field_paths else None
    return ComponentError(
        _CODES.get(exc.code, "MEDIA_TOOL_FAILED"),
        f"{what}：{exc.message}",
        details=details,
    )


__all__ = ["media_failure"]
