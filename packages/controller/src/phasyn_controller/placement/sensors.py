"""Read current placement data only from the Controller's live configured catalog."""

from __future__ import annotations

import asyncio
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

import httpx
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_server.http import parse_json_bytes


if TYPE_CHECKING:
    from ..state import Controller

type Doc = dict[str, Any]
_MAX_RESOURCE_BYTES = 65536


async def read_node(ctl: Controller, node: str, components: set[str]) -> Doc | None:
    """Read and validate one bounded Node resource response."""
    try:
        endpoint = ctl.catalog.endpoint_for_call(node)
        async with (
            asyncio.timeout(4),
            ctl.http.stream(
                "GET",
                endpoint + "/api/resources",
                params=[("component", name) for name in sorted(components)],
                headers={"Accept-Encoding": "identity"},
                timeout=3,
            ) as response,
        ):
            if (
                response.status_code != HTTPStatus.OK
                or response.headers.get("content-encoding", "identity") != "identity"
            ):
                return None
            raw = bytearray()
            async for chunk in response.aiter_raw(8192):
                if len(raw) + len(chunk) > _MAX_RESOURCE_BYTES:
                    return None
                raw.extend(chunk)
        doc = parse_json_bytes(bytes(raw), what="Node placement snapshot")
        contracts.validate("PlacementNodeResources", doc)
        if doc["node_id"].lower() != node or set(doc["components"]) != components:
            return None
        return dict(doc)
    except (ComponentError, httpx.HTTPError, TimeoutError):
        return None
