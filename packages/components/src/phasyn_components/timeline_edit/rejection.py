"""The typed refusal of a timeline edit: a stable reason for programs and a sentence for people."""

from __future__ import annotations

from typing import Any, NoReturn

from ..errors import ComponentError

REJECTED_CODE = "STUDIO_TIMELINE_REJECTED"


class TimelineRejected(Exception):
    """An edit that would break the document or that its own rules refuse. Nothing was changed.

    ``reason`` is one of ``StudioTimelineRejection.reason`` in the contract; ``message`` is Traditional
    Chinese and safe to show; ``details`` carries facts (ids, frames) and never a path or a stack.
    """

    def __init__(self, reason: str, message: str, **details: Any) -> None:
        super().__init__(f"{reason}: {message}")
        self.reason = reason
        self.message = message
        self.details = details

    def to_error(self, *, command_index: int | None = None) -> ComponentError:
        """The wire error (422 ``STUDIO_TIMELINE_REJECTED``), naming the refused command when there is one."""
        details: dict[str, Any] = {"reason": self.reason, **self.details}
        if command_index is not None:
            details["command_index"] = command_index
        return ComponentError(REJECTED_CODE, self.message, details=details)


def reject(reason: str, message: str, **details: Any) -> NoReturn:
    raise TimelineRejected(reason, message, **details)


def rejection_of(error: ComponentError) -> TimelineRejected:
    """A validator refusal (``INVALID_ARGUMENT`` with ``details.reason``) as a typed rejection."""
    details = {key: value for key, value in error.details.items() if key != "reason"}
    return TimelineRejected(str(error.details.get("reason") or "invalid_document"), error.message, **details)


__all__ = ["REJECTED_CODE", "TimelineRejected", "reject", "rejection_of"]
