"""Recording index and exports, and the CPU providers (including a real component process)."""

from __future__ import annotations

import io
import uuid
import zipfile
from pathlib import Path

import pytest
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.recorder import Recorder
from phasyn_components.records import RecordingStore, export
from phasyn_components.testing.ids import NODE_A_ID

NODE = NODE_A_ID


def _recording(root: Path, *, component: str = "c") -> str:
    rid = str(uuid.uuid4())
    rec = Recorder(
        recordings_root=root,
        recording_id=rid,
        stream_id="runtime",
        node_id=NODE,
        component_id=component,
        provider_id="p",
        process_instance_id=str(uuid.uuid4()),
        operation="invoke",
        config={"mode": "detailed"},
    )
    rec.write_context(settings=None)
    rec.set_metric("output_frame_count", 3, unit="count")
    rec.log("info", "=cmd|calc")
    rec.finalize("succeeded")
    return rid


def test_index_pagination_dedup_and_exports(tmp_path: Path) -> None:
    root = tmp_path / "recordings"
    ids = [_recording(root) for _ in range(5)]
    store = RecordingStore(root)
    store.index_local()
    seen: list[str] = []
    cursor = None
    while True:
        page = store.list({}, cursor=cursor, limit=2)
        contracts.validate("RecordingPage", page)
        seen += [i["context"]["recording_id"] for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert sorted(seen) == sorted(ids) and len(seen) == len(set(seen))
    # Controller 端：同一 batch 收兩次 → 事件不重複；同鍵不同內容 → rejected
    copy = RecordingStore(tmp_path / "controller" / "recordings")
    events = store.events(ids[0], stream_id="runtime")["events"]
    batch = {
        "node_id": NODE,
        "contexts": [store.read_context(ids[0])],
        "events": events,
        "summaries": [store.read_summary(ids[0])],
    }
    first = copy.ingest_batch(batch)
    second = copy.ingest_batch(batch)
    assert (
        first["accepted_events"] == len(events)
        and second["duplicate_events"] == len(events)
        and second["accepted_events"] == 0
    )
    tampered = dict(events[0], level="error")
    assert (
        copy.ingest_batch({"node_id": NODE, "contexts": [], "events": [tampered], "summaries": []})["rejected_events"]
        == 1
    )
    assert len(copy.events(ids[0], stream_id="runtime")["events"]) == len(events)
    csv_text = b"".join(export(store, ids[0], "csv").chunks).decode()
    assert "cmd|calc" not in csv_text  # log messages never reach the metric long table
    rows = csv_text.splitlines()
    assert rows[0] == "recording,node,component,metric,value,unit,quality,method,scope,reason"
    assert any(row.split(",")[3] == "output_frame_count" for row in rows[1:])
    zdata = b"".join(export(store, ids[0], "zip").chunks)
    names = set(zipfile.ZipFile(io.BytesIO(zdata)).namelist())
    assert {"README.txt", "context.json", "summary.json", "settings_diff.json", "events/runtime.jsonl"} <= names
    with pytest.raises(ComponentError) as err:
        export(store, ids[0], "trace")
    assert err.value.code == "TRACE_UNAVAILABLE" and err.value.status == 404


def test_csv_formula_escape() -> None:
    from phasyn_components.records.export import csv_safe

    assert [csv_safe(v) for v in ("=1+1", "+x", "-y", "@z", "ok", 5)] == ["'=1+1", "'+x", "'-y", "'@z", "ok", 5]
