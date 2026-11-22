"""Read installed native provider declarations without importing a provider or resolving model paths."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
from collections.abc import Mapping
from functools import cache
from importlib.machinery import PathFinder
from shutil import which
from typing import Any

from .contracts import is_valid
from .native_manifest import (
    ManifestIssue,
    invalid_constant,
    package_data,
    read_manifest,
    unique_object,
)
from .registry import ENTRY_POINT_GROUP, known_providers, provider_target
from .upstream import distribution_problem


ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", re.ASCII)
MODULE = re.compile(r"[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*:[a-zA-Z_]\w*", re.ASCII)
FILTERS = (
    "provider_id",
    "kind",
    "input_type",
    "output_type",
    "operation",
    "model",
    "device",
    "cache",
    "retry",
    "cancellation",
    "progress",
    "license",
    "sha256",
)


@cache
def _packages() -> dict[str, dict[str, str | None]]:

    result = {}
    for ep in importlib.metadata.entry_points(group=ENTRY_POINT_GROUP):
        if ep.dist is not None:
            result[ep.name] = {
                "name": ep.dist.metadata.get("Name"),
                "version": ep.dist.version,
            }
    return result


def _item(provider_id: str) -> dict[str, Any]:
    target = provider_target(provider_id)
    module_root = target.partition(":")[0].partition(".")[0]
    package_name = module_root.replace("_", "-")
    package = _packages().get(provider_id)
    if package is None:
        try:
            package = {
                "name": package_name,
                "version": importlib.metadata.version(package_name),
            }
        except importlib.metadata.PackageNotFoundError:
            package = {"name": None, "version": None}
    identity = {"provider_id": provider_id, "distribution": package}
    try:
        _check_entry(provider_id, target)
        raw = package_data(module_root, f"{provider_id}.json")
        if raw is None:
            return {
                **identity,
                "status": "legacy",
                "manifest": None,
                "sha256": None,
                "issue": None,
            }
        doc = read_manifest(raw, provider_id, target)
        return {
            **identity,
            "status": "declared",
            "manifest": doc,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "issue": None,
        }
    except (OSError, ManifestIssue) as exc:
        return {
            **identity,
            "status": "invalid",
            "manifest": None,
            "sha256": None,
            "issue": str(exc)
            if isinstance(exc, ManifestIssue)
            else "unsafe_or_unreadable_file",
        }


def _check_entry(provider_id: str, target: str) -> None:
    if not ID.fullmatch(provider_id) or not MODULE.fullmatch(target):
        raise ManifestIssue("invalid_registry_entry")


def matches(row: Mapping[str, Any], filters: Mapping[str, str]) -> bool:
    """Check whether a catalog row satisfies every requested filter."""
    data = row.get("manifest") or {}
    resources = data.get("resources", {})
    execution = data.get("execution", {})
    models = data.get("models", [])
    values = {
        "provider_id": [row.get("provider_id")],
        "kind": [data.get("kind")],
        "input_type": [p["type_id"] for p in data.get("inputs", [])],
        "output_type": [p["type_id"] for p in data.get("outputs", [])],
        "operation": data.get("operations", []),
        "model": [m["id"] for m in models],
        "device": resources.get("devices", []),
        "cache": [execution.get("cache")],
        "retry": [execution.get("retry")],
        "cancellation": [execution.get("cancellation")],
        "progress": execution.get("progress", []),
        "license": [data.get("license"), *(m["license"] for m in models)],
        "sha256": [
            row.get("sha256"),
            *(f["sha256"] for m in models for f in m["files"] if f["sha256"]),
        ],
    }
    return all(value in values[key] for key, value in filters.items())


def catalog(filters: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
    """Filter declarations on exact values; legacy and malformed rows remain visible by ID."""
    selected = dict(filters or {})
    if set(selected) - set(FILTERS):
        raise ValueError("Unknown native capability filter")
    indexes: dict[str, dict[str, Any]] = {}
    rows = []
    for provider in known_providers():
        if "provider_id" in selected and provider != selected["provider_id"]:
            continue
        row = _item(provider)
        if matches(row, selected):
            rows.append({**row, **_summary(row, indexes)})
    return rows


def _legacy_row(
    provider_id: str, target: str, indexes: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    package = target.partition(":")[0].partition(".")[0]
    if package not in indexes:
        indexes[package] = {}
        if MODULE.fullmatch(target):
            try:
                raw = package_data(package, "legacy-index.json")
                if raw is not None:
                    doc = json.loads(
                        raw.decode("utf-8"),
                        object_pairs_hook=unique_object,
                        parse_constant=invalid_constant,
                    )
                    if (
                        isinstance(doc, dict)
                        and doc.get("schema_version") == "1.0"
                        and isinstance(doc.get("providers"), dict)
                    ):
                        indexes[package] = doc["providers"]
            except (OSError, ValueError, RecursionError):
                pass
    row = indexes[package].get(provider_id)
    return row if isinstance(row, dict) and row.get("entry_point") == target else {}


def _target_present(target: str) -> bool:

    if not MODULE.fullmatch(target):
        return False
    parts = target.partition(":")[0].split(".")
    search = None
    for index in range(len(parts)):
        spec = PathFinder.find_spec(".".join(parts[: index + 1]), search)
        if spec is None:
            return False
        search = spec.submodule_search_locations
        if index < len(parts) - 1 and search is None:
            return False
    return True


def _availability(
    summary: Mapping[str, Any], manifest: Mapping[str, Any]
) -> str | None:

    resources = manifest.get("resources", {})
    missing = [
        name
        for name in summary.get(
            "required_modules", resources.get("required_modules", [])
        )
        if isinstance(name, str)
        and name.isidentifier()
        and PathFinder.find_spec(name) is None
    ]
    if missing:
        return "Required Python modules are absent: " + ", ".join(missing)
    for name, commit in summary.get("source_pins", []):
        if isinstance(name, str) and isinstance(commit, str) and ID.fullmatch(name):
            problem = distribution_problem(name, vcs_commit=commit)
            if problem:
                return str(problem)
    for binary in resources.get("executables", []):
        if which(binary) is None:
            return f"Required executable is absent: {binary}"
    return None


def _summary(
    entry: Mapping[str, Any], indexes: dict[str, dict[str, Any]]
) -> dict[str, Any]:

    provider_id = entry["provider_id"]
    desc = entry["manifest"] or {}
    target = provider_target(provider_id)
    summary = _legacy_row(provider_id, target, indexes)
    try:
        reason = (
            entry["issue"]
            or (None if _target_present(target) else "provider_module_missing")
            or _availability(summary, desc)
        )
        defaults = desc.get("default_settings", summary.get("default_settings"))
        return {
            "provider_id": provider_id,
            "kind": desc.get("kind", summary.get("kind", "unknown")),
            "label": desc.get("label", summary.get("label", provider_id)),
            "available": reason is None,
            "reason": reason,
            "synthetic": summary.get("synthetic", False),
            "default_settings": defaults
            if defaults is None or is_valid("InstanceSettings", defaults)
            else None,
        }
    except (ValueError, TypeError, KeyError, OSError):
        return {
            "provider_id": provider_id,
            "kind": "unknown",
            "label": provider_id,
            "available": False,
            "reason": "invalid_legacy_summary",
            "synthetic": False,
            "default_settings": None,
        }


def summaries() -> list[dict[str, Any]]:
    """Return the existing runtime host's --list projection without loading any provider."""
    return [
        {
            k: row[k]
            for k in (
                "provider_id",
                "kind",
                "label",
                "available",
                "reason",
                "synthetic",
                "default_settings",
            )
        }
        for row in catalog()
    ]


def main() -> int:
    """Write the selected native provider declarations to standard output."""
    parser = argparse.ArgumentParser(
        description="Query installed native provider manifests without loading providers."
    )
    for key in FILTERS:
        parser.add_argument("--" + key.replace("_", "-"), dest=key)
    filters = {k: v for k, v in vars(parser.parse_args()).items() if v is not None}
    print(  # noqa: T201 - This CLI writes the JSON response to stdout.
        json.dumps(
            {"ok": True, "schema_version": "1.0", "items": catalog(filters)},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
