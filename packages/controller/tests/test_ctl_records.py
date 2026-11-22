"""紀錄：上報去重、補抓 Node 歷史（只 GET、不改 run）、匯出（CSV 防公式、ZIP 內容）、比較與查詢。"""

from __future__ import annotations

import asyncio
import copy
import csv
import io
import json
import uuid
import zipfile
from pathlib import Path
from typing import Any

from controller_support import ENDPOINT_A, NODE_A, FakeNode, Harness, descriptor
from phasyn_components import contracts
from phasyn_components.recorder import Recorder
from phasyn_components.records import RecordingStore
from phasyn_components.testing import ids


PID = ids.uid(3)


# Fixtures set the recording stream, event count, lifecycle and environment independently.
def record(  # noqa: PLR0913
    root: Path,
    rid: str,
    *,
    stream: str = "runtime",
    events: int = 5,
    context: bool = True,
    final: bool = True,
    environment: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """用真的 Recorder 寫一份 recording（本機 JSONL），回傳它送給 publisher 的 records。"""
    published: list[dict[str, Any]] = []

    def publish(record: dict[str, Any]) -> bool:
        published.append(record)
        return True

    rec = Recorder(
        recordings_root=root,
        recording_id=rid,
        stream_id=stream,
        node_id=NODE_A,
        component_id="echo",
        provider_id="test.echo",
        process_instance_id=PID,
        operation="invoke",
        call_id=str(uuid.uuid4()),
        config={"mode": "detailed"},
        publish=publish,
    )
    if context:
        rec.write_context(
            settings=None, input_summary={}, environment=environment or {"test": True}
        )
    for i in range(events):
        rec.log("info", f"{stream} 事件 {i}", index=i)
    rec.finalize("succeeded", write=final)
    return published


def batch_of(
    records: list[dict[str, Any]], *, events: slice | None = None
) -> dict[str, Any]:
    evs = [r["data"] for r in records if r["record"] == "event"]
    batch = {
        "node_id": NODE_A,
        "contexts": [r["data"] for r in records if r["record"] == "context"],
        "events": evs[events] if events is not None else evs,
        "summaries": [r["data"] for r in records if r["record"] == "summary"],
    }
    contracts.validate("EventBatch", batch)
    return batch


def test_telemetry_batch_dedup(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            rid = str(uuid.uuid4())
            batch = batch_of(record(tmp_path / "node", rid, events=6))
            n = len(batch["events"])
            first = (await h.client.post("/api/telemetry/batches", json=batch)).json()
            second = (await h.client.post("/api/telemetry/batches", json=batch)).json()
            for ack in (first, second):
                contracts.validate("BatchAck", ack)
            assert (
                first["accepted_events"],
                first["duplicate_events"],
                first["rejected_events"],
            ) == (n, 0, 0)
            assert (
                second["accepted_events"],
                second["duplicate_events"],
                second["rejected_events"],
            ) == (0, n, 0)
            page = (
                await h.client.get(
                    f"/api/recordings/{rid}/events",
                    params={"stream_id": "runtime", "limit": 2000},
                )
            ).json()
            contracts.validate("EventPage", page)
            assert [e["seq"] for e in page["events"]] == list(range(1, n + 1)) and page[
                "gap"
            ] is False

            tampered = copy.deepcopy(batch)
            tampered["contexts"], tampered["summaries"] = [], []
            tampered["events"] = [dict(tampered["events"][0], level="error")]
            ack = (await h.client.post("/api/telemetry/batches", json=tampered)).json()
            assert (
                ack["rejected_events"] == 1 and "CORRUPT_RECORD" in ack["message"]
            )  # 同鍵不同內容：不覆蓋
            page = (
                await h.client.get(
                    f"/api/recordings/{rid}/events",
                    params={"stream_id": "runtime", "limit": 1},
                )
            ).json()
            assert page["events"][0]["level"] == "info"

            resp = await h.client.post(
                "/api/telemetry/batches", json={"node_id": NODE_A, "events": []}
            )
            assert resp.status_code == 422 and resp.json()["code"] == "INVALID_ARGUMENT"
            assert resp.json()["details"]["errors"]

    asyncio.run(scenario())


def test_fetch_history_imports_missing_events_with_get_only(tmp_path: Path) -> None:
    async def scenario() -> None:
        node_root = tmp_path / "node" / "recordings"
        rid = str(uuid.uuid4())
        runtime = record(node_root, rid, stream="runtime", events=10)
        record(node_root, rid, stream="node", events=4, context=False, final=False)
        node_store = RecordingStore(node_root, tmp_path / "node" / "index.sqlite")
        node_store.index_local()
        node = FakeNode(NODE_A, ENDPOINT_A, [descriptor(NODE_A, "echo")])
        node.store = node_store
        async with Harness(tmp_path / "ctl") as h:
            await h.add_node(node)
            # 主控只收到部分上報（context+runtime 前 3 筆），其餘批次遺失
            partial = batch_of(runtime, events=slice(0, 3))
            partial["summaries"] = []
            await h.client.post("/api/telemetry/batches", json=partial)
            runtime_total = len([r for r in runtime if r["record"] == "event"])

            resp = await h.client.post(
                f"/api/recordings/{rid}/fetch-history", json={"node_id": NODE_A}
            )
            assert resp.status_code == 200, resp.text
            result = resp.json()
            contracts.validate("FetchHistoryResult", result)
            assert result["recording_id"] == rid
            assert result["imported_events"] == (runtime_total - 3) + 4
            assert result["still_partial"] is False, result["message"]

            for stream, count in (("runtime", runtime_total), ("node", 4)):
                page = (
                    await h.client.get(
                        f"/api/recordings/{rid}/events",
                        params={"stream_id": stream, "limit": 2000},
                    )
                ).json()
                assert len(page["events"]) == count and page["gap"] is False
            resp = await h.client.get(f"/api/recordings/{rid}/events")
            assert resp.status_code == 400 and resp.json()["code"] == "AMBIGUOUS_STREAM"
            assert {s["stream_id"] for s in resp.json()["details"]["streams"]} == {
                "runtime",
                "node",
            }
            summary = (await h.client.get(f"/api/recordings/{rid}")).json()["summary"]
            assert (
                summary["state"] == "succeeded" and summary["context_available"] is True
            )

            again = (
                await h.client.post(
                    f"/api/recordings/{rid}/fetch-history", json={"node_id": NODE_A}
                )
            ).json()
            assert (
                again["imported_events"] == 0 and again["still_partial"] is False
            )  # 去重

            node_requests = h.router.seen(host="node-a")
            assert node_requests and {r.method for r in node_requests} == {
                "GET"
            }  # 只讀，不 invoke／control／run
            assert all(
                r.url.path.startswith(f"/api/recordings/{rid}") for r in node_requests
            )
            assert node.calls == [] and node.cancels == []
            assert (await h.client.get("/api/runs")).json()["items"] == []

            # 主控沒收到的 recording：唯讀轉送 Node 本機列表找出 id（extension）；只轉送已知篩選鍵
            listed = await h.client.get(
                f"/api/nodes/{NODE_A}/recordings",
                params={"component_id": "echo", "operation": "invoke", "bogus": "1"},
            )
            assert listed.status_code == 200, listed.text
            assert [i["context"]["recording_id"] for i in listed.json()["items"]] == [
                rid
            ]
            assert node.recording_queries[-1] == {
                "component_id": "echo",
                "operation": "invoke",
                "node_id": NODE_A,
            }
            assert {r.method for r in h.router.seen(host="node-a")} == {"GET"}

            h.router.unmount(ENDPOINT_A)
            down = (
                await h.client.post(
                    f"/api/recordings/{rid}/fetch-history", json={"node_id": NODE_A}
                )
            ).json()
            contracts.validate("FetchHistoryResult", down)
            assert down["still_partial"] is True and down["imported_events"] == 0
            unknown = await h.client.post(
                f"/api/recordings/{rid}/fetch-history",
                json={"node_id": str(uuid.uuid4())},
            )
            assert (
                unknown.status_code == 503
                and unknown.json()["code"] == "NODE_UNREACHABLE"
            )

    asyncio.run(scenario())


def test_exports_csv_escaping_zip_jsonl_trace(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            rid = str(uuid.uuid4())
            environment = {
                "test": True,
                "hostname": "workstation.example",
                "weights": "/srv/models/demo/w.safetensors",
            }
            batch = batch_of(
                record(tmp_path / "node", rid, events=3, environment=environment)
            )
            batch["summaries"][0]["metrics"]["test.formula"] = {
                "value": 1,
                "unit": "=1+1",
                "quality": "instrumented",
                "scope": "+scope",
                "method": "-method",
                "reason": "@SUM(A1)",
            }
            contracts.validate("EventBatch", batch)
            await h.client.post("/api/telemetry/batches", json=batch)

            resp = await h.client.get(
                f"/api/recordings/{rid}/export", params={"format": "csv"}
            )
            assert resp.status_code == 200
            assert (
                resp.headers["content-disposition"]
                == f'attachment; filename="recording-{rid}.csv"'
            )
            rows = list(csv.DictReader(io.StringIO(resp.text)))
            formula = next(r for r in rows if r["metric"] == "test.formula")
            assert (
                formula["unit"],
                formula["scope"],
                formula["method"],
                formula["reason"],
            ) == (
                "'=1+1",
                "'+scope",
                "'-method",
                "'@SUM(A1)",
            )

            resp = await h.client.get(
                f"/api/recordings/{rid}/export", params={"format": "zip"}
            )
            assert resp.status_code == 200 and resp.headers[
                "content-disposition"
            ].startswith("attachment;")
            names = set(zipfile.ZipFile(io.BytesIO(resp.content)).namelist())
            assert {
                "README.txt",
                "context.json",
                "summary.json",
                "settings_diff.json",
                "events/runtime.jsonl",
            } <= names

            resp = await h.client.get(
                f"/api/recordings/{rid}/export", params={"format": "jsonl"}
            )
            kinds = [json.loads(line)["record"] for line in resp.text.splitlines()]
            assert (
                kinds[0] == "context"
                and kinds[-1] == "summary"
                and kinds.count("event") == len(batch["events"])
            )

            resp = await h.client.get(
                f"/api/recordings/{rid}/export", params={"format": "trace"}
            )
            assert (
                resp.status_code == 404 and resp.json()["code"] == "TRACE_UNAVAILABLE"
            )
            resp = await h.client.get(
                f"/api/recordings/{rid}/export", params={"format": "pdf"}
            )
            assert resp.status_code == 422

            # C3: repeatable redact categories reach the exporter; unknown ones and redacted traces are refused
            plain = await h.client.get(
                f"/api/recordings/{rid}/export", params={"format": "jsonl"}
            )
            masked = await h.client.get(
                f"/api/recordings/{rid}/export",
                params=[
                    ("format", "jsonl"),
                    ("redact", "hostname"),
                    ("redact", "paths"),
                ],
            )
            assert (
                "workstation.example" in plain.text and "/srv/models/demo" in plain.text
            )
            assert (
                masked.status_code == 200 and "workstation.example" not in masked.text
            )
            assert (
                "/srv/models/demo" not in masked.text and "w.safetensors" in masked.text
            )  # paths keep the file name
            bad = await h.client.get(
                f"/api/recordings/{rid}/export",
                params={"format": "zip", "redact": "secrets"},
            )
            assert bad.status_code == 422 and bad.json()["details"]["field"] == "redact"
            refused = await h.client.get(
                f"/api/recordings/{rid}/export",
                params={"format": "trace", "redact": "all"},
            )
            assert refused.status_code == 422

    asyncio.run(scenario())
