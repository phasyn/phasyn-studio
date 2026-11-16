"""phasyn_server: bounded JSON bodies and uploads (413/415), the error policy, the request guards (C7)."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import APIRouter, FastAPI, Request
from phasyn_components import contracts
from phasyn_components.files import FileStore
from phasyn_components.testing import ids
from phasyn_server import DataDirBusy, DataDirLock, HttpLimits, create_api
from phasyn_server.files import file_response, receive_upload
from phasyn_server.http import json_response, query_int, read_json
from phasyn_server.middleware import HostPolicy, Role
from starlette.responses import JSONResponse, Response

JSON_LIMIT = 64 * 1024
UPLOAD_LIMIT = 1000


def make_app(store: FileStore, *, role: Role = "controller", allowed_hosts: list[str] | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield

    app = create_api(
        title="test",
        version="0",
        role=role,
        limits=HttpLimits(JSON_LIMIT, UPLOAD_LIMIT),
        lifespan=lifespan,
        hosts=HostPolicy.for_service(allowed_hosts, advertise_url="http://svc.test:8090", bind_host="127.0.0.1"),
    )
    router = APIRouter()

    @router.post("/echo")
    async def echo(request: Request) -> JSONResponse:
        return json_response(await read_json(request))

    @router.get("/count")
    async def count(request: Request) -> JSONResponse:
        return json_response({"n": query_int(request.query_params, "n", default=1, minimum=1, maximum=10)})

    @router.get("/boom")
    async def boom() -> JSONResponse:
        raise RuntimeError("secret /srv/models/path")

    @router.post("/api/files")
    async def upload(request: Request) -> JSONResponse:
        return json_response(await receive_upload(store, request, buffer_bytes=256), status_code=201)

    @router.get("/api/files/{file_id}")
    async def download(file_id: str, request: Request) -> Response:
        return await file_response(store, file_id, request.headers.get("range"))

    app.include_router(router)
    return app


def call(app: FastAPI, method: str, url: str, **kwargs: Any) -> httpx.Response:
    async def go() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://svc.test") as client:
            return await client.request(method, url, **kwargs)

    return asyncio.run(go())


@pytest.fixture
def store(tmp_path: Path) -> FileStore:
    return FileStore(tmp_path / "data", ids.NODE_A_ID)


def assert_error(resp: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert resp.status_code == status, resp.text
    body: dict[str, Any] = resp.json()
    contracts.validate("Error", body)
    assert body["code"] == code
    return body


JSON = {"Content-Type": "application/json"}


def test_json_body_content_type_and_limits(store: FileStore) -> None:
    app = make_app(store)
    assert call(app, "POST", "/echo", json={"a": 1}).json() == {"a": 1}
    with_charset = {"Content-Type": "application/json; charset=utf-8"}
    assert call(app, "POST", "/echo", content=b'{"a": 2}', headers=with_charset).json() == {"a": 2}
    for content_type in (None, "text/plain", "application/x-www-form-urlencoded"):
        headers = {"Content-Type": content_type} if content_type else {}
        assert_error(call(app, "POST", "/echo", content=b'{"a": 1}', headers=headers), 415, "UNSUPPORTED_MEDIA_TYPE")
    big = b'{"pad": "' + b"x" * JSON_LIMIT + b'"}'
    body = assert_error(call(app, "POST", "/echo", content=big, headers=JSON), 413, "PAYLOAD_TOO_LARGE")
    assert body["details"] == {"limit_bytes": JSON_LIMIT}

    async def chunks() -> AsyncIterator[bytes]:  # no Content-Length: counted while reading
        yield b'{"pad": "'
        for _ in range(JSON_LIMIT // 1024 + 1):
            yield b"x" * 1024
        yield b'"}'

    assert_error(call(app, "POST", "/echo", content=chunks(), headers=JSON), 413, "PAYLOAD_TOO_LARGE")
    assert_error(call(app, "POST", "/echo", content=b'{"a": NaN}', headers=JSON), 422, "INVALID_ARGUMENT")
    deep = assert_error(call(app, "POST", "/echo", content=b"[" * 5000, headers=JSON), 422, "INVALID_ARGUMENT")
    assert "Traceback" not in json.dumps(deep)  # too deep for the parser: a client error, not a 500
    assert_error(call(app, "GET", "/count", params={"n": "11"}), 422, "INVALID_ARGUMENT")


def test_upload_limit_publishes_nothing(store: FileStore) -> None:
    app = make_app(store)
    resp = call(app, "POST", "/api/files", params={"media_type": "text/plain"}, content=b"hello")
    assert resp.status_code == 201, resp.text
    ref = resp.json()
    contracts.validate("FileRef", ref)
    ranged = call(app, "GET", f"/api/files/{ref['file_id'].upper()}", headers={"Range": "bytes=1-3"})
    assert ranged.status_code == 206 and ranged.content == b"ell" and ranged.headers["etag"] == f'"{ref["sha256"]}"'
    assert_error(
        call(app, "GET", f"/api/files/{ref['file_id']}", headers={"Range": "bytes=9-"}), 416, "RANGE_NOT_SATISFIABLE"
    )

    before = sorted(p.name for p in store.root.iterdir())
    over = b"y" * (UPLOAD_LIMIT + 1)
    assert_error(
        call(app, "POST", "/api/files", params={"media_type": "text/plain"}, content=over), 413, "PAYLOAD_TOO_LARGE"
    )

    async def chunks() -> AsyncIterator[bytes]:
        for _ in range(UPLOAD_LIMIT // 100 + 1):
            yield b"z" * 100

    assert_error(
        call(app, "POST", "/api/files", params={"media_type": "text/plain"}, content=chunks()), 413, "PAYLOAD_TOO_LARGE"
    )
    assert sorted(p.name for p in store.root.iterdir()) == before  # no file, no leftover .part directory
    bad = call(app, "POST", "/api/files", params={"media_type": "text/plain\r\nX-Evil: 1"}, content=b"x")
    assert_error(bad, 422, "INVALID_ARGUMENT")


def test_unexpected_error_hides_message_and_stack(store: FileStore, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR, logger="phasyn_server"):
        resp = call(make_app(store), "GET", "/boom")
    body = assert_error(resp, 500, "RUNTIME_ERROR")
    assert body == {
        "code": "RUNTIME_ERROR",
        "message": "主控內部錯誤：RuntimeError",
        "details": {"exception_type": "builtins.RuntimeError"},
    }
    assert "/srv/models" not in resp.text and "Traceback" not in resp.text
    assert "secret /srv/models/path" in caplog.text  # the detail stays in the log


def test_controller_refuses_cross_site_browser_writes(store: FileStore) -> None:
    app = make_app(store)
    for headers, status in (
        ({"Origin": "http://evil.example"}, 400),
        ({"Origin": "null"}, 400),
        ({"Sec-Fetch-Site": "cross-site"}, 400),  # even without Origin
        ({"Origin": "http://svc.test", "Sec-Fetch-Site": "same-origin"}, 200),
        ({}, 200),  # CLI, Nodes
    ):
        resp = call(app, "POST", "/echo", json={"a": 1}, headers=headers)
        assert resp.status_code == status, (headers, resp.text)
        assert "access-control-allow-origin" not in resp.headers
    assert call(app, "GET", "/count", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 200  # reads pass
    assert_error(call(app, "GET", "/missing"), 404, "NOT_FOUND")
    assert_error(call(app, "DELETE", "/count"), 405, "METHOD_NOT_ALLOWED")


def test_node_refuses_every_browser_request(store: FileStore) -> None:
    app = make_app(store, role="node")
    refused = (
        ("POST", "/echo", {"Origin": "http://example.com"}),
        ("POST", "/echo", {"Origin": "http://svc.test"}),  # even same-origin: browsers never talk to a Node
        ("GET", "/count", {"Sec-Fetch-Site": "same-origin"}),  # what a DNS-rebound page would send
        ("GET", "/count", {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors"}),
        ("POST", "/echo", {"Sec-Fetch-Site": "none"}),
    )
    for method, url, headers in refused:
        kwargs: dict[str, Any] = {"json": {"a": 1}} if method == "POST" else {}
        assert_error(call(app, method, url, headers=headers, **kwargs), 403, "BROWSER_REQUEST_REJECTED")
    assert call(app, "GET", "/count", headers={"Sec-Fetch-Site": "none"}).status_code == 200  # typed in the address bar
    assert call(app, "POST", "/echo", json={"a": 1}).json() == {"a": 1}  # httpx: no browser headers


def test_allowed_hosts(store: FileStore) -> None:
    app = make_app(store, role="node", allowed_hosts=["svc.test", "[::1]"])
    assert call(app, "GET", "/count").status_code == 200
    assert call(app, "GET", "/count", headers={"Host": "SVC.test:8090"}).status_code == 200
    assert call(app, "GET", "/count", headers={"Host": "[::1]:8090"}).status_code == 200
    assert_error(call(app, "GET", "/count", headers={"Host": "rebound.example"}), 400, "HOST_NOT_ALLOWED")
    assert_error(call(app, "GET", "/count", headers={"Host": "127.0.0.1:8090"}), 400, "HOST_NOT_ALLOWED")  # not listed


def test_hosts_without_allowed_hosts_are_local_only(store: FileStore) -> None:
    """The default answers IP literals, localhost and the service's own names, never a rebound DNS name."""
    roles: tuple[Role, ...] = ("controller", "node")
    for role in roles:
        app = make_app(store, role=role)
        for host in (
            "svc.test:8090",  # the host of advertise_url
            "SVC.TEST.",
            "127.0.0.1:8090",
            "192.0.2.20:8090",
            "[::1]:8090",
            "[2001:db8::1]:8090",
            "localhost:8090",
            "studio.localhost",
        ):
            assert call(app, "GET", "/count", headers={"Host": host}).status_code == 200, (role, host)
        for host in ("rebound.example:8090", "127.0.0.1.rebound.example", "localhost.rebound.example", "[::1", ""):
            assert_error(call(app, "GET", "/count", headers={"Host": host}), 400, "HOST_NOT_ALLOWED")
    # A rebound page is same-origin with its own requests: only the Host check stops its writes.
    rebound = {"Host": "rebound.example:8080", "Origin": "http://rebound.example:8080", "Sec-Fetch-Site": "same-origin"}
    assert_error(call(make_app(store), "POST", "/echo", json={"a": 1}, headers=rebound), 400, "HOST_NOT_ALLOWED")


def test_data_dir_lock_is_exclusive(tmp_path: Path) -> None:
    first = DataDirLock(tmp_path / "data")
    with first, pytest.raises(DataDirBusy, match=r"已被另一個程序使用（持有者 PID \d+）"):
        DataDirLock(tmp_path / "data").acquire()
    assert (tmp_path / "data").stat().st_mode & 0o777 == 0o700  # a new data directory is private to its owner
    with DataDirLock(tmp_path / "data") as again:  # released → free again
        assert again.held
