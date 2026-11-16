#!/usr/bin/env python3
"""Generate and check the files derived from the Studio plugin packages.

The built-in packages (``contracts/studio-plugins/<plugin_id>/plugin.json``) are the authority. Generated from them:

``contracts/examples/plugin-rules/registry.json``
    The registry (contract ``StudioPluginList``) that the shared rule vectors are evaluated against: the built-in
    packages plus the fixture packages listed in ``fixtures.json``, built by the code the Controller uses.

Checked, not generated: every built-in package is valid and compatible with this version; the limits in code and
in the contract agree; every case of the shared vectors gives its expected result in the reference evaluator
(``plugin_rules_reference.py``) and the case files are ASCII (other characters are written as escapes, so a reader
sees which one a case is about); every example package under ``examples/studio-plugins/`` is valid and its built
``.phasynplugin`` file has exactly the content of its directory.

Run it in the workspace environment, since it imports ``phasyn_components``::

    uv run python tools/contracts/sync_studio_plugins.py            # rewrite the generated files, then check
    uv run python tools/contracts/sync_studio_plugins.py --check    # exit 1 on drift or a failed check
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import sys
import tempfile
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from phasyn_components import __version__ as HOST_VERSION
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.plugin_manifest import LIMITS, MANIFEST_NAME, PluginLimits, issue
from phasyn_components.plugin_package import archive_name, load_directory, unpack_archive
from phasyn_components.plugin_registry import BUILTIN_DIR, PluginRecord, load_builtin_records, registry_document
from plugin_rules_reference import evaluate

REPO = Path(__file__).resolve().parents[2]
CONTRACTS = REPO / "contracts"
VECTORS = CONTRACTS / "examples" / "plugin-rules"
FIXTURES = VECTORS / "fixtures.json"
FIXTURE_PACKAGES = VECTORS / "packages"
REGISTRY = VECTORS / "registry.json"
CASE_FILES = ("prompt-rules.json", "generation.json")
EXAMPLES = REPO / "examples" / "studio-plugins"
COMMAND = "uv run python tools/contracts/sync_studio_plugins.py"
PACK_COMMAND = "uv run python tools/contracts/pack_studio_plugin.py"


def render(document: Any) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


def read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------------------------- the vector registry
def _installed(record: PluginRecord, spec: Mapping[str, Any], at: str) -> PluginRecord:
    """The record with what the Controller keeps for a package installed through the API."""
    permissions = list(record.package.manifest.get("permissions") or []) if record.package is not None else []
    return dataclasses.replace(
        record,
        disabled=bool(spec.get("disabled", False)),
        revision=int(spec.get("revision", 1)),
        installed_at=at,
        updated_at=at,
        consent={"digest": record.digest, "permissions": permissions, "at": at},
    )


def _fixture_record(spec: Mapping[str, Any], at: str) -> PluginRecord:
    """One package of ``fixtures.json``: a directory under ``packages/``, or an installed package whose content
    cannot be read (``unreadable`` names the issue code)."""
    if "directory" not in spec:
        recorded = hashlib.sha256(str(spec["plugin_id"]).encode()).hexdigest()
        problems = (issue(str(spec["unreadable"])),)
        broken = PluginRecord(spec["plugin_id"], "installed", None, problems, version=spec["version"], digest=recorded)
        return _installed(broken, spec, at)
    package = load_directory(FIXTURE_PACKAGES / spec["directory"], builtin=False)
    record = PluginRecord(package.plugin_id, spec["source"], package, version=package.version, digest=package.digest)
    return _installed(record, spec, at) if spec["source"] == "installed" else record


def fixture_registry() -> dict[str, Any]:
    """The registry of the shared vectors, as the Controller would serve it for these packages."""
    fixtures = read(FIXTURES)
    records = [
        *load_builtin_records(CONTRACTS),
        *(_fixture_record(spec, fixtures["at"]) for spec in fixtures["packages"]),
    ]
    limits = dataclasses.replace(LIMITS, **fixtures.get("limits", {}))
    return registry_document(records, host_version=HOST_VERSION, install="api", limits=limits)


def generated() -> dict[Path, str]:
    return {REGISTRY: render(fixture_registry())}


# ---------------------------------------------------------------------------------------------- checks
def _schema_limits() -> Iterator[tuple[str, Any, Any]]:
    """``(what, value in the contract, value in code)`` for every limit that both state."""
    defs = contracts.schema()["$defs"]
    manifest = defs["StudioPluginManifest"]["properties"]
    yield (
        "prompt_plugins maxItems",
        defs["StudioProject"]["properties"]["prompt_plugins"]["maxItems"],
        LIMITS.project_plugins,
    )
    yield (
        "take prompt_plugins maxItems",
        defs["StudioTake"]["properties"]["prompt_plugins"]["maxItems"],
        LIMITS.project_plugins,
    )
    yield "preset rules maxItems", defs["StudioPluginPreset"]["properties"]["rules"]["maxItems"], LIMITS.project_plugins
    yield "inject maxLength", defs["StudioPluginRule"]["properties"]["inject"]["maxLength"], LIMITS.inject_chars
    yield (
        "integrity.files maxProperties",
        manifest["integrity"]["properties"]["files"]["maxProperties"],
        LIMITS.files - 1,
    )
    yield "file path maxLength", defs["StudioPluginFile"]["properties"]["path"]["maxLength"], LIMITS.path_length
    config = defs["ControllerPluginsConfig"]["properties"]
    yield "max_package_bytes default", config["max_package_bytes"]["default"], LIMITS.package_bytes
    yield "max_package_bytes maximum", config["max_package_bytes"]["maximum"], LIMITS.unpacked_bytes
    yield "limits contract", sorted(defs["StudioPluginLimits"]["required"]), sorted(PluginLimits().to_dict())


def limit_problems() -> list[str]:
    return [
        f"{what}: the contract says {declared!r}, the code {coded!r}"
        for what, declared, coded in _schema_limits()
        if declared != coded
    ]


def builtin_problems() -> list[str]:
    """Every directory of ``contracts/studio-plugins`` is a valid built-in package that this version can use."""
    records = load_builtin_records(CONTRACTS)
    listed = {record.plugin_id for record in records}
    problems = [
        f"{BUILTIN_DIR}/{path.name}: not a built-in package directory"
        for path in sorted((CONTRACTS / BUILTIN_DIR).iterdir() if (CONTRACTS / BUILTIN_DIR).is_dir() else ())
        if path.name not in listed
    ]
    document = registry_document(records, host_version=HOST_VERSION, install="api")
    problems += [f"registry: {text}" for text in contracts.errors("StudioPluginList", document)]
    for item in document["items"]:
        problems += [
            f"{item['plugin_id']}: {found['code']} {found['path'] or ''} {found['details']}"
            for found in item["problems"]
        ]
    return problems


def vector_problems() -> list[str]:
    """Every case of the shared vectors against the reference evaluator and the fixture registry on disk."""
    registry = read(REGISTRY)
    problems = [f"{REGISTRY.name}: {text}" for text in contracts.errors("StudioPluginList", registry)]
    for name in CASE_FILES:
        text = (VECTORS / name).read_text(encoding="utf-8")
        if not text.isascii():  # a no-break space or a Kelvin sign written as itself looks like another character
            problems.append(f"{name}: write every character outside ASCII as a JSON Unicode escape")
        seen: set[str] = set()
        for case in json.loads(text)["cases"]:
            label = f"{name}: {case['name']!r}"
            if case["name"] in seen:
                problems.append(f"{label}: duplicate case name")
            seen.add(case["name"])
            available = registry if case.get("registry", "available") == "available" else None
            result = evaluate(available, case["plugins"], case["prompt"], case.get("settings"))
            if "settings" not in case:
                del result["unmet"]
            if result != case["expect"]:
                problems.append(f"{label}: expected {render(case['expect'])}got {render(result)}")
    return problems


def _example_problems(directory: Path) -> list[str]:
    try:
        package = load_directory(directory, builtin=False)
    except ComponentError as exc:
        return [f"{directory.name}: {exc.message} {exc.details.get('errors')}"]
    document = registry_document(
        [*load_builtin_records(CONTRACTS), PluginRecord(package.plugin_id, "installed", package)],
        host_version=HOST_VERSION,
        install="api",
    )
    entry = next(item for item in document["items"] if item["plugin_id"] == package.plugin_id)
    problems = [f"{directory.name}: {found['code']} {found['details']}" for found in entry["problems"]]
    archive = directory.parent / archive_name(package)
    if not archive.is_file():
        return [*problems, f"{archive.name} is missing; run: {PACK_COMMAND} {directory.relative_to(REPO)}"]
    with tempfile.TemporaryDirectory() as scratch:
        try:
            built = unpack_archive(archive, Path(scratch) / "content")
        except ComponentError as exc:
            return [*problems, f"{archive.name}: {exc.message} {exc.details.get('errors')}"]
    if built.digest != package.digest:
        problems.append(f"{archive.name} is not the content of {directory.name}/; pack it again")
    return problems


def example_problems() -> list[str]:
    directories = (
        sorted(path for path in EXAMPLES.iterdir() if (path / MANIFEST_NAME).is_file()) if EXAMPLES.is_dir() else []
    )
    return [problem for directory in directories for problem in _example_problems(directory)]


def check_problems() -> list[str]:
    return [*limit_problems(), *builtin_problems(), *vector_problems(), *example_problems()]


def stale() -> list[Path]:
    return [
        path for path, text in generated().items() if not path.is_file() or path.read_text(encoding="utf-8") != text
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="only report drift and failed checks; do not write")
    args = parser.parse_args(argv)
    outdated = stale()
    if args.check and outdated:
        names = ", ".join(str(path.relative_to(REPO)) for path in outdated)
        print(f"out of date: {names}; run: {COMMAND}", file=sys.stderr)
        return 1
    for path in outdated:
        path.write_text(generated()[path], encoding="utf-8")
        print(f"updated {path.relative_to(REPO)}")
    problems = check_problems()
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
