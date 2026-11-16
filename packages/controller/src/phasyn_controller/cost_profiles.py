"""Cost profiles for the ETA estimator: how many milliseconds one unit of work takes, per component and setup.

Providers record the work they actually did in each recording's ``cost`` block (stages with ``work`` in a
``work_unit`` and the measured ``compute_ms``). This module fits, from the recording index only, a profile per
key (node, device, component, effective load settings, code revision), and within it one fit per
(stage, work_unit); a unit outside :data:`COST_UNITS` is ignored:

- stage ``theta_ms_per_unit`` from the most recent :data:`MAX_SAMPLES` successful *warm* calls within
  :data:`WINDOW_DAYS`: 1 sample → its ratio; 2 → Σcompute / Σwork; 3 or more → the weighted median of the
  ratios (weight ``exp(-age / 7 days)``) after dropping outliers (``|log r − median| > max(3·1.4826·MAD,
  ln 1.3)``). No free-form polynomial is ever fitted.
- a key without any warm sample (the first call after a load is always cold) is fitted on its *cold* calls
  with the same rules: a stage's compute span barely depends on the cold start, which mostly lands in the
  overhead and the first step. ``samples`` then counts cold calls (``warm_samples`` is 0, ``cold_samples`` is
  not), ``overhead_ms`` includes the cold start and ``cold_ms`` is null (nothing warm to compare with).
- drift: when the :data:`DRIFT_RUN` newest samples all fall outside the interval of the older ones, on the
  same side, only the :data:`DRIFT_WINDOW` newest samples are used;
- leave-one-out log residuals give the stage's 10 % / 90 % quantiles (the client turns them into intervals);
- ``overhead_ms`` (wall − Σcompute, never below 0), ``cold_ms`` (what the first call after a load costs on top
  of a warm one), ``load_ms`` (median of the "load" stage of load recordings);
- out-of-memory warning: ``max_succeeded_risk`` (largest of successful calls) and ``min_failed_risk``
  (smallest of GPU_OOM / HOST_OOM failures) compare only the stage's ``shape.risk_measure``, a number that
  grows with memory use, in ``shape.risk_unit``. A failure that a newer call of the same or a larger measure
  succeeded after no longer counts: something changed since (the allocator, the other work on the card, the
  settings), and the warning would only keep people from a size that now runs. Work (for example FLOP) is
  never used for this; a stage without a risk measure reports null.

Nothing here is a measured number: the profile is computed from the recordings of the machine it runs on.
"""

from __future__ import annotations

import asyncio
import math
import statistics
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, NamedTuple

from fastapi import APIRouter, Request
from phasyn_components.ids import is_local_id, require_local_id, require_uuid
from phasyn_components.recorder.core import COST_UNITS, RISK_UNIT_RE
from phasyn_components.records import RecordingStore
from phasyn_components.timeutil import parse_rfc3339, utc_now
from phasyn_server.http import json_response
from starlette.responses import JSONResponse

if TYPE_CHECKING:
    from .state import Controller

WINDOW_DAYS = 30
MAX_SAMPLES = 50
WEIGHT_DAYS = 7.0
OUTLIER_MADS = 3.0
MAD_TO_SIGMA = 1.4826
OUTLIER_FLOOR = math.log(1.3)
DRIFT_RUN = 3
DRIFT_WINDOW = 5
OOM_CODES = frozenset({"GPU_OOM", "HOST_OOM"})
ROW_LIMIT = 10000
CACHE_MAX_AGE_S = 600.0  # weights age with time: refit at least this often even when nothing new arrived
CACHE_ENTRIES = 256

ProfileKey = tuple[str, str | None, str, str | None, str | None]
Slot = tuple[str, str]  # (stage, work_unit)


@dataclass(frozen=True)
class Sample:
    recording_id: str
    created_at: datetime
    work: float
    compute_ms: float

    @property
    def ratio(self) -> float:
        return self.compute_ms / self.work


def _weight(sample: Sample, now: datetime) -> float:
    age_days = max(0.0, (now - sample.created_at).total_seconds() / 86400.0)
    return math.exp(-age_days / WEIGHT_DAYS)


def _weighted_median(values: Sequence[tuple[float, float]]) -> float:
    """Median of (value, weight) pairs: the smallest value whose cumulative weight reaches half the total."""
    ordered = sorted(values)
    total = sum(weight for _, weight in ordered)
    running = 0.0
    for value, weight in ordered:
        running += weight
        if running >= total / 2:
            return value
    return ordered[-1][0]


def inliers(samples: Sequence[Sample]) -> list[Sample]:
    """Drop ratios whose log is too far from the median (the threshold never drops below ln 1.3)."""
    logs = [math.log(s.ratio) for s in samples]
    median = statistics.median(logs)
    mad = statistics.median(abs(value - median) for value in logs)
    limit = max(OUTLIER_MADS * MAD_TO_SIGMA * mad, OUTLIER_FLOOR)
    kept = [s for s, value in zip(samples, logs, strict=True) if abs(value - median) <= limit]
    return kept or list(samples)


def fit_theta(samples: Sequence[Sample], now: datetime) -> float:
    """Milliseconds per unit of work (see the module docstring for the rule per sample count)."""
    if not samples:
        raise ValueError("no samples")
    if len(samples) == 1:
        return samples[0].ratio
    if len(samples) == 2:
        return sum(s.compute_ms for s in samples) / sum(s.work for s in samples)
    kept = inliers(samples)
    return _weighted_median([(s.ratio, _weight(s, now)) for s in kept])


def quantile(values: Sequence[float], q: float) -> float:
    """Linear-interpolation quantile (like ``numpy.quantile``'s default)."""
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def loo_residuals(samples: Sequence[Sample], now: datetime) -> list[float]:
    """``log(actual / predicted)`` of every sample predicted from the others."""
    out: list[float] = []
    for index, sample in enumerate(samples):
        others = [s for i, s in enumerate(samples) if i != index]
        out.append(math.log(sample.compute_ms / (fit_theta(others, now) * sample.work)))
    return out


def stage_window(samples: Sequence[Sample], now: datetime) -> list[Sample]:
    """The samples a stage is fitted on (newest first): all of them, or the newest few after a drift."""
    if len(samples) < DRIFT_RUN + 2:
        return list(samples)
    newest, older = samples[:DRIFT_RUN], samples[DRIFT_RUN:]
    theta = fit_theta(older, now)
    residuals = loo_residuals(older, now)
    low, high = quantile(residuals, 0.1), quantile(residuals, 0.9)
    misses = [math.log(s.compute_ms / (theta * s.work)) for s in newest]
    if all(e > high for e in misses) or all(e < low for e in misses):
        return list(samples[:DRIFT_WINDOW])
    return list(samples)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


class StageCost(NamedTuple):
    name: str
    unit: str
    work: float
    compute_ms: float | None
    risk: float | None  # shape.risk_measure
    risk_unit: str | None  # shape.risk_unit

    @property
    def slot(self) -> Slot:
        return self.name, self.unit


def _risk(shape: Any) -> tuple[float | None, str | None]:
    """(risk_measure, risk_unit) of a stage's shape; (None, None) when absent or malformed."""
    if not isinstance(shape, Mapping):
        return None, None
    risk = _number(shape.get("risk_measure"))
    if risk is None or risk < 0:
        return None, None
    unit = shape.get("risk_unit")
    if unit is None:
        return risk, None
    if not isinstance(unit, str) or not RISK_UNIT_RE.match(unit):
        return None, None
    return risk, unit


def _stages(cost: Mapping[str, Any]) -> Iterable[StageCost]:
    """The stages of a cost block; malformed stages (or units outside COST_UNITS) are skipped."""
    for stage in cost.get("stages") or []:
        if not isinstance(stage, Mapping):
            continue
        work = _number(stage.get("work"))
        unit = stage.get("work_unit")
        if work is None or work <= 0 or not is_local_id(stage.get("stage")) or unit not in COST_UNITS:
            continue
        risk, risk_unit = _risk(stage.get("shape"))
        yield StageCost(str(stage["stage"]), str(unit), work, _number(stage.get("compute_ms")), risk, risk_unit)


def profile_key(row: Mapping[str, Any]) -> ProfileKey:
    cost = row["cost"]
    return (
        str(row["node_id"]),
        cost.get("device_id"),
        str(row["component_id"]),
        cost.get("load_digest"),
        cost.get("source_revision"),
    )


@dataclass
class _Calls:
    """The successful invoke calls of one kind (warm or cold): newest first, at most :data:`MAX_SAMPLES`."""

    rows: list[Mapping[str, Any]] = field(default_factory=list)
    samples: dict[Slot, list[Sample]] = field(default_factory=dict)

    def add(self, row: Mapping[str, Any], created_at: datetime, stages: Iterable[StageCost]) -> None:
        if len(self.rows) >= MAX_SAMPLES:  # rows arrive newest first
            return
        self.rows.append(row)
        for stage in stages:
            if stage.compute_ms is not None and stage.compute_ms > 0:
                sample = Sample(str(row["recording_id"]), created_at, stage.work, stage.compute_ms)
                self.samples.setdefault(stage.slot, []).append(sample)


class _ProfileBuilder:
    def __init__(self, key: ProfileKey, provider_id: str) -> None:
        self.key = key
        self.provider_id = provider_id
        self.warm = _Calls()
        self.cold = _Calls()
        self.loads: list[float] = []
        self.risk_units: dict[Slot, str | None] = {}  # pinned by the newest row that reported a risk measure
        self.succeeded_risk: dict[Slot, float] = {}
        self.failed_risk: dict[Slot, float] = {}

    def add(self, row: Mapping[str, Any], created_at: datetime) -> None:
        cost, state, operation = row["cost"], row.get("state"), row.get("operation")
        stages = list(_stages(cost))
        if operation == "load":
            if state == "succeeded":
                self.loads += [s.compute_ms for s in stages if s.name == "load" and s.compute_ms is not None]
            return
        if operation != "invoke":
            return
        oom = state == "failed" and row.get("error_code") in OOM_CODES
        if state == "succeeded" or oom:
            for stage in stages:
                self._add_risk(stage, failed=oom)
        if state != "succeeded":
            return
        if cost.get("warm") is True:
            self.warm.add(row, created_at, stages)
        elif cost.get("warm") is False:
            self.cold.add(row, created_at, stages)

    def _add_risk(self, stage: StageCost, *, failed: bool) -> None:
        """Track the risk measure of a successful or out-of-memory call (same risk unit as the newest one only)."""
        if stage.risk is None:
            return
        unit = self.risk_units.setdefault(stage.slot, stage.risk_unit)
        if unit != stage.risk_unit:
            return
        if failed:
            # Rows arrive newest first: a success already seen here is newer than this failure, and one of the same
            # or a larger measure supersedes it
            if self.succeeded_risk.get(stage.slot, -math.inf) >= stage.risk:
                return
            self.failed_risk[stage.slot] = min(self.failed_risk.get(stage.slot, math.inf), stage.risk)
        else:
            self.succeeded_risk[stage.slot] = max(self.succeeded_risk.get(stage.slot, 0.0), stage.risk)

    def build(self, now: datetime) -> dict[str, Any]:
        # Warm calls when there are any; otherwise the cold calls (after a load, the first call is always cold).
        basis = self.warm if self.warm.rows or not self.cold.rows else self.cold
        windows = {slot: stage_window(samples, now) for slot, samples in basis.samples.items()}
        thetas = {slot: fit_theta(samples, now) for slot, samples in windows.items()}
        stages = []
        for slot, samples in sorted(windows.items()):
            residuals = loo_residuals(samples, now) if len(samples) >= 2 else []
            newest = max(samples, key=lambda s: s.created_at)
            stages.append(
                {
                    "stage": slot[0],
                    "work_unit": slot[1],
                    "theta_ms_per_unit": thetas[slot],
                    "samples": len(samples),
                    "residual_q10": quantile(residuals, 0.1) if residuals else None,
                    "residual_q90": quantile(residuals, 0.9) if residuals else None,
                    "max_succeeded_risk": self.succeeded_risk.get(slot),
                    "min_failed_risk": self.failed_risk.get(slot),
                    "risk_unit": self.risk_units.get(slot),
                    "updated_at": newest.created_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    "last_recording_id": newest.recording_id,
                }
            )
        newest_row = basis.rows[0] if basis.rows else None
        node_id, device_id, component_id, load_digest, source_revision = self.key
        return {
            "node_id": node_id,
            "device_id": device_id,
            "component_id": component_id,
            "provider_id": self.provider_id,
            "load_digest": load_digest,
            "source_revision": source_revision,
            "load_ms": statistics.median(self.loads) if self.loads else None,
            "load_samples": len(self.loads),
            "overhead_ms": _overhead(basis.rows),
            "cold_ms": self._cold(thetas) if basis is self.warm else None,
            "samples": len(basis.rows),
            "warm_samples": len(self.warm.rows),
            "cold_samples": len(self.cold.rows),
            "updated_at": str(newest_row["created_at"]) if newest_row is not None else None,
            "last_recording_id": str(newest_row["recording_id"]) if newest_row is not None else None,
            "stages": stages,
        }

    def _cold(self, thetas: Mapping[Slot, float]) -> float | None:
        """median over first-after-load calls of what their stages took beyond the warm prediction."""
        extras = []
        for row in self.cold.rows:
            parts = [
                (s.compute_ms, thetas[s.slot] * s.work)
                for s in _stages(row["cost"])
                if s.compute_ms is not None and s.slot in thetas
            ]
            if parts:
                extras.append(max(0.0, sum(actual - predicted for actual, predicted in parts)))
        return statistics.median(extras) if extras else None


def _overhead(rows: Iterable[Mapping[str, Any]]) -> float | None:
    """median(wall − Σ stage compute) of the calls, never below 0; None without wall times."""
    gaps = []
    for row in rows:
        wall = _number(row.get("wall_ms"))
        if wall is not None:
            computed = sum(s.compute_ms for s in _stages(row["cost"]) if s.compute_ms is not None)
            gaps.append(max(0.0, wall - computed))
    return statistics.median(gaps) if gaps else None


def build_profiles(rows: Iterable[Mapping[str, Any]], *, now: datetime) -> list[dict[str, Any]]:
    """Cost profiles from index rows (newest first, as ``RecordingStore.cost_rows`` returns them)."""
    oldest = now - timedelta(days=WINDOW_DAYS)
    builders: dict[ProfileKey, _ProfileBuilder] = {}
    for row in rows:
        cost = row.get("cost")
        if not isinstance(cost, Mapping):
            continue
        try:
            created_at = parse_rfc3339(str(row["created_at"]))
        except (KeyError, ValueError):
            continue
        if created_at < oldest:
            continue
        key = profile_key(row)
        builder = builders.get(key)
        if builder is None:
            builder = builders[key] = _ProfileBuilder(key, str(row.get("provider_id") or ""))
        builder.add(row, created_at)
    return [builders[key].build(now) for key in sorted(builders, key=lambda k: tuple(str(part) for part in k))]


def cost_profiles(rows: Iterable[Mapping[str, Any]], *, now: str | None = None) -> dict[str, Any]:
    """Contract ``CostProfileList``."""
    stamp = now or utc_now()
    return {"computed_at": stamp, "items": build_profiles(rows, now=parse_rfc3339(stamp))}


@dataclass(frozen=True)
class _Cached:
    generation: int
    at: float
    value: dict[str, Any]


class CostProfileService:
    """Fits on demand; an answer is reused until the recording index changes (or :data:`CACHE_MAX_AGE_S`)."""

    def __init__(self, store: RecordingStore, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.store = store
        self.clock = clock
        self._lock = threading.Lock()
        self._cache: dict[tuple[str | None, str | None], _Cached] = {}
        self.fits = 0

    def profiles(self, *, node_id: str | None = None, component_id: str | None = None) -> dict[str, Any]:
        """(thread) Contract ``CostProfileList`` for the query."""
        key = (node_id, component_id)
        generation = self.store.generation  # read before the index rows: a concurrent write invalidates
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None and hit.generation == generation and self.clock() - hit.at < CACHE_MAX_AGE_S:
                return hit.value
        stamp = utc_now()
        since = (parse_rfc3339(stamp) - timedelta(days=WINDOW_DAYS)).isoformat()
        rows = self.store.cost_rows(node_id=node_id, component_id=component_id, since=since, limit=ROW_LIMIT)
        value = cost_profiles(rows, now=stamp)
        with self._lock:
            self.fits += 1
            if len(self._cache) >= CACHE_ENTRIES:
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = _Cached(generation, self.clock(), value)
        return value


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.get("/api/cost-profiles")
    async def list_cost_profiles(request: Request) -> JSONResponse:
        """x-phasyn-extension: cost profiles fitted on demand from the recording index (no extra write path)."""
        params = request.query_params
        node_id = require_uuid(params["node_id"], "node_id") if params.get("node_id") else None
        component_id = require_local_id(params["component_id"], "component_id") if params.get("component_id") else None
        doc = await asyncio.to_thread(ctl.cost_profiles.profiles, node_id=node_id, component_id=component_id)
        return json_response(doc)

    return router


__all__ = [
    "MAX_SAMPLES",
    "WINDOW_DAYS",
    "CostProfileService",
    "Sample",
    "StageCost",
    "build_profiles",
    "cost_profiles",
    "fit_theta",
    "inliers",
    "loo_residuals",
    "quantile",
    "routes",
    "stage_window",
]
