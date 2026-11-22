"""Build a conservative estimate from the actual samples of an identified successful matching run."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError


if TYPE_CHECKING:
    from ..state import Controller
type Doc = dict[str, Any]


def unavailable(reason: str) -> ComponentError:
    """Report why this recording cannot calibrate the requested shape."""
    return ComponentError(
        "INVALID_ARGUMENT", "缺少相符的歷史記憶體量測", details={"reason": reason}
    )


def peak(metrics: Doc, name: str) -> int:
    """Read a measured nonnegative peak from the matching metrics."""
    item = metrics.get(name) or {}
    value = item.get("value")
    if (
        item.get("quality") != "sampled"
        or item.get("unit") != "bytes"
        or not isinstance(value, int)
        or value < 1
    ):
        raise unavailable("missing_sample:" + name)
    return value


@dataclass(frozen=True)
class PlacementSnapshot:
    """Hold a frozen request, its planned steps, and the observed Node configuration."""

    body: Doc
    steps: Doc
    descriptors: dict[tuple[str, str], Doc]
    observed: dict[str, Doc | None]


def from_run(
    ctl: Controller, source: str, margin: int, frozen: PlacementSnapshot, signature: str
) -> Doc:
    """Derive per-stage resource demand from compatible recorded inputs."""
    body, steps, observed = frozen.body, frozen.steps, frozen.observed
    prior = ctl.runs.read(source)
    if prior["state"] != "succeeded" or any(
        digest(prior["request"][k]) != digest(body[k]) for k in ("inputs", "pipeline")
    ):
        raise unavailable("run_request_or_state_mismatch")
    nodes: Doc = {}
    risks: Doc = {}
    ids = []
    for sid, s in steps.items():
        row = prior["steps"][sid]
        nid = s["node_id"]
        cid = s["component_id"]
        snapshot = observed[nid]
        if (
            snapshot is None
            or row.get("state") != "succeeded"
            or row.get("invoke_snapshot") != s["invoke_snapshot"]
            or not row.get("recording_id")
        ):
            raise unavailable("step_or_settings_mismatch:" + sid)
        recorded = ctl.store.get(row["recording_id"])
        context = recorded["context"]
        summary = recorded["summary"]
        cost = summary.get("cost") or {}
        current = snapshot["components"][cid]
        dev = current["device_id"]
        device = snapshot["devices"][dev]
        identity = {
            "recording_id": row["recording_id"],
            "node_id": nid,
            "component_id": cid,
            "run_id": source,
            "call_id": row["call_id"],
            "provider_id": current["provider_id"],
            "operation": "invoke",
        }
        if (
            summary["state"] != "succeeded"
            or not summary["context_available"]
            or any(context.get(k) != v for k, v in identity.items())
            or cost.get("source_revision") != snapshot["source_revision"]
            or not current["effective_load_digest"]
            or cost.get("load_digest") != current["effective_load_digest"]
            or cost.get("device_id") != dev
        ):
            raise unavailable("recording_identity_mismatch:" + sid)
        if device["pool"] not in {"host", "dedicated"}:
            # Actor RSS and CUDA allocation can overlap on a unified machine. A disjoint joint pool measurement is required.
            raise unavailable("joint_pool_measurement_required:" + sid)
        memory = nodes.setdefault(nid, {"host_bytes": 0, "device_bytes": {}})
        # Sum sampled peaks for every step, even when sequential. Resident weights may already be counted
        # in utilization, so this sacrifices some placements rather than inventing a resident baseline.
        memory["host_bytes"] += (
            peak(summary["metrics"], "host_rss_sample_peak_bytes") * (100 + margin) + 99
        ) // 100
        if device["pool"] == "dedicated":
            mem = memory["device_bytes"]
            mem[dev] = (
                mem.get(dev, 0)
                + (
                    peak(summary["metrics"], "nvml_device_used_sample_peak_bytes")
                    * (100 + margin)
                    + 99
                )
                // 100
            )
        ids.append(row["recording_id"])
        for stage in cost.get("stages") or []:
            shape = stage.get("shape") or {}
            val = shape.get("risk_measure")
            unit = shape.get("risk_unit")
            if (
                isinstance(unit, str)
                and isinstance(val, int | float)
                and not isinstance(val, bool)
                and val >= 0
            ):
                risks.setdefault(sid, {})[stage["stage"]] = {"unit": unit, "value": val}
    return {
        "signature": signature,
        "basis": "sampled_process_RSS_and_dedicated_board_used_peaks",
        "nodes": nodes,
        "stage_risks": risks,
        "evidence": {"run_id": source, "recording_ids": ids, "padding_percent": margin},
    }
