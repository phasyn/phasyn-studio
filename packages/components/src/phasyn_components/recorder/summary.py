"""Building a recording summary: pure functions of the aggregates, the writer's stats and call facts.

Nothing here locks, starts threads or writes files, so the summary rules (metric names, null
semantics, coverage, notes, the ``cost`` block) can be tested directly.
"""

from __future__ import annotations

import os
import platform
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .aggregate import Aggregates, TransferAgg
from .metrics import metric
from .rmath import effective_gbps, percentile
from .writer import WriterStats


COPY_CATEGORIES = (
    "weight_h2d",
    "weight_d2h",
    "activation_h2d",
    "activation_d2h",
    "device_copy",
    "peer_copy",
    "host_copy",
    "diagnostic_readback",
)
PHASE_METRICS = {
    "load": "host_load_ms",
    "input_transfer": "host_input_transfer_ms",
    "output_publish": "host_output_publish_ms",
    "encode": "host_encode_ms",
    "wait": "host_wait_ms",
}
# Synchronous host-side transfers: their host time is the completion time (the host time of an
# asynchronous GPU copy is only the enqueue and must never be used as a denominator).
HOST_TIMED_CATEGORIES = frozenset({"network", "disk_read", "disk_write", "host_copy"})


@dataclass(frozen=True)
class CallFacts:
    """Facts used to construct the final call summary."""

    recording_id: str
    stream_id: str
    operation: str
    mode: str
    wall_ms: float
    cpu_ms: float | None
    measurement_errors: int
    context_available: bool


_MAX_MISSING_RANGES = 16


def build_metrics(
    agg: Aggregates, facts: CallFacts, writer: WriterStats, *, has_publisher: bool
) -> dict[str, Any]:
    """Build the measured metrics for this operation."""
    out: dict[str, dict[str, Any]] = {}
    out["host_wall_ms"] = metric(
        "host_wall_ms", facts.wall_ms, scope=f"{facts.operation}:{facts.stream_id}"
    )
    for phase, total in agg.phases.items():
        name = PHASE_METRICS.get(phase)
        if name:
            out[name] = metric(name, total)
        else:
            out[f"phase.{phase}_ms"] = metric(
                f"phase.{phase}_ms",
                total,
                unit="ms",
                scope="call_or_phase",
                method="host_monotonic",
            )
    if facts.cpu_ms is not None:
        out["host_cpu_time_ms"] = metric(
            "host_cpu_time_ms",
            facts.cpu_ms,
            scope="actor_process",
            method="process_cpu_time",
        )
    for name, value in agg.counters.items():
        out[name] = metric(name, value, unit="count")
    for name, peak in agg.sample_peaks.items():
        out[name] = metric(name, peak, quality="sampled", count=agg.sample_count)
    out.update(_step_metrics(agg))
    out.update(_transfer_metrics(agg.transfers))
    out["events_dropped"] = metric("events_dropped", writer.dropped_events)
    out["publisher_dropped"] = metric("publisher_dropped", writer.publisher_dropped)
    out["recorder_written_bytes"] = metric(
        "recorder_written_bytes", writer.written_bytes
    )
    out["publisher_bytes"] = metric(
        "publisher_bytes",
        writer.publisher_bytes if has_publisher else None,
        quality="instrumented" if has_publisher else "not_applicable",
        reason=None if has_publisher else "此 stream 沒有 publisher",
    )
    out["recorder_cpu_ms"] = metric(
        "recorder_cpu_ms",
        writer.recorder_ns / 1_000_000,
        method="recorder_self_perf_counter",
    )
    out["measurement_error_count"] = metric(
        "measurement_error_count",
        facts.measurement_errors + writer.serialization_errors,
    )
    out["sample_count"] = metric("sample_count", agg.sample_count)
    for name, m in agg.metrics.items():
        out[name] = dict(m)
    return out


def _step_metrics(agg: Aggregates) -> dict[str, dict[str, Any]]:
    if not agg.step_host:
        return {}
    n = len(agg.step_host)
    out = {
        "steps.host_ms_p50": metric(
            "steps.host_ms_p50",
            percentile(agg.step_host, 50),
            unit="ms",
            scope="component_call_steps",
            method="host_monotonic",
            count=n,
        ),
        "steps.host_ms_p95": metric(
            "steps.host_ms_p95",
            percentile(agg.step_host, 95),
            unit="ms",
            scope="component_call_steps",
            method="host_monotonic_nearest_rank",
            count=n,
        ),
    }
    if agg.step_gpu and not agg.step_gpu_missing:
        out["steps.gpu_event_ms_p50"] = metric(
            "steps.gpu_event_ms_p50",
            percentile(agg.step_gpu, 50),
            unit="ms",
            scope="device_stream_interval",
            method="cuda_event",
            count=n,
        )
        out["steps.gpu_event_ms_p95"] = metric(
            "steps.gpu_event_ms_p95",
            percentile(agg.step_gpu, 95),
            unit="ms",
            scope="device_stream_interval",
            method="cuda_event_nearest_rank",
            count=n,
        )
    return out


def _transfer_metrics(
    transfers: Mapping[str, TransferAgg],
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for category, agg in transfers.items():
        incomplete = agg.pending > 0
        if category in COPY_CATEGORIES:
            out[f"{category}_submitted_count"] = metric(
                f"{category}_submitted_count", agg.submitted_count
            )
            out[f"{category}_submitted_bytes"] = metric(
                f"{category}_submitted_bytes", agg.submitted_bytes
            )
            reason = "部分搬運未確認完成（崩潰／逾時／未同步）" if incomplete else None
            out[f"{category}_completed_count"] = metric(
                f"{category}_completed_count",
                None if incomplete else agg.completed_count,
                reason=reason,
            )
            out[f"{category}_completed_bytes"] = metric(
                f"{category}_completed_bytes",
                None if incomplete else agg.completed_bytes,
                reason=reason,
            )
        elif category == "network":
            out["network_received_bytes"] = metric(
                "network_received_bytes",
                None if incomplete else agg.completed_bytes,
                reason="部分下載未完成" if incomplete else None,
            )
        elif category == "disk_read":
            out["logical_disk_read_bytes"] = metric(
                "logical_disk_read_bytes", agg.completed_bytes
            )
        elif category == "disk_write":
            out["logical_disk_written_bytes"] = metric(
                "logical_disk_written_bytes", agg.completed_bytes
            )
        elif category == "pin":
            out["pin_count"] = metric("pin_count", agg.submitted_count)
        elif category == "unpin":
            out["unpin_count"] = metric("unpin_count", agg.submitted_count)
    return out


def build_transfer_totals(
    transfers: Mapping[str, TransferAgg],
) -> dict[str, dict[str, Any]]:
    """Summarize transfer counts and byte totals."""
    totals: dict[str, dict[str, Any]] = {}
    for category, agg in transfers.items():
        incomplete = agg.pending > 0
        completed_bytes = None if incomplete else agg.completed_bytes
        gpu_ms = (
            None if (agg.gpu_missing or agg.completed_count == 0) else agg.gpu_event_ms
        )
        totals[category] = {
            "submitted_count": agg.submitted_count,
            "submitted_bytes": agg.submitted_bytes,
            "completed_count": None if incomplete else agg.completed_count,
            "completed_bytes": completed_bytes,
            "logical_bytes": agg.logical_bytes,
            "no_op_count": agg.no_op_count,
            "pending_count": agg.pending,
            "host_ms_sum": round(agg.host_ms, 6),
            "gpu_event_ms_sum": gpu_ms,
            "effective_gbps": None,
            "effective_gbps_basis": None,
        }
        if gpu_ms:
            totals[category]["effective_gbps"] = effective_gbps(completed_bytes, gpu_ms)
            totals[category]["effective_gbps_basis"] = (
                "gpu_event_ms_sum（同類 copy 區間和；並行時不等於裝置帶寬）"
            )
        elif (
            category in HOST_TIMED_CATEGORIES
            and agg.host_timed
            and completed_bytes
            and agg.host_ms > 0
        ):
            totals[category]["effective_gbps"] = effective_gbps(
                completed_bytes, agg.host_ms
            )
            totals[category]["effective_gbps_basis"] = (
                "host_ms_sum（同步傳輸的完成時間；多筆並行時不等於鏈路帶寬）"
            )
    return totals


def build_part_totals(
    parts: Mapping[str, Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Summarize time and counts for each component part."""
    out: dict[str, dict[str, Any]] = {}
    for part, entry in parts.items():
        gpu_ms = None if entry["gpu_event_missing"] else entry["gpu_event_ms"]
        out[part] = {
            "calls": entry["calls"],
            "host_ms_inclusive": round(entry["host_ms"], 6),
            "gpu_event_ms": gpu_ms,
            "gpu_event_coverage": "full"
            if not entry["gpu_event_missing"]
            else ("none" if entry["gpu_event_ms"] == 0 else "partial"),
            "counters": dict(entry["counters"]),
            "transfers": {k: dict(v) for k, v in entry["transfers"].items()},
            "values": {k: dict(v) for k, v in (entry.get("values") or {}).items()},
        }
    return out


def build_notes(  # noqa: PLR0913 - Keep the published positional and keyword API.
    agg: Aggregates,
    writer: WriterStats,
    *,
    mode: str,
    stream_id: str,
    max_detail_bytes: int,
    error: Mapping[str, Any] | None,
    extra_notes: list[str] | None,
) -> list[str]:
    """Collect explanatory notes and coverage gaps."""
    notes = [*agg.notes, *(n for n in writer.notes if n not in agg.notes)]
    if mode == "off":
        notes.insert(
            0, "recording_disabled=true（mode=off：只有結果、設定快照與 wall time）"
        )
    if writer.degraded_reason:
        notes.append(f"RECORDER_DEGRADED：{writer.degraded_reason}")
    if writer.detail_truncated:
        notes.append(
            f"DETAIL_TRUNCATED：本 recording detail 超過 {max_detail_bytes} bytes，之後只保留 counter 與摘要"
        )
    if writer.missing:
        ranges = ", ".join(
            f"{a}-{b}" if a != b else str(a)
            for a, b in writer.missing[:_MAX_MISSING_RANGES]
        )
        notes.append(
            f"stream {stream_id} 缺段 seq：{ranges}{' …' if len(writer.missing) > _MAX_MISSING_RANGES else ''}"
        )
    notes.extend(f"coverage：{r}" for r in agg.coverage_reasons)
    if error is not None:
        notes.append(f"error：{error.get('code')}：{str(error.get('message'))[:500]}")
    notes.extend(extra_notes or [])
    return notes


def coverage_of(agg: Aggregates, writer: WriterStats, *, mode: str) -> str:
    """Determine the coverage of a part."""
    coverage = "none" if mode == "off" else agg.coverage
    if coverage == "full" and (
        writer.dropped_events or writer.degraded_reason or writer.detail_truncated
    ):
        return "partial"
    return coverage


def build_summary(  # noqa: PLR0913 - Keep the published positional and keyword API.
    agg: Aggregates,
    facts: CallFacts,
    writer: WriterStats,
    *,
    state: str,
    has_publisher: bool,
    max_detail_bytes: int,
    error: Mapping[str, Any] | None = None,
    extra_notes: list[str] | None = None,
) -> dict[str, Any]:
    """Build the final recording summary."""
    summary: dict[str, Any] = {
        "recording_id": facts.recording_id,
        "state": state,
        "metrics": build_metrics(agg, facts, writer, has_publisher=has_publisher),
        "transfer_totals": build_transfer_totals(agg.transfers),
        "part_totals": build_part_totals(agg.parts),
        "coverage": coverage_of(agg, writer, mode=facts.mode),
        "dropped_events": writer.dropped_events,
        "dropped_bytes": writer.dropped_bytes,
        "detail_truncated": writer.detail_truncated,
        "notes": build_notes(
            agg,
            writer,
            mode=facts.mode,
            stream_id=facts.stream_id,
            max_detail_bytes=max_detail_bytes,
            error=error,
            extra_notes=extra_notes,
        ),
        "context_available": facts.context_available,
    }
    cost = agg.cost.summary()
    if cost is not None:
        summary["cost"] = cost
    return summary


def merge_summaries(
    primary: Mapping[str, Any],
    secondary: Mapping[str, Any] | None,
    *,
    state: str | None = None,
) -> dict[str, Any]:
    """Merge two streams' summaries of one recording (the Node's call layer + the runtime's compute layer).

    A metric present in both keeps the primary value (e.g. the whole call's ``host_wall_ms``); the
    secondary one is kept as ``runtime.<name>`` so the two bases never overwrite each other.
    Transfers and parts add up per category; ``cost`` comes from the stream that recorded it.
    """
    if secondary is None:
        out = {
            k: (dict(v) if isinstance(v, Mapping) else v) for k, v in primary.items()
        }
        if state:
            out["state"] = state
        return out
    metrics = dict(primary.get("metrics") or {})
    for name, m in (secondary.get("metrics") or {}).items():
        if name in metrics:
            metrics[f"runtime.{name}"] = dict(m)
        else:
            metrics[name] = dict(m)
    transfers = _merged_transfers(primary, secondary)
    parts = {k: dict(v) for k, v in (primary.get("part_totals") or {}).items()}
    for name, part in (secondary.get("part_totals") or {}).items():
        parts.setdefault(name, dict(part))
    order = {"full": 0, "partial": 1, "none": 2}
    coverage = max(
        str(primary.get("coverage", "full")),
        str(secondary.get("coverage", "full")),
        key=lambda c: order.get(c, 1),
    )
    merged: dict[str, Any] = {
        "recording_id": primary["recording_id"],
        "state": state or str(primary.get("state")),
        "metrics": metrics,
        "transfer_totals": transfers,
        "part_totals": parts,
        "coverage": coverage,
        "dropped_events": int(primary.get("dropped_events", 0))
        + int(secondary.get("dropped_events", 0)),
        "dropped_bytes": int(primary.get("dropped_bytes", 0))
        + int(secondary.get("dropped_bytes", 0)),
        "detail_truncated": bool(primary.get("detail_truncated"))
        or bool(secondary.get("detail_truncated")),
        "notes": [
            *list(primary.get("notes") or []),
            *list(secondary.get("notes") or []),
        ],
        "context_available": bool(primary.get("context_available"))
        or bool(secondary.get("context_available")),
    }
    cost = secondary.get("cost") or primary.get("cost")
    if cost:
        merged["cost"] = dict(cost)
    return merged


def _merged_transfers(
    primary: Mapping[str, Any], secondary: Mapping[str, Any]
) -> dict[str, dict[str, Any]]:
    transfers: dict[str, dict[str, Any]] = {
        k: dict(v) for k, v in (primary.get("transfer_totals") or {}).items()
    }
    for category, tot in (secondary.get("transfer_totals") or {}).items():
        if category not in transfers:
            transfers[category] = dict(tot)
            continue
        cur = transfers[category]
        for key in (
            "submitted_count",
            "submitted_bytes",
            "logical_bytes",
            "no_op_count",
            "pending_count",
        ):
            cur[key] = int(cur.get(key) or 0) + int(tot.get(key) or 0)
        for key in ("completed_count", "completed_bytes"):
            a, b = cur.get(key), tot.get(key)
            cur[key] = None if a is None or b is None else int(a) + int(b)
        cur["host_ms_sum"] = float(cur.get("host_ms_sum") or 0) + float(
            tot.get("host_ms_sum") or 0
        )
        cur["gpu_event_ms_sum"] = None
        cur["effective_gbps"] = None
    return transfers


def environment_facts() -> dict[str, Any]:
    """Environment facts for a recording context (never a dump of the whole environment)."""
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "pid": os.getpid(),
        "hostname": platform.node(),
    }


__all__ = [
    "COPY_CATEGORIES",
    "HOST_TIMED_CATEGORIES",
    "PHASE_METRICS",
    "CallFacts",
    "build_metrics",
    "build_notes",
    "build_part_totals",
    "build_summary",
    "build_transfer_totals",
    "coverage_of",
    "environment_facts",
    "merge_summaries",
]
