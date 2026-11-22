"""Compare frozen inference evidence from two runs; metric deltas are right minus left."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from .canonical import digest


type Doc = dict[str, Any]
_MISSING = object()
_MEASURED = frozenset({"instrumented", "sampled", "trace"})
_STATIC_FIELDS = (
    "provider_id",
    "component_id",
    "node_id",
    "inputs",
    "requested.frozen_invoke_sha256",
    "requested.settings.load",
    "requested.settings.load.precision",
    "effective.settings.load",
    "effective.settings.load.precision",
    "effective.settings.load.provider_options.variant",
    "effective.acceleration",
    "effective.component_policies",
    "model.identity",
    "model.identity.variant",
    "model.sha256",
    "model.components",
    "adapters",
    "runtime",
    "effective.sampling",
)


def _obj(value: object) -> Doc:
    return value if isinstance(value, dict) else {}


def _at(value: Any, path: str) -> Any:
    for key in path.split("."):
        value = _obj(value).get(key, _MISSING)
    return value


def _value(value: Any) -> Any:
    if (
        isinstance(value, dict)
        and value.get("status") in ("recorded", "unknown")
        and "value" in value
    ):
        return value["value"] if value["status"] == "recorded" else None
    return value


def _row(name: str, left: Any, right: Any) -> Doc:
    a, b = _value(left), _value(right)
    if left is _MISSING and right is not _MISSING:
        status = "right_only"
    elif right is _MISSING and left is not _MISSING:
        status = "left_only"
    elif left is _MISSING or a is None or b is None:
        status = "unknown"
    else:
        status = "equal" if digest(a) == digest(b) else "different"
    return {
        "name": name,
        "left": None if left is _MISSING else left,
        "right": None if right is _MISSING else right,
        "status": status,
    }


def _entries(left: Any, right: Any, prefix: str = "") -> list[Doc]:
    a, b = _obj(left), _obj(right)
    return [
        _row(prefix + k, a.get(k, _MISSING), b.get(k, _MISSING))
        for k in sorted(a.keys() | b.keys())
    ]


def _inputs(left: Any, right: Any) -> list[Doc]:
    rows = _entries(left, right)
    for row in rows:
        a = _obj(row["left"])
        checksum = (
            a.get("sha256") if a.get("transport") == "file" else a.get("value_sha256")
        )
        if row["status"] == "equal" and (
            not checksum or any(v is None for v in _obj(a.get("links")).values())
        ):
            row["status"] = "unknown"
    return rows


def _settings(left: Doc, right: Doc) -> list[Doc]:
    rows = [_row(path, _at(left, path), _at(right, path)) for path in _STATIC_FIELDS]
    for path in ("requested.step_parameters", "requested.frozen_invoke", "observed"):
        rows.extend(_entries(_at(left, path), _at(right, path), path + "."))
    return rows


def _measured(metric: Doc) -> bool:
    v = metric.get("value")
    return (
        isinstance(metric.get("quality"), str)
        and metric["quality"] in _MEASURED
        and not isinstance(v, bool)
        and (isinstance(v, int) or (isinstance(v, float) and math.isfinite(v)))
    )


def _metric_reason(left: Doc, right: Doc, *, same_provider: bool) -> str | None:
    if not _measured(left) or not _measured(right):
        return "unmeasured"
    for key in ("unit", "scope", "method"):
        value = left.get(key)
        if not isinstance(value, str) or not value.strip() or value != right.get(key):
            return key
    if left["unit"] in {"bool", "boolean"}:
        return "categorical"
    return None if same_provider else "provider"


def _metrics(left: Any, right: Any, *, same_provider: bool) -> list[Doc]:
    rows = []
    a_metrics, b_metrics = _obj(left), _obj(right)
    for name in sorted(a_metrics.keys() | b_metrics.keys()):
        a, b = _obj(a_metrics.get(name)), _obj(b_metrics.get(name))
        reason = _metric_reason(a, b, same_provider=same_provider)
        try:
            change = None if reason else b["value"] - a["value"]
        except OverflowError:
            change, reason = None, "nonfinite"
        if isinstance(change, float) and not math.isfinite(change):
            change, reason = None, "nonfinite"
        rows.append(
            {
                "name": name,
                "left": a_metrics.get(name),
                "right": b_metrics.get(name),
                "delta": change,
                "reason": reason,
            }
        )
    return rows


def _summary(document: Mapping[str, Any]) -> Doc:
    execution = _obj(document.get("execution"))
    return {
        "run_id": execution["run_id"],
        "state": execution.get("state"),
        "pipeline_id": _obj(document.get("recipe")).get("pipeline_id"),
        "recipe_sha256": document["recipe_sha256"],
        "document_sha256": document["document_sha256"],
    }


def _step(sid: str, left: Mapping[str, Any], right: Mapping[str, Any]) -> Doc:
    a = _obj(_obj(_at(left, "recipe.steps")).get(sid))
    b = _obj(_obj(_at(right, "recipe.steps")).get(sid))
    ar = _obj(_obj(_at(left, "execution.steps")).get(sid))
    br = _obj(_obj(_at(right, "execution.steps")).get(sid))
    same_provider = isinstance(a.get("provider_id"), str) and a["provider_id"] == b.get(
        "provider_id"
    )
    return {
        "step_id": sid,
        "left_present": bool(a),
        "right_present": bool(b),
        "left_recording": ar.get("recording_href"),
        "right_recording": br.get("recording_href"),
        "settings": _settings(a, b),
        "metrics": _metrics(
            ar.get("metrics"), br.get("metrics"), same_provider=same_provider
        ),
    }


def compare_recipes(left: Mapping[str, Any], right: Mapping[str, Any]) -> Doc:
    """Align exact step IDs and retain both measurements, including incomplete or incompatible evidence."""
    steps = (
        _obj(_at(left, "recipe.steps")).keys() | _obj(_at(right, "recipe.steps")).keys()
    )
    return {
        "schema_version": "phasyn.recipe-comparison.v1",
        "left": _summary(left),
        "right": _summary(right),
        "inputs": _inputs(_at(left, "recipe.inputs"), _at(right, "recipe.inputs")),
        "steps": [_step(sid, left, right) for sid in sorted(steps)],
        "attribution": "not_established",
        "perceptual_quality": "not_measured",
    }
