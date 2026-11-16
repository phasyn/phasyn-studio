"""Query parsing and export responses of the recording routes served by both the controller and the Node.

``GET /api/recordings`` (filters, cursor, limit), ``GET /api/recordings/{id}/events`` (stream_id, after_seq,
limit) and ``GET /api/recordings/{id}/export`` (format, repeatable ``redact``) share one parameter policy. Exports are always streamed; with ``redact`` the export replaces
hostnames, device ids, prompts and/or paths (``all`` = every category).
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from phasyn_components.records import export
from phasyn_components.records.store import MAX_EVENTS, MAX_PAGE, RecordingStore
from starlette.datastructures import QueryParams
from starlette.responses import StreamingResponse

from .http import MAX_SAFE_INT, attachment, query_int

RECORDING_FILTERS = (
    "node_id",
    "component_id",
    "provider_id",
    "run_id",
    "call_id",
    "part",
    "since",
    "until",
    "error_code",
    "precision",
    "config_digest",
    "operation",
)
PAGE_PARAMS = ("cursor", "limit")


def list_query(params: Mapping[str, str]) -> tuple[dict[str, str], str | None, int | None]:
    """(filters, cursor, limit) of ``GET /api/recordings``; unknown parameters are ignored."""
    filters = {key: str(params[key]) for key in RECORDING_FILTERS if params.get(key)}
    limit = query_int(params, "limit", default=None, minimum=1, maximum=MAX_PAGE)
    return filters, params.get("cursor") or None, limit


def events_query(params: Mapping[str, str]) -> dict[str, Any]:
    """Keyword arguments of ``RecordingStore.events`` from the query string."""
    return {
        "stream_id": params.get("stream_id") or None,
        "after_seq": query_int(params, "after_seq", default=0, minimum=0, maximum=MAX_SAFE_INT) or 0,
        "limit": query_int(params, "limit", default=None, minimum=1, maximum=MAX_EVENTS),
    }


async def list_page(store: RecordingStore, params: Mapping[str, str]) -> dict[str, Any]:
    filters, cursor, limit = list_query(params)
    page: dict[str, Any] = await asyncio.to_thread(store.list, filters, cursor=cursor, limit=limit)
    return page


async def events_page(store: RecordingStore, recording_id: str, params: Mapping[str, str]) -> dict[str, Any]:
    page: dict[str, Any] = await asyncio.to_thread(store.events, recording_id, **events_query(params))
    return page


async def export_response(store: RecordingStore, recording_id: str, params: QueryParams) -> StreamingResponse:
    """Validate everything first (format, redact, recording, trace) so errors still get a proper status."""
    fmt = params.get("format") or "jsonl"
    result = await asyncio.to_thread(export, store, recording_id, fmt, redact=params.getlist("redact"))
    return StreamingResponse(result.chunks, media_type=result.media_type, headers=attachment(result.filename))


__all__ = [
    "PAGE_PARAMS",
    "RECORDING_FILTERS",
    "events_page",
    "events_query",
    "export_response",
    "list_page",
    "list_query",
]
