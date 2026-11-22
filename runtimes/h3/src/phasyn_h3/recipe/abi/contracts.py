"""The H3 recipe's JSON Schema contracts (draft 2020-12): locate, load and validate.

The schemas ship with the package in ``schemas/`` (tensor/conditioning bundles, the job request and the
runtime profile they reference).  Validation errors are converted into dotted field paths such as
``output.width`` or ``materials[0].role``.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from functools import cache, lru_cache
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError, best_match
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012


BASE_URI = "https://contracts.phasyn-studio.invalid/"
SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"
# a schema every installation must ship; its absence means broken package data
_MARKER = "tensor-bundle.schema.json"


@lru_cache(maxsize=1)
def contracts_dir() -> Path:
    """Locate the contract directory used by the runtime."""
    if not (SCHEMA_DIR / _MARKER).is_file():
        raise FileNotFoundError(
            f"H3 recipe 契約目錄缺少 {_MARKER}（套件資料不完整，請重新安裝 phasyn-h3）"
        )
    return SCHEMA_DIR


def schema_names() -> list[str]:
    """List the registered contract schema names."""
    return sorted(p.name for p in contracts_dir().glob("*.schema.json"))


@cache
def load_contract(name: str) -> Any:
    """Read the requested contract from the schema directory."""
    path = contracts_dir() / name
    if path.parent != contracts_dir() or not path.is_file():
        raise FileNotFoundError(name)
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def registry() -> Registry:
    reg: Registry = Registry()
    for name in schema_names():
        resource = Resource.from_contents(
            load_contract(name), default_specification=DRAFT202012
        )
        reg = reg.with_resource(BASE_URI + name, resource)
    return reg


@cache
def _validator_for_name(name: str) -> Draft202012Validator:
    return Draft202012Validator({"$ref": BASE_URI + name}, registry=registry())


@dataclass(frozen=True)
class Issue:
    """Locate a validation issue in an H3 contract."""

    field_path: str
    message: str
    validator: str


def dotted_path(parts: Iterable[Any]) -> str:
    out = ""
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += ("." if out else "") + str(part)
    return out


_VALIDATION_MESSAGES = {
    "additionalProperties": "不允許未知欄位",
    "type": "型別錯誤，需要 {value}",
    "pattern": "格式不符合規則",
    "minimum": "數值低於下限 {value}",
    "exclusiveMinimum": "數值低於下限 {value}",
    "maximum": "數值超過上限 {value}",
    "exclusiveMaximum": "數值超過上限 {value}",
    "minLength": "字串長度至少 {value}",
    "maxLength": "字串長度最多 {value}",
    "minItems": "項目至少 {value} 個",
    "maxItems": "項目最多 {value} 個",
    "uniqueItems": "項目不可重複",
    "multipleOf": "必須是 {value} 的倍數",
    "oneOf": "不符合任何允許的格式",
    "anyOf": "不符合任何允許的格式",
}


def _messages_zh(error: ValidationError) -> str:
    kind = error.validator
    value = error.validator_value
    if kind == "required":
        missing = error.message.split("'")[1] if "'" in error.message else ""
        return f"缺少必要欄位 {missing}"
    if kind == "enum":
        return f"值不在允許清單：{', '.join(map(str, cast(Iterable[Any], value)))}"
    if kind == "const":
        return f"值必須是 {json.dumps(value, ensure_ascii=False)}"
    template = _VALIDATION_MESSAGES.get(str(kind))
    return template.format(value=value) if template is not None else error.message


def _flatten(error: ValidationError) -> list[ValidationError]:
    if error.validator in ("anyOf", "oneOf") and error.context:
        best = best_match(error.context)
        if best is not None and list(best.absolute_path) != list(error.absolute_path):
            return _flatten(best)
        if best is not None and best.validator not in ("anyOf", "oneOf"):
            return [best]
    return [error]


def issues_from_errors(errors: Iterable[ValidationError]) -> list[Issue]:
    """Convert schema validation errors into located issues."""
    issues: list[Issue] = []
    for raw in errors:
        for error in _flatten(raw):
            base = list(error.absolute_path)
            if error.validator == "additionalProperties" and isinstance(
                error.instance, dict
            ):
                schema = error.schema
                allowed = (
                    set(schema.get("properties", {}))
                    if isinstance(schema, Mapping)
                    else set()
                )
                unexpected = sorted(k for k in error.instance if k not in allowed)
                issues.extend(
                    Issue(
                        dotted_path([*base, key]),
                        "不允許未知欄位",
                        "additionalProperties",
                    )
                    for key in unexpected or [""]
                )
                continue
            if error.validator == "required" and "'" in error.message:
                missing = error.message.split("'")[1]
                issues.append(
                    Issue(
                        dotted_path([*base, missing]), _messages_zh(error), "required"
                    )
                )
                continue
            issues.append(
                Issue(dotted_path(base), _messages_zh(error), str(error.validator))
            )
    # deterministic order, de-duplicated
    seen: set[tuple[str, str]] = set()
    unique: list[Issue] = []
    for issue in sorted(issues, key=lambda i: (i.field_path, i.message)):
        key = (issue.field_path, issue.message)
        if key not in seen:
            seen.add(key)
            unique.append(issue)
    return unique


def validate(document: Any, schema_name: str) -> list[Issue]:
    """Validate against ``schemas/<schema_name>``; an empty list means valid."""
    return issues_from_errors(_validator_for_name(schema_name).iter_errors(document))


class _Missing:
    pass


_MISSING = _Missing()


def schema_default(schema_name: str) -> dict[str, Any]:
    """Collect ``default`` values from a schema's object properties (recursive)."""

    def collect(node: Mapping[str, Any]) -> Any:
        if "default" in node:
            return node["default"]
        if node.get("type") == "object" and "properties" in node:
            out = {}
            for key, sub in node["properties"].items():
                value = collect(sub)
                if value is not _MISSING:
                    out[key] = value
            return out or _MISSING
        return _MISSING

    result = collect(load_contract(schema_name))
    return {} if result is _MISSING else result


__all__ = [
    "Issue",
    "contracts_dir",
    "issues_from_errors",
    "load_contract",
    "schema_default",
    "schema_names",
    "validate",
]
