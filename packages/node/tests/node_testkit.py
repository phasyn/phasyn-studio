"""NodeGateway 測試工具：真實元件子程序（CPU runtime = 目前 venv 的 python + phasyn_components.runtime_host，
provider test.echo）、假主控（httpx.MockTransport）、以 httpx.ASGITransport 呼叫 Node 的 HTTP。

模組名稱刻意不叫 conftest／helpers，避免與其他套件的測試模組撞名。"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sys
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import psutil
from fastapi import FastAPI
from phasyn_components import contracts, testing
from phasyn_components.settings import normalize_recording
from phasyn_node.app import create_app
from phasyn_node.config import NodeConfig, config_from_dict
from phasyn_node.service import NodeService

CONTROLLER_HOST = "controller.test:8080"
CONTROLLER = f"http://{CONTROLLER_HOST}"
RUNTIME_MODULE = "phasyn_components.runtime_host"
TESTS_DIR = Path(__file__).resolve().parent
FIXTURE_MODULE = "misbehaving_runtime"  # tests/misbehaving_runtime.py


def runtime_children() -> list[psutil.Process]:
    found: list[psutil.Process] = []
    for proc in psutil.Process().children(recursive=True):
        with contextlib.suppress(psutil.Error):
            if RUNTIME_MODULE in " ".join(proc.cmdline()) and "--component-id" in proc.cmdline():
                found.append(proc)
    return found


def cpu_runtime(runtime_id: str = "cpu", python: str | None = None, **env: str) -> dict[str, Any]:
    """CPU runtime in this venv; the test.* providers are enabled explicitly through the runtime env."""
    return {
        "runtime_id": runtime_id,
        "python": python or sys.executable,
        "module": RUNTIME_MODULE,
        "env": {testing.ENABLE_ENV: "1", **env},
    }


def fixture_runtime(runtime_id: str, mode: str, **env: str) -> dict[str, Any]:
    """The misbehaving fixture runtime (``misbehaving_runtime.py``) in ``mode`` (CPU only, no model)."""
    fixture_env = {"PHASYN_TEST_MISBEHAVE": mode, "PYTHONPATH": str(TESTS_DIR), **env}
    return {**cpu_runtime(runtime_id, **fixture_env), "module": FIXTURE_MODULE}


def recording(**overrides: Any) -> dict[str, Any]:
    return normalize_recording({"mode": "detailed", **overrides})


def echo_definition(component_id: str, group: str = "cpu-echo", **load: Any) -> dict[str, Any]:
    load_settings: dict[str, Any] = {
        "device": {"kind": "cpu", "id": "cpu", "resource_group": group},
        "precision": {"compute_dtype": "native"},
        "provider_options": {},
    }
    load_settings.update(load)
    return {
        "component_id": component_id,
        "label": f"echo {component_id}",
        "provider_id": "test.echo",
        "runtime_id": "cpu",
        "autostart": False,
        "settings": {"load": load_settings, "invoke": {}, "recording": recording()},
    }


def make_config(
    tmp_path: Path,
    *,
    name: str = "node-a",
    node_id: str | None = None,
    components: list[dict[str, Any]] | tuple[dict[str, Any], ...] = (),
    runtimes: list[dict[str, Any]] | None = None,
    **overrides: Any,
) -> NodeConfig:
    doc: dict[str, Any] = {
        "node_id": node_id or str(uuid.uuid4()),
        "label": name,
        "bind_host": "127.0.0.1",
        "port": 8090,
        "advertise_url": f"http://{name}.test:8090",
        "controller_url": CONTROLLER,
        "data_dir": str(tmp_path / name),
        "catalog_interval_seconds": 5,
        "load_timeout_seconds": 30,
        "cancel_grace_seconds": 1,
        "runtimes": runtimes if runtimes is not None else [cpu_runtime()],
        "components": list(components),
        "recording": recording(publish_interval_ms=100),
    }
    doc.update(overrides)
    return config_from_dict(doc)


class FakeController:
    """只實作 Node 會呼叫的主控端點（目錄、紀錄批次、中間預覽通知），並以契約驗證收到的內容。"""

    def __init__(self) -> None:
        self.controller_id = str(uuid.uuid4())
        self.nodes: dict[str, dict[str, Any]] = {}
        self.catalog_puts: list[dict[str, Any]] = []
        self.batches: list[dict[str, Any]] = []
        self.preview_notices: list[tuple[str, dict[str, Any]]] = []  # (path, RunStepPreviewNotice)
        self.problems: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "PUT" and path.startswith("/api/catalog/"):
            body = json.loads(request.content)
            self.problems += [f"NodeSnapshot {p}" for p in contracts.errors("NodeSnapshot", body)]
            if path != f"/api/catalog/{body.get('node_id')}":
                self.problems.append(f"catalog path {path} != node_id")
            self.catalog_puts.append(body)
            self.nodes[body["node_id"]] = body
            ack = {
                "registered": True,
                "nodes": [
                    {
                        "node_id": nid,
                        "label": snap["label"],
                        "endpoint": snap["endpoint"],
                        "state": "online",
                        "last_seen_at": "2026-10-17T00:00:00.000Z",
                    }
                    for nid, snap in self.nodes.items()
                ],
                "controller_endpoint": CONTROLLER,
                "controller_id": self.controller_id,
            }
            return httpx.Response(200, json=ack)
        if request.method == "POST" and path == "/api/telemetry/batches":
            body = json.loads(request.content)
            self.problems += [f"EventBatch {p}" for p in contracts.errors("EventBatch", body)]
            self.batches.append(body)
            ack = {
                "accepted_events": len(body.get("events") or []),
                "duplicate_events": 0,
                "rejected_events": 0,
                "message": "ok",
            }
            return httpx.Response(200, json=ack)
        if request.method == "POST" and path.startswith("/api/runs/") and path.endswith("/preview"):
            body = json.loads(request.content)
            self.problems += [f"RunStepPreviewNotice {p}" for p in contracts.errors("RunStepPreviewNotice", body)]
            self.preview_notices.append((path, body))
            return httpx.Response(200, json={"accepted": True, "message": "fake controller"})
        return httpx.Response(404, json={"code": "NOT_FOUND", "message": "fake controller"})

    def records(self, kind: str) -> list[dict[str, Any]]:
        return [item for batch in self.batches for item in batch[kind]]


class Router(httpx.AsyncBaseTransport):
    """依 host:port 把 Node 的對外請求轉到假主控或另一個 Node（in-process ASGI）。"""

    def __init__(self, controller: FakeController | None = None) -> None:
        self.controller = controller or FakeController()
        self.routes: dict[str, httpx.AsyncBaseTransport] = {
            CONTROLLER_HOST: httpx.MockTransport(self.controller.handler)
        }

    def add(self, netloc: str, transport: httpx.AsyncBaseTransport) -> None:
        self.routes[netloc] = transport

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        transport = self.routes.get(request.url.netloc.decode("ascii"))
        if transport is None:
            raise httpx.ConnectError(f"no route to {request.url.netloc!r}", request=request)
        return await transport.handle_async_request(request)


@dataclass
class Node:
    app: FastAPI
    service: NodeService
    client: httpx.AsyncClient
    config: NodeConfig

    async def components(self) -> dict[str, dict[str, Any]]:
        response = await self.client.get("/api/components")
        assert response.status_code == 200, response.text
        body = response.json()
        assert not contracts.errors("ListComponents", body), contracts.errors("ListComponents", body)
        return {c["component_id"]: c for c in body["items"]}

    async def component(self, component_id: str) -> dict[str, Any]:
        return (await self.components())[component_id]

    async def wait_state(self, component_id: str, *states: str, timeout: float = 15.0) -> dict[str, Any]:
        async def check() -> dict[str, Any] | None:
            desc = await self.component(component_id)
            return desc if desc["state"] in states else None

        return await wait_until(check, timeout=timeout, what=f"{component_id} → {states}")

    async def control(self, component_id: str, action: str) -> httpx.Response:
        return await self.client.post(f"/api/components/{component_id}/control", json={"action": action})

    async def start_ready(self, *component_ids: str) -> None:
        responses = await asyncio.gather(*(self.control(cid, "start") for cid in component_ids))
        for response in responses:
            assert response.status_code == 200, response.text
        for cid in component_ids:
            await self.wait_state(cid, "ready")

    async def invoke(self, component_id: str, body: dict[str, Any]) -> httpx.Response:
        return await self.client.post(f"/api/components/{component_id}/invoke", json=body)

    async def cancel(self, component_id: str, call_id: str) -> httpx.Response:
        return await self.client.post(f"/api/components/{component_id}/cancel", json={"call_id": call_id})


@contextlib.asynccontextmanager
async def running_node(config: NodeConfig, transport: httpx.AsyncBaseTransport | None = None) -> AsyncIterator[Node]:
    app = create_app(config, http_transport=transport or Router())
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=config.advertise_url, timeout=60) as client,
    ):
        yield Node(app=app, service=app.state.service, client=client, config=config)


async def wait_until(predicate: Callable[[], Any], *, timeout: float = 10.0, what: str = "condition") -> Any:
    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if asyncio.iscoroutine(result):
            result = await result
        if result:
            return result
        if time.monotonic() > deadline:
            raise AssertionError(f"等待逾時：{what}")
        await asyncio.sleep(0.02)


def invoke_body(
    *,
    value: Any = None,
    file: dict[str, Any] | None = None,
    call_id: str | None = None,
    parameters: dict[str, Any] | None = None,
    required_loaded_revision: int | None = None,
    timeout_seconds: int = 60,
    type_id: str = "test.echo.v1",
    port: str = "value",
) -> dict[str, Any]:
    item: dict[str, Any] = (
        {"type_id": type_id, "file": file} if file is not None else {"type_id": type_id, "value": value}
    )
    return {
        "call_id": call_id or str(uuid.uuid4()),
        "run_id": None,
        "step_id": None,
        "inputs": {port: item},
        "parameters": parameters or {},
        "required_loaded_revision": required_loaded_revision,
        "recording": recording(),
        "timeout_seconds": timeout_seconds,
    }


def assert_valid(definition: str, obj: Any) -> None:
    problems = contracts.errors(definition, obj)
    assert not problems, f"{definition}: {problems}"


def read_stream(recording_dir: Path, stream: str) -> list[dict[str, Any]]:
    path = recording_dir / "streams" / f"{stream}.0000.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
