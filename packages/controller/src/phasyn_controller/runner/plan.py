"""Planning a run: check the wiring and freeze, per step, exactly what will be sent (pure functions).

At ``POST /api/runs`` every step's load revision, invoke snapshot (stored defaults + step parameters) and
recording snapshot are frozen, so later edits to a component never change a run that already started.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.pipeline import (
    binding_kind,
    dependencies,
    validate_pipeline,
    validate_run_inputs,
)
from phasyn_components.settings import deep_overlay, normalize_recording

from .lora_compatibility import check_lora_compatibility


DEFAULT_TIMEOUT_SECONDS = int(contracts.defaults_of("Step")["timeout_seconds"])

DescriptorKey = tuple[str, str]


@dataclass(frozen=True)
class StepPlan:
    """Frozen component, inputs and dependencies for one run step."""

    step_id: str
    node_id: str
    component_id: str
    inputs: dict[str, Any]
    deps: frozenset[str]
    resource_key: tuple[
        str, str
    ]  # (node_id, resource_group): steps sharing it run one after another
    timeout_seconds: int


def input_summary(inputs: Mapping[str, Any]) -> dict[str, Any]:
    """The run inputs as the controller recording keeps them: FileRef identity or a digest of inline values."""
    out: dict[str, Any] = {}
    for name, value in inputs.items():
        if isinstance(value, dict) and isinstance(value.get("file"), dict):
            ref = value["file"]
            out[name] = {
                "type_id": value.get("type_id"),
                "file": {
                    k: ref.get(k)
                    for k in (
                        "node_id",
                        "file_id",
                        "size_bytes",
                        "sha256",
                        "media_type",
                    )
                },
            }
        elif isinstance(value, dict):
            out[name] = {
                "type_id": value.get("type_id"),
                "value_digest": digest(value.get("value")),
            }
    return out


def _load_revision(step: Mapping[str, Any], settings: Mapping[str, Any]) -> int | None:
    """The step's explicit ``load_revision``, else what the component reports as loaded (None = no check)."""
    if step.get("load_revision") is not None:
        return int(step["load_revision"])
    if settings.get("loaded_revision") is not None:
        return int(settings["loaded_revision"])
    return None


def plan_run(
    body: Mapping[str, Any], descriptors: Mapping[DescriptorKey, Mapping[str, Any]]
) -> tuple[list[str], dict[str, StepPlan], dict[str, Any]]:
    """(order, plans, run.json steps) of a validated RunRequest; ``descriptors`` are private copies."""
    pipeline = body["pipeline"]
    order = validate_pipeline(pipeline, descriptors, require_descriptors=True)
    validate_run_inputs(pipeline, body["inputs"])
    plans: dict[str, StepPlan] = {}
    steps: dict[str, Any] = {}
    for step in pipeline["steps"]:
        sid = str(step["step_id"])
        node_id = str(step["node_id"])
        cid = str(step["component_id"])
        desc = descriptors[(node_id, cid)]
        settings = desc.get("settings") or {}
        stored = settings.get("stored") or {}
        invoke_snapshot = deep_overlay(
            stored.get("invoke") or {}, step.get("parameters") or {}
        )
        recording_snapshot = normalize_recording(
            deep_overlay(
                stored.get("recording") or {}, step.get("recording_override") or {}
            )
        )
        contracts.validate(
            "RecorderConfig", recording_snapshot, what=f"步驟 {sid} 的 recording 設定"
        )
        loaded = (
            settings.get("loaded") if isinstance(settings.get("loaded"), dict) else None
        )
        device = (loaded or {}).get("device") or desc.get("device") or {}
        group = str(device.get("resource_group") or f"component:{cid}")
        plans[sid] = StepPlan(
            step_id=sid,
            node_id=node_id,
            component_id=cid,
            inputs=copy.deepcopy(step.get("inputs") or {}),
            deps=frozenset(dependencies(step)),
            resource_key=(node_id, group),
            timeout_seconds=int(step.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS),
        )
        steps[sid] = {
            "state": "pending",
            "resource_group": group,
            "attempts": [],
            "retry_after_verified_stop": desc.get("retry_after_verified_stop") is True,
            "node_id": node_id,
            "component_id": cid,
            "call_id": None,
            "recording_id": None,
            "started_at": None,
            "finished_at": None,
            "outputs": {},
            "error": None,
            "remote_outcome_unknown": False,
            "settings": None,
            "load_revision": _load_revision(step, settings),
            "invoke_snapshot": invoke_snapshot,
            "recording_snapshot": recording_snapshot,
        }
    check_lora_compatibility(body, descriptors, steps)
    return order, plans, steps


def restore_plans(run: Mapping[str, Any]) -> tuple[list[str], dict[str, StepPlan]]:
    pipeline = run["request"]["pipeline"]
    order = validate_pipeline(pipeline)
    plans = {}
    for step in pipeline["steps"]:
        sid = str(step["step_id"])
        node = str(step["node_id"])
        plans[sid] = StepPlan(
            sid,
            node,
            str(step["component_id"]),
            step.get("inputs") or {},
            frozenset(dependencies(step)),
            (node, run["steps"][sid]["resource_group"]),
            int(step.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS),
        )
    return order, plans


def resolve_inputs(
    plan: StepPlan,
    request_inputs: Mapping[str, Any],
    steps: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """The step's input values: run inputs, upstream outputs (which must exist) or literals."""
    out: dict[str, Any] = {}
    for port, binding in plan.inputs.items():
        kind = binding_kind(binding)
        if kind == "input":
            name = str(binding["from_input"])
            if name in request_inputs:
                out[port] = copy.deepcopy(request_inputs[name])
        elif kind == "step":
            src_id = str(binding["from_step"])
            value = (steps[src_id].get("outputs") or {}).get(str(binding["output"]))
            if value is None:
                raise ComponentError(
                    "PORT_MISMATCH",
                    f"上游步驟 {src_id} 沒有產生輸出 {binding['output']}；不送出步驟 {plan.step_id} 的呼叫",
                    details={
                        "step": plan.step_id,
                        "from_step": src_id,
                        "output": binding["output"],
                    },
                )
            out[port] = copy.deepcopy(value)
        else:
            out[port] = copy.deepcopy(binding["literal"])
    return out


def invoke_request(
    run_id: str, plan: StepPlan, entry: Mapping[str, Any], inputs: Mapping[str, Any]
) -> dict[str, Any]:
    """The InvokeRequest of one step from its frozen snapshots (validated against the contract)."""
    body = {
        "call_id": entry["call_id"],
        "run_id": run_id,
        "step_id": plan.step_id,
        "inputs": dict(inputs),
        "parameters": copy.deepcopy(entry["invoke_snapshot"]),
        "required_loaded_revision": entry["load_revision"],
        "recording": copy.deepcopy(entry["recording_snapshot"]),
        "timeout_seconds": plan.timeout_seconds,
    }
    previous = next(
        (
            a
            for a in entry.get("attempts", [])
            if a.get("superseded") and a["call_id"] != entry["call_id"]
        ),
        None,
    )
    if previous:
        body["retry_of"] = {
            "call_id": previous["call_id"],
            "request_digest": previous["request_digest"],
        }
    contracts.validate(
        "InvokeRequest", body, what=f"步驟 {plan.step_id} 的 InvokeRequest"
    )
    return body


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "StepPlan",
    "input_summary",
    "invoke_request",
    "plan_run",
    "resolve_inputs",
]
