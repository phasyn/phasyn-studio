"""The Node's HTTP guards (C7) and request limits (P0-6): browsers are refused, JSON needs its Content-Type,
bodies and uploads are bounded. httpx clients (controller, other Nodes, CLI) are unaffected."""

from __future__ import annotations

from pathlib import Path

import pytest
from node_testkit import assert_valid, echo_definition, make_config, running_node

from phasyn_node.config import ConfigError


pytestmark = pytest.mark.anyio


async def test_browser_requests_are_refused_and_state_is_unchanged(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, components=[echo_definition("echo")])
    async with running_node(config) as node:
        url = "/api/components/echo/control"
        refused = await node.client.post(
            url, json={"action": "start"}, headers={"Origin": "http://example.com"}
        )
        assert (
            refused.status_code == 403
            and refused.json()["code"] == "BROWSER_REQUEST_REJECTED"
        ), refused.text
        assert_valid("Error", refused.json())
        rebound = await node.client.get(
            "/api/components", headers={"Sec-Fetch-Site": "same-origin"}
        )
        assert rebound.status_code == 403
        typed = await node.client.get(
            "/api/node", headers={"Sec-Fetch-Site": "none"}
        )  # address bar
        assert typed.status_code == 200
        simple = await node.client.post(
            url, content=b'{"action": "start"}', headers={"Content-Type": "text/plain"}
        )
        assert (
            simple.status_code == 415
            and simple.json()["code"] == "UNSUPPORTED_MEDIA_TYPE"
        )
        assert (await node.component("echo"))[
            "state"
        ] == "stopped" and node.service.instances["echo"].spawn_count == 0


async def test_allowed_hosts(tmp_path: Path) -> None:
    with pytest.raises(
        ConfigError, match="不符合契約"
    ):  # empty would refuse every request: omit it instead
        make_config(tmp_path, allowed_hosts=[])
    config = make_config(tmp_path, allowed_hosts=["node-a.test"])
    async with running_node(config) as node:
        assert (
            await node.client.get("/api/node")
        ).status_code == 200  # Host: node-a.test:8090
        other = await node.client.get(
            "/api/node", headers={"Host": "rebound.example:8090"}
        )
        assert other.status_code == 400 and other.json()["code"] == "HOST_NOT_ALLOWED"
