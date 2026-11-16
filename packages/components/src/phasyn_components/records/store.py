"""紀錄的本機副本、SQLite 查詢索引與讀取。

原始 JSONL 是權威；SQLite 只是可重建的查詢索引（不存租約、待重播命令或身份表）。
Controller 用 ``ingest_batch`` 寫入收到的副本並以 (recording_id, stream_id, seq) 去重；
Node 用 ``index_local`` 增量索引自己（與元件程序）寫的檔案。兩者共用查詢與匯出。
"""

from __future__ import annotations

import base64
import builtins
import contextlib
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import threading
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, BinaryIO

from ..canonical import atomic_write_json, canonical_json, read_json
from ..errors import ComponentError, exception_message
from ..ids import is_local_id, is_uuid, new_id, require_uuid
from ..recorder.sink import list_segments, segment_name
from ..timeutil import parse_rfc3339, utc_now

log = logging.getLogger("phasyn_components.records")

SCHEMA_VERSION = 2  # 2: recordings.cost, recordings.wall_ms (an index with another version is rebuilt from the files)
MAX_COST_ROWS = 10_000
DEFAULT_PAGE = 50
MAX_PAGE = 200
DEFAULT_EVENTS = 200
MAX_EVENTS = 2000
SEGMENT_BYTES = 64 * 1024 * 1024
FINAL_STATES = ("succeeded", "failed", "cancelled", "interrupted", "unknown")

_DDL = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recordings(
    recording_id TEXT PRIMARY KEY,
    node_id TEXT, component_id TEXT, provider_id TEXT, process_instance_id TEXT,
    run_id TEXT, call_id TEXT, operation TEXT,
    created_at TEXT NOT NULL, state TEXT, error_code TEXT, precision TEXT, config_digest TEXT,
    parts TEXT, context_available INTEGER NOT NULL DEFAULT 0, summary_available INTEGER NOT NULL DEFAULT 0,
    synthetic INTEGER NOT NULL DEFAULT 0, updated_at TEXT, cost TEXT, wall_ms REAL
);
CREATE INDEX IF NOT EXISTS recordings_order ON recordings(created_at DESC, recording_id DESC);
CREATE INDEX IF NOT EXISTS recordings_component ON recordings(node_id, component_id);
CREATE INDEX IF NOT EXISTS recordings_run ON recordings(run_id);
CREATE INDEX IF NOT EXISTS recordings_call ON recordings(call_id);
CREATE TABLE IF NOT EXISTS events(
    recording_id TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL,
    segment INTEGER NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, sha256 TEXT NOT NULL,
    PRIMARY KEY(recording_id, stream_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS stream_files(
    recording_id TEXT NOT NULL, stream_id TEXT NOT NULL, segment INTEGER NOT NULL, indexed_bytes INTEGER NOT NULL,
    PRIMARY KEY(recording_id, stream_id, segment)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS corrupt(
    recording_id TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL,
    existing_sha256 TEXT NOT NULL, received_sha256 TEXT NOT NULL, seen_at TEXT NOT NULL
);
"""
# 一份 recording 在索引中的所有資料表（刪除時全部清掉）
RECORDING_TABLES = ("events", "stream_files", "corrupt", "recordings")


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def encode_cursor(created_at: str, recording_id: str) -> str:
    raw = json.dumps([created_at, recording_id], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, str]:
    """完整檢查 cursor 內容（只是位置資料，不簽名、不是 token）。"""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        doc = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        created_at, rid = doc
        if not isinstance(created_at, str) or not is_uuid(rid):
            raise ValueError
        parse_rfc3339(created_at)
    except (ValueError, TypeError) as exc:
        raise ComponentError("INVALID_ARGUMENT", "cursor 格式錯誤") from exc
    return created_at, rid


def _normalize_time(value: Any) -> str:
    """索引排序用：一律轉成毫秒精度 UTC（字串比較即時間順序）。"""
    if isinstance(value, str):
        try:
            return parse_rfc3339(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except ValueError:
            pass
    return utc_now()


def _precision_text(context: Mapping[str, Any] | None) -> str | None:
    if not context:
        return None
    settings = context.get("settings") or {}
    effective = (settings.get("effective") or {}) if isinstance(settings, Mapping) else {}
    precision = ((effective.get("load") or {}).get("precision") or {}) if isinstance(effective, Mapping) else {}
    if not isinstance(precision, Mapping) or not precision:
        return None
    parts = [f"{k}={v}" for k, v in sorted(precision.items()) if v is not None and not isinstance(v, (dict, list))]
    return ";".join(parts) or None


def _error_code(summary: Mapping[str, Any] | None) -> str | None:
    for note in (summary or {}).get("notes") or []:
        if isinstance(note, str) and note.startswith("error："):
            rest = note[len("error：") :]
            code = rest.split("：", 1)[0].strip()
            if is_local_id(code):
                return code
    return None


def placeholder_context(recording_id: str, event: Mapping[str, Any] | None) -> dict[str, Any]:
    """收到事件但還沒有 context：建立明示 placeholder，不偽補參數。"""
    ev = event or {}
    nil = "00000000-0000-4000-8000-000000000000"
    return {
        "recording_id": recording_id,
        "node_id": ev.get("node_id") or nil,
        "component_id": ev.get("component_id") or "unknown",
        "provider_id": "unknown",
        "process_instance_id": ev.get("process_instance_id") or nil,
        "run_id": ev.get("run_id"),
        "call_id": ev.get("call_id"),
        "operation": "invoke" if ev.get("call_id") else "node",
        "created_at": ev.get("occurred_at") or utc_now(),
        "clock_domain": "unknown",
        "settings": None,
        "input_summary": {},
        "recording": {"mode": "detailed"},
        "environment": {"placeholder": True, "reason": "context 尚未收到"},
        "synthetic": False,
    }


PLACEHOLDER_SUMMARY_NOTE = "summary 尚未收到（可能仍在執行、上報缺段或程序中斷）"


def is_placeholder_summary(summary: Mapping[str, Any]) -> bool:
    return PLACEHOLDER_SUMMARY_NOTE in (summary.get("notes") or [])


def placeholder_summary(recording_id: str, *, context_available: bool) -> dict[str, Any]:
    return {
        "recording_id": recording_id,
        "state": "unknown",
        "metrics": {},
        "transfer_totals": {},
        "part_totals": {},
        "coverage": "partial",
        "dropped_events": 0,
        "dropped_bytes": 0,
        "detail_truncated": False,
        "notes": [PLACEHOLDER_SUMMARY_NOTE],
        "context_available": context_available,
    }


class RecordingStore:
    def __init__(self, recordings_root: Path, index_path: Path | None = None) -> None:
        self.root = Path(recordings_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = Path(index_path) if index_path else self.root.parent / "recording-index.sqlite"
        self._lock = threading.RLock()
        self._generation = 0
        self._db, rebuilt = self._open()
        if rebuilt:
            self.index_local()

    @property
    def generation(self) -> int:
        """Grows by one after every successful ingest, index or delete (in this process): a cheap
        "has anything changed?" check for caches derived from the index."""
        with self._lock:
            return self._generation

    def _changed(self) -> None:
        with self._lock:
            self._generation += 1

    # ------------------------------------------------------------------ db
    def _open(self) -> tuple[sqlite3.Connection, bool]:
        """Open the index; an index written with another schema version is discarded (``True``)."""
        rebuilt = False
        while True:
            db = sqlite3.connect(self.index_path, check_same_thread=False, isolation_level=None)
            db.row_factory = sqlite3.Row
            with contextlib.suppress(sqlite3.DatabaseError):
                db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.executescript(_DDL)
            row = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if row is None:
                db.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
                return db, rebuilt
            if row["value"] == str(SCHEMA_VERSION) or rebuilt:
                return db, rebuilt
            db.close()  # the files are the authority: start a fresh index and re-read them
            self._remove_index_files()
            rebuilt = True

    def _remove_index_files(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            Path(str(self.index_path) + suffix).unlink(missing_ok=True)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def rebuild(self) -> int:
        """Drop the index and rebuild it from the files (never starts work or revives a run)."""
        with self._lock:
            self._db.close()
            self._remove_index_files()
            self._db, _ = self._open()
        return self.index_local()

    # ------------------------------------------------------------------ paths
    def directory(self, recording_id: str) -> Path:
        return self.root / require_uuid(recording_id, "recording_id")

    def _read_doc(self, path: Path) -> dict[str, Any] | None:
        try:
            doc = read_json(path)
        except (OSError, ValueError):
            return None
        return doc if isinstance(doc, dict) else None

    def read_context(self, recording_id: str) -> dict[str, Any] | None:
        return self._read_doc(self.directory(recording_id) / "context.json")

    def read_summary(self, recording_id: str) -> dict[str, Any] | None:
        return self._read_doc(self.directory(recording_id) / "summary.json")

    # ------------------------------------------------------------------ index rows
    def _upsert_row(
        self,
        recording_id: str,
        *,
        context: Mapping[str, Any] | None,
        summary: Mapping[str, Any] | None,
        first_event: Mapping[str, Any] | None = None,
    ) -> None:
        ctx = context or (placeholder_context(recording_id, first_event) if first_event else None)
        existing = self._db.execute("SELECT * FROM recordings WHERE recording_id=?", (recording_id,)).fetchone()
        if ctx is None and existing is None:
            ctx = placeholder_context(recording_id, None)
        parts = None
        if summary:
            names = sorted((summary.get("part_totals") or {}).keys())
            parts = "\n" + "\n".join(names) + "\n" if names else None
        settings = (context or {}).get("settings") if context else None
        config_digest = settings.get("config_digest") if isinstance(settings, Mapping) else None
        values = {
            "recording_id": recording_id,
            "node_id": (ctx or {}).get("node_id"),
            "component_id": (ctx or {}).get("component_id"),
            "provider_id": (ctx or {}).get("provider_id"),
            "process_instance_id": (ctx or {}).get("process_instance_id"),
            "run_id": (ctx or {}).get("run_id"),
            "call_id": (ctx or {}).get("call_id"),
            "operation": (ctx or {}).get("operation"),
            "created_at": _normalize_time((ctx or {}).get("created_at")),
            "state": (summary or {}).get("state") if summary else None,
            "error_code": _error_code(summary),
            "precision": _precision_text(context),
            "config_digest": config_digest,
            "parts": parts,
            "context_available": 1 if context else 0,
            "summary_available": 1 if summary else 0,
            "synthetic": 1 if (context or {}).get("synthetic") else 0,
            "updated_at": utc_now(),
            "cost": _cost_text(summary),
            "wall_ms": _wall_ms(summary),
        }
        if existing is not None:
            for key in ("state", "error_code", "parts", "cost", "wall_ms"):
                if values[key] is None and summary is None:
                    values[key] = existing[key]
            for key in ("precision", "config_digest"):
                if values[key] is None and context is None:
                    values[key] = existing[key]
            if context is None:
                for key in (
                    "node_id",
                    "component_id",
                    "provider_id",
                    "process_instance_id",
                    "run_id",
                    "call_id",
                    "operation",
                    "created_at",
                ):
                    values[key] = existing[key]
                values["context_available"] = existing["context_available"]
                values["synthetic"] = existing["synthetic"]
            if summary is None:
                values["summary_available"] = existing["summary_available"]
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        updates = ", ".join(f"{k}=excluded.{k}" for k in values if k != "recording_id")
        self._db.execute(
            f"INSERT INTO recordings({cols}) VALUES({marks}) ON CONFLICT(recording_id) DO UPDATE SET {updates}",
            tuple(values.values()),
        )

    def index_recording(self, recording_id: str) -> int:
        """增量索引單一 recording 的 stream 檔（只處理完整行）。回傳新增事件數。"""
        directory = self.directory(recording_id)
        if not directory.is_dir():
            return 0
        added = 0
        first_event: dict[str, Any] | None = None
        with self._lock:
            for stream_id, segments in list_segments(directory).items():
                for segment, path in segments:
                    row = self._db.execute(
                        "SELECT indexed_bytes FROM stream_files WHERE recording_id=? AND stream_id=? AND segment=?",
                        (recording_id, stream_id, segment),
                    ).fetchone()
                    start = int(row["indexed_bytes"]) if row else 0
                    try:
                        size = path.stat().st_size
                    except OSError:
                        continue
                    if size <= start:
                        continue
                    offset = start
                    self._db.execute("BEGIN")
                    try:
                        with open(path, "rb") as fh:
                            fh.seek(start)
                            for line in fh:
                                if not line.endswith(b"\n"):
                                    break  # 寫入中的半行
                                length = len(line)
                                try:
                                    event = json.loads(line)
                                    seq = int(event["seq"])
                                except (ValueError, KeyError, TypeError):
                                    offset += length
                                    continue  # 損壞行跳過；其餘可讀
                                if first_event is None:
                                    first_event = event
                                sha = hashlib.sha256(canonical_json(event)).hexdigest()
                                cur = self._db.execute(
                                    "INSERT OR IGNORE INTO events(recording_id, stream_id, seq, segment, offset, length, sha256)"
                                    " VALUES(?,?,?,?,?,?,?)",
                                    (recording_id, stream_id, seq, segment, offset, length, sha),
                                )
                                added += cur.rowcount
                                offset += length
                        self._db.execute(
                            "INSERT INTO stream_files(recording_id, stream_id, segment, indexed_bytes) VALUES(?,?,?,?)"
                            " ON CONFLICT(recording_id, stream_id, segment) DO UPDATE SET indexed_bytes=excluded.indexed_bytes",
                            (recording_id, stream_id, segment, offset),
                        )
                        self._db.execute("COMMIT")
                    except BaseException:
                        self._db.execute("ROLLBACK")
                        raise
            self._upsert_row(
                recording_id,
                context=self.read_context(recording_id),
                summary=self.read_summary(recording_id),
                first_event=first_event,
            )
            self._changed()
        return added

    def index_local(self, recording_ids: builtins.list[str] | None = None) -> int:
        total = 0
        ids = recording_ids
        if ids is None:
            ids = [p.name for p in self.root.iterdir() if p.is_dir() and is_uuid(p.name)] if self.root.is_dir() else []
        for rid in ids:
            try:
                total += self.index_recording(rid)
            except (OSError, sqlite3.DatabaseError):
                continue
        return total

    # ------------------------------------------------------------------ controller ingest
    def ingest_batch(self, batch: Mapping[str, Any]) -> dict[str, Any]:
        """收下 Node 上報的副本：context／events／summaries。去重只為 log 資料，不重播任何 run。"""
        accepted = duplicate = rejected = 0
        problems: builtins.list[str] = []
        with self._lock:
            for ctx in batch.get("contexts") or []:
                rid = str(ctx.get("recording_id"))
                if not is_uuid(rid):
                    rejected += 1
                    continue
                atomic_write_json(self.directory(rid) / "context.json", ctx)
                self._upsert_row(rid, context=ctx, summary=None)
            touched: dict[tuple[str, str], list[tuple[int, bytes, dict[str, Any]]]] = {}
            for event in batch.get("events") or []:
                try:
                    rid = require_uuid(event.get("recording_id"), "recording_id")
                    stream = str(event.get("stream_id"))
                    if not is_local_id(stream):
                        raise ComponentError("INVALID_ARGUMENT", "stream_id")
                    seq = int(event["seq"])
                    if seq < 1:
                        raise ValueError
                    line = (
                        json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
                    ).encode("utf-8")  # NaN/Infinity -> ValueError: rejected like any other malformed event
                except (ComponentError, KeyError, TypeError, ValueError):
                    rejected += 1
                    continue
                touched.setdefault((rid, stream), []).append((seq, line, event))
            for (rid, stream), items in touched.items():
                directory = self.directory(rid)
                (directory / "streams").mkdir(parents=True, exist_ok=True)
                seg_row = self._db.execute(
                    "SELECT segment, indexed_bytes FROM stream_files WHERE recording_id=? AND stream_id=? ORDER BY segment DESC LIMIT 1",
                    (rid, stream),
                ).fetchone()
                segment = int(seg_row["segment"]) if seg_row else 0
                committed = int(seg_row["indexed_bytes"]) if seg_row else 0
                path = directory / "streams" / segment_name(stream, segment)
                self._db.execute("BEGIN")
                try:
                    fh, size = _open_for_append(path, committed)
                    try:
                        for seq, line, _event in items:
                            sha = hashlib.sha256(canonical_json(_event)).hexdigest()  # 與 key 順序無關
                            row = self._db.execute(
                                "SELECT sha256 FROM events WHERE recording_id=? AND stream_id=? AND seq=?",
                                (rid, stream, seq),
                            ).fetchone()
                            if row is not None:
                                if row["sha256"] == sha:
                                    duplicate += 1
                                else:
                                    rejected += 1
                                    problems.append(f"CORRUPT_RECORD {rid}/{stream}#{seq}")
                                    self._db.execute(
                                        "INSERT INTO corrupt(recording_id, stream_id, seq, existing_sha256, received_sha256, seen_at)"
                                        " VALUES(?,?,?,?,?,?)",
                                        (rid, stream, seq, row["sha256"], sha, utc_now()),
                                    )
                                continue
                            if size > 0 and size + len(line) > SEGMENT_BYTES:
                                fh.close()
                                segment += 1
                                path = directory / "streams" / segment_name(stream, segment)
                                fh, size = _open_for_append(path, 0)
                            fh.write(line)
                            self._db.execute(
                                "INSERT INTO events(recording_id, stream_id, seq, segment, offset, length, sha256) VALUES(?,?,?,?,?,?,?)",
                                (rid, stream, seq, segment, size, len(line), sha),
                            )
                            size += len(line)
                            accepted += 1
                    finally:
                        fh.flush()
                        fh.close()
                    self._db.execute(
                        "INSERT INTO stream_files(recording_id, stream_id, segment, indexed_bytes) VALUES(?,?,?,?)"
                        " ON CONFLICT(recording_id, stream_id, segment) DO UPDATE SET indexed_bytes=excluded.indexed_bytes",
                        (rid, stream, segment, size),
                    )
                    self._db.execute("COMMIT")
                except BaseException:
                    self._db.execute("ROLLBACK")
                    raise
                existing = self._db.execute("SELECT 1 FROM recordings WHERE recording_id=?", (rid,)).fetchone()
                if existing is None:
                    self._upsert_row(rid, context=None, summary=None, first_event=items[0][2])
            for summary in batch.get("summaries") or []:
                rid = str(summary.get("recording_id"))
                if not is_uuid(rid):
                    rejected += 1
                    continue
                current = self.read_summary(rid)
                if current is not None and current.get("state") in FINAL_STATES and summary.get("state") == "running":
                    continue  # final summary 不被較舊的 running 覆蓋
                atomic_write_json(self.directory(rid) / "summary.json", summary)
                self._upsert_row(rid, context=self.read_context(rid), summary=summary)
            self._changed()
        message = "ok" if not problems else "; ".join(problems[:20])
        return {
            "accepted_events": accepted,
            "duplicate_events": duplicate,
            "rejected_events": rejected,
            "message": message,
        }

    # ------------------------------------------------------------------ queries
    def list(
        self, filters: Mapping[str, str | None], *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        lim = DEFAULT_PAGE if limit is None else int(limit)
        if lim < 1 or lim > MAX_PAGE:
            raise ComponentError("INVALID_ARGUMENT", f"limit 必須介於 1 與 {MAX_PAGE}")
        where: builtins.list[str] = []
        args: builtins.list[Any] = []
        for key in ("node_id", "component_id", "provider_id", "run_id", "call_id", "error_code", "config_digest"):
            value = filters.get(key)
            if value:
                where.append(f"{key} = ?")
                args.append(str(value))
        if filters.get("operation"):
            where.append("operation = ?")
            args.append(str(filters["operation"]))
        if filters.get("part"):
            where.append("parts LIKE ? ESCAPE '\\'")
            args.append(f"%{_escape_like(str(filters['part']))}%")
        if filters.get("precision"):
            where.append("precision LIKE ? ESCAPE '\\'")
            args.append(f"%{_escape_like(str(filters['precision']))}%")
        for key, op in (("since", ">="), ("until", "<=")):
            value = filters.get(key)
            if value:
                try:
                    stamp = parse_rfc3339(str(value)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                except ValueError as exc:
                    raise ComponentError("INVALID_ARGUMENT", f"{key} 必須是 RFC3339 時間") from exc
                where.append(f"created_at {op} ?")
                args.append(stamp)
        if cursor:
            created_at, rid = decode_cursor(cursor)
            where.append("(created_at < ? OR (created_at = ? AND recording_id < ?))")
            args.extend([created_at, created_at, rid])
        sql = "SELECT recording_id, created_at FROM recordings"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at DESC, recording_id DESC LIMIT ?"
        args.append(lim + 1)
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        items = [self.get(r["recording_id"]) for r in rows[:lim]]
        next_cursor = (
            encode_cursor(rows[lim - 1]["created_at"], rows[lim - 1]["recording_id"]) if len(rows) > lim else None
        )
        return {"items": items, "next_cursor": next_cursor}

    def exists(self, recording_id: str) -> bool:
        with self._lock:
            row = self._db.execute("SELECT 1 FROM recordings WHERE recording_id=?", (recording_id,)).fetchone()
        return row is not None or self.directory(recording_id).is_dir()

    def get(self, recording_id: str) -> dict[str, Any]:
        rid = require_uuid(recording_id, "recording_id")
        context = self.read_context(rid)
        summary = self.read_summary(rid)
        if context is None and summary is None and not self.exists(rid):
            raise ComponentError("RECORDING_NOT_FOUND", f"找不到 recording {rid}")
        if context is None:
            first = self._first_event(rid)
            context = placeholder_context(rid, first)
            available = False
        else:
            available = True
        if summary is None:
            summary = placeholder_summary(rid, context_available=available)
        else:
            summary = dict(summary)
            summary["context_available"] = available
        return {"context": context, "summary": summary}

    def _first_event(self, rid: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT stream_id, seq FROM events WHERE recording_id=? ORDER BY stream_id, seq LIMIT 1", (rid,)
            ).fetchone()
        if row is None:
            return None
        events = self._read_events(rid, row["stream_id"], after_seq=row["seq"] - 1, limit=1)
        return events[0] if events else None

    def streams(self, recording_id: str) -> builtins.list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT stream_id, MAX(seq) AS last_seq, COUNT(*) AS n FROM events WHERE recording_id=? GROUP BY stream_id ORDER BY stream_id",
                (recording_id,),
            ).fetchall()
        return [{"stream_id": r["stream_id"], "last_seq": r["last_seq"], "event_count": r["n"]} for r in rows]

    def _read_events(self, rid: str, stream_id: str, *, after_seq: int, limit: int) -> builtins.list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT seq, segment, offset, length FROM events WHERE recording_id=? AND stream_id=? AND seq>? ORDER BY seq LIMIT ?",
                (rid, stream_id, after_seq, limit),
            ).fetchall()
        out: builtins.list[dict[str, Any]] = []
        handles: dict[int, Any] = {}
        try:
            for r in rows:
                seg = int(r["segment"])
                fh = handles.get(seg)
                if fh is None:
                    fh = open(self.directory(rid) / "streams" / segment_name(stream_id, seg), "rb")  # noqa: SIM115
                    handles[seg] = fh
                fh.seek(int(r["offset"]))
                data = fh.read(int(r["length"]))
                try:
                    out.append(json.loads(data))
                except ValueError:
                    continue
        finally:
            for fh in handles.values():
                fh.close()
        return out

    def events(
        self, recording_id: str, *, stream_id: str | None, after_seq: int = 0, limit: int | None = None
    ) -> dict[str, Any]:
        rid = require_uuid(recording_id, "recording_id")
        lim = DEFAULT_EVENTS if limit is None else int(limit)
        if lim < 1 or lim > MAX_EVENTS:
            raise ComponentError("INVALID_ARGUMENT", f"limit 必須介於 1 與 {MAX_EVENTS}")
        if after_seq < 0:
            raise ComponentError("INVALID_ARGUMENT", "after_seq 不可為負")
        streams = self.streams(rid)
        if stream_id is None:
            if len(streams) == 1:
                stream_id = streams[0]["stream_id"]
            elif not streams:
                if not self.exists(rid):
                    raise ComponentError("RECORDING_NOT_FOUND", f"找不到 recording {rid}")
                return {"events": [], "next_seq": None, "stream_id": "runtime", "has_more": False, "gap": False}
            else:
                raise ComponentError(
                    "AMBIGUOUS_STREAM",
                    "此 recording 有多個 stream；請指定 stream_id（沒有跨 stream 的全域 seq）",
                    details={"streams": streams},
                )
        if not is_local_id(stream_id):
            raise ComponentError("INVALID_ARGUMENT", "stream_id 格式錯誤")
        events = self._read_events(rid, stream_id, after_seq=after_seq, limit=lim + 1)
        has_more = len(events) > lim
        events = events[:lim]
        gap = False
        expected = after_seq + 1
        for ev in events:
            if int(ev["seq"]) != expected:
                gap = True
            expected = int(ev["seq"]) + 1
        if not events:
            with self._lock:
                row = self._db.execute(
                    "SELECT MAX(seq) AS m FROM events WHERE recording_id=? AND stream_id=?", (rid, stream_id)
                ).fetchone()
            gap = bool(row and row["m"] is not None and row["m"] > after_seq)
        next_seq = int(events[-1]["seq"]) if events else (after_seq if after_seq else None)
        return {"events": events, "next_seq": next_seq, "stream_id": stream_id, "has_more": has_more, "gap": gap}

    def iter_stream(self, recording_id: str, stream_id: str) -> Iterator[dict[str, Any]]:
        after = 0
        while True:
            batch = self._read_events(recording_id, stream_id, after_seq=after, limit=MAX_EVENTS)
            if not batch:
                return
            yield from batch
            after = int(batch[-1]["seq"])

    def cost_rows(
        self,
        *,
        node_id: str | None = None,
        component_id: str | None = None,
        since: str | None = None,
        limit: int = 1000,
    ) -> builtins.list[dict[str, Any]]:
        """Recordings whose summary carries a ``cost`` block, newest first (the ETA cost-profile input).

        Each row: ``recording_id``, ``node_id``, ``component_id``, ``provider_id``, ``operation``,
        ``state``, ``error_code``, ``wall_ms`` (the summary's ``host_wall_ms``), ``created_at`` and the
        parsed ``cost``. Reads the index only (no file access).
        """
        if not 1 <= int(limit) <= MAX_COST_ROWS:
            raise ComponentError("INVALID_ARGUMENT", f"limit 必須介於 1 與 {MAX_COST_ROWS}")
        where = ["cost IS NOT NULL"]
        args: builtins.list[Any] = []
        for column, value in (("node_id", node_id), ("component_id", component_id)):
            if value:
                where.append(f"{column} = ?")
                args.append(str(value))
        if since:
            try:
                stamp = parse_rfc3339(str(since)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            except ValueError as exc:
                raise ComponentError("INVALID_ARGUMENT", "since 必須是 RFC3339 時間") from exc
            where.append("created_at >= ?")
            args.append(stamp)
        sql = (
            "SELECT recording_id, node_id, component_id, provider_id, operation, state, error_code, wall_ms,"
            " created_at, cost "
            f"FROM recordings WHERE {' AND '.join(where)} ORDER BY created_at DESC, recording_id DESC LIMIT ?"  # fixed columns; every value is bound
        )
        args.append(int(limit))
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        out: builtins.list[dict[str, Any]] = []
        for row in rows:
            doc = dict(row)
            try:
                doc["cost"] = json.loads(doc["cost"])
            except ValueError:
                continue
            out.append(doc)
        return out

    def trace_files(self, recording_id: str) -> builtins.list[Path]:
        trace_dir = self.directory(recording_id) / "trace"
        if not trace_dir.is_dir():
            return []
        return sorted(p for p in trace_dir.iterdir() if p.suffix == ".json" and p.is_file())

    # ------------------------------------------------------------------ deletion（使用者明確要求）
    def ids_for_run(self, run_id: str) -> builtins.list[str]:
        """索引中 run_id 相符的 recording（建立時間舊到新）。只查索引，不掃檔案。"""
        with self._lock:
            rows = self._db.execute(
                "SELECT recording_id FROM recordings WHERE run_id=? ORDER BY created_at, recording_id", (run_id,)
            ).fetchall()
        return [str(r["recording_id"]) for r in rows]

    def delete(self, recording_id: str) -> bool:
        """刪除這份本機副本：所有索引列與 recording 目錄（context、summary、streams、trace…）。

        在 store 鎖內刪索引列，並把目錄原子改名離開 ``recordings/<id>``（讀者看到完整或不存在），
        之後才清掉改名後的目錄。索引列與目錄都不存在 → False。只動本機；之後若再收到同一
        recording 的上報，它會以新收到的內容重新出現。
        """
        rid = require_uuid(recording_id, "recording_id")
        directory = self.directory(rid)
        trash = self.root / f".deleted-{rid}-{new_id()[:8]}"
        moved = False
        with self._lock:
            self._db.execute("BEGIN")
            try:
                removed = 0
                for table in RECORDING_TABLES:
                    removed += self._db.execute(f"DELETE FROM {table} WHERE recording_id=?", (rid,)).rowcount
                try:
                    directory.rename(trash)
                    moved = True
                except FileNotFoundError:
                    pass
                self._db.execute("COMMIT")
            except BaseException as exc:
                with contextlib.suppress(sqlite3.Error):
                    self._db.execute("ROLLBACK")
                if moved:  # 索引列沒刪成：目錄放回原處，維持一致
                    with contextlib.suppress(OSError):
                        trash.rename(directory)
                if isinstance(exc, OSError):
                    raise ComponentError(
                        "RUNTIME_ERROR",
                        f"recording {rid} 無法刪除：{exception_message(exc)}；索引與檔案都未變更",
                        details={"recording_id": rid, "errno": exc.errno},
                    ) from exc
                raise
        if moved:
            _remove_tree(trash)
        if moved or removed > 0:
            self._changed()
        return moved or removed > 0


def _wall_ms(summary: Mapping[str, Any] | None) -> float | None:
    value = (((summary or {}).get("metrics") or {}).get("host_wall_ms") or {}).get("value")
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _cost_text(summary: Mapping[str, Any] | None) -> str | None:
    cost = (summary or {}).get("cost")
    return canonical_json(cost).decode("utf-8") if isinstance(cost, Mapping) else None


def _open_for_append(path: Path, committed: int) -> tuple[BinaryIO, int]:
    """Open a stream segment for appending; return the handle and the offset the next line lands at.

    The index (``stream_files.indexed_bytes``) is the authority on what a segment holds. Bytes past
    it were appended by a batch whose transaction rolled back (or a process that died before
    COMMIT): they are cut off, so the offsets recorded next always match the file. A segment shorter
    than the index claims keeps its real length, so new offsets still point at the new lines.
    """
    fh = open(path, "ab")  # noqa: SIM115 - closed by the caller
    end = os.fstat(fh.fileno()).st_size
    if end > committed:
        fh.truncate(committed)
        end = committed
    return fh, end


def _remove_tree(path: Path) -> None:
    """清掉已改名離開命名空間的目錄；失敗只留下 ``.deleted-*``（不再被索引或查詢），記 log 供手動清理。"""
    try:
        shutil.rmtree(path)
    except OSError as exc:
        log.warning("已刪除 recording 的目錄 %s 無法完全清除（索引已移除，需手動清理）：%s", path, exc)


__all__ = [
    "RECORDING_TABLES",
    "RecordingStore",
    "decode_cursor",
    "encode_cursor",
    "placeholder_context",
    "placeholder_summary",
]
