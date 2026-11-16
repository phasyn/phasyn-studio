"""RecordingStore: ingest that survives a failed batch, segment rollover, rebuild and cursor checks."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest
from phasyn_components.recorder import Recorder
from phasyn_components.records import RecordingStore
from phasyn_components.records import store as store_module
from phasyn_components.testing.ids import NODE_A_ID, uid

RID = uid(100)


def _event(seq: int, message: str = "synthetic") -> dict[str, Any]:
    return {
        "recording_id": RID,
        "stream_id": "runtime",
        "node_id": NODE_A_ID,
        "component_id": "c",
        "process_instance_id": uid(101),
        "run_id": None,
        "call_id": None,
        "occurred_at": "2026-10-19T00:00:00Z",
        "level": "info",
        "seq": seq,
        "monotonic_ns": str(seq * 1000),
        "kind": "log",
        "data": {"message": f"{message} {seq}"},
    }


class _FailingDb:
    """Delegates to the real connection but fails the N-th event insert (a disk error mid-batch)."""

    def __init__(self, db: sqlite3.Connection, fail_on_insert: int) -> None:
        self._db = db
        self._left = fail_on_insert

    def execute(self, sql: str, *args: Any) -> Any:
        if sql.startswith("INSERT INTO events"):
            self._left -= 1
            if self._left == 0:
                raise sqlite3.OperationalError("simulated disk I/O error")
        return self._db.execute(sql, *args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


@pytest.mark.parametrize("segment_bytes", [store_module.SEGMENT_BYTES, 1], ids=["one-segment", "rollover"])
def test_ingest_after_a_failed_batch_keeps_offsets_exact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, segment_bytes: int
) -> None:
    monkeypatch.setattr(store_module, "SEGMENT_BYTES", segment_bytes)  # 1 = every event in its own segment
    store = RecordingStore(tmp_path / "controller" / "recordings")
    real_db = store._db
    store._db = _FailingDb(real_db, fail_on_insert=3)  # type: ignore[assignment]
    with pytest.raises(sqlite3.OperationalError):
        store.ingest_batch({"node_id": NODE_A_ID, "events": [_event(s, "first try") for s in (1, 2, 3, 4)]})
    store._db = real_db  # the lines already appended for the rolled-back batch are still on disk

    sent = [_event(s) for s in (1, 2, 3, 4, 5)]
    ack = store.ingest_batch({"node_id": NODE_A_ID, "events": sent})
    assert (ack["accepted_events"], ack["rejected_events"]) == (5, 0)
    assert store.events(RID, stream_id="runtime", limit=10)["events"] == sent
    assert list(store.iter_stream(RID, "runtime")) == sent


def test_ingest_rejects_events_that_cannot_be_serialised(tmp_path: Path) -> None:
    store = RecordingStore(tmp_path / "recordings")
    bad = _event(1) | {"data": {"value": float("nan")}}
    ack = store.ingest_batch({"node_id": NODE_A_ID, "events": [bad, _event(2)]})
    assert (ack["accepted_events"], ack["rejected_events"]) == (1, 1)


def _local_recording(root: Path, rid: str) -> None:
    rec = Recorder(
        recordings_root=root,
        recording_id=rid,
        stream_id="runtime",
        node_id=NODE_A_ID,
        component_id="c",
        provider_id="p",
        process_instance_id=uid(200),
        operation="invoke",
        config={"mode": "detailed"},
    )
    rec.write_context(settings=None)
    rec.log("info", "synthetic")
    rec.finalize("succeeded")


def test_rebuild_restores_the_same_view_from_files(tmp_path: Path) -> None:
    root = tmp_path / "recordings"
    rids = [uid(300 + i) for i in range(3)]
    for rid in rids:
        _local_recording(root, rid)
    store = RecordingStore(root)
    store.index_local()
    before = (store.list({}, limit=10), [store.events(r, stream_id="runtime") for r in rids])
    assert store.rebuild() > 0
    assert (store.list({}, limit=10), [store.events(r, stream_id="runtime") for r in rids]) == before
