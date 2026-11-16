"""Loading and validating the wire contracts (``contracts/component.schema.json``, JSON Schema 2020-12).

Lookup order: the ``PHASYN_CONTRACTS_DIR`` environment variable, the copy packaged in the wheel
(``phasyn_components/_contracts``), then a ``contracts/`` directory found by walking up from this
file (a workspace checkout). The result is cached for the life of the process.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import reprlib
from collections.abc import Iterator, Mapping
from functools import cache, lru_cache
from pathlib import Path
from typing import Any

from .errors import ComponentError

SCHEMA_FILE = "component.schema.json"
METRIC_CATALOG_FILE = "metric-catalog.json"
OPENAPI_FILE = "openapi.json"
CONTRACTS_DIR_ENV = "PHASYN_CONTRACTS_DIR"


@lru_cache(maxsize=1)
def contracts_dir() -> Path:
    env = os.environ.get(CONTRACTS_DIR_ENV)
    if env and (Path(env) / SCHEMA_FILE).is_file():
        return Path(env)
    here = Path(__file__).resolve().parent
    packaged = here / "_contracts"
    if (packaged / SCHEMA_FILE).is_file():
        return packaged
    for parent in here.parents:
        candidate = parent / "contracts"
        if (candidate / SCHEMA_FILE).is_file():
            return candidate
    raise RuntimeError("找不到 contracts/component.schema.json；設定 PHASYN_CONTRACTS_DIR")


@lru_cache(maxsize=1)
def schema() -> dict[str, Any]:
    return json.loads((contracts_dir() / SCHEMA_FILE).read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def metric_catalog() -> dict[str, dict[str, Any]]:
    doc = json.loads((contracts_dir() / METRIC_CATALOG_FILE).read_text(encoding="utf-8"))
    return {str(m["name"]): dict(m) for m in doc.get("metrics", [])}


def definition(name: str) -> dict[str, Any]:
    defs = schema()["$defs"]
    if name not in defs:
        raise KeyError(name)
    return defs[name]


@lru_cache(maxsize=256)
def _pattern(source: str) -> re.Pattern[str]:
    """``pattern`` compiled with ECMAScript anchoring: Python's ``$`` also matches before a final newline."""
    if source.endswith("$") and not source.endswith("\\$"):
        source = source[:-1] + r"\Z"
    return re.compile(source)


def _strict_pattern(validator: Any, pattern: str, instance: Any, _schema: Any) -> Iterator[Any]:
    from jsonschema import ValidationError

    if validator.is_type(instance, "string") and not _pattern(pattern).search(instance):
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


@lru_cache(maxsize=1)
def _validator_class() -> Any:
    """Draft 2020-12 with a ``pattern`` that an identifier ending in a line break cannot pass."""
    from jsonschema import Draft202012Validator, validators

    return validators.extend(Draft202012Validator, {"pattern": _strict_pattern})


def _for_definition(validator_class: Any, name: str) -> Any:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource

    root = schema()
    definition(name)  # KeyError for unknown names
    resource = Resource.from_contents(root)
    registry = Registry().with_resource(root["$id"], resource)
    sub = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$ref": f"{root['$id']}#/$defs/{name}"}
    return validator_class(sub, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER)


@cache
def _validator(name: str) -> Any:
    return _for_definition(_validator_class(), name)


# ---------------------------------------------------------------------- documents from strangers
# The stock validator answers ``uniqueItems`` by comparing every pair of values that cannot be sorted, and ``anyOf``
# by collecting every problem of every alternative before it says anything. For a document a stranger wrote, each
# turns a few kilobytes into a minute of work. The two keywords below give the same verdicts at a cost that grows
# only with the size of the document, and STRANGER_DEPTH keeps the recursion of everything that follows shallow.
STRANGER_DEPTH = 32
_brief = reprlib.Repr().repr


def _frozen(value: Any) -> Any:
    """A hashable stand-in, equal exactly when two JSON values are: 1 and 1.0 are, true and 1 are not."""
    if value is None or isinstance(value, bool):
        return (type(value), value)
    if isinstance(value, dict):
        return frozenset((key, _frozen(item)) for key, item in value.items())
    if isinstance(value, list):
        return tuple(_frozen(item) for item in value)
    return value


def _hashed_unique_items(validator: Any, unique: Any, instance: Any, _schema: Any) -> Iterator[Any]:
    from jsonschema import ValidationError

    if unique and validator.is_type(instance, "array"):
        seen: set[Any] = set()
        for item in instance:
            key = _frozen(item)
            if key in seen:
                yield ValidationError(f"{_brief(instance)} has non-unique elements")
                return
            seen.add(key)


def _first_problem_any_of(validator: Any, alternatives: Any, instance: Any, _schema: Any) -> Iterator[Any]:
    from jsonschema import ValidationError

    for index, alternative in enumerate(alternatives):
        if next(validator.descend(instance, alternative, schema_path=index), None) is None:
            return
    yield ValidationError(f"{_brief(instance)} is not valid under any of the given schemas")


@lru_cache(maxsize=1)
def _stranger_validator_class() -> Any:
    from jsonschema import validators

    return validators.extend(_validator_class(), {"uniqueItems": _hashed_unique_items, "anyOf": _first_problem_any_of})


@cache
def _stranger_validator(name: str) -> Any:
    return _for_definition(_stranger_validator_class(), name)


def _deeper_than(value: Any, limit: int) -> bool:
    """Whether arrays and objects nest more than ``limit`` levels (level by level, so no depth can exhaust a stack)."""
    level = [value]
    for _ in range(limit + 1):
        level = [
            child
            for node in level
            if isinstance(node, dict | list)
            for child in (node.values() if isinstance(node, dict) else node)
        ]
        if not level:
            return False
    return True


def _format_error(err: Any) -> str:
    path = "/".join(str(p) for p in err.absolute_path) or "(root)"
    return f"{path}: {err.message}"[:500]


def errors(name: str, obj: Any, *, limit: int = 20) -> list[str]:
    validator = _validator(name)
    out: list[str] = []
    for err in sorted(validator.iter_errors(obj), key=lambda e: list(e.absolute_path)):
        out.append(_format_error(err))
        if len(out) >= limit:
            break
    return out


def first_errors(name: str, obj: Any, *, limit: int = 20) -> list[str]:
    """The first ``limit`` problems in validation order, at a cost that grows only with the size of ``obj``.

    For documents from strangers (a plugin manifest). :func:`errors` produces every error before it sorts and cuts
    them, on a validator that a small hostile document keeps busy for a minute. Here nothing is looked for beyond
    ``limit`` problems, a document nested deeper than ``STRANGER_DEPTH`` levels is one problem and is not examined
    further, uniqueness is decided by hashing, and an alternative of ``anyOf`` is left at its first problem.
    """
    if _deeper_than(obj, STRANGER_DEPTH):
        return [f"(root): nested deeper than {STRANGER_DEPTH} levels"]
    return [_format_error(err) for err in itertools.islice(_stranger_validator(name).iter_errors(obj), limit)]


def validate(name: str, obj: Any, *, code: str = "INVALID_ARGUMENT", what: str | None = None) -> None:
    problems = errors(name, obj)
    if problems:
        label = what or name
        raise ComponentError(code, f"{label} 不符合契約：{problems[0]}", details={"schema": name, "errors": problems})


def is_valid(name: str, obj: Any) -> bool:
    return not errors(name, obj, limit=1)


def validate_with_schema(json_schema: Mapping[str, Any], obj: Any, *, code: str, what: str) -> None:
    """以 provider 宣告的 schema 驗證（settings_schema、parameters_schema）。"""
    from jsonschema import Draft202012Validator

    validator = _validator_class()(dict(json_schema), format_checker=Draft202012Validator.FORMAT_CHECKER)
    problems = [_format_error(e) for e in sorted(validator.iter_errors(obj), key=lambda e: list(e.absolute_path))][:20]
    if problems:
        raise ComponentError(code, f"{what}：{problems[0]}", details={"errors": problems})


def defaults_of(name: str) -> dict[str, Any]:
    """object definition 的頂層 default 值（例如 RecorderConfig）。"""
    props = definition(name).get("properties", {})
    return {k: v["default"] for k, v in props.items() if isinstance(v, dict) and "default" in v}


__all__ = [
    "contracts_dir",
    "defaults_of",
    "definition",
    "errors",
    "first_errors",
    "is_valid",
    "metric_catalog",
    "schema",
    "validate",
    "validate_with_schema",
]
