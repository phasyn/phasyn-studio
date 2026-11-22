"""Choose among complete saved alternatives. Model loading, tensor transfer and execution stay with the runtime."""

from __future__ import annotations

import asyncio
import copy
from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError

from ..runner.plan import plan_run
from .calibration import PlacementSnapshot, from_run
from .memory import evaluate_memory
from .reservations import apply, current, physical_pools
from .sensors import read_node


if TYPE_CHECKING:
    from ..state import Controller
type Doc = dict[str, Any]
_MAX_PLACEMENT_STEPS = 32


def shape_settings(values: Doc) -> Doc:
    """Select load parameters that affect the memory footprint."""
    keys = {
        "width",
        "height",
        "frames",
        "num_frames",
        "frame_count",
        "resolution",
        "batch_size",
        "steps",
        "num_inference_steps",
        "sequence_length",
        "max_sequence_length",
        "num_images",
    }
    return {
        k: v
        for k, v in values.items()
        if k in keys and isinstance(v, int | float | str) and not isinstance(v, bool)
    }


def input_shapes(inputs: Doc) -> Doc:
    """Describe the input shapes relevant to an estimate."""
    summary = {}
    for name, typed in inputs.items():
        value = typed.get("value")
        ref = typed.get("file") or {}
        meta = ref.get("metadata") or {}
        shape = {"type_id": typed["type_id"], **shape_settings(meta)}
        if ref:
            shape["size_bytes"] = ref["size_bytes"]
        elif isinstance(value, str):
            shape["text_characters"] = len(value)
        elif isinstance(value, dict):
            shape.update(shape_settings(value))
        summary[name] = shape
    return summary


def strategy(settings: Doc) -> Doc:
    """Report the offload and precision policies already selected by the runtime."""
    options = settings.get("provider_options") or {}
    names = (
        "offload",
        "offload_mode",
        "cpu_offload",
        "group_offload",
        "offload_strategy",
        "vae_streaming",
        "streaming",
        "offload_device",
        "disk_offload",
        "prefetch_depth",
        "pinned_memory",
    )
    return {
        "load": settings.get("offload") or {},
        "provider_options": {
            k: options[k]
            for k in names
            if k in options and isinstance(options[k], str | int | bool)
        },
    }


def targets(pipeline: Doc) -> dict[str, set[str]]:
    """Group the pipeline components by their hosting Node."""
    nodes: dict[str, set[str]] = {}
    for step in pipeline["steps"]:
        nodes.setdefault(step["node_id"], set()).add(step["component_id"])
    return nodes


async def read_all(ctl: Controller, pipeline: Doc) -> dict[str, Doc | None]:
    """Fetch bounded resource observations for all target Nodes."""
    nodes = targets(pipeline)
    replies = await asyncio.gather(
        *(read_node(ctl, node, ids) for node, ids in nodes.items())
    )
    return dict(zip(nodes, replies, strict=True))


def history(
    ctl: Controller, component: tuple[str, str], obs: Doc, source: str, risks: Doc
) -> tuple[list[Doc], list[str]]:
    """Compare recorded peaks with the current shape and settings."""
    node, cid = component
    if not obs["effective_load_digest"]:
        return [], []
    items = ctl.cost_profiles.profiles(node_id=node, component_id=cid)["items"]
    match = next(
        (
            p
            for p in items
            if p["device_id"] == obs["device_id"]
            and p["load_digest"] == obs["effective_load_digest"]
            and p["source_revision"] == source
            and p["provider_id"] == obs["provider_id"]
        ),
        None,
    )
    if not match:
        return [], []
    notes = []
    failed = []
    for s in match["stages"][:32]:
        risk = risks.get(s["stage"])
        measured = None
        if risk and risk["unit"] == s["risk_unit"]:
            measured = risk["value"]
            if s["min_failed_risk"] is not None and measured >= s["min_failed_risk"]:
                failed.append("recorded_oom:" + s["stage"])
        notes.append(
            {
                k: s.get(k)
                for k in (
                    "stage",
                    "risk_unit",
                    "max_succeeded_risk",
                    "min_failed_risk",
                    "last_recording_id",
                    "samples",
                )
            }
            | {"requested_risk": measured}
        )
    return notes, failed


def _component_changes(
    sid: str, s: Doc, obs: Doc, descriptor: Doc, loaded: Doc
) -> list[str]:
    bad = []
    device = obs["device_id"]
    if (
        obs["state"] not in {"ready", "busy"}
        or not loaded
        or not obs["effective_load_digest"]
    ):
        bad.append("component_not_loaded:" + sid)
    if (
        obs["provider_id"] != descriptor["provider_id"]
        or obs["loaded_revision"] != s["load_revision"]
        or obs["resource_group"] != s["resource_group"]
        or device != (loaded.get("device") or {}).get("id")
    ):
        bad.append("component_changed:" + sid)
    return bad


def _admission(
    sid: str, obs: Doc, *, group_occupied: bool, device_active: bool
) -> list[str]:
    waiting = []
    if obs["busy"] or obs["state"] == "busy" or group_occupied:
        waiting.append("resource_group_busy:" + sid)
    waiting.extend("admission:" + sid + ":" + reason for reason in obs["holds"])
    if device_active:
        waiting.append("device_active:" + sid)
    return waiting


def _envelope_error(
    envelope: Doc | None, signature: str, observed: dict[str, Doc | None]
) -> str | None:
    if not envelope:
        return "missing_shape_envelope"
    if envelope["signature"] != signature:
        return "measurement_does_not_match_frozen_request"
    if set(envelope["nodes"]) != set(observed):
        return "node_envelope_mismatch"
    return None


def assess(
    ctl: Controller,
    frozen: PlacementSnapshot,
    envelope: Doc | None,
    *,
    slot: bool,
    occupied: set[tuple[str, str]],
) -> Doc:
    """Evaluate the frozen pipeline against Node capacity and existing reservations."""
    body, steps, descriptors, observed = (
        frozen.body,
        frozen.steps,
        frozen.descriptors,
        frozen.observed,
    )
    pipe = body["pipeline"]
    bad = []
    waiting = []
    basis = {}
    view = {}
    nodes_view = {}
    groups: dict[str, set[str]] = {}
    for sid, s in steps.items():
        node = s["node_id"]
        cid = s["component_id"]
        snapshot = observed[node]
        if snapshot is None:
            bad.append("node_unreachable_or_unverified:" + node)
            continue
        obs = snapshot["components"][cid]
        device = obs["device_id"]
        groups.setdefault(node, set()).add(device)
        if device not in snapshot["devices"]:
            bad.append("device_missing:" + sid)
            continue
        descriptor = descriptors[node, cid]
        loaded = descriptor["settings"].get("loaded") or {}
        bad.extend(_component_changes(sid, s, obs, descriptor, loaded))
        waiting.extend(
            _admission(
                sid,
                obs,
                group_occupied=(node, obs["resource_group"]) in occupied,
                device_active=(snapshot["devices"][device]["utilization_pct"] or 0) > 0,
            )
        )
        basis[sid] = {
            "node": node,
            "component": cid,
            "provider": obs["provider_id"],
            "runtime": obs["runtime_id"],
            "device": device,
            "group": obs["resource_group"],
            "source_revision": snapshot["source_revision"],
            "loaded_revision": s["load_revision"],
            "effective_load_digest": obs["effective_load_digest"],
            "invoke_digest": digest(s["invoke_snapshot"]),
            "recording_digest": digest(s["recording_snapshot"]),
            "stored_load_digest": digest(loaded),
        }
        fits, oom = history(
            ctl,
            (node, cid),
            obs,
            snapshot["source_revision"],
            ((envelope or {}).get("stage_risks") or {}).get(sid, {}),
        )
        bad.extend(oom)
        view[sid] = {
            "configuration": basis[sid],
            "input_shape": shape_settings(s["invoke_snapshot"]),
            "offload": strategy(loaded),
            "precision": loaded.get("precision") or {},
            "cost_evidence": fits,
        }
    signature = digest({"request": body, "steps": basis})
    envelope_error = _envelope_error(envelope, signature, observed)
    if envelope_error:
        bad.append(envelope_error)
    for node, snapshot in observed.items():
        if snapshot is None:
            continue
        pools: Doc = {}
        need = (envelope or {}).get("nodes", {}).get(node)
        if need is not None:
            impossible, busy, pools = evaluate_memory(
                snapshot, need, groups.get(node, set())
            )
            bad.extend(node + ":" + k for k in impossible)
            waiting.extend(node + ":" + k for k in busy)
        nodes_view[node] = {
            "host_pool_id": snapshot["host_pool_id"],
            "sampled_at": snapshot["sampled_at"],
            "host": snapshot["host"],
            "devices": snapshot["devices"],
            "pools": pools,
        }
    if not slot:
        waiting.append("controller_slots_busy")
    return {
        "pipeline_id": pipe["pipeline_id"],
        "state": "rejected" if bad else "waiting" if waiting else "ready",
        "signature": signature,
        "reasons": list(dict.fromkeys(bad + waiting)),
        "input_shapes": input_shapes(body["inputs"]),
        "steps": view,
        "nodes": nodes_view,
        "physical_pools": physical_pools(nodes_view),
        "envelope_basis": (envelope or {}).get("basis"),
    }


async def _evaluate_candidate(
    ctl: Controller, entry: Doc, inputs: Doc
) -> tuple[Doc, Doc | None]:
    pid = entry["pipeline_id"]
    pipe = await asyncio.to_thread(ctl.pipelines.get, pid)
    if not 1 <= len(pipe["steps"]) <= _MAX_PLACEMENT_STEPS:
        raise ComponentError("INVALID_ARGUMENT", "資源規劃最多支援三十二個步驟")
    for s in pipe["steps"]:
        s["node_id"] = s["node_id"].lower()
    body = {"pipeline": pipe, "inputs": inputs, "recovery_policy": "observe_only"}
    contracts.validate("RunRequest", body)
    keys = {(s["node_id"], s["component_id"]) for s in pipe["steps"]}
    descriptors = await asyncio.to_thread(ctl.catalog.descriptors, keys)
    _, _, steps = await asyncio.to_thread(plan_run, body, descriptors)
    observed = await read_all(ctl, pipe)
    frozen = PlacementSnapshot(body, steps, descriptors, observed)
    envelope = entry.get("envelope")
    evidence = (envelope or {}).get("evidence") or {}
    source = entry.get("source_run_id") or evidence.get("run_id")
    if source:
        probe = await asyncio.to_thread(
            assess, ctl, frozen, None, slot=True, occupied=set()
        )
        measured = await asyncio.to_thread(
            from_run,
            ctl,
            source,
            entry.get("padding_percent", evidence.get("padding_percent", 0)),
            frozen,
            probe["signature"],
        )
        contracts.validate("PlacementEnvelope", measured)
        if envelope is not None and measured != envelope:
            raise ComponentError("STATE_CONFLICT", "歷史量測與已核准的資源配置不同")
        envelope = measured
    option = await asyncio.to_thread(
        assess,
        ctl,
        frozen,
        envelope,
        slot=ctl.runner.has_slot(),
        occupied=set(ctl.runner.holders()),
    )
    claims = apply(option, current(ctl))
    if option["state"] == "rejected":
        return option, None
    guard = {
        "signature": option["signature"],
        "envelope": envelope,
        "claims": claims,
    }
    return option, {**body, "placement": guard}


async def candidate(ctl: Controller, entry: Doc, inputs: Doc) -> tuple[Doc, Doc | None]:
    """Build a candidate with its validation and placement evidence."""
    pid = entry["pipeline_id"]
    try:
        return await _evaluate_candidate(ctl, entry, inputs)
    except ComponentError as exc:
        return {
            "pipeline_id": pid,
            "state": "rejected",
            "signature": None,
            "reasons": [exc.code, str((exc.details or {}).get("reason", exc.message))],
            "input_shapes": {},
            "steps": {},
            "nodes": {},
            "physical_pools": {},
            "envelope_basis": None,
        }, None


async def preview(ctl: Controller, spec: Doc) -> Doc:
    """Evaluate alternative pipelines and return a signed plan."""
    entries = spec["alternatives"]
    if len({e["pipeline_id"] for e in entries}) != len(entries):
        raise ComponentError("INVALID_ARGUMENT", "候選管線不可重複")
    options = await asyncio.gather(
        *(candidate(ctl, entry, spec["inputs"]) for entry in entries)
    )
    selected = next(
        (
            (o, body)
            for state in ("ready", "waiting")
            for o, body in options
            if o["state"] == state
        ),
        None,
    )
    return {
        "alternatives": [o for o, _ in options],
        "selected": selected[0]["pipeline_id"] if selected else None,
        "run_request": selected[1] if selected else None,
    }


async def verify(
    ctl: Controller, request: Doc, steps: Doc, descriptors: dict[tuple[str, str], Doc]
) -> None:
    """Recheck the frozen plan before dispatching the run."""
    body = copy.copy(request)
    guard = body.pop("placement")
    if body.get("purpose") is not None or body.get("recovery_policy") != "observe_only":
        raise ComponentError("INVALID_ARGUMENT", "自動配置必須使用單次派送策略")
    saved = await asyncio.to_thread(ctl.pipelines.get, body["pipeline"]["pipeline_id"])
    for s in saved["steps"]:
        s["node_id"] = s["node_id"].lower()
    if (
        digest(saved) != digest(body["pipeline"])
        or len(saved["steps"]) > _MAX_PLACEMENT_STEPS
    ):
        raise ComponentError("STATE_CONFLICT", "資源配置的管線已變更，請重新預覽")
    observed = await read_all(ctl, saved)
    frozen = PlacementSnapshot(body, steps, descriptors, observed)
    result = await asyncio.to_thread(
        assess,
        ctl,
        frozen,
        guard["envelope"],
        slot=ctl.runner.has_slot(),
        occupied=set(ctl.runner.holders()),
    )
    evidence = guard["envelope"].get("evidence")
    if evidence:
        measured = await asyncio.to_thread(
            from_run,
            ctl,
            evidence["run_id"],
            evidence["padding_percent"],
            frozen,
            result["signature"],
        )
        if guard["envelope"] != measured:
            raise ComponentError("STATE_CONFLICT", "歷史量測與已核准的資源配置不同")
    # Nothing awaits between this final check and RunManager registering the execution as active.
    claims = apply(result, current(ctl))
    if (
        claims != guard["claims"]
        or result["signature"] != guard["signature"]
        or result["state"] != "ready"
    ):
        raise ComponentError(
            "STATE_CONFLICT",
            "資源配置目前無法送出",
            details={"state": result["state"], "reasons": result["reasons"]},
        )
