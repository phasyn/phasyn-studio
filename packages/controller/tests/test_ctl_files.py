"""檔案：主控上傳（串流 SHA、FileRef node_id=主控）、單一 Range、媒體代理轉傳 Range 與狀態。"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from pathlib import Path

import pytest
from controller_support import (
    CONTROLLER_ID,
    ENDPOINT_A,
    NODE_A,
    FakeNode,
    Harness,
    descriptor,
)
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore

from phasyn_controller.studio_take_source import published


DATA = bytes(range(256)) * 4 + b"tail"  # 1028 bytes


def test_upload_and_local_ranges(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            resp = await h.client.post(
                "/api/files", params={"media_type": "video/mp4"}, content=DATA
            )
            assert resp.status_code == 201, resp.text
            ref = resp.json()
            contracts.validate("FileRef", ref)
            assert ref["node_id"] == CONTROLLER_ID and ref["size_bytes"] == len(DATA)
            assert ref["sha256"] == hashlib.sha256(DATA).hexdigest()
            fid = ref["file_id"]

            full = await h.client.get(f"/api/files/{fid}")
            assert full.status_code == 200 and full.content == DATA
            assert full.headers["accept-ranges"] == "bytes" and full.headers[
                "content-length"
            ] == str(len(DATA))
            assert full.headers["content-type"].startswith("video/mp4")

            for path in (f"/api/files/{fid}", f"/api/media/{CONTROLLER_ID}/{fid}"):
                part = await h.client.get(path, headers={"Range": "bytes=10-19"})
                assert part.status_code == 206 and part.content == DATA[10:20]
                assert (
                    part.headers["content-range"] == f"bytes 10-19/{len(DATA)}"
                    and part.headers["content-length"] == "10"
                )
            tail = await h.client.get(
                f"/api/files/{fid}", headers={"Range": "bytes=-4"}
            )
            assert tail.status_code == 206 and tail.content == b"tail"
            bad = await h.client.get(
                f"/api/files/{fid}", headers={"Range": "bytes=5000-6000"}
            )
            assert (
                bad.status_code == 416 and bad.json()["code"] == "RANGE_NOT_SATISFIABLE"
            )
            assert bad.headers["content-range"] == f"bytes */{len(DATA)}"

            assert (
                await h.client.post("/api/files", content=b"x")
            ).status_code == 422  # media_type 必填
            bad_type = await h.client.post(
                "/api/files",
                params={"media_type": "video/mp4\r\nX-Evil: 1"},
                content=b"x",
            )
            assert bad_type.status_code == 422
            missing = await h.client.get(f"/api/files/{uuid.uuid4()}")
            assert (
                missing.status_code == 404
                and missing.json()["code"] == "FILE_NOT_FOUND"
            )
            assert (await h.client.get("/api/files/..%2Fconfig")).status_code in (
                404,
                422,
            )

    asyncio.run(scenario())


def test_studio_probes_uploaded_files_and_rejects_changed_identity(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            upload = await h.client.post(
                "/api/files", params={"media_type": "application/json"}, content=DATA
            )
            assert upload.status_code == 201
            ref = upload.json()
            assert await published(h.ctl, ref) == DATA[:1]
            assert await published(h.ctl, ref, manifest=True) == DATA
            with pytest.raises(ComponentError) as changed:
                await published(h.ctl, {**ref, "sha256": "0" * 64})
            assert changed.value.code == "STATE_CONFLICT"

            path = h.ctl.files.payload_path(ref["file_id"])
            path.write_bytes(bytes(len(DATA)))
            with pytest.raises(ComponentError) as corrupt:
                await published(h.ctl, ref, manifest=True)
            assert corrupt.value.code == "STATE_CONFLICT"
            path.write_bytes(DATA[:1])
            with pytest.raises(ComponentError) as truncated:
                await published(h.ctl, ref)
            assert truncated.value.code == "STATE_CONFLICT"

    asyncio.run(scenario())


def test_media_proxy_passes_single_range_and_status(tmp_path: Path) -> None:
    async def scenario() -> None:
        node = FakeNode(NODE_A, ENDPOINT_A, [descriptor(NODE_A, "echo")])
        node.files = FileStore(tmp_path / "node", NODE_A)
        writer = node.files.new_writer("video/mp4")
        writer.write(DATA)
        ref = writer.commit()
        async with Harness(tmp_path / "ctl") as h:
            await h.add_node(node)
            url = f"/api/media/{NODE_A}/{ref['file_id']}"
            part = await h.client.get(url, headers={"Range": "bytes=100-199"})
            assert part.status_code == 206 and part.content == DATA[100:200]
            assert part.headers["content-range"] == f"bytes 100-199/{len(DATA)}"
            assert (
                part.headers["content-length"] == "100"
                and part.headers["accept-ranges"] == "bytes"
            )
            assert part.headers["content-type"].startswith("video/mp4")
            # served from the controller's origin: never sniffed, never run as a page
            assert part.headers["x-content-type-options"] == "nosniff"
            assert part.headers["content-security-policy"] == "sandbox"
            sent = h.router.seen("GET", f"/api/files/{ref['file_id']}")
            assert (
                len(sent) == 1 and sent[0].headers["range"] == "bytes=100-199"
            )  # 只轉一個 Range 標頭

            whole = await h.client.get(url)
            assert (
                whole.status_code == 200
                and whole.content == DATA
                and "range" not in h.router.requests[-1].headers
            )
            gone = await h.client.get(f"/api/media/{NODE_A}/{uuid.uuid4()}")
            assert (
                gone.status_code == 404 and gone.json()["code"] == "FILE_NOT_FOUND"
            )  # Node 的狀態與本文原樣轉回
            unknown = await h.client.get(f"/api/media/{uuid.uuid4()}/{ref['file_id']}")
            assert (
                unknown.status_code == 503
                and unknown.json()["code"] == "NODE_UNREACHABLE"
            )
            h.router.unmount(ENDPOINT_A)
            down = await h.client.get(url)
            assert down.status_code == 503 and not down.json().get(
                "remote_outcome_unknown"
            )

    asyncio.run(scenario())
