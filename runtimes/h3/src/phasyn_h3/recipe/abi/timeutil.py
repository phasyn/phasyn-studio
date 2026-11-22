"""UTC RFC3339 timestamps; local wall clock is only for display/logging."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta


_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


def utc_now() -> datetime:
    """Return the current timezone-aware UTC time."""
    return datetime.now(UTC)


def to_rfc3339(moment: datetime) -> str:
    """Format as fixed-width ``YYYY-MM-DDTHH:MM:SS.ffffffZ`` (contract TS pattern).

    Fixed width keeps lexicographic order equal to chronological order, which
    the SQLite store relies on for TEXT timestamp comparisons.
    """
    if moment.tzinfo is None:
        raise ValueError("naive datetime is not allowed; use UTC")
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def now_rfc3339() -> str:
    """Return the current UTC time as an RFC 3339 timestamp."""
    return to_rfc3339(utc_now())


def _valid_utc_string(value: object) -> bool:
    return isinstance(value, str) and bool(_RFC3339.match(value))


def parse_rfc3339(value: str) -> datetime:
    """Parse a UTC timestamp in the supported RFC 3339 format."""
    if not _valid_utc_string(value):
        raise ValueError(f"not an RFC3339 UTC timestamp: {value!r}")
    text = value[:-1]
    if "." in text:
        head, frac = text.split(".", 1)
        frac = (frac + "000000")[:6]
        text = f"{head}.{frac}"
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%f").replace(tzinfo=UTC)
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)


def rfc3339_after(seconds: float, *, start: datetime | None = None) -> str:
    """Format a UTC timestamp offset by the requested number of seconds."""
    return to_rfc3339((start or utc_now()) + timedelta(seconds=seconds))
