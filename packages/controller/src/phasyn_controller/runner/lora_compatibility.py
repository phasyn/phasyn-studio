"""Resolve a provider's declarative LoRA restrictions against the same snapshots used for dispatch."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError


type Doc = dict[str, Any]
CAPABILITY = "lora_compatibility"
_ID = {"type": "string", "maxLength": 128, "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$"}
_PATH = {"type": "array", "items": _ID, "minItems": 1, "maxItems": 8}
_HASH = {"type": "string", "pattern": "^[a-f0-9]{64}$", "maxLength": 64}
_MISSING = object()
_MAX_ADAPTERS = 64


def _closed(properties: Doc, *required: str) -> Doc:
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
    }


_ELEMENTS = {"type": ["number", "string", "boolean", "null"], "maxLength": 256}
_CONDITION = _closed(
    {
        "scope": {"enum": ["load", "invoke", "adapter", "upstream_invoke", "input"]},
        "default": _ELEMENTS,
        "path": {**_PATH, "minItems": 0},
        "port": _ID,
        "provider": _ID,
        "allow": {
            "type": "array",
            "items": _ELEMENTS,
            "minItems": 1,
            "maxItems": 32,
            "uniqueItems": True,
        },
        "min": {"type": "number"},
        "max": {"type": "number"},
    },
    "scope",
    "path",
)
_CONDITION["allOf"] = [
    {"anyOf": [{"required": [field]} for field in ("allow", "min", "max")]},
    {
        "if": {"properties": {"scope": {"enum": ["input", "upstream_invoke"]}}},
        "then": {"properties": {"default": False}},
    },
    {
        "if": {"properties": {"scope": {"const": "upstream_invoke"}}},
        "then": {"required": ["port", "provider"]},
        "else": {"properties": {"provider": False}},
    },
    {
        "if": {"properties": {"scope": {"const": "input"}}},
        "then": {"required": ["port"]},
    },
    {
        "if": {"properties": {"scope": {"enum": ["load", "invoke", "adapter"]}}},
        "then": {"properties": {"port": False}},
    },
]
_CONDITIONS = {"type": "array", "items": _CONDITION, "maxItems": 32}
_RULE = _closed(
    {
        "id": _ID,
        "match": {"type": "string", "minLength": 1, "maxLength": 512},
        "role": {"enum": ["style", "control", "acceleration"]},
        "weight_revision": _ID,
        "weight_sha256": _HASH,
        "requires": _CONDITIONS,
    },
    "id",
    "match",
    "role",
    "requires",
)
_SCHEMA = _closed(
    {
        "version": {"const": 1},
        "revision": _ID,
        "adapters": _closed(
            {
                "path": _PATH,
                "layout": {"enum": ["single", "list"]},
                "key": _PATH,
                "sha256": _PATH,
                "allow_absent": {"type": "boolean"},
                "key_encoding": {"enum": ["text", "canonical_sha256"]},
            },
            "path",
            "layout",
            "key",
        ),
        "unlisted": {"enum": ["allow", "reject"]},
        "requires": _CONDITIONS,
        "rules": {"type": "array", "items": _RULE, "maxItems": 64},
    },
    "version",
    "revision",
    "adapters",
    "unlisted",
    "rules",
)


def _get(tree: Any, path: list[str]) -> Any:
    for key in path:
        if not isinstance(tree, Mapping) or key not in tree:
            return _MISSING
        tree = tree[key]
    return tree


def _reject(step: str, reason: str, **details: Any) -> ComponentError:
    # Neither the actual value nor the native filesystem/weight name belongs in a wire error.
    return ComponentError(
        "UNSUPPORTED_SETTING",
        f"步驟 {step} 無法套用 LoRA 相容規則（{reason}）",
        details={"step": step, "capability": CAPABILITY, "reason": reason, **details},
    )


def _rules(declaration: Any, step: str) -> dict[str, Doc]:
    try:
        contracts.validate_with_schema(
            _SCHEMA, declaration, code="UNSUPPORTED_SETTING", what=CAPABILITY
        )
    except ComponentError:
        raise _reject(step, "invalid_declaration") from None
    rules: dict[str, Doc] = {item["match"]: item for item in declaration["rules"]}
    ids = {item["id"] for item in declaration["rules"]}
    if len(rules) != len(declaration["rules"]) or len(ids) != len(rules):
        raise _reject(step, "ambiguous_rule")
    for checks in [
        declaration.get("requires", []),
        *(item["requires"] for item in rules.values()),
    ]:
        if any("min" in c and "max" in c and c["min"] > c["max"] for c in checks):
            raise _reject(step, "invalid_bounds")
    return rules


def _selected(binding: Doc, load: Doc, step: str) -> list[Doc]:
    value = _get(load, binding["path"])
    if value is None or (value is _MISSING and binding.get("allow_absent") is True):
        return []
    values = [value] if binding["layout"] == "single" else value
    if (
        not isinstance(values, list)
        or len(values) > _MAX_ADAPTERS
        or not all(isinstance(a, dict) for a in values)
    ):
        raise _reject(step, "adapter_layout")
    return values


def _equal(left: Any, right: Any) -> bool:
    return isinstance(left, bool) == isinstance(right, bool) and left == right


def _accept(check: Doc, value: Any) -> bool:
    if value is _MISSING or isinstance(value, (list, dict)):
        return False
    if "allow" in check and not any(
        _equal(value, candidate) for candidate in check["allow"]
    ):
        return False
    if "min" not in check and "max" not in check:
        return True
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        return False
    return bool(check.get("min", value) <= value <= check.get("max", value))


@dataclass(frozen=True)
class _Graph:
    definitions: dict[str, Doc]
    providers: dict[str, str]
    inputs: Mapping[str, Any]
    frozen: dict[str, Any]

    def condition_value(self, step: str, check: Doc, load: Doc, adapter: Doc) -> Any:
        scope = check["scope"]
        if scope == "load":
            source = load
        elif scope == "invoke":
            source = self.frozen[step]["invoke_snapshot"]
        elif scope == "adapter":
            source = adapter
        else:
            binding = (self.definitions[step].get("inputs") or {}).get(
                check["port"], {}
            )
            if scope == "upstream_invoke":
                producer = binding.get("from_step")
                if self.providers.get(producer) != check["provider"]:
                    return _MISSING
                source = self.frozen[producer]["invoke_snapshot"]
            else:
                typed = binding.get(
                    "literal", self.inputs.get(binding.get("from_input"))
                )
                if not isinstance(typed, Mapping) or "value" not in typed:
                    return _MISSING
                source = typed["value"]
        value = _get(source, check["path"])
        return check.get("default", _MISSING) if value is _MISSING else value


def _adapter_receipt(rule: Doc | None, binding: Doc, adapter: Doc, sid: str) -> Doc:
    if rule is None:
        return {"rule_id": None}
    receipt = {"rule_id": rule["id"], "role": rule["role"]}
    if "weight_revision" in rule:
        receipt["declared_weight_revision"] = rule["weight_revision"]
    if "weight_sha256" in rule:
        receipt["declared_weight_sha256"] = rule["weight_sha256"]
        if "sha256" in binding:
            value = _get(adapter, binding["sha256"])
            if (
                not isinstance(value, str)
                or not re.fullmatch("[A-Fa-f0-9]{64}", value)
                or value.lower() != rule["weight_sha256"]
            ):
                raise _reject(
                    sid, "configured_weight_sha256_mismatch", rule_id=rule["id"]
                )
            receipt["configured_weight_sha256_matched"] = True
    return receipt


def _check_step(graph: _Graph, sid: str, declaration: Doc, settings: Doc) -> Doc:
    rules = _rules(declaration, sid)
    loaded = isinstance(settings.get("loaded"), dict)
    load = settings["loaded"] if loaded else (settings.get("stored") or {}).get("load")
    revision = settings.get("loaded_revision" if loaded else "stored_revision")
    if type(revision) is not int or not isinstance(load, dict):
        raise _reject(sid, "missing_load_snapshot")
    entry = graph.frozen[sid]
    wanted = entry["load_revision"]
    if wanted is not None and wanted != revision:
        raise _reject(
            sid, "load_revision_mismatch", expected=wanted, available=revision
        )
    binding = declaration["adapters"]
    receipts: list[Doc] = []
    for index, adapter in enumerate(_selected(binding, load, sid)):
        key = _get(adapter, binding["key"])
        if not isinstance(key, str) or not key:
            raise _reject(sid, "missing_adapter_key", index=index)
        if binding.get("key_encoding") == "canonical_sha256":
            key = digest(key)
        rule = rules.get(key)
        if rule is None and declaration["unlisted"] == "reject":
            raise _reject(sid, "unlisted_adapter", index=index)
        receipt = _adapter_receipt(rule, binding, adapter, sid)
        for check in [
            *declaration.get("requires", []),
            *(rule["requires"] if rule else []),
        ]:
            if not _accept(check, graph.condition_value(sid, check, load, adapter)):
                raise _reject(
                    sid,
                    "condition_failed",
                    rule_id=receipt["rule_id"],
                    index=index,
                    scope=check["scope"],
                    field=check["path"],
                )
        receipts.append(receipt)
    # Pin a cold configuration too. A later start with different settings cannot silently run this plan.
    entry["load_revision"] = revision
    return {
        "version": 1,
        "revision": declaration["revision"],
        "definition_sha256": digest(declaration),
        "load_source": "loaded" if loaded else "stored",
        "load_revision": revision,
        "adapters": receipts,
    }


def check_lora_compatibility(
    body: Mapping[str, Any],
    descriptors: Mapping[tuple[str, str], Mapping[str, Any]],
    frozen: dict[str, Any],
) -> None:
    """Check all opted-in steps after stored invoke settings and request overrides have been merged."""
    declared = []
    providers = {}
    definitions = {step["step_id"]: step for step in body["pipeline"]["steps"]}
    for sid, step in definitions.items():
        desc = descriptors[(step["node_id"], step["component_id"])]
        providers[sid] = str(desc.get("provider_id", ""))
        facts = desc.get("facts") or {}
        if CAPABILITY in facts:
            declared.append((sid, facts[CAPABILITY], desc.get("settings") or {}))
    graph = _Graph(definitions, providers, body["inputs"], frozen)
    for sid, declaration, settings in declared:
        frozen[sid][CAPABILITY] = _check_step(graph, sid, declaration, settings)
