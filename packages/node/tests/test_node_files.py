"""檔案端點：串流上傳、單一 Range、416、只公開已發布檔、file_id 必須是 UUID。"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

import pytest
from node_testkit import assert_valid, make_config, running_node


pytestmark = pytest.mark.anyio


async def test_upload_and_single_range_download(tmp_path: Path) -> None:
    config = make_config(tmp_path, file_buffer_bytes=65536)
    async with running_node(config) as node:
        data = bytes(range(256)) * 400  # 102400 bytes，跨多個 64 KiB buffer
        created = await node.client.post(
            "/api/files", params={"media_type": "video/mp4"}, content=data
        )
        assert created.status_code == 201, created.text
        ref = created.json()
        assert_valid("FileRef", ref)
        assert ref["node_id"] == config.node_id and ref["size_bytes"] == len(data)
        assert (
            ref["sha256"] == hashlib.sha256(data).hexdigest()
            and ref["media_type"] == "video/mp4"
        )
        url = f"/api/files/{ref['file_id']}"

        full = await node.client.get(url)
        assert full.status_code == 200 and full.content == data
        assert full.headers["content-length"] == str(len(data))
        assert full.headers["accept-ranges"] == "bytes"
        assert full.headers["content-type"] == "video/mp4"
        assert "content-encoding" not in full.headers

        # Range handling is shared (phasyn_server); here only the wiring of the Node's route.
        part = await node.client.get(url, headers={"Range": "bytes=102000-"})
        assert part.status_code == 206 and part.content == data[102000:]
        assert (
            part.headers["content-range"] == f"bytes 102000-{len(data) - 1}/{len(data)}"
        )
        bad = await node.client.get(url, headers={"Range": "bytes=0-1,5-6"})
        assert bad.status_code == 416 and bad.json()["code"] == "RANGE_NOT_SATISFIABLE"
        assert bad.headers["content-range"] == f"bytes */{len(data)}"

        not_uuid = await node.client.get("/api/files/..%2Fconfig")
        assert not_uuid.status_code in (404, 422)
        not_uuid = await node.client.get("/api/files/not-a-uuid")
        assert (
            not_uuid.status_code == 422
            and not_uuid.json()["code"] == "INVALID_ARGUMENT"
        )
        unknown = await node.client.get(f"/api/files/{uuid.uuid4()}")
        assert unknown.status_code == 404 and unknown.json()["code"] == "FILE_NOT_FOUND"

        # 寫入中的 `.part` 不對外可讀
        file_id, part_path = node.service.store.reserve()
        part_path.write_bytes(b"half a video")
        assert (await node.client.get(f"/api/files/{file_id}")).status_code == 404

        no_type = await node.client.post("/api/files", content=b"x")
        assert (
            no_type.status_code == 422 and no_type.json()["code"] == "INVALID_ARGUMENT"
        )
        empty = await node.client.post(
            "/api/files", params={"media_type": "application/octet-stream"}, content=b""
        )
        assert empty.status_code == 201 and empty.json()["size_bytes"] == 0
        assert (
            await node.client.get(f"/api/files/{empty.json()['file_id']}")
        ).content == b""
        unknown_route = await node.client.get("/api/nope")
        assert (
            unknown_route.status_code == 404
            and unknown_route.json()["code"] == "NOT_FOUND"
        )


async def test_delete_published_file(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    async with running_node(config) as node:
        created = await node.client.post(
            "/api/files", params={"media_type": "video/mp4"}, content=b"generated video"
        )
        assert created.status_code == 201, created.text
        file_id = created.json()["file_id"]
        url = f"/api/files/{file_id}"

        gone = await node.client.delete(url)
        assert gone.status_code == 200 and gone.json() == {
            "file_id": file_id,
            "deleted": True,
        }
        assert (await node.client.get(url)).status_code == 404
        assert not (node.service.store.root / file_id).exists()
        again = await node.client.delete(url)
        assert again.status_code == 404 and again.json()["code"] == "FILE_NOT_FOUND"
        bad = await node.client.delete("/api/files/not-a-uuid")
        assert bad.status_code == 422 and bad.json()["code"] == "INVALID_ARGUMENT"

        # 寫入中的 `.part` 不刪（元件程序仍在寫）
        reserved, part_path = node.service.store.reserve()
        part_path.write_bytes(b"half a video")
        busy = await node.client.delete(f"/api/files/{reserved}")
        assert (
            busy.status_code == 409
            and busy.json()["code"] == "STATE_CONFLICT"
            and part_path.exists()
        )
