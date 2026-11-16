#!/usr/bin/env python3
"""Build a ``.phasynplugin`` file from an unpacked Studio plugin package directory.

The directory is validated with the rules an installation applies (``phasyn_components.plugin_package``) and packed
in a fixed order with fixed timestamps, like an export from the Controller. Nothing in the package is executed.

Run it in the workspace environment, since it imports ``phasyn_components``::

    uv run python tools/contracts/pack_studio_plugin.py examples/studio-plugins/depth-staging
    uv run python tools/contracts/pack_studio_plugin.py my-plugin --write-integrity --output out/my-plugin.phasynplugin

``--write-integrity`` first rewrites ``integrity.files`` in ``plugin.json`` with the SHA-256 of every other file in the
directory (the manifest is saved again with two-space indentation). Without it, hashes that do not match are an error.
The default output is ``<plugin_id>-<version>.phasynplugin`` next to the directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from phasyn_components.errors import ComponentError
from phasyn_components.plugin_manifest import LIMITS, MANIFEST_NAME, issues_of
from phasyn_components.plugin_package import archive_name, load_directory, write_archive


def _other_files(directory: Path) -> list[str]:
    """Relative paths of every file below ``directory`` except the manifest (links are not followed)."""
    found = []
    for root, _, names in os.walk(directory, followlinks=False):
        found += [(Path(root) / name).relative_to(directory).as_posix() for name in names]
    return sorted(path for path in found if path != MANIFEST_NAME)


def write_integrity(directory: Path) -> None:
    """Replace ``integrity`` in ``plugin.json`` with the hashes of the files that are there now."""
    manifest_path = directory / MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = {path: hashlib.sha256((directory / path).read_bytes()).hexdigest() for path in _other_files(directory)}
    manifest["integrity"] = {"algorithm": "sha256", "files": files}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _lacks_integrity(directory: Path) -> bool:
    """Whether the manifest can be read and has no ``integrity`` section yet."""
    try:
        manifest = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(manifest, dict) and "integrity" not in manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    parser.add_argument("directory", type=Path, help="the unpacked package (plugin.json at its root)")
    parser.add_argument("--output", type=Path, help="the archive to write")
    parser.add_argument("--write-integrity", action="store_true", help="rewrite integrity.files in plugin.json first")
    args = parser.parse_args(argv)
    directory: Path = args.directory
    try:
        if args.write_integrity:
            write_integrity(directory)
        package = load_directory(directory, builtin=False)
    except (OSError, ValueError) as exc:
        print(f"{directory}: {exc}", file=sys.stderr)
        return 1
    except ComponentError as exc:
        print(f"{directory.name}: {exc.message}", file=sys.stderr)
        for found in issues_of(exc):
            print(
                f"  {found['code']}  {found['path'] or ''}  {found['message']}  {found['details'] or ''}",
                file=sys.stderr,
            )
        if not args.write_integrity and _lacks_integrity(directory):
            print("  plugin.json has no integrity section yet: run again with --write-integrity", file=sys.stderr)
        return 1
    output: Path = args.output or directory.resolve().parent / archive_name(package)
    with open(output, "wb") as target:
        write_archive(package, target)
    print(f"{output}  {package.plugin_id} {package.version}  digest {package.digest}")
    size = output.stat().st_size
    if size > LIMITS.package_bytes:
        print(
            f"{output.name}: {size} bytes is more than the default upload limit of {LIMITS.package_bytes} bytes; a "
            "Controller accepts it only with a larger plugins.max_package_bytes",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
