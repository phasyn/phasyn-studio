"""紀錄分析算式。分析用，不在 hot path。

參考算式的語意：p50 用中位數、其他 nearest-rank；
跨 clock domain 的區間不可合併；copy GB/s 分母為同一組 copy 的有效區間。
"""

from __future__ import annotations

import copy
import math
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from typing import Any


def percentile(values: Sequence[float], p: float) -> float | None:
    if not 0 < p <= 100:
        raise ValueError("p must be in (0, 100]")
    if any(not math.isfinite(v) for v in values):
        raise ValueError("non-finite sample")
    xs = sorted(values)
    if not xs:
        return None
    if p == 50 and len(xs) % 2 == 0:
        return (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2
    return float(xs[max(0, math.ceil(len(xs) * p / 100) - 1)])


def union_duration_ms(intervals: Iterable[Mapping[str, Any]]) -> float:
    xs = list(intervals)
    domains = {x["clock_domain"] for x in xs}
    if len(domains) > 1:
        raise ValueError("cross-clock intervals cannot be combined")
    pairs = sorted((int(x["start_mono_ns"]), int(x["end_mono_ns"])) for x in xs)
    if any(s < 0 or e < s for s, e in pairs):
        raise ValueError("invalid interval")
    total = 0
    if pairs:
        start, end = pairs[0]
        for s, e in pairs[1:]:
            if s <= end:
                end = max(end, e)
            else:
                total += end - start
                start, end = s, e
        total += end - start
    return total / 1_000_000


def effective_gbps(completed_bytes: int | None, duration_ms: float | None) -> float | None:
    if completed_bytes is None or duration_ms is None or duration_ms == 0:
        return None
    if completed_bytes < 0 or not math.isfinite(duration_ms) or duration_ms < 0:
        raise ValueError("invalid bytes/duration")
    return completed_bytes / (duration_ms / 1000) / 1_000_000_000


def transfer_totals(records: Iterable[Mapping[str, Any]], coverage: str = "full") -> dict[str, Any]:
    """依 transfer_id 取最後狀態；network 只計 consumer。"""
    if coverage not in ("full", "partial", "none"):
        raise ValueError("invalid coverage")
    latest: dict[str, Mapping[str, Any]] = {}
    for r in records:
        if not r.get("actual_copy", True):
            continue
        if r["category"] == "network" and r.get("owner") != "consumer":
            continue
        latest[r["transfer_id"]] = r
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for r in latest.values():
        grouped[r["category"]].append(r)
    result: dict[str, Any] = {}
    for name, rs in grouped.items():
        unknown = coverage != "full" or any(
            r.get("completed_bytes") is None or r.get("completed_count") is None for r in rs
        )
        observed_bytes = sum(r.get("completed_bytes") or 0 for r in rs)
        observed_count = sum(r.get("completed_count") or 0 for r in rs)
        result[name] = {
            "submitted_bytes": sum(r["submitted_bytes"] for r in rs),
            "submitted_count": sum(r["submitted_count"] for r in rs),
            "completed_bytes": None if unknown else observed_bytes,
            "completed_count": None if unknown else observed_count,
            "observed_completed_bytes": observed_bytes,
            "observed_completed_count": observed_count,
        }
    return result


def paired_roundtrips(records: Iterable[Mapping[str, Any]], coverage: str = "full") -> int | None:
    if coverage != "full":
        return None
    groups: dict[str, set[str]] = defaultdict(set)
    for r in records:
        pair = r.get("roundtrip_id")
        if not pair or not r.get("actual_copy", True):
            continue
        if r["category"] in ("weight_h2d", "weight_d2h") and r.get("completed_count") is None:
            return None
        if (r.get("completed_count") or 0) > 0 and r["category"] in ("weight_h2d", "weight_d2h"):
            groups[pair].add(r["direction"])
    return sum(d == {"H2D", "D2H"} for d in groups.values())


def config_diff(a: Any, b: Any, prefix: str = "") -> list[dict[str, Any]]:
    if isinstance(a, dict) and isinstance(b, dict):
        out: list[dict[str, Any]] = []
        for key in sorted(set(a) | set(b)):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in a or key not in b:
                out.append(
                    {
                        "path": path,
                        "before": copy.deepcopy(a.get(key)),
                        "after": copy.deepcopy(b.get(key)),
                        "before_present": key in a,
                        "after_present": key in b,
                    }
                )
            else:
                out.extend(config_diff(a[key], b[key], path))
        return out
    return [] if a == b else [{"path": prefix, "before": a, "after": b, "before_present": True, "after_present": True}]


def same_latent(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    keys = ("latent_id", "blob_sha256", "manifest_sha256")
    return all(k in a and k in b and a[k] == b[k] for k in keys)


__all__ = [
    "config_diff",
    "effective_gbps",
    "paired_roundtrips",
    "percentile",
    "same_latent",
    "transfer_totals",
    "union_duration_ms",
]
