"""使用者明確要求的刪除：RecordingStore.delete 清掉所有索引表與 recording 目錄、ids_for_run；
FileStore.delete 只刪已發布檔（寫入中拒絕）。"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import pytest

from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.recorder import Recorder
from phasyn_components.records import RecordingStore
from phasyn_components.records.store import RECORDING_TABLES


NODE = str(uuid.uuid4())


def _record(root: Path, run_id: str | None) -> str:
    rid = str(uuid.uuid4())
    rec = Recorder(
        recordings_root=root,
        recording_id=rid,
        stream_id="runtime",
        node_id=NODE,
        component_id="c",
        provider_id="p",
        process_instance_id=str(uuid.uuid4()),
        operation="invoke",
        run_id=run_id,
        config={"mode": "detailed"},
    )
    rec.write_context(settings=None)
    rec.log("info", "事件")
    rec.finalize("succeeded")
    return rid


def _rows(store: RecordingStore, rid: str) -> dict[str, int]:
    statements = {
        "events": "SELECT COUNT(*) FROM events WHERE recording_id=?",
        "stream_files": "SELECT COUNT(*) FROM stream_files WHERE recording_id=?",
        "corrupt": "SELECT COUNT(*) FROM corrupt WHERE recording_id=?",
        "recordings": "SELECT COUNT(*) FROM recordings WHERE recording_id=?",
    }
    assert set(statements) == set(RECORDING_TABLES)
    return {
        table: store._db.execute(sql, (rid,)).fetchone()[0]
        for table, sql in statements.items()
    }


def test_recording_store_delete_removes_all_index_rows_and_files(
    tmp_path: Path,
) -> None:
    run_a, run_b = str(uuid.uuid4()), str(uuid.uuid4())
    source = RecordingStore(tmp_path / "node", tmp_path / "node.sqlite")
    a1, a2, b1 = (
        _record(source.root, run_a),
        _record(source.root, run_a),
        _record(source.root, run_b),
    )
    source.index_local()
    store = RecordingStore(tmp_path / "ctl" / "recordings", tmp_path / "ctl.sqlite")
    for rid in (a1, a2, b1):  # 主控收到的副本
        events = source.events(rid, stream_id="runtime", limit=2000)["events"]
        batch = {
            "node_id": NODE,
            "contexts": [source.read_context(rid)],
            "events": events,
        }
        store.ingest_batch({**batch, "summaries": [source.read_summary(rid)]})
    first = source.events(a1, stream_id="runtime", limit=1)["events"][0]
    assert (
        store.ingest_batch({"node_id": NODE, "events": [dict(first, level="error")]})[
            "rejected_events"
        ]
        == 1
    )

    assert sorted(store.ids_for_run(run_a)) == sorted([a1, a2]) and store.ids_for_run(
        run_b
    ) == [b1]
    assert all(_rows(store, a1).values())  # 四個資料表都有 a1（含 corrupt）
    assert store.delete(a1) is True
    assert _rows(store, a1) == dict.fromkeys(RECORDING_TABLES, 0)
    assert not store.directory(a1).exists() and not list(store.root.glob(".deleted-*"))
    assert store.ids_for_run(run_a) == [a2]
    with pytest.raises(ComponentError) as err:
        store.get(a1)
    assert err.value.code == "RECORDING_NOT_FOUND"
    assert store.delete(a1) is False
    assert len(store.events(b1, stream_id="runtime")["events"]) == len(
        source.events(b1, stream_id="runtime")["events"]
    )

    shutil.rmtree(store.directory(a2))  # 只剩索引列
    assert (
        store.delete(a2) is True
        and store.ids_for_run(run_a) == []
        and not any(_rows(store, a2).values())
    )
    orphan = _record(store.root, run_a)  # 只有檔案、尚未索引
    assert store.delete(orphan) is True and not store.directory(orphan).exists()
    assert [r["context"]["recording_id"] for r in store.list({})["items"]] == [b1]
    assert (
        source.get(a1)["summary"]["state"] == "succeeded"
    )  # 來源（Node 本機）不受影響


def test_file_store_delete_only_published_files(tmp_path: Path) -> None:
    store = FileStore(tmp_path, NODE)
    writer = store.new_writer("video/mp4")
    writer.write(b"x" * 10)
    ref = writer.commit()
    assert store.delete(ref["file_id"]) is True
    assert (
        store.meta(ref["file_id"]) is None
        and not store.directory(ref["file_id"]).exists()
    )
    assert not list(store.root.glob(".deleted-*"))
    assert (
        store.delete(ref["file_id"]) is False
        and store.delete(str(uuid.uuid4())) is False
    )

    file_id, part = store.reserve()  # 元件程序仍在寫入
    part.write_bytes(b"half")
    with pytest.raises(ComponentError) as err:
        store.delete(file_id)
    assert err.value.code == "STATE_CONFLICT" and part.exists()
    with pytest.raises(ComponentError) as err:
        store.delete("../config")
    assert err.value.code == "INVALID_ARGUMENT"
