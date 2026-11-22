"""Recording exports: ``jsonl``, ``csv``, ``zip`` (diagnostic bundle) and ``trace``, all streamed.

Rules:

- ``jsonl``: one ``context`` record, every event (per stream, in ``seq`` order), one ``summary`` record.
- ``csv``: the metric long table (``recording,node,component,metric,value,unit,quality,method,scope,
  reason``) plus transfer, part, step and sample rows. Strings starting with ``= + - @`` (or TAB/CR)
  are prefixed with ``'`` so spreadsheets never evaluate them.
- ``zip``: ``README.txt``, ``context.json``, ``summary.json``, ``settings_diff.json``,
  ``events/<stream>.jsonl`` and any profiler trace; never large media, weights or raw tensors (only
  their references and hashes).
- ``trace``: the torch.profiler Chrome trace(s); none -> 404 ``TRACE_UNAVAILABLE``, never an empty
  archive.

:func:`export` checks everything it can before returning (unknown recording, unknown format,
missing trace, unsupported redaction), so a server can map errors to HTTP statuses before the first
byte goes out. The returned chunks are produced lazily with bounded memory; iterate them off the
event loop (Starlette's ``StreamingResponse`` does so for sync iterators).

Optional redaction (:mod:`.redact`) rewrites hostnames, device ids, prompts and paths in the
context, summary and events. Profiler traces are not parsed, so a redacted ``zip`` leaves them out
and a redacted ``trace`` export is refused.
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import ComponentError
from ..recorder.rmath import config_diff
from .redact import Redactor
from .store import RecordingStore


EXPORT_FORMATS = ("jsonl", "csv", "zip", "trace")
CSV_HEADER = [
    "recording",
    "node",
    "component",
    "metric",
    "value",
    "unit",
    "quality",
    "method",
    "scope",
    "reason",
]
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
CHUNK_BYTES = 256 * 1024
FILE_BLOCK_BYTES = 1024 * 1024

README = """Phasyn Studio diagnostic bundle
===============================

context.json        full recording context (requested / effective / observed settings, model and
                    runtime identity, environment, input summary)
summary.json        final summary (every metric carries unit / quality / scope / method / reason;
                    null means "not measured", never 0)
events/*.jsonl      raw events per stream (seq increases within one stream only; there is no global
                    order across streams)
settings_diff.json  requested -> effective and effective -> observed differences
trace/*.json        torch.profiler Chrome traces from trace mode (only when present)

Not included: large videos, weights or raw tensors (only FileRef file_id / size / sha256 references).
Time: monotonic values are decimal strings and only comparable within one clock_domain; never
subtract them across Nodes.
Units: durations are ms; bytes are integer bytes; GB/s is decimal.
"""

README_REDACTED = """
Redacted export: {fields} were replaced by "<redacted>" (paths keep only the file name).
Profiler traces are not included in redacted exports.
"""


@dataclass(frozen=True)
class ExportResult:
    """A streamed export: iterate ``chunks`` once; ``filename`` is the suggested download name."""

    chunks: Iterator[bytes]
    media_type: str
    filename: str


def csv_safe(value: Any) -> Any:
    """Encode a spreadsheet-safe CSV field."""
    if isinstance(value, str) and value.startswith(FORMULA_PREFIXES):
        return "'" + value
    return value


def _json_line(record: Any) -> bytes:
    return (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")


def _batched(pieces: Iterable[bytes], size: int = CHUNK_BYTES) -> Iterator[bytes]:
    """Coalesce many small byte strings into chunks of roughly ``size`` bytes."""
    buffer: list[bytes] = []
    pending = 0
    for piece in pieces:
        buffer.append(piece)
        pending += len(piece)
        if pending >= size:
            yield b"".join(buffer)
            buffer.clear()
            pending = 0
    if buffer:
        yield b"".join(buffer)


def _stream_ids(store: RecordingStore, rid: str) -> list[str]:
    return [s["stream_id"] for s in store.streams(rid)]


def _events(
    store: RecordingStore, rid: str, stream: str, redactor: Redactor
) -> Iterator[dict[str, Any]]:
    for event in store.iter_stream(rid, stream):
        yield redactor.document(event)


# ---------------------------------------------------------------------------------------- jsonl
def _jsonl_lines(
    store: RecordingStore, rid: str, rec: Mapping[str, Any], redactor: Redactor
) -> Iterator[bytes]:
    yield _json_line({"record": "context", "data": redactor.document(rec["context"])})
    for stream in _stream_ids(store, rid):
        for event in _events(store, rid, stream, redactor):
            yield _json_line({"record": "event", "data": event})
    yield _json_line({"record": "summary", "data": redactor.document(rec["summary"])})


# ------------------------------------------------------------------------------------------ csv
def _metric_row(
    rid: str, ctx: Mapping[str, Any], name: str, m: Mapping[str, Any]
) -> list[Any]:
    return [
        csv_safe(x)
        for x in (
            rid,
            ctx.get("node_id"),
            ctx.get("component_id"),
            name,
            m.get("value"),
            m.get("unit"),
            m.get("quality"),
            m.get("method"),
            m.get("scope"),
            m.get("reason"),
        )
    ]


_TRANSFER_FIELDS = (
    ("submitted_count", "count"),
    ("submitted_bytes", "bytes"),
    ("completed_count", "count"),
    ("completed_bytes", "bytes"),
    ("no_op_count", "count"),
    ("host_ms_sum", "ms"),
    ("gpu_event_ms_sum", "ms"),
    ("effective_gbps", "GB/s"),
)
_IO_TRANSFERS = ("network", "disk_read", "disk_write")


def _summary_rows(
    rid: str, ctx: Mapping[str, Any], summary: Mapping[str, Any]
) -> Iterator[list[Any]]:
    for name, m in sorted((summary.get("metrics") or {}).items()):
        yield _metric_row(rid, ctx, name, m)
    for category, totals in sorted((summary.get("transfer_totals") or {}).items()):
        for field, unit in _TRANSFER_FIELDS:
            value = totals.get(field)
            yield _metric_row(
                rid,
                ctx,
                f"transfer.{category}.{field}",
                {
                    "value": value,
                    "unit": unit,
                    "quality": "instrumented" if value is not None else "unavailable",
                    "method": "io_wrapper"
                    if category in _IO_TRANSFERS
                    else "runtime_copy_hook",
                    "scope": "recording_transfer_totals",
                    "reason": None if value is not None else "未確認完成或未量測",
                },
            )
    for part, totals in sorted((summary.get("part_totals") or {}).items()):
        for field, unit in (
            ("calls", "count"),
            ("host_ms_inclusive", "ms"),
            ("gpu_event_ms", "ms"),
        ):
            value = totals.get(field)
            yield _metric_row(
                rid,
                ctx,
                f"part.{part}.{field}",
                {
                    "value": value,
                    "unit": unit,
                    "quality": "instrumented" if value is not None else "unavailable",
                    "method": "cuda_event"
                    if field == "gpu_event_ms"
                    else "host_monotonic",
                    "scope": "part_inclusive",
                    "reason": None if value is not None else "未量測",
                },
            )


def _event_rows(
    rid: str, ctx: Mapping[str, Any], stream: str, event: Mapping[str, Any]
) -> Iterator[list[Any]]:
    kind, data = event.get("kind"), event.get("data") or {}
    if kind == "step":
        index = data.get("step_index")
        for field in ("host_ms", "gpu_event_ms"):
            value = data.get(field)
            yield _metric_row(
                rid,
                ctx,
                f"step.{index}.{field}",
                {
                    "value": value,
                    "unit": "ms",
                    "quality": "instrumented" if value is not None else "unavailable",
                    "method": "cuda_event"
                    if field == "gpu_event_ms"
                    else "host_monotonic",
                    "scope": f"{stream}#{event.get('seq')}",
                    "reason": None if value is not None else "未量測",
                },
            )
    elif kind == "sample":
        for name, m in (data.get("metrics") or {}).items():
            yield _metric_row(rid, ctx, f"sample.{data.get('sample_id')}.{name}", m)


def _csv_rows(
    store: RecordingStore, rid: str, rec: Mapping[str, Any], redactor: Redactor
) -> Iterator[list[Any]]:
    ctx = redactor.document(rec["context"])
    yield CSV_HEADER
    yield from _summary_rows(rid, ctx, redactor.document(rec["summary"]))
    for stream in _stream_ids(store, rid):
        for event in _events(store, rid, stream, redactor):
            yield from _event_rows(rid, ctx, stream, event)


def _csv_lines(rows: Iterable[list[Any]]) -> Iterator[bytes]:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    for row in rows:
        writer.writerow(row)
        yield buffer.getvalue().encode("utf-8")
        buffer.seek(0)
        buffer.truncate()


# ------------------------------------------------------------------------------------------ zip
class _ChunkSink:
    """Write-only, non-seekable target for :class:`zipfile.ZipFile`; drained between members."""

    def __init__(self) -> None:
        self._parts: list[bytes] = []
        self.pending = 0

    def write(self, data: bytes) -> int:
        self._parts.append(bytes(data))
        self.pending += len(data)
        return len(data)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None

    def drain(self) -> bytes:
        data = b"".join(self._parts)
        self._parts.clear()
        self.pending = 0
        return data


def _settings_diff(ctx: Mapping[str, Any]) -> dict[str, Any]:
    settings = ctx.get("settings") or {}
    return {
        "requested_vs_effective": config_diff(
            settings.get("requested") or {}, settings.get("effective") or {}
        ),
        "effective_vs_observed_keys": sorted(
            set((settings.get("observed") or {}).keys())
        ),
        "stored_revision": settings.get("stored_revision"),
        "loaded_revision": settings.get("loaded_revision"),
        "config_digest": settings.get("config_digest"),
    }


def _zip_member_from_lines(
    zf: zipfile.ZipFile, sink: _ChunkSink, name: str, lines: Iterable[bytes]
) -> Iterator[bytes]:
    with zf.open(name, "w", force_zip64=True) as member:
        for line in lines:
            member.write(line)
            if sink.pending >= CHUNK_BYTES:
                yield sink.drain()
    yield sink.drain()


def _zip_member_from_file(
    zf: zipfile.ZipFile, sink: _ChunkSink, name: str, path: Path
) -> Iterator[bytes]:
    with path.open("rb") as src, zf.open(name, "w", force_zip64=True) as member:
        while block := src.read(FILE_BLOCK_BYTES):
            member.write(block)
            if sink.pending >= CHUNK_BYTES:
                yield sink.drain()
    yield sink.drain()


def _zip_chunks(
    store: RecordingStore, rid: str, rec: Mapping[str, Any], redactor: Redactor
) -> Iterator[bytes]:
    ctx = redactor.document(rec["context"])
    readme = README
    if redactor:
        readme += README_REDACTED.format(fields=", ".join(sorted(redactor.fields)))
    sink = _ChunkSink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("README.txt", readme)
        zf.writestr("context.json", json.dumps(ctx, ensure_ascii=False, indent=2))
        zf.writestr(
            "summary.json",
            json.dumps(redactor.document(rec["summary"]), ensure_ascii=False, indent=2),
        )
        zf.writestr(
            "settings_diff.json",
            json.dumps(_settings_diff(ctx), ensure_ascii=False, indent=2),
        )
        yield sink.drain()
        for stream in _stream_ids(store, rid):
            lines = (
                _json_line(event) for event in _events(store, rid, stream, redactor)
            )
            yield from _zip_member_from_lines(zf, sink, f"events/{stream}.jsonl", lines)
        if not redactor:
            for path in store.trace_files(rid):
                yield from _zip_member_from_file(zf, sink, f"trace/{path.name}", path)
    yield sink.drain()


# ---------------------------------------------------------------------------------------- trace
def _file_chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as fh:
        while block := fh.read(FILE_BLOCK_BYTES):
            yield block


def _trace_zip_chunks(files: list[Path]) -> Iterator[bytes]:
    sink = _ChunkSink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            yield from _zip_member_from_file(zf, sink, path.name, path)
    yield sink.drain()


def _export_trace(store: RecordingStore, rid: str, redactor: Redactor) -> ExportResult:
    if redactor:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "trace 匯出不支援遮罩：trace 檔可能含本機路徑與裝置資訊；需要遮罩時請改用 zip 診斷包（不附 trace）",
            details={"redact": sorted(redactor.fields)},
        )
    files = store.trace_files(rid)
    if not files:
        raise ComponentError(
            "TRACE_UNAVAILABLE",
            "此 recording 沒有 trace（只有 trace 模式且 backend 可用時才會產生）",
        )
    if len(files) == 1:
        return ExportResult(
            _file_chunks(files[0]), "application/json", f"{rid}-{files[0].name}"
        )
    return ExportResult(_trace_zip_chunks(files), "application/zip", f"{rid}-trace.zip")


def export(
    store: RecordingStore,
    recording_id: str,
    fmt: str,
    *,
    redact: Iterable[str] = frozenset(),
) -> ExportResult:
    """Stream one recording as ``fmt`` (see the module docstring); ``redact`` takes categories or ``all``."""
    if fmt not in EXPORT_FORMATS:
        raise ComponentError(
            "INVALID_ARGUMENT", "format 必須是 jsonl、csv、zip 或 trace"
        )
    try:
        redactor = Redactor(redact)
    except ValueError as exc:
        raise ComponentError(
            "INVALID_ARGUMENT", str(exc), details={"field": "redact"}
        ) from exc
    rec = store.get(recording_id)
    rid = str(rec["context"].get("recording_id") or recording_id).lower()
    if fmt == "trace":
        return _export_trace(store, rid, redactor)
    if fmt == "jsonl":
        chunks = _batched(_jsonl_lines(store, rid, rec, redactor))
        return ExportResult(chunks, "application/x-ndjson", f"recording-{rid}.jsonl")
    if fmt == "csv":
        chunks = _batched(_csv_lines(_csv_rows(store, rid, rec, redactor)))
        return ExportResult(chunks, "text/csv; charset=utf-8", f"recording-{rid}.csv")
    return ExportResult(
        _zip_chunks(store, rid, rec, redactor),
        "application/zip",
        f"diagnostic-{rid}.zip",
    )


__all__ = ["CSV_HEADER", "EXPORT_FORMATS", "ExportResult", "csv_safe", "export"]
