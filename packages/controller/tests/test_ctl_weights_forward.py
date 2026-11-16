"""The controller forwards the weight routes: the plan GET, the download POST (checked
against WeightsDownloadRequest locally, so a request without the license acknowledgement never reaches the Node) and
the cancel POST; the Node's replies come back unchanged and nothing is resent."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from controller_support import ENDPOINT_A, NODE_A, FakeNode, Harness, descriptor
from fastapi import Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_controller import forward
from starlette.responses import JSONResponse, Response

BASE = f"/api/nodes/{NODE_A}/components/{{cid}}/weights"


def job(state: str = "running") -> dict[str, Any]:
    return {
        "job_id": str(uuid.UUID(int=7)),
        "component_id": "dit",
        "state": state,
        "started_at": "2026-11-04T00:00:00.000Z",
        "finished_at": None if state == "running" else "2026-11-04T00:00:01.000Z",
        "sets": ["qwen-image-2.1"],
        "files_total": 2,
        "files_done": 0,
        "files_linked": 0,
        "bytes_total": 10,
        "bytes_done": 0,
        "current": None,
        "error": None,
    }


def weights_node() -> FakeNode:
    node = FakeNode(NODE_A, ENDPOINT_A, [descriptor(NODE_A, "dit")])
    node.download_bodies = []  # type: ignore[attr-defined]

    @node.app.get("/api/components/{component_id}/weights")
    async def get_weights(component_id: str) -> Response:
        view = {
            "component_id": component_id,
            "root": "/models",
            "root_exists": True,
            "sets": [],
            "notes": ["note"],
            "free_bytes": 1000,
            "source": {"endpoint": "https://huggingface.co", "token": False},
            "job": None,
        }
        return JSONResponse(view)

    @node.app.post("/api/components/{component_id}/weights/download")
    async def download(component_id: str, request: Request) -> Response:
        body = await request.json()
        node.download_bodies.append(body)  # type: ignore[attr-defined]
        if component_id != "dit":
            err = ComponentError("NOT_FOUND", f"這個 Node 沒有元件 {component_id}")
            return JSONResponse(err.to_dict(), status_code=err.status)
        return JSONResponse(job())

    @node.app.post("/api/components/{component_id}/weights/cancel")
    async def cancel(component_id: str) -> Response:
        return JSONResponse(job("cancelled"))

    return node


def test_weight_routes_are_forwarded(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            node = weights_node()
            await h.add_node(node)

            view = await h.client.get(BASE.format(cid="dit"))
            assert view.status_code == 200, view.text
            contracts.validate("WeightsView", view.json())
            assert view.json()["notes"] == ["note"]

            body = {"accept_licenses": True, "sets": ["qwen-image-2.1"], "replace_mismatched": False}
            started = await h.client.post(BASE.format(cid="dit") + "/download", json=body)
            assert started.status_code == 200, started.text
            contracts.validate("WeightsDownloadJob", started.json())
            assert node.download_bodies == [body]  # type: ignore[attr-defined]

            before = len(h.router.requests)
            for bad in (
                {},
                {"accept_licenses": False},
                {"accept_licenses": True, "sets": []},
                {"accept_licenses": True, "extra": 1},
            ):
                refused = await h.client.post(BASE.format(cid="dit") + "/download", json=bad)
                assert (refused.status_code, refused.json()["code"]) == (422, "INVALID_ARGUMENT"), (bad, refused.text)
            assert len(h.router.requests) == before  # checked locally, never sent

            missing = await h.client.post(BASE.format(cid="ghost") + "/download", json={"accept_licenses": True})
            assert (missing.status_code, missing.json()["code"]) == (404, "NOT_FOUND")

            cancelled = await h.client.post(BASE.format(cid="dit") + "/cancel")
            assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"

    asyncio.run(scenario())


def test_a_node_reply_never_runs_as_a_page_in_the_controller_origin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A registered Node chooses its replies: each one is relayed as API JSON and bounded, whatever it claims."""

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            await h.add_node(weights_node())
            page = b"<script>fetch('/api/runs', {method: 'DELETE'})</script>"

            async def html(request: httpx.Request) -> httpx.Response | None:
                if request.url.path.endswith("/weights"):
                    return httpx.Response(200, headers={"content-type": "text/html"}, content=page)
                return None

            h.router.intercept = html
            relayed = await h.client.get(BASE.format(cid="dit"))
            assert relayed.status_code == 200 and relayed.content == page
            assert relayed.headers["content-type"] == "application/json"
            assert relayed.headers["x-content-type-options"] == "nosniff"

            monkeypatch.setattr(forward, "FORWARD_BODY_LIMIT", len(page) - 1)
            refused = await h.client.get(BASE.format(cid="dit"))
            assert (refused.status_code, refused.json()["code"]) == (502, "RUNTIME_ERROR"), refused.text
            assert page.decode() not in refused.text

    asyncio.run(scenario())
