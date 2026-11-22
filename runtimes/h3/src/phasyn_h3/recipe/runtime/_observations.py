"""Capture optional runtime measurements and loader failures for the actor's structured report."""

from __future__ import annotations

from types import TracebackType
from typing import Self


class RuntimeObservation:
    """Retain an exception from a backend call while preserving process and cancellation signals."""

    def __init__(self, *propagate: type[Exception]) -> None:
        """Specify exceptions that must reach the caller's normal error handler."""
        self.error: Exception | None = None
        self._propagate = propagate

    def __enter__(self) -> Self:
        """Begin a single observation."""
        return self

    def __exit__(
        self,
        _kind: type[BaseException] | None,
        error: BaseException | None,
        _traceback: TracebackType | None,
    ) -> bool:
        """Capture ordinary backend exceptions except the explicitly propagated classes."""
        if isinstance(error, Exception) and not isinstance(error, self._propagate):
            self.error = error
            return True
        return False

    def failure(self) -> Exception:
        """Retrieve the failure when a successful operation would have returned from its caller."""
        if self.error is None:
            raise RuntimeError("The backend call completed without an exception")
        return self.error
