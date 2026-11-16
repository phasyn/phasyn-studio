"""主控測試共用：假 Node（小型 FastAPI app）、依 origin 分派的 httpx transport、可控 monotonic 時鐘。

沒有真實 socket：主控對 Node 的 HTTP 走 ``Router``（每個假 Node 是一個 ASGITransport），
測試對主控的 HTTP 走 ``httpx.ASGITransport(app=controller_app)``。
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from phasyn_components import PROTOCOL_VERSION, contracts
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.records import RecordingStore
from phasyn_components.settings import effective_context, normalize_recording
from phasyn_components.testing import ids
from phasyn_components.timeutil import utc_now
from phasyn_controller import ControllerConfig, create_app
from phasyn_server.files import file_response
from starlette.responses import JSONResponse, Response

CONTROLLER_ID = ids.CONTROLLER_ID
NODE_A = ids.NODE_A_ID
NODE_B = ids.NODE_B_ID
NODE_C = ids.NODE_C_ID
ENDPOINT_A = "http://node-a:8090"
ENDPOINT_B = "http://node-b:8090"
ENDPOINT_C = "http://node-c:8090"
TYPE = "test.echo.v1"
CONTROLLER_HOST = "http://controller.test"

Intercept = Callable[[httpx.Request], Awaitable[httpx.Response | None]]
TypedValue = dict[str, Any]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class Router(httpx.AsyncBaseTransport):
    """依 scheme://host:port 把請求交給對應的假 Node；沒有掛載的 origin → ConnectError。"""

    def __init__(self) -> None:
        self.apps: dict[str, httpx.ASGITransport] = {}
        self.requests: list[httpx.Request] = []
        self.intercept: Intercept | None = None

    def mount(self, origin: str, app: FastAPI) -> None:
        self.apps[origin] = httpx.ASGITransport(app=app)

    def unmount(self, origin: str) -> None:
        self.apps.pop(origin, None)

    def seen(self, method: str | None = None, path_suffix: str = "", host: str | None = None) -> list[httpx.Request]:
        return [
            r
            for r in self.requests
            if (method is None or r.method == method)
            and r.url.path.endswith(path_suffix)
            and (host is None or r.url.host == host)
        ]

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.intercept is not None:
            result = await self.intercept(request)
            if result is not None:
                return result
        origin = f"{request.url.scheme}://{request.url.host}:{request.url.port}"
        transport = self.apps.get(origin)
        if transport is None:
            raise httpx.ConnectError(f"no route to {origin}", request=request)
        return await transport.handle_async_request(request)


def port(name: str, type_id: str = TYPE, *, required: bool = True) -> dict[str, Any]:
    return {"name": name, "type_id": type_id, "required": required, "transport": "either", "description": name}


def descriptor(
    node_id: str,
    component_id: str,
    *,
    resource_group: str = "cpu-0",
    loaded_revision: int | None = 1,
    inputs: list[dict[str, Any]] | None = None,
    outputs: list[dict[str, Any]] | None = None,
    invoke_defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    load = {"device": {"kind": "cpu", "id": "cpu", "resource_group": resource_group}}
    stored = {
        "load": load,
        "invoke": dict(invoke_defaults or {}),
        "recording": normalize_recording({"mode": "detailed"}),
    }
    return {
        "component_id": component_id,
        "label": f"假元件 {component_id}",
        "provider_id": "test.echo",
        "runtime_id": "cpu",
        "node_id": node_id,
        "state": "ready",
        "device": load["device"],
        "api_path": f"/api/components/{component_id}",
        "inputs": inputs if inputs is not None else [port("value")],
        "outputs": outputs if outputs is not None else [port("value")],
        "parts": [],
        "settings": {
            "stored_revision": 1,
            "loaded_revision": loaded_revision,
            "stored": stored,
            "loaded": load if loaded_revision is not None else None,
            "restart_required": False,
            "settings_schema": {},
            "parameters_schema": {},
        },
        "active_call_id": None,
        "last_error": None,
        "recorder_state": "ok",
        "folder": None,
        "autostart": False,
        "exclusive_group": None,
        "limits": None,
        "facts": None,
    }


def summary(recording_id: str, state: str) -> dict[str, Any]:
    return {
        "recording_id": recording_id,
        "state": state,
        "metrics": {},
        "transfer_totals": {},
        "part_totals": {},
        "coverage": "full",
        "dropped_events": 0,
        "dropped_bytes": 0,
        "detail_truncated": False,
        "notes": [],
        "context_available": True,
    }


class FakeNode:
    """A fake NodeGateway. ``invoke`` follows its parameters: ``gate`` (wait until the test opens that gate),
    ``sleep_s``, ``fail``, ``hang`` (until a cancel), ``produce`` (publish fake outputs in ``files``).
    ``DELETE /api/files/{id}`` uses a real FileStore.delete; ``file_delete_errors`` forces errors ("*" = all)."""

    def __init__(
        self, node_id: str, endpoint: str, components: list[dict[str, Any]], *, label: str = "假 Node"
    ) -> None:
        self.node_id = node_id
        self.endpoint = endpoint
        self.label = label
        self.process_instance_id = str(uuid.uuid4())
        self.components = {c["component_id"]: c for c in components}
        self.calls: list[dict[str, Any]] = []
        self.cancels: list[dict[str, Any]] = []
        self.events: dict[str, asyncio.Event] = {}
        self.files: FileStore | None = None
        self.store: RecordingStore | None = None
        self.recording_queries: list[dict[str, str]] = []
        self.file_deletes: list[str] = []
        self.file_delete_errors: dict[str, ComponentError] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.app = self._build()

    def gate(self, name: str) -> asyncio.Event:
        """A barrier for invokes with ``parameters.gate == name``; ``gate(name).set()`` lets them finish."""
        return self.gates.setdefault(name, asyncio.Event())

    def started(self, step_id: str) -> bool:
        return any(c["step_id"] == step_id for c in self.calls)

    def publish_file(self, data: bytes, media_type: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        assert self.files is not None, "FakeNode.files 未設定"
        writer = self.files.new_writer(media_type, metadata or {})
        writer.write(data)
        return writer.commit()

    def produce(self, component_id: str) -> dict[str, TypedValue]:
        """假產物：兩個 latent manifest 共用同一個 links.blob 附件，加上 media.asset.v1（inline 值內的 file）。"""
        blob = self.publish_file(b"latent blob " + component_id.encode(), "application/x-safetensors", {"role": "blob"})
        video_manifest = self.publish_file(b'{"latent": "video"}', "application/json", {"links": {"blob": blob}})
        audio_manifest = self.publish_file(b'{"latent": "audio"}', "application/json", {"links": {"blob": blob}})
        video = self.publish_file(b"fake mp4 " + component_id.encode(), "video/mp4", {"kind": "final"})
        asset = {
            "asset_id": str(uuid.uuid4()),
            "kind": "final",
            "file": video,
            "source_latent": None,
            "frame_count": 1,
            "fps": None,
            "width": 8,
            "height": 8,
            "complete": True,
            "actual_settings": {},
        }
        return {
            "video_latent": {"type_id": "video.final-latent.v1", "file": video_manifest},
            "audio_latent": {"type_id": "audio.final-latent.v1", "file": audio_manifest},
            "asset": {"type_id": "media.asset.v1", "value": asset},
        }

    def snapshot(self, *, process_instance_id: str | None = None, endpoint: str | None = None) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "process_instance_id": process_instance_id or self.process_instance_id,
            "label": self.label,
            "endpoint": endpoint or self.endpoint,
            "protocol_version": PROTOCOL_VERSION,
            "platform": "linux-test",
            "components": list(self.components.values()),
            "observed_at": utc_now(),
        }

    def call(self, step_id: str) -> dict[str, Any]:
        matches = [c for c in self.calls if c["step_id"] == step_id]
        assert len(matches) == 1, f"{step_id}: {len(matches)} 次 invoke"
        return matches[0]

    def _build(self) -> FastAPI:
        app = FastAPI()

        @app.post("/api/components/{component_id}/invoke")
        async def invoke(component_id: str, request: Request) -> Response:
            body = await request.json()
            contracts.validate("InvokeRequest", body)
            record: dict[str, Any] = {
                "component_id": component_id,
                "step_id": body["step_id"],
                "call_id": body["call_id"],
                "body": body,
                "start": time.monotonic(),
            }
            self.calls.append(record)
            params = body["parameters"]
            event = self.events.setdefault(body["call_id"], asyncio.Event())
            state = "succeeded"
            if params.get("reject"):
                err = ComponentError("COMPONENT_NOT_READY", "假 Node：元件未就緒")
                return JSONResponse(err.to_dict(), status_code=err.status)
            if params.get("gate"):
                await self.gate(str(params["gate"])).wait()
            if params.get("hang"):
                await event.wait()
                state = "cancelled"
            elif params.get("sleep_s"):
                try:
                    await asyncio.wait_for(event.wait(), float(params["sleep_s"]))
                    state = "cancelled"
                except TimeoutError:
                    pass
            record["end"] = time.monotonic()
            error = None
            if params.get("fail") and state == "succeeded":
                state = "failed"
                error = {"code": "GPU_OOM", "message": "假 Node：測試用失敗"}
            outputs = {}
            if state == "succeeded" and params.get("produce"):
                outputs = self.produce(component_id)
            elif state == "succeeded":
                outputs = {"value": body["inputs"].get("value") or {"type_id": TYPE, "value": component_id}}
            rid = str(uuid.uuid4())
            record["recording_id"] = rid
            result = {
                "call_id": body["call_id"],
                "recording_id": rid,
                "state": state,
                "outputs": outputs,
                "settings": effective_context(
                    requested=body["parameters"],
                    effective=body["parameters"],
                    observed={},
                    stored_revision=1,
                    loaded_revision=body["required_loaded_revision"],
                    expanded_parts={},
                    model_identity={"model": "fake"},
                    runtime_identity={"kind": "test"},
                ),
                "error": error,
                "summary": summary(rid, state),
            }
            contracts.validate("InvokeResult", result)
            return JSONResponse(result)

        @app.post("/api/components/{component_id}/cancel")
        async def cancel(component_id: str, request: Request) -> Response:
            body = await request.json()
            self.cancels.append({"component_id": component_id, **body})
            event = self.events.get(body["call_id"])
            accepted = event is not None and not event.is_set()
            if event is not None:
                event.set()
            return JSONResponse(
                {"call_id": body["call_id"], "accepted": accepted, "process_exited": None, "message": "假 Node"}
            )

        @app.post("/api/components/{component_id}/control")
        async def control(component_id: str, request: Request) -> Response:
            err = ComponentError(
                "COMPONENT_BUSY", "假 Node：元件忙碌，請先取消", details={"component_id": component_id}
            )
            return JSONResponse(err.to_dict(), status_code=err.status)

        @app.get("/api/components/{component_id}/settings")
        async def get_settings(component_id: str) -> Response:
            return JSONResponse(self.components[component_id]["settings"])

        @app.get("/api/providers")
        async def providers() -> Response:
            return JSONResponse({"node_id": self.node_id, "items": []})

        @app.get("/api/files/{file_id}")
        async def file(file_id: str, request: Request) -> Response:
            assert self.files is not None
            try:
                return await file_response(self.files, file_id, request.headers.get("range"))
            except ComponentError as err:
                return JSONResponse(err.to_dict(), status_code=err.status)

        @app.delete("/api/files/{file_id}")
        async def delete_file(file_id: str) -> Response:
            self.file_deletes.append(file_id)
            err = self.file_delete_errors.get(file_id) or self.file_delete_errors.get("*")
            if err is None:
                assert self.files is not None
                try:
                    if self.files.delete(file_id):
                        return JSONResponse({"file_id": file_id, "deleted": True})
                    err = ComponentError("FILE_NOT_FOUND", f"假 Node：找不到已發布檔案 {file_id}")
                except ComponentError as exc:
                    err = exc
            return JSONResponse(err.to_dict(), status_code=err.status)

        @app.get("/api/recordings")
        def list_recordings(request: Request) -> Response:
            assert self.store is not None
            params = dict(request.query_params)
            limit = params.pop("limit", None)
            cursor = params.pop("cursor", None)
            self.recording_queries.append(dict(request.query_params))
            try:
                page = self.store.list(params, cursor=cursor, limit=int(limit) if limit else None)
            except ComponentError as err:
                return JSONResponse(err.to_dict(), status_code=err.status)
            return JSONResponse(page)

        @app.get("/api/recordings/{recording_id}")
        def get_recording(recording_id: str) -> Response:
            assert self.store is not None
            try:
                return JSONResponse(self.store.get(recording_id))
            except ComponentError as err:
                return JSONResponse(err.to_dict(), status_code=err.status)

        @app.get("/api/recordings/{recording_id}/events")
        def get_events(recording_id: str, request: Request) -> Response:
            assert self.store is not None
            params = request.query_params
            try:
                page = self.store.events(
                    recording_id,
                    stream_id=params.get("stream_id") or None,
                    after_seq=int(params.get("after_seq") or 0),
                    limit=int(params.get("limit") or 200),
                )
            except ComponentError as err:
                return JSONResponse(err.to_dict(), status_code=err.status)
            return JSONResponse(page)

        return app


def make_config(data_dir: Path, **overrides: Any) -> ControllerConfig:
    doc: dict[str, Any] = {
        "instance_id": CONTROLLER_ID,
        "label": "測試主控",
        "bind_host": "127.0.0.1",
        "port": 8080,
        "advertise_url": "http://controller.test:8080",
        "data_dir": str(data_dir),
        "static_dir": "",
        "max_active_runs": 1,
        "node_stale_seconds": 15,
        "recording": normalize_recording({"mode": "detailed"}),
    }
    doc.update(overrides)
    contracts.validate("ControllerConfig", doc)
    return ControllerConfig.from_dict(doc)


class Harness:
    """一個主控實例（lifespan 手動啟停）＋對它的 async client。"""

    def __init__(
        self, data_dir: Path, *, router: Router | None = None, clock: FakeClock | None = None, **config: Any
    ) -> None:
        self.router = router or Router()
        self.clock = clock or FakeClock()
        self.config = make_config(data_dir, **config)
        self.app = create_app(self.config, transport=self.router, clock=self.clock)
        self.ctl = self.app.state.controller
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url=CONTROLLER_HOST)

    async def __aenter__(self) -> Harness:
        await self.ctl.startup()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.client.aclose()
        await self.ctl.shutdown()

    async def add_node(self, node: FakeNode) -> dict[str, Any]:
        self.router.mount(node.endpoint, node.app)
        resp = await self.client.put(f"/api/catalog/{node.node_id}", json=node.snapshot())
        assert resp.status_code == 200, resp.text
        contracts.validate("RegistrationAck", resp.json())
        return dict(resp.json())

    async def start_run(
        self, pipeline: dict[str, Any], inputs: dict[str, Any] | None = None, **extra: Any
    ) -> dict[str, Any]:
        body = {
            "pipeline": pipeline,
            "inputs": inputs if inputs is not None else {"text": {"type_id": TYPE, "value": "hi"}},
            **extra,
        }
        resp = await self.client.post("/api/runs", json=body)
        assert resp.status_code == 202, resp.text
        run = dict(resp.json())
        contracts.validate("Run", run)
        return run

    async def wait_run(self, run_id: str, timeout: float = 10.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            resp = await self.client.get(f"/api/runs/{run_id}")
            assert resp.status_code == 200, resp.text
            run = dict(resp.json())
            if run["state"] != "running":
                contracts.validate("Run", run)
                return run
            assert time.monotonic() < deadline, (
                f"run 未在 {timeout}s 內結束：{json.dumps(run, ensure_ascii=False)[:2000]}"
            )
            await asyncio.sleep(0.02)


async def wait_until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "條件未在期限內成立"
        await asyncio.sleep(0.01)


def pipeline(
    steps: list[dict[str, Any]], *, outputs: dict[str, Any] | None = None, pipeline_id: str = "p1"
) -> dict[str, Any]:
    return {
        "pipeline_id": pipeline_id,
        "label": "測試接線",
        "inputs": [{"name": "text", "type_id": TYPE, "required": True, "transport": "inline", "description": "text"}],
        "steps": steps,
        "outputs": outputs or {},
    }


def step(
    step_id: str, node_id: str, component_id: str, *, params: dict[str, Any] | None = None, **inputs: Any
) -> dict[str, Any]:
    bindings = inputs or {"value": {"from_input": "text"}}
    return {
        "step_id": step_id,
        "node_id": node_id,
        "component_id": component_id,
        "inputs": bindings,
        "parameters": params or {},
    }


__all__ = [
    "CONTROLLER_ID",
    "ENDPOINT_A",
    "ENDPOINT_B",
    "ENDPOINT_C",
    "NODE_A",
    "NODE_B",
    "NODE_C",
    "TYPE",
    "FakeClock",
    "FakeNode",
    "Harness",
    "Router",
    "descriptor",
    "make_config",
    "pipeline",
    "port",
    "step",
    "summary",
    "wait_until",
]
