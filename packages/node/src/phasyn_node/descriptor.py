"""Pieces of the public ``ComponentDescriptor`` that do not depend on a live instance.

A provider's ``describe`` output is untrusted input: ports and parts are normalised (unknown values fall back
to safe defaults, long strings are cut) and facts are size-checked before they reach the catalog.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any, Literal

from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError
from phasyn_components.ids import is_local_id
from phasyn_components.provider import FACTS_MAX_BYTES


ComponentState = Literal["stopped", "loading", "ready", "busy", "stopping", "error"]
RecorderState = Literal["off", "unknown", "degraded", "ok"]

PORT_TRANSPORTS = ("inline", "file", "either")
PART_COVERAGE = ("full", "partial", "none")
TEXT_MAX = 16000


def ports(items: Any) -> list[dict[str, Any]]:
    """Return the advertised port definitions."""
    out: list[dict[str, Any]] = []
    for port in items or []:
        if (
            not isinstance(port, Mapping)
            or not is_local_id(port.get("name"))
            or not is_local_id(port.get("type_id"))
        ):
            continue
        transport = port.get("transport")
        out.append(
            {
                "name": str(port["name"]),
                "type_id": str(port["type_id"]),
                "required": bool(port.get("required", True)),
                "transport": transport if transport in PORT_TRANSPORTS else "either",
                "description": str(port.get("description") or "")[:TEXT_MAX],
            }
        )
    return out


def parts(items: Any) -> list[dict[str, Any]]:
    """Return the advertised component part definitions."""
    out: list[dict[str, Any]] = []
    for part in items or []:
        if not isinstance(part, Mapping) or not part.get("path"):
            continue
        schema = part.get("settings_schema")
        coverage = part.get("coverage")
        reason = part.get("reason")
        out.append(
            {
                "path": str(part["path"])[:TEXT_MAX],
                "kind": str(part.get("kind") or "part")[:TEXT_MAX],
                "settings_schema": dict(schema) if isinstance(schema, Mapping) else {},
                "observable": [
                    str(x)[:TEXT_MAX]
                    for x in (part.get("observable") or [])
                    if isinstance(x, str)
                ],
                "coverage": coverage if coverage in PART_COVERAGE else "full",
                "reason": None if reason is None else str(reason)[:TEXT_MAX],
            }
        )
    return out


def facts(value: Any) -> dict[str, Any] | None:
    """The provider's describe ``facts`` for the full ComponentDescriptor (never the Lite one).

    Always present in a descriptor: ``None`` when the provider reported none (an empty object), or when what it
    reported is not a JSON object of at most :data:`FACTS_MAX_BYTES` canonical bytes.
    """
    if not isinstance(value, Mapping) or not value:
        return None
    try:
        size = len(canonical_json(dict(value)))
    except (ComponentError, TypeError, ValueError):  # NaN/Infinity or not JSON at all
        return None
    return copy.deepcopy(dict(value)) if size <= FACTS_MAX_BYTES else None


def normalize_error(
    doc: Any, *, default_code: str, default_message: str
) -> dict[str, Any]:
    """A runtime-reported error as a contract Error (a default when the runtime gave none)."""
    if isinstance(doc, Mapping) and doc.get("code"):
        return ComponentError.from_dict(doc).to_dict()
    return ComponentError(default_code, default_message).to_dict()


def recorder_state_of(mode: str, summary: Mapping[str, Any] | None) -> RecorderState:
    """Resolve recorder status from mode and the latest summary."""
    if mode == "off":
        return "off"
    if summary is None:
        return "unknown"
    notes = summary.get("notes") or []
    if any(isinstance(n, str) and n.startswith("RECORDER_DEGRADED") for n in notes):
        return "degraded"
    return "ok"


__all__ = [
    "ComponentState",
    "RecorderState",
    "facts",
    "normalize_error",
    "parts",
    "ports",
    "recorder_state_of",
]
