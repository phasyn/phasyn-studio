"""invoke round trip：inline 與 FileRef 輸入、輸出發布、兩個 stream 的 recording。"""

from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

import httpx
import pytest
from node_testkit import (
    Router,
    assert_valid,
    echo_definition,
    invoke_body,
    make_config,
    read_stream,
    running_node,
    wait_until,
)


pytestmark = pytest.mark.anyio


async def test_remote_fileref_download_reuse_and_integrity(tmp_path: Path) -> None:
    router = Router()
    config_b = make_config(tmp_path, name="node-b")
    config_a = make_config(
        tmp_path, name="node-a", components=[echo_definition("echo")]
    )
    async with running_node(config_b, router) as node_b:
        router.add("node-b.test:8090", httpx.ASGITransport(app=node_b.app))
        payload = os.urandom(1_200_000)
        ref_b = (
            await node_b.client.post(
                "/api/files", params={"media_type": "video/mp4"}, content=payload
            )
        ).json()
        assert_valid("FileRef", ref_b)
        await wait_until(
            lambda: config_b.node_id in router.controller.nodes, what="node-b 登記"
        )
        async with running_node(config_a, router) as node_a:
            await wait_until(
                lambda: node_a.service.directory.endpoint_for(config_b.node_id),
                what="位址目錄",
            )
            await node_a.start_ready("echo")

            first = (await node_a.invoke("echo", invoke_body(file=ref_b))).json()
            assert_valid("InvokeResult", first)
            assert first["state"] == "succeeded", first
            out = first["outputs"]["value"]["file"]
            assert (
                out["node_id"] == config_a.node_id
                and out["sha256"] == hashlib.sha256(payload).hexdigest()
            )
            metrics = first["summary"]["metrics"]
            assert metrics["network_received_bytes"]["value"] == len(payload)
            network = first["summary"]["transfer_totals"]["network"]
            assert (
                network["completed_bytes"] == len(payload)
                and network["completed_count"] == 1
            )
            rdir = config_a.data_dir / "recordings" / first["recording_id"]
            net_events = [
                e["data"]
                for e in read_stream(rdir, "node")
                if e["kind"] == "transfer" and e["data"]["category"] == "network"
            ]
            assert len(net_events) == 1
            assert (
                net_events[0]["owner"] == "consumer"
                and net_events[0]["byte_basis"] == "http_entity"
            )
            assert net_events[0]["completed_bytes"] == len(payload)
            cache = (
                config_a.data_dir
                / "files"
                / "remote"
                / config_b.node_id
                / ref_b["file_id"]
                / "payload"
            )
            assert cache.read_bytes() == payload

            # 已驗證的遠端副本直接重用：network=0
            second = (await node_a.invoke("echo", invoke_body(file=ref_b))).json()
            assert second["state"] == "succeeded"
            assert second["summary"]["metrics"]["network_received_bytes"]["value"] == 0
            assert "network" not in second["summary"]["transfer_totals"]

            # 完整性錯誤：不 fallback，呼叫失敗並帶原因
            bad_hash = (
                await node_a.invoke(
                    "echo", invoke_body(file={**ref_b, "sha256": "0" * 64})
                )
            ).json()
            assert_valid("InvokeResult", bad_hash)
            assert (
                bad_hash["state"] == "failed"
                and bad_hash["error"]["code"] == "FILE_HASH_MISMATCH"
            )
            too_long = (
                await node_a.invoke(
                    "echo", invoke_body(file={**ref_b, "size_bytes": len(payload) + 7})
                )
            ).json()
            assert (
                too_long["state"] == "failed"
                and too_long["error"]["code"] == "FILE_TRUNCATED"
            )
            gone = (
                await node_a.invoke(
                    "echo", invoke_body(file={**ref_b, "file_id": str(uuid.uuid4())})
                )
            ).json()
            assert (
                gone["state"] == "failed" and gone["error"]["code"] == "FILE_NOT_FOUND"
            )
            stranger = (
                await node_a.invoke(
                    "echo", invoke_body(file={**ref_b, "node_id": str(uuid.uuid4())})
                )
            ).json()
            assert (
                stranger["state"] == "failed"
                and stranger["error"]["code"] == "NODE_UNREACHABLE"
            )
            assert (await node_a.component("echo"))["state"] == "ready"
            assert not list(
                (config_a.data_dir / "files" / "remote").rglob("payload.part")
            )
    assert not router.controller.problems, router.controller.problems[:5]
