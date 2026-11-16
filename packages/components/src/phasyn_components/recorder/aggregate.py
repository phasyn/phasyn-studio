"""Aggregation state of one recording stream.

Counters, metrics, phases, parts, transfers, steps, samples, coverage, notes and the ``cost`` block.
Plain data with update methods: the :class:`~phasyn_components.recorder.core.Recorder` serialises
access with its lock, so nothing here locks, emits events or touches the disk. The summary is built
from this state by :mod:`phasyn_components.recorder.summary`.
"""

from __future__ import annotations

import collections
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

MAX_STEP_SAMPLES = 200_000
MAX_NOTES = 200
NOTE_LIMIT = 2000
MAX_COST_STAGES = 64

# Peak trackers fed by Node samples: sampled metric -> summary metric
SAMPLE_PEAKS = {
    "nvml_device_used_bytes": "nvml_device_used_sample_peak_bytes",
    "host_rss_current_bytes": "host_rss_sample_peak_bytes",
}
_COVERAGE_ORDER = {"full": 0, "partial": 1, "none": 2}


@dataclass(slots=True)
class TransferAgg:
    submitted_count: int = 0
    submitted_bytes: int = 0
    completed_count: int = 0
    completed_bytes: int = 0
    logical_bytes: int = 0
    pending: int = 0
    host_ms: float = 0.0
    gpu_event_ms: float = 0.0
    gpu_missing: int = 0
    no_op_count: int = 0
    # Every real copy completed synchronously with a host time: host_ms is then that group's interval.
    host_timed: bool = True


class CostLog:
    """The ``cost`` block of a summary: generic facts of the call plus the stages' actual work."""

    def __init__(self) -> None:
        self.facts: dict[str, Any] = {}
        self.stages: list[dict[str, Any]] = []
        self.dropped = 0

    def add_stage(self, stage: dict[str, Any]) -> None:
        if len(self.stages) < MAX_COST_STAGES:
            self.stages.append(stage)
        else:
            self.dropped += 1

    def summary(self) -> dict[str, Any] | None:
        if not self.facts and not self.stages:
            return None
        out: dict[str, Any] = {
            "load_digest": self.facts.get("load_digest"),
            "warm": self.facts.get("warm"),
            "loadavg": self.facts.get("loadavg"),
            "device_id": self.facts.get("device_id"),
            "source_revision": self.facts.get("source_revision"),
            "stages": [dict(s) for s in self.stages],
        }
        if self.dropped:
            out["dropped_stages"] = self.dropped
        return out


class Aggregates:
    def __init__(self) -> None:
        self.phases: dict[str, float] = collections.defaultdict(float)
        self.counters: dict[str, int] = {}
        self.metrics: dict[str, dict[str, Any]] = {}
        self.transfers: dict[str, TransferAgg] = {}
        self.pending: dict[str, tuple[str, str | None]] = {}
        self.parts: dict[str, dict[str, Any]] = {}
        self.step_host: list[float] = []
        self.step_gpu: list[float] = []
        self.step_gpu_missing = 0
        self.sample_peaks: dict[str, float] = {}
        self.sample_count = 0
        self.coverage = "full"
        self.coverage_reasons: list[str] = []
        self.notes: list[str] = []
        self.cost = CostLog()

    # ------------------------------------------------------------------ notes / coverage
    def add_note(self, text: str) -> None:
        if len(self.notes) < MAX_NOTES and text not in self.notes:
            self.notes.append(text[:NOTE_LIMIT])

    def set_coverage(self, coverage: str, reason: str) -> None:
        if coverage not in _COVERAGE_ORDER:
            raise ValueError(coverage)
        if _COVERAGE_ORDER[coverage] > _COVERAGE_ORDER[self.coverage]:
            self.coverage = coverage
        self.coverage_reasons.append(reason[:1000])

    # ------------------------------------------------------------------ phases / parts
    def add_phase(self, phase: str, host_ms: float) -> None:
        self.phases[phase] += host_ms

    def add_part(
        self, part: str, *, host_ms: float = 0.0, gpu_ms: float | None = None, calls: int = 0
    ) -> dict[str, Any]:
        entry = self.parts.get(part)
        if entry is None:
            entry = {
                "calls": 0,
                "host_ms": 0.0,
                "gpu_event_ms": 0.0,
                "gpu_event_missing": 0,
                "counters": {},
                "transfers": {},
            }
            self.parts[part] = entry
        entry["calls"] += calls
        entry["host_ms"] += host_ms
        if calls:
            if gpu_ms is None:
                entry["gpu_event_missing"] += calls
            else:
                entry["gpu_event_ms"] += gpu_ms
        return entry

    def set_part_value(self, part: str, name: str, value: float | int | None, *, unit: str, method: str) -> None:
        self.add_part(part).setdefault("values", {})[name] = {"value": value, "unit": unit, "method": method}

    # ------------------------------------------------------------------ counters / metrics
    def declare(self, names: tuple[str, ...]) -> None:
        for name in names:
            self.counters.setdefault(name, 0)

    def count(self, name: str, n: int, *, part: str | None) -> None:
        self.counters[name] = self.counters.get(name, 0) + int(n)
        if part is not None:
            counters = self.add_part(part)["counters"]
            counters[name] = counters.get(name, 0) + int(n)

    def max_metric(self, name: str, m: dict[str, Any]) -> None:
        current = self.metrics.get(name)
        if current is None or current.get("value") is None or m["value"] > current["value"]:
            self.metrics[name] = m

    # ------------------------------------------------------------------ steps / samples
    def add_step(self, host_ms: float, gpu_event_ms: float | None) -> None:
        if len(self.step_host) >= MAX_STEP_SAMPLES:
            return
        self.step_host.append(float(host_ms))
        if gpu_event_ms is None:
            self.step_gpu_missing += 1
        else:
            self.step_gpu.append(float(gpu_event_ms))

    def add_sample(self, metrics: Mapping[str, Mapping[str, Any]]) -> None:
        self.sample_count += 1
        for name, m in metrics.items():
            value = m.get("value") if isinstance(m, Mapping) else None
            peak = SAMPLE_PEAKS.get(name)
            if peak is not None and isinstance(value, (int, float)) and value > self.sample_peaks.get(peak, -1):
                self.sample_peaks[peak] = value

    # ------------------------------------------------------------------ transfers
    def add_transfer(
        self,
        transfer_id: str,
        category: str,
        *,
        submitted_count: int,
        submitted_bytes: int,
        completed_count: int | None,
        completed_bytes: int | None,
        logical_bytes: int | None,
        host_ms: float,
        gpu_event_ms: float | None,
        actual_copy: bool,
        completion_status: str,
        part: str | None,
    ) -> None:
        agg = self.transfers.setdefault(category, TransferAgg())
        if not actual_copy or completion_status == "no_op":
            agg.no_op_count += submitted_count
            return
        agg.submitted_count += submitted_count
        agg.submitted_bytes += int(submitted_bytes)
        agg.logical_bytes += int(logical_bytes if logical_bytes is not None else submitted_bytes)
        agg.host_ms += float(host_ms)
        if completion_status != "completed" or not float(host_ms) > 0:
            agg.host_timed = False
        if completion_status == "completed":
            agg.completed_count += int(completed_count or 0)
            agg.completed_bytes += int(completed_bytes or 0)
            if gpu_event_ms is None:
                agg.gpu_missing += 1
            else:
                agg.gpu_event_ms += float(gpu_event_ms)
        elif completion_status == "submitted":
            agg.pending += 1
            self.pending[transfer_id] = (category, part)
        else:  # failed / unknown
            agg.pending += 1
        if part is not None:
            totals = self.add_part(part)["transfers"].setdefault(category, {"count": 0, "bytes": 0})
            totals["count"] += submitted_count
            totals["bytes"] += int(submitted_bytes)

    def complete_transfer(
        self, transfer_id: str, *, completed_bytes: int, completed_count: int, gpu_event_ms: float | None
    ) -> None:
        pending = self.pending.pop(transfer_id, None)
        if pending is None:
            return
        agg = self.transfers[pending[0]]
        agg.pending -= 1
        agg.completed_count += int(completed_count)
        agg.completed_bytes += int(completed_bytes)
        if gpu_event_ms is None:
            agg.gpu_missing += 1
        else:
            agg.gpu_event_ms += float(gpu_event_ms)


__all__ = ["MAX_COST_STAGES", "Aggregates", "CostLog", "TransferAgg"]
