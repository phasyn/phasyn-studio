"""Optimistic concurrency of the controller's documents (Studio projects, prompt studies, the prompt library and
the pipeline layout).

A write names the revision it read (0 when the document was never saved). On a match the document is saved
with revision + 1; otherwise the answer is 409 REVISION_CONFLICT and nothing is merged, overwritten or retried:
the client reloads and the user decides. The caller holds its store's lock around the check and the write (one
controller process is the only writer).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components.errors import ComponentError


def stored_revision(doc: Mapping[str, Any] | None) -> int:
    """The revision of a stored document (0 when there is none)."""
    return int(doc["revision"]) if doc else 0


def require_revision(stored: int, expected: Any, *, what: str, suffix: str) -> int:
    """``stored`` when the writer read it; otherwise 409 REVISION_CONFLICT.

    ``what`` names the document and ``suffix`` tells the user what to do; both are message fragments.
    """
    if int(expected) != stored:
        raise ComponentError(
            "REVISION_CONFLICT",
            f"{what}已在其他地方更新（目前 revision {stored}，送出時為 {expected}）；{suffix}",
            details={"stored_revision": stored, "expected_revision": expected},
        )
    return stored


def saved_form(body: Mapping[str, Any], current: Mapping[str, Any] | None, *, now: str) -> dict[str, Any]:
    """An accepted save of a document with ``created_at``: revision + 1, ``updated_at`` now, ``created_at`` kept."""
    doc = dict(body)
    doc["revision"] = stored_revision(current) + 1
    doc["updated_at"] = now
    doc["created_at"] = current["created_at"] if current else body.get("created_at") or now
    return doc


__all__ = ["require_revision", "saved_form", "stored_revision"]
