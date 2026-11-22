"""Reserve authorized CUDA device-seconds and externally enforced charges for a frozen draft plan."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from phasyn_components.errors import ComponentError


type Doc = dict[str, Any]
type Descriptors = dict[tuple[str, str], Doc]

_GPU = "max_gpu_seconds"
_COST = "max_external_cost_usd_micros"
_MAX_SAFE_INTEGER = (1 << 53) - 1
_UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
_CUDA_ID = re.compile(
    rf"(?:[0-9]+|(?:GPU|MIG)-{_UUID}|MIG-GPU-{_UUID}/[0-9]+/[0-9]+)", re.ASCII
)
# The mandatory QC stages use only local FFmpeg/ffprobe. New providers need an independently configured policy.
_LOCAL_QC = frozenset({"media.probe", "media.frame"})


def _reject(reason: str, step: str) -> ComponentError:
    return ComponentError(
        "INVALID_ARGUMENT",
        "草稿預算無法核准",
        details={"reason": reason, "step_id": step},
    )


def _loaded_device(desc: Doc) -> object:
    settings = desc.get("settings") or {}
    loaded = settings.get("loaded")
    if isinstance(loaded, Mapping) and isinstance(loaded.get("device"), Mapping):
        return loaded["device"]
    if settings.get("restart_required") is False and settings.get(
        "loaded_revision"
    ) == settings.get("stored_revision"):
        return desc.get("device")
    return None


def _gpu_count(desc: Doc, step: str) -> int:
    device = _loaded_device(desc)
    if not isinstance(device, Mapping):
        raise _reject("gpu_device_bound_unknown", step)
    if device.get("kind") == "cpu":
        return 0
    value = device.get("id")
    if device.get("kind") != "cuda" or not isinstance(value, str) or not value:
        raise _reject("gpu_device_bound_unknown", step)
    # This is the same visible-device list the Node gives the worker process. No inference from a group label.
    ids = [token.strip() for token in value.split(",")]
    if any(_CUDA_ID.fullmatch(token) is None for token in ids):
        raise _reject("gpu_device_bound_unknown", step)
    return len(ids)


def _policy(container: Doc) -> Doc | None:
    policy = container.get("draft_budget")
    if (
        not isinstance(policy, dict)
        or type(policy.get("version")) is not int
        or policy["version"] != 1
    ):
        return None
    cost = policy.get("external_cost")
    return cost if isinstance(cost, dict) else None


def _uint(value: object) -> bool:
    return type(value) is int and 0 <= value <= _MAX_SAFE_INTEGER


def _external_bound(desc: Doc, step: Doc) -> int:
    name = str(step["step_id"])
    facts, limits = desc.get("facts") or {}, desc.get("limits") or {}
    owner, declared = _policy(limits), _policy(facts)
    if (
        "draft_budget" not in facts
        and "draft_budget" not in limits
        and desc["provider_id"] in _LOCAL_QC
    ):
        return 0
    if owner is None or ("draft_budget" in facts and declared is None):
        raise _reject("external_cost_bound_unverified", name)
    if owner.get("kind") == "local_only" and (
        declared is None or declared.get("kind") == "local_only"
    ):
        return 0
    if (
        owner.get("kind") != "provider_enforced"
        or declared is None
        or declared.get("kind") != "provider_enforced"
    ):
        raise _reject("external_cost_bound_unverified", name)
    # A price estimate or a provider's own assertion is insufficient. The Node owner must attest that this
    # specific connector forwards a mandatory upper limit to the billable service, including its internal calls.
    field = owner.get("parameter")
    if not isinstance(field, str) or not field or declared.get("parameter") != field:
        raise _reject("external_cost_parameter_unverified", name)
    schema = ((desc.get("settings") or {}).get("parameters_schema") or {}).get(
        "properties"
    ) or {}
    field_schema = schema.get(field)
    if not isinstance(field_schema, dict) or field_schema.get("type") != "integer":
        raise _reject("external_cost_parameter_unverified", name)
    amount = step["parameters"].get(field)
    ceiling = owner.get("max_usd_micros_per_call")
    if not _uint(amount) or not _uint(ceiling) or amount > ceiling:
        raise _reject("external_cost_limit_must_be_frozen_on_step", name)
    return int(amount)


def pin_budget_revisions(pipeline: Doc, desc: Descriptors, cfg: Doc) -> None:
    """Freeze the current loaded revision before any candidate authorized under a financial or GPU cap."""
    if _GPU not in cfg and _COST not in cfg:
        return
    for step in pipeline["steps"]:
        descriptor = desc.get((step["node_id"], step["component_id"]), {})
        revision = (descriptor.get("settings") or {}).get("loaded_revision")
        if (
            type(revision) is not int
            or revision < 1
            or step.get("load_revision") not in (None, revision)
        ):
            raise _reject("budget_requires_verified_loaded_revision", step["step_id"])
        step["load_revision"] = revision


def fingerprint_fields(desc: Doc, cfg: Doc | None) -> Doc:
    """Add declared bindings and owner cost policies, preserving digests of older undeclared components."""
    extra: Doc = {}
    facts, limits = desc.get("facts") or {}, desc.get("limits") or {}
    for key in (
        "studio_generation",
        "studio_review",
        "draft_budget",
        "lora_compatibility",
    ):
        if key in facts:
            extra[key] = facts[key]
    if "draft_budget" in limits:
        extra["owner_draft_budget"] = limits["draft_budget"]
    if cfg and (_GPU in cfg or _COST in cfg):
        extra["approved_runtime"] = desc.get("runtime_id")
    if cfg and _GPU in cfg:
        extra["approved_loaded_device"] = _loaded_device(desc)
    policy = _policy(limits)
    field = policy.get("parameter") if policy else None
    if isinstance(field, str):
        fields = ((desc.get("settings") or {}).get("parameters_schema") or {}).get(
            "properties"
        ) or {}
        extra["external_cap_schema"] = fields.get(field)
    return extra


def _reserve_pipeline(pipeline: Doc, desc: Descriptors, cfg: Doc) -> tuple[int, int]:
    gpu = cost = 0
    for step in pipeline["steps"]:
        comp = desc[(step["node_id"], step["component_id"])]
        if _GPU in cfg:
            gpu += int(step["timeout_seconds"]) * _gpu_count(comp, step["step_id"])
        if _COST in cfg:
            cost += _external_bound(comp, step)
    return gpu, cost


def reservations(
    candidates: Sequence[Doc],
    draft: Descriptors,
    qc: Doc,
    checks: Descriptors,
    cfg: Doc,
) -> Doc:
    """Reserve one draft and one QC pass per candidate; rejected totals never reach dispatch."""
    if _GPU not in cfg and _COST not in cfg:
        return {}
    qc_gpu, qc_cost = _reserve_pipeline(qc, checks, cfg)
    gpu, cost = qc_gpu * len(candidates), qc_cost * len(candidates)
    for candidate in candidates:
        draft_gpu, draft_cost = _reserve_pipeline(
            candidate["draft"]["pipeline"], draft, cfg
        )
        gpu += draft_gpu
        cost += draft_cost
    if _GPU in cfg and gpu > cfg[_GPU]:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "GPU 秒數預留超過上限",
            details={
                "reason": "gpu_budget_exceeded",
                "reserved": gpu,
                "limit": cfg[_GPU],
            },
        )
    if _COST in cfg and cost > cfg[_COST]:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "外部費用預留超過上限",
            details={
                "reason": "external_cost_budget_exceeded",
                "reserved": cost,
                "limit": cfg[_COST],
            },
        )
    return {
        **({"reserved_gpu_seconds": gpu} if _GPU in cfg else {}),
        **({"reserved_external_cost_usd_micros": cost} if _COST in cfg else {}),
    }
