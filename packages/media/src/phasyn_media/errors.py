"""Media errors: the shared code taxonomy plus the media-specific ``MEDIA_TOOL_FAILED`` and ``CANCELLED``.

Every media code is also registered in :data:`phasyn_components.errors.ERROR_CODES`.
:class:`MediaCanceled` is a :class:`phasyn_components.errors.Cancelled`, so component processes and
the H3 recipe treat it as a cancellation. Messages are Traditional Chinese (i18n-keyed) and never
carry secrets; tool stderr is bounded and local paths are replaced by placeholders.

A *cancel signal* is anything with ``is_set()`` (``threading.Event``, ``RunContext.cancel_token``)
or a zero-argument callable returning ``bool``; :func:`cancel_requested` is the one place that reads it.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from phasyn_components.errors import Cancelled

# code -> 預設是否可單獨重試（只是描述；本產品不自動重試）
MEDIA_ERROR_CODES: dict[str, bool] = {
    "INVALID_ARGUMENT": False,
    "UNSUPPORTED_COMBINATION": False,
    "INTEGRITY_MISMATCH": False,
    "ENCODER_CONTRACT_MISMATCH": False,
    "RESOURCE_EXHAUSTED": False,
    "MEDIA_TOOL_FAILED": True,
    "MEDIA_INCOMPLETE": False,
    "CANCELLED": False,
}


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


class MediaError(Exception):
    """帶 taxonomy code 與繁中訊息的媒體失敗。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        field_paths: Iterable[str] = (),
        retryable: bool | None = None,
        expected: Any = None,
        actual: Any = None,
    ) -> None:
        if code not in MEDIA_ERROR_CODES:
            raise ValueError(f"unknown media error code: {code}")
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.field_paths: tuple[str, ...] = tuple(field_paths)
        self.retryable = MEDIA_ERROR_CODES[code] if retryable is None else bool(retryable)
        self.expected = None if expected is None else str(expected)
        self.actual = None if actual is None else str(actual)

    @property
    def error_code(self) -> str:
        return self.code


class MediaCanceled(MediaError, Cancelled):
    """A cancel request observed at a safe boundary (code ``CANCELLED``)."""

    def __init__(self, message: str = "已要求取消") -> None:
        MediaError.__init__(self, "CANCELLED", message)


def cancel_requested(cancel: Any) -> bool:
    """True when the cancel signal (``is_set()`` object or callable; ``None`` = never) is set."""
    if cancel is None:
        return False
    if hasattr(cancel, "is_set"):
        return bool(cancel.is_set())
    return bool(cancel())


def raise_if_canceled(cancel: Any, what: str = "媒體處理") -> None:
    if cancel_requested(cancel):
        reason = getattr(cancel, "reason", "") or ""
        raise MediaCanceled(f"{what}已取消" + (f"：{reason}" if reason else ""))
