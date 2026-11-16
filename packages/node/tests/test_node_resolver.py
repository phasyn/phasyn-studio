"""Materialising a FileRef from another Node: concurrent requests download once, and a body that is too long or
cut off never becomes a visible copy (no resume, no retry)."""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.testing import ids
from phasyn_node.files import Directory, FileResolver

pytestmark = pytest.mark.anyio

ENDPOINT_B = "http://node-b:8090"
DATA = b"synthetic file body " * 512


def streamed(data: bytes) -> httpx.Response:
    """A streamed body, as a real transport delivers it (``content=`` would be read up front)."""
    return httpx.Response(200, stream=httpx.ByteStream(data))


def published_on_b(tmp_path: Path) -> dict[str, Any]:
    store = FileStore(tmp_path / "b", ids.NODE_B_ID)
    file_id, part = store.reserve()
    part.write_bytes(DATA)
    return store.publish_reserved(
        file_id,
        media_type="application/octet-stream",
        metadata={},
        size=len(DATA),
        sha256=hashlib.sha256(DATA).hexdigest(),
    )


def resolver(tmp_path: Path, handler: Any) -> tuple[FileResolver, FileStore]:
    store = FileStore(tmp_path / "a", ids.NODE_A_ID)
    directory = Directory(node_id=ids.NODE_A_ID, advertise_url="http://node-a:8090", controller_url="http://ctl:8080")
    directory.update({"nodes": [{"node_id": ids.NODE_B_ID, "endpoint": ENDPOINT_B, "state": "online"}]})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return FileResolver(
        store=store, directory=directory, node_id=ids.NODE_A_ID, client=client, buffer_bytes=1024, concurrency=4
    ), store


class CutOff(httpx.AsyncByteStream):
    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield DATA[:1000]
        raise httpx.ReadError("connection reset by peer")


@pytest.mark.parametrize(
    ("response", "fragment"),
    [
        (lambda: streamed(DATA + b"extra"), "超過"),
        (lambda: httpx.Response(200, stream=CutOff()), "連線中斷"),
    ],
)
async def test_a_bad_body_never_becomes_a_copy(tmp_path: Path, response: Any, fragment: str) -> None:
    ref = published_on_b(tmp_path)
    calls = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        result: httpx.Response = response()
        return result

    files, store = resolver(tmp_path, handler)
    with pytest.raises(ComponentError) as failed:
        await files.materialize(ref)
    assert failed.value.code == "FILE_TRUNCATED" and fragment in failed.value.message
    assert calls == 1 and store.remote_copy(ref) is None  # not retried, nothing half-written is visible
