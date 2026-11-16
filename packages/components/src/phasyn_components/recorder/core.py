"""Recorder: the recording library every component shares.

The model thread only updates small counters and timestamps and enqueues events without blocking;
a background writer (:mod:`.writer`) appends JSONL to local disk (the authority) and then hands the
events to the publisher best-effort (the Node batches them to the controller). When a queue is full,
detail events go first and a bounded critical area (errors, settings, lifecycle) is kept; every loss
is counted and leaves a missing ``seq`` range, and computation is never blocked.

Modes:
- ``off``: settings snapshot, wall time and result only (``recording_disabled``).
- ``summary``: lifecycle, phases, copy counts and bytes, memory, Node samples, step aggregates.
- ``detailed`` (default): plus every step, part span, transfer event, GPU event time and log.
- ``trace``: everything in ``detailed``; GPU components also run torch.profiler on chosen steps
  (see :mod:`phasyn_components.recorder.gpu`).

This module is the facade: aggregation state lives in :mod:`.aggregate`, the queue and writer in
:mod:`.writer`, the summary rules in :mod:`.summary`.
"""

from __future__ import annotations

import fnmatch
import itertools
import json
import math
import re
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..ids import is_local_id, require_uuid
from ..settings import normalize_recording
from ..timeutil import host_clock_domain, mono_ns, utc_now
from .aggregate import Aggregates
from .metrics import metric
from .sink import RecordingSink
from .summary import CallFacts, build_summary, environment_facts, merge_summaries
from .writer import EventWriter, Publisher

LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40}
DETAIL_MODES = ("detailed", "trace")
LOG_MESSAGE_LIMIT = 16384
# The work units the ETA estimator understands (one vocabulary for providers, fitter and frontend).
COST_UNITS = ("flop", "pixel", "pixel_frame", "second", "byte", "token", "call")
RISK_UNIT_RE = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")
COST_SHAPE_TEXT_LIMIT = 200


def _finite(value: float | None) -> float | None:
    if value is None:
        return None
    v = float(value)
    return v if math.isfinite(v) else None


class Span:
    """A host monotonic span, optionally with a GPU event interval (an event pair on one stream)."""

    __slots__ = (
        "_rec",
        "coverage",
        "critical",
        "end_ns",
        "gpu_device_id",
        "gpu_event_ms",
        "gpu_stream_id",
        "name",
        "parent_span_id",
        "part",
        "phase",
        "quality",
        "reason",
        "span_id",
        "start_ns",
        "step_index",
    )

    def __init__(
        self,
        rec: Recorder,
        name: str,
        *,
        part: str | None,
        step_index: int | None,
        parent_span_id: str | None,
        phase: str | None,
        critical: bool,
    ) -> None:
        self._rec = rec
        self.name = name
        self.part = part
        self.step_index = step_index
        self.parent_span_id = parent_span_id
        self.phase = phase
        self.critical = critical
        self.span_id = rec._next_span_id()
        self.start_ns = 0
        self.end_ns = 0
        self.gpu_event_ms: float | None = None
        self.gpu_device_id: str | None = None
        self.gpu_stream_id: str | None = None
        self.quality = "instrumented"
        self.coverage = "full"
        self.reason: str | None = None

    def __enter__(self) -> Span:
        self.start_ns = mono_ns()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.end_ns = mono_ns()
        if exc is not None and self.reason is None:
            self.reason = f"{type(exc).__name__}: {exc}"[:500]
        self._rec._finish_span(self)

    def set_gpu(
        self, ms: float | None, *, device_id: str | None, stream_id: str | None, reason: str | None = None
    ) -> None:
        self.gpu_event_ms = _finite(ms)
        self.gpu_device_id = device_id
        self.gpu_stream_id = stream_id
        if ms is None and reason:
            self.reason = reason

    @property
    def host_ms(self) -> float:
        return max(0, self.end_ns - self.start_ns) / 1_000_000


class Recorder:
    """One stream of one recording. Thread-safe; an I/O failure only degrades the recording."""

    def __init__(
        self,
        *,
        recordings_root: Path | None,
        recording_id: str,
        stream_id: str,
        node_id: str,
        component_id: str,
        provider_id: str,
        process_instance_id: str,
        operation: str,
        run_id: str | None = None,
        call_id: str | None = None,
        config: Mapping[str, Any] | None = None,
        publish: Publisher | None = None,
        synthetic: bool = False,
        clock_domain: str | None = None,
        track_process_cpu: bool = False,
    ) -> None:
        self.recording_id = require_uuid(recording_id, "recording_id")
        self.stream_id = stream_id
        self.node_id = node_id
        self.component_id = component_id
        self.provider_id = provider_id
        self.process_instance_id = process_instance_id
        self.operation = operation
        self.run_id = run_id
        self.call_id = call_id
        self.config = normalize_recording(config)
        self.mode = str(self.config.get("mode", "detailed"))
        self.synthetic = synthetic
        self.clock_domain = clock_domain or host_clock_domain(node_id)
        self._log_threshold = LEVELS.get(str(self.config.get("log_level", "info")), 20)
        self._part_filters = [str(p) for p in self.config.get("parts") or []]
        self._step_filters = {int(s) for s in self.config.get("steps") or []}
        self._lock = threading.Lock()
        self._span_counter = itertools.count(1)
        self._transfer_counter = itertools.count(1)
        self._agg = Aggregates()
        self._measurement_errors = 0
        self._closed = False

        sink: RecordingSink | None = None
        degraded: str | None = None
        if recordings_root is not None:
            try:
                sink = RecordingSink(
                    Path(recordings_root),
                    self.recording_id,
                    stream_id,
                    segment_bytes=int(self.config.get("segment_bytes", 64 * 1024 * 1024)),
                )
            except OSError as exc:
                degraded = f"無法建立紀錄目錄：{exc}"
        self._sink = sink
        self._writer = EventWriter(
            sink=sink,
            publish=publish,
            stream_id=stream_id,
            queue_max_events=int(self.config.get("queue_max_events", 8192)),
            queue_max_bytes=int(self.config.get("queue_max_bytes", 16 * 1024 * 1024)),
            max_detail_bytes=int(self.config.get("max_detail_bytes_per_recording", 2 * 1024**3)),
            degraded_reason=degraded,
        )

        self.created_at = utc_now()
        self.start_ns = mono_ns()
        self._cpu_start = time.process_time() if track_process_cpu else None
        self.context: dict[str, Any] | None = None
        self.summary: dict[str, Any] | None = None

    # ------------------------------------------------------------------ helpers
    @property
    def detailed(self) -> bool:
        return self.mode in DETAIL_MODES

    @property
    def enabled(self) -> bool:
        return self.mode != "off"

    @property
    def directory(self) -> Path | None:
        return self._sink.directory if self._sink is not None else None

    def _next_span_id(self) -> str:
        return f"sp-{next(self._span_counter)}"

    def part_selected(self, part: str | None) -> bool:
        if not self._part_filters or part is None:
            return True
        return any(part == f or fnmatch.fnmatchcase(part, f) for f in self._part_filters)

    def step_selected(self, step_index: int | None) -> bool:
        return not self._step_filters or step_index is None or step_index in self._step_filters

    # ------------------------------------------------------------------ context
    def write_context(
        self,
        *,
        settings: Mapping[str, Any] | None = None,
        input_summary: Mapping[str, Any] | None = None,
        environment: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        ctx = {
            "recording_id": self.recording_id,
            "node_id": self.node_id,
            "component_id": self.component_id,
            "provider_id": self.provider_id,
            "process_instance_id": self.process_instance_id,
            "run_id": self.run_id,
            "call_id": self.call_id,
            "operation": self.operation,
            "created_at": self.created_at,
            "clock_domain": self.clock_domain,
            "settings": dict(settings) if settings is not None else None,
            "input_summary": dict(input_summary or {}),
            "recording": dict(self.config),
            "environment": dict(environment or {}),
            "synthetic": bool(self.synthetic),
        }
        self.context = ctx
        if self._sink is not None:
            try:
                self._sink.write_context(ctx)
            except (OSError, ValueError) as exc:
                self._writer.degrade(f"context 寫入失敗：{exc}")
        self._writer.publish({"record": "context", "data": ctx})
        return ctx

    # ------------------------------------------------------------------ events
    def _emit(self, kind: str, data: Mapping[str, Any], *, level: str = "info", critical: bool = False) -> int | None:
        if self.mode == "off" or self._closed:
            return None
        started = time.perf_counter_ns()
        event = {
            "recording_id": self.recording_id,
            "stream_id": self.stream_id,
            "seq": 0,
            "node_id": self.node_id,
            "component_id": self.component_id,
            "process_instance_id": self.process_instance_id,
            "run_id": self.run_id,
            "call_id": self.call_id,
            "occurred_at": utc_now(),
            "monotonic_ns": str(mono_ns()),
            "level": level,
            "kind": kind,
            "data": dict(data),
        }
        return self._writer.enqueue(event, critical=critical, started_ns=started)

    # ------------------------------------------------------------------ spans
    def span(
        self,
        name: str,
        *,
        part: str | None = None,
        step_index: int | None = None,
        parent: Span | str | None = None,
        phase: str | None = None,
        critical: bool = False,
    ) -> Span:
        parent_id = parent.span_id if isinstance(parent, Span) else parent
        return Span(
            self, name, part=part, step_index=step_index, parent_span_id=parent_id, phase=phase, critical=critical
        )

    def _finish_span(self, span: Span) -> None:
        host_ms = span.host_ms
        with self._lock:
            if span.phase:
                self._agg.add_phase(span.phase, host_ms)
            if span.part:
                self._agg.add_part(span.part, host_ms=host_ms, gpu_ms=span.gpu_event_ms, calls=1)
        if not self.enabled:
            return
        if not span.critical and not (
            self.detailed and self.part_selected(span.part) and self.step_selected(span.step_index)
        ):
            return
        self._emit("span", self._span_data(span), critical=span.critical)

    def _span_data(self, span: Span) -> dict[str, Any]:
        return {
            "span_id": span.span_id,
            "parent_span_id": span.parent_span_id,
            "name": span.name,
            "part": span.part,
            "step_index": span.step_index,
            "clock_domain": self.clock_domain,
            "start_mono_ns": str(span.start_ns),
            "end_mono_ns": str(max(span.end_ns, span.start_ns)),
            "host_ms": span.host_ms,
            "gpu_event_ms": span.gpu_event_ms,
            "gpu_device_id": span.gpu_device_id,
            "gpu_stream_id": span.gpu_stream_id,
            "quality": span.quality,
            "coverage": span.coverage,
            "reason": span.reason,
        }

    def add_span(
        self,
        name: str,
        *,
        start_ns: int,
        end_ns: int,
        part: str | None = None,
        step_index: int | None = None,
        gpu_event_ms: float | None = None,
        gpu_device_id: str | None = None,
        gpu_stream_id: str | None = None,
        phase: str | None = None,
        critical: bool = False,
        reason: str | None = None,
    ) -> None:
        sp = Span(self, name, part=part, step_index=step_index, parent_span_id=None, phase=phase, critical=critical)
        sp.start_ns, sp.end_ns = int(start_ns), int(end_ns)
        sp.set_gpu(gpu_event_ms, device_id=gpu_device_id, stream_id=gpu_stream_id, reason=reason)
        self._finish_span(sp)

    @contextmanager
    def phase(self, name: str, *, part: str | None = None, critical: bool = False) -> Iterator[Span]:
        with self.span(name, part=part, phase=name, critical=critical) as sp:
            yield sp

    # ------------------------------------------------------------------ parts
    def part_call(self, part: str, *, host_ms: float = 0.0, gpu_event_ms: float | None = None, calls: int = 1) -> None:
        with self._lock:
            self._agg.add_part(part, host_ms=host_ms, gpu_ms=gpu_event_ms, calls=calls)

    def part_value(self, part: str, name: str, value: float | int | None, *, unit: str, method: str) -> None:
        """An extra measurement of a part (e.g. a CUDA-event wait for weights); not a global counter."""
        with self._lock:
            self._agg.set_part_value(part, name, value, unit=unit, method=method)

    # ------------------------------------------------------------------ counters/metrics
    def declare(self, *names: str) -> None:
        """Declare hook coverage for these counters: zero is reported as 0, not as missing."""
        with self._lock:
            self._agg.declare(names)

    def count(self, name: str, n: int = 1, *, part: str | None = None) -> None:
        with self._lock:
            self._agg.count(name, n, part=part)

    def set_metric(self, name: str, value: float | int | None, **kw: Any) -> None:
        m = metric(name, value, **kw)
        with self._lock:
            self._agg.metrics[name] = m

    def put_metric(self, name: str, m: Mapping[str, Any]) -> None:
        with self._lock:
            self._agg.metrics[name] = dict(m)

    def max_metric(self, name: str, value: float | int | None, **kw: Any) -> None:
        if value is None:
            return
        m = metric(name, value, **kw)
        with self._lock:
            self._agg.max_metric(name, m)

    def set_coverage(self, coverage: str, reason: str) -> None:
        """Declare incomplete hook coverage (e.g. a compiled or fused region without per-part hooks)."""
        with self._lock:
            self._agg.set_coverage(coverage, reason)

    def note(self, text: str) -> None:
        with self._lock:
            self._agg.add_note(text)

    def measurement_error(self, what: str) -> None:
        with self._lock:
            self._measurement_errors += 1
            self._agg.add_note(f"量測失敗：{what}")

    # ------------------------------------------------------------------ cost (ETA data)
    def record_cost(self, stage: str, *, work: float, unit: str, compute_ms: float | None = None, **shape: Any) -> None:
        """The work one stage actually did in this call (data for the ETA cost profiles, never a prediction).

        ``work`` is counted in ``unit``, one of :data:`COST_UNITS`; ``compute_ms`` is the stage's
        measured compute time; ``shape`` holds the scalar facts the work was derived from (e.g.
        ``seq_len=35008, steps=8``). Two shape keys are reserved for out-of-memory warnings:
        ``risk_measure`` (a number >= 0 that grows with memory use, e.g. the DiT's used rows) and
        ``risk_unit`` (its unit, e.g. ``"row"``); the fitter compares only ``risk_measure`` values,
        never work. Invalid arguments raise ``ValueError`` (a programming error).
        """
        if not is_local_id(stage):
            raise ValueError(f"cost stage must be a local id: {stage!r}")
        amount = float(work)
        if not math.isfinite(amount) or amount < 0:
            raise ValueError(f"cost work must be a finite number >= 0: {work!r}")
        if unit not in COST_UNITS:
            raise ValueError(f"cost unit must be one of {', '.join(COST_UNITS)}: {unit!r}")
        ms = None if compute_ms is None else float(compute_ms)
        if ms is not None and (not math.isfinite(ms) or ms < 0):
            raise ValueError(f"compute_ms must be a finite number >= 0: {compute_ms!r}")
        risk = shape.get("risk_measure")
        if "risk_measure" in shape and (
            isinstance(risk, bool) or not isinstance(risk, (int, float)) or not math.isfinite(risk) or risk < 0
        ):
            raise ValueError(f"risk_measure must be a finite number >= 0: {risk!r}")
        if "risk_unit" in shape and not (
            isinstance(shape["risk_unit"], str) and RISK_UNIT_RE.match(shape["risk_unit"])
        ):
            raise ValueError(f"risk_unit must match {RISK_UNIT_RE.pattern}: {shape['risk_unit']!r}")
        facts: dict[str, Any] = {}
        for key, value in shape.items():
            if not is_local_id(key):
                raise ValueError(f"cost shape key must be a local id: {key!r}")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError(f"cost shape value must be finite: {key}={value!r}")
            if value is not None and not isinstance(value, (bool, int, float, str)):
                raise ValueError(f"cost shape values must be scalars: {key}={value!r}")
            facts[key] = value[:COST_SHAPE_TEXT_LIMIT] if isinstance(value, str) else value
        entry = {"stage": stage, "work": amount, "work_unit": unit, "compute_ms": ms, "shape": facts}
        with self._lock:
            self._agg.cost.add_stage(entry)

    def cost_facts(
        self,
        *,
        load_digest: str | None = None,
        warm: bool | None = None,
        loadavg: Mapping[str, float | None] | None = None,
        device_id: str | None = None,
        source_revision: str | None = None,
    ) -> None:
        """Generic facts of the call for the ``cost`` block (filled by the component runtime host)."""
        facts = {
            "load_digest": load_digest,
            "warm": warm,
            "loadavg": None if loadavg is None else {"start": loadavg.get("start"), "end": loadavg.get("end")},
            "device_id": device_id,
            "source_revision": source_revision,
        }
        with self._lock:
            self._agg.cost.facts.update(facts)

    # ------------------------------------------------------------------ steps
    def step(
        self,
        step_index: int,
        *,
        host_ms: float,
        gpu_event_ms: float | None = None,
        scheduler_update_index: int | None = None,
        forward_index: int | None = None,
        cfg_branch: str | None = None,
        sigma: float | None = None,
        metrics: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> None:
        with self._lock:
            self._agg.add_step(host_ms, gpu_event_ms)
        if self.detailed and self.step_selected(step_index):
            self._emit(
                "step",
                {
                    "step_index": int(step_index),
                    "scheduler_update_index": scheduler_update_index,
                    "forward_index": forward_index,
                    "cfg_branch": cfg_branch,
                    "sigma": _finite(sigma),
                    "host_ms": max(0.0, float(host_ms)),
                    "gpu_event_ms": _finite(gpu_event_ms),
                    "metrics": {k: dict(v) for k, v in (metrics or {}).items()},
                },
            )

    # ------------------------------------------------------------------ transfers
    def transfer(
        self,
        category: str,
        *,
        direction: str,
        submitted_bytes: int,
        completed_bytes: int | None = None,
        submitted_count: int = 1,
        completed_count: int | None = None,
        part: str | None = None,
        step_index: int | None = None,
        forward_index: int | None = None,
        host_ms: float = 0.0,
        gpu_event_ms: float | None = None,
        owner: str = "runtime",
        byte_basis: str = "logical_tensor",
        actual_copy: bool = True,
        src: str = "",
        dst: str = "",
        src_memory_kind: str = "",
        dst_memory_kind: str = "",
        logical_bytes: int | None = None,
        host_submit_ms: float = 0.0,
        completion_status: str = "completed",
        offload_cycle_id: str | None = None,
        roundtrip_id: str | None = None,
        quality: str = "instrumented",
        reason: str | None = None,
        transfer_id: str | None = None,
    ) -> str:
        """Record one real (or no-op) copy. With ``completion_status='submitted'``, complete it later
        with :meth:`transfer_completed`."""
        tid = transfer_id or f"tx-{next(self._transfer_counter)}"
        if completion_status == "completed":
            if completed_bytes is None:
                completed_bytes = submitted_bytes
            if completed_count is None:
                completed_count = submitted_count
        with self._lock:
            self._agg.add_transfer(
                tid,
                category,
                submitted_count=submitted_count,
                submitted_bytes=submitted_bytes,
                completed_count=completed_count,
                completed_bytes=completed_bytes,
                logical_bytes=logical_bytes,
                host_ms=host_ms,
                gpu_event_ms=gpu_event_ms,
                actual_copy=actual_copy,
                completion_status=completion_status,
                part=part,
            )
        if self.detailed and self.part_selected(part) and self.step_selected(step_index):
            self._emit(
                "transfer",
                {
                    "transfer_id": tid,
                    "category": category,
                    "part": part,
                    "step_index": step_index,
                    "forward_index": forward_index,
                    "offload_cycle_id": offload_cycle_id,
                    "roundtrip_id": roundtrip_id,
                    "direction": direction,
                    "submitted_count": int(submitted_count),
                    "submitted_bytes": int(submitted_bytes),
                    "completed_count": completed_count,
                    "completed_bytes": completed_bytes,
                    "host_ms": max(0.0, float(host_ms)),
                    "gpu_event_ms": _finite(gpu_event_ms),
                    "clock_domain": self.clock_domain,
                    "owner": owner,
                    "byte_basis": byte_basis,
                    "quality": quality,
                    "actual_copy": bool(actual_copy),
                    "reason": reason,
                    "src": src,
                    "dst": dst,
                    "src_memory_kind": src_memory_kind,
                    "dst_memory_kind": dst_memory_kind,
                    "logical_bytes": int(logical_bytes if logical_bytes is not None else submitted_bytes),
                    "host_submit_ms": max(0.0, float(host_submit_ms)),
                    "completion_status": "no_op" if not actual_copy else completion_status,
                },
            )
        return tid

    def transfer_completed(
        self, transfer_id: str, *, completed_bytes: int, completed_count: int = 1, gpu_event_ms: float | None = None
    ) -> None:
        with self._lock:
            self._agg.complete_transfer(
                transfer_id, completed_bytes=completed_bytes, completed_count=completed_count, gpu_event_ms=gpu_event_ms
            )

    # ------------------------------------------------------------------ samples/logs/notices
    def sample(
        self, sample_id: str, *, device_id: str | None, process_id: int | None, metrics: Mapping[str, Mapping[str, Any]]
    ) -> None:
        with self._lock:
            self._agg.add_sample(metrics)
        if self.enabled:
            self._emit(
                "sample",
                {
                    "sample_id": sample_id,
                    "device_id": device_id,
                    "process_id": process_id,
                    "metrics": {k: dict(v) for k, v in metrics.items()},
                },
            )

    def log(self, level: str, message: str, **fields: Any) -> None:
        lvl = LEVELS.get(level, 20)
        critical = lvl >= LEVELS["warning"]
        if not critical and lvl < self._log_threshold:
            return
        truncated = len(message) > LOG_MESSAGE_LIMIT
        text = message[:LOG_MESSAGE_LIMIT]
        safe_fields: dict[str, Any] = {}
        for k, v in fields.items():
            try:
                json.dumps(v, allow_nan=False)
                safe_fields[k] = v
            except (TypeError, ValueError):
                safe_fields[k] = repr(v)[:2000]
        if critical or self.detailed or self.mode == "summary":
            self._emit(
                "log", {"message": text, "fields": safe_fields, "truncated": truncated}, level=level, critical=critical
            )

    def notice(self, code: str, message: str, *, dropped_events: int = 0, dropped_bytes: int = 0) -> None:
        self._emit(
            "notice",
            {
                "code": code,
                "message": message[:LOG_MESSAGE_LIMIT],
                "dropped_events": int(dropped_events),
                "dropped_bytes": int(dropped_bytes),
            },
            level="warning",
            critical=True,
        )

    def write_trace(self, name: str, document: Any) -> Path | None:
        if self._sink is None:
            return None
        try:
            return self._sink.write_trace(name, document)
        except (OSError, ValueError) as exc:
            self.measurement_error(f"trace 寫入失敗：{exc}")
            return None

    # ------------------------------------------------------------------ summary
    def recorder_state(self) -> str:
        if self.mode == "off":
            return "off"
        return "degraded" if self._writer.degraded_reason else "ok"

    def finalize(
        self,
        state: str,
        *,
        error: Mapping[str, Any] | None = None,
        write: bool = True,
        publish: bool = True,
        extra_notes: list[str] | None = None,
        drain_timeout_s: float = 5.0,
    ) -> dict[str, Any]:
        """Finish the recording: drain the writer (bounded), build the summary, write and publish it."""
        if self.summary is not None:
            return self.summary
        end_ns = mono_ns()
        if error is not None:
            self.log("error", f"{error.get('code')}: {error.get('message')}", error=dict(error))
        self._closed = True
        self._writer.close(drain_timeout_s)
        with self._lock:
            facts = CallFacts(
                recording_id=self.recording_id,
                stream_id=self.stream_id,
                operation=self.operation,
                mode=self.mode,
                wall_ms=(end_ns - self.start_ns) / 1_000_000,
                cpu_ms=(time.process_time() - self._cpu_start) * 1000 if self._cpu_start is not None else None,
                measurement_errors=self._measurement_errors,
                context_available=self.context is not None,
            )
            summary = build_summary(
                self._agg,
                facts,
                self._writer.stats(),
                state=state,
                has_publisher=self._writer.has_publisher,
                max_detail_bytes=self._writer.max_detail_bytes,
                error=error,
                extra_notes=extra_notes,
            )
            self.summary = summary
        if write and self._sink is not None:
            try:
                self._sink.write_summary(summary)
            except (OSError, ValueError) as exc:
                summary["notes"].append(f"summary 寫入失敗：{exc}")
        if publish:
            self._writer.publish({"record": "summary", "data": summary})
        return summary


__all__ = ["DETAIL_MODES", "LEVELS", "Recorder", "Span", "environment_facts", "merge_summaries"]
