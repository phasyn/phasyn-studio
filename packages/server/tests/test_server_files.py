"""The file endpoints both ends share (``phasyn_server.files``): one table of Range / 416 cases and the interrupted
upload, maintained here once. The controller and Node tests only check that their routes use these functions."""

from __future__ import annotations

import asyncio
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
from phasyn_server import HostPolicy, HttpLimits, create_api
from phasyn_server.files import file_response, receive_upload
from phasyn_server.http import json_response
from starlette.responses import JSONResponse, Response

DATA = bytes(range(256)) * 400  # 102400 bytes: several upload buffers
SIZE = len(DATA)

RANGES = [  # (Range header, first byte, last byte)
    ("bytes=10-19", 10, 19),
    ("bytes=0-0", 0, 0),
    ("bytes=-5", SIZE - 5, SIZE - 1),  # suffix
    ("bytes=-999999", 0, SIZE - 1),  # suffix longer than the file
    ("bytes=102000-", 102000, SIZE - 1),  # open end
    ("bytes=0-999999", 0, SIZE - 1),  # end past the file is clamped
    (" bytes=1-2 ", 1, 2),
]


def make_app(store: FileStore) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield

    app = create_api(
        title="files",
        version="0",
        role="node",
        limits=HttpLimits(64 * 1024, 10**6),
        lifespan=lifespan,
        hosts=HostPolicy.local(advertise_url="http://svc.test"),
    )
    router = APIRouter()

    @router.post("/api/files")
    async def upload(request: Request) -> JSONResponse:
        return json_response(await receive_upload(store, request, buffer_bytes=4096), status_code=201)

    @router.get("/api/files/{file_id}")
    async def download(file_id: str, request: Request) -> Response:
        return await file_response(store, file_id, request.headers.get("range"))

    app.include_router(router)
    return app


async def request(app: FastAPI, method: str, url: str, **kwargs: Any) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://svc.test") as client:
        return await client.request(method, url, **kwargs)


@pytest.fixture
def store(tmp_path: Path) -> FileStore:
    return FileStore(tmp_path / "data", ids.NODE_A_ID)


@pytest.fixture
def uploaded(store: FileStore) -> tuple[FastAPI, dict[str, Any]]:
    app = make_app(store)
    created = asyncio.run(request(app, "POST", "/api/files", params={"media_type": "video/mp4"}, content=DATA))
    assert created.status_code == 201, created.text
    ref: dict[str, Any] = created.json()
    contracts.validate("FileRef", ref)
    return app, ref


@pytest.mark.parametrize(("header", "first", "last"), RANGES)
def test_single_byte_range(uploaded: tuple[FastAPI, dict[str, Any]], header: str, first: int, last: int) -> None:
    app, ref = uploaded
    part = asyncio.run(request(app, "GET", f"/api/files/{ref['file_id']}", headers={"Range": header}))
    assert part.status_code == 206, part.text
    assert part.content == DATA[first : last + 1]
    assert part.headers["content-range"] == f"bytes {first}-{last}/{SIZE}"
    assert part.headers["content-length"] == str(last - first + 1)
    assert part.headers["etag"] == f'"{ref["sha256"]}"' and part.headers["accept-ranges"] == "bytes"
    assert part.headers["x-content-type-options"] == "nosniff" and part.headers["content-security-policy"] == "sandbox"


async def raw_upload(app: FastAPI, chunks: list[bytes]) -> list[dict[str, Any]]:
    """Drive the ASGI app directly: the client sends ``chunks`` and then disconnects."""
    incoming: list[dict[str, Any]] = [{"type": "http.request", "body": chunk, "more_body": True} for chunk in chunks]
    incoming.append({"type": "http.disconnect"})
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return incoming.pop(0) if incoming else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/files",
        "raw_path": b"/api/files",
        "query_string": b"media_type=application%2Foctet-stream",
        "root_path": "",
        "headers": [(b"host", b"svc.test"), (b"content-length", str(SIZE).encode())],
        "client": ("192.0.2.10", 40000),
        "server": ("svc.test", 80),
    }
    await app(scope, receive, send)
    return sent


def test_an_interrupted_upload_publishes_nothing(store: FileStore) -> None:
    app = make_app(store)
    sent = asyncio.run(raw_upload(app, [DATA[:5000], DATA[5000:9000]]))
    start = next(message for message in sent if message["type"] == "http.response.start")
    assert start["status"] == 422  # FILE_TRUNCATED: not resumed, nothing published
    assert b"FILE_TRUNCATED" in b"".join(message.get("body", b"") for message in sent)
    assert not any(store.root.iterdir())  # no published file and no partial directory left behind
