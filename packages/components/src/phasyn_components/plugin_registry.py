"""The plugin registry as clients read it (contracts ``StudioPlugin``, ``StudioPluginList``, ``StudioPluginDetail``).

The Controller keeps the packages (built-in, installed, development); this module turns them into the one document
the browser evaluates rules from. It is
pure: records in, JSON out.

A package's contributions are usable only while its status is ``ok``. ``disabled``, ``incompatible`` and ``invalid``
packages stay listed with their reasons, because a project that selects one of their contributions must be refused
with that reason instead of rendering without the rule.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ComponentError
from .plugin_manifest import (
    BUILTIN_PREFIX,
    LIMITS,
    MANIFEST_VERSION,
    MAX_ISSUES,
    PLUGIN_APIS,
    Issue,
    PluginLimits,
    compatibility_issues,
    contribution_ref,
    generation_rev,
    is_plugin_id,
    issue,
    issues_of,
    rule_rev,
)
from .plugin_package import Package, load_directory


log = logging.getLogger("phasyn_components.plugins")

BUILTIN_DIR = "studio-plugins"
SOURCE_ORDER: Mapping[str, int] = {"builtin": 0, "installed": 1, "dev": 2}


@dataclass(frozen=True)
class PluginRecord:
    """One package of the registry: its content, or the reasons the content could not be loaded, plus the facts the registry keeps about it (source, and for installed packages what was recorded at installation)."""

    plugin_id: str
    source: str  # builtin | installed | dev
    package: Package | None = None
    issues: tuple[Issue, ...] = ()  # why ``package`` is None
    disabled: bool = False
    revision: int = 0
    version: str | None = None
    digest: str | None = None
    installed_at: str | None = None
    updated_at: str | None = None
    consent: Mapping[str, Any] | None = None


def _selectable(package: Package) -> list[str]:
    contributes = package.manifest.get("contributes") or {}
    return [
        str(item["id"])
        for kind in ("rules", "generation")
        for item in contributes.get(kind) or []
    ]


def builtin_rule_ids(records: Iterable[PluginRecord]) -> frozenset[str]:
    """Ids of the rules of the loaded built-in packages (what a preset of another package may name)."""
    return frozenset(
        str(rule["id"])
        for record in records
        if record.source == "builtin" and record.package is not None
        for rule in (record.package.manifest.get("contributes") or {}).get("rules")
        or []
    )


def _load_builtin(directory: Path, taken: set[str]) -> PluginRecord:
    plugin_id = directory.name
    try:
        package = load_directory(directory, builtin=True)
    except ComponentError as exc:
        return PluginRecord(plugin_id, "builtin", issues=tuple(issues_of(exc)))
    problems = (
        [] if package.plugin_id == plugin_id else [issue("builtin_id", path="id")]
    )
    # Built-in contributions are referenced without a prefix, so their ids are unique across built-in packages.
    problems += [
        issue("duplicate_id", path="contributes", id=name)
        for name in _selectable(package)
        if name in taken
    ]
    if problems:
        return PluginRecord(plugin_id, "builtin", issues=tuple(problems))
    taken.update(_selectable(package))
    return PluginRecord(
        plugin_id, "builtin", package, version=package.version, digest=package.digest
    )


def load_builtin_records(contracts_dir: Path) -> list[PluginRecord]:
    """The built-in packages shipped with the contracts (``<contracts>/studio-plugins/<plugin_id>/``), by id.

    A package that breaks a rule is still returned, as a record without content: the registry shows why, and a
    repository check keeps that from being released.
    """
    root = contracts_dir / BUILTIN_DIR
    if not root.exists():
        return []  # this build ships no built-in packages
    try:
        with os.scandir(root) as entries:
            names = sorted(
                entry.name for entry in entries if entry.is_dir(follow_symlinks=False)
            )
    except OSError:
        log.warning("找不到內建插件目錄 %s", BUILTIN_DIR)
        return []
    taken: set[str] = set()
    # A directory whose name is not a built-in id is not a package (a repository check refuses such a directory).
    return [
        _load_builtin(root / name, taken)
        for name in names
        if is_plugin_id(name) and name.startswith(BUILTIN_PREFIX)
    ]


# ---------------------------------------------------------------------------------------------- client documents
def _contributions(
    package: Package, *, builtin: bool, builtin_rules: frozenset[str]
) -> tuple[dict[str, Any], list[Issue]]:
    """The registry form of a package's contributions, and the preset references that resolve to nothing."""
    declared = package.manifest.get("contributes") or {}
    plugin_id = package.plugin_id
    rules = declared.get("rules") or []
    own = {str(rule["id"]) for rule in rules}
    problems = []
    presets = []
    for index, preset in enumerate(declared.get("presets") or []):
        refs = []
        for name in preset["rules"]:
            if name in own:
                refs.append(contribution_ref(plugin_id, name, builtin=builtin))
            elif name in builtin_rules:
                refs.append(name)
            else:
                where = f"contributes/presets/{index}/rules"
                problems.append(
                    issue(
                        "preset_rule_missing",
                        path=where,
                        preset=preset["id"],
                        rule=name,
                    )
                )
        presets.append({"preset": preset, "refs": refs})
    contributes = {
        "rules": [
            {
                "ref": contribution_ref(plugin_id, rule["id"], builtin=builtin),
                "rev": rule_rev(rule),
                "rule": rule,
            }
            for rule in rules
        ],
        "presets": presets,
        "generation": [
            {
                "ref": contribution_ref(plugin_id, item["id"], builtin=builtin),
                "rev": generation_rev(item),
                "generation": item,
            }
            for item in declared.get("generation") or []
        ],
        "commands": list(declared.get("commands") or []),
        "panels": list(declared.get("panels") or []),
    }
    return contributes, problems


def _facts(record: PluginRecord) -> dict[str, Any]:
    return {
        "plugin_id": record.plugin_id,
        "source": record.source,
        "disabled": record.disabled,
        "revision": record.revision,
        "installed_at": record.installed_at,
        "updated_at": record.updated_at,
    }


def _unreadable_entry(record: PluginRecord) -> dict[str, Any]:
    return {
        **_facts(record),
        "status": "invalid",
        "problems": [dict(item) for item in record.issues[:MAX_ISSUES]],
        "version": record.version,
        "name": {"en": record.plugin_id},
        "description": None,
        "author": None,
        "license": None,
        "engines": None,
        "permissions": [],
        "has_code": False,
        "digest": record.digest,
        "size_bytes": 0,
        "file_count": 0,
        "contributes": {
            "rules": [],
            "presets": [],
            "generation": [],
            "commands": [],
            "panels": [],
        },
    }


def plugin_entry(
    record: PluginRecord, *, host_version: str, builtin_rules: frozenset[str]
) -> dict[str, Any]:
    """Contract ``StudioPlugin``: one registry row with the package's status and resolved contributions."""
    package = record.package
    if package is None:
        return _unreadable_entry(record)
    manifest = package.manifest
    builtin = record.source == "builtin"
    contributes, unresolved = _contributions(
        package, builtin=builtin, builtin_rules=builtin_rules
    )
    problems = [*compatibility_issues(manifest, host_version=host_version), *unresolved]
    author = manifest.get("author")
    return {
        **_facts(record),
        "status": "incompatible"
        if problems
        else "disabled"
        if record.disabled
        else "ok",
        "problems": problems[:MAX_ISSUES],
        "version": package.version,
        "name": manifest["name"],
        "description": manifest.get("description"),
        "author": {"name": author["name"], "url": author.get("url")}
        if author
        else None,
        "license": manifest.get("license"),
        "engines": {
            "phasyn": manifest["engines"]["phasyn"],
            "plugin_api": manifest["engines"].get("plugin_api"),
        },
        "permissions": list(manifest.get("permissions") or []),
        "has_code": "main" in manifest,
        "digest": package.digest,
        "size_bytes": package.size_bytes,
        "file_count": package.file_count,
        "contributes": contributes,
    }


def plugin_detail(record: PluginRecord, entry: Mapping[str, Any]) -> dict[str, Any]:
    """Contract ``StudioPluginDetail`` for a record and its :func:`plugin_entry`."""
    package = record.package
    return {
        "plugin": dict(entry),
        "manifest": package.manifest if package is not None else None,
        "files": [item.to_dict() for item in package.files]
        if package is not None
        else [],
        "consent": dict(record.consent) if record.consent is not None else None,
    }


def registry_document(
    records: Sequence[PluginRecord],
    *,
    host_version: str,
    install: str,
    limits: PluginLimits = LIMITS,
    problems: Sequence[Issue] = (),
) -> dict[str, Any]:
    """Contract ``StudioPluginList``: built-in, installed and development packages, each group sorted by id."""
    builtin_rules = builtin_rule_ids(records)
    ordered = sorted(
        records, key=lambda record: (SOURCE_ORDER[record.source], record.plugin_id)
    )
    return {
        "items": [
            plugin_entry(record, host_version=host_version, builtin_rules=builtin_rules)
            for record in ordered
        ],
        "limits": limits.to_dict(),
        "host": {
            "version": host_version,
            "manifest_version": MANIFEST_VERSION,
            "plugin_api": list(PLUGIN_APIS),
        },
        "install": install,
        "problems": [dict(item) for item in problems[:MAX_ISSUES]],
    }


__all__ = [
    "BUILTIN_DIR",
    "SOURCE_ORDER",
    "PluginRecord",
    "builtin_rule_ids",
    "load_builtin_records",
    "plugin_detail",
    "plugin_entry",
    "registry_document",
]
