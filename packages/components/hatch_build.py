"""Hatch build hook: ship the repository's ``contracts/`` inside ``phasyn_components/_contracts``.

From the repository the contracts are two directories up; an sdist built here already carries them
under ``src/phasyn_components/_contracts``, so a wheel built from that sdist needs nothing extra.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, override

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


SCHEMA = "component.schema.json"


class ContractsHook(BuildHookInterface[Any]):
    """Bundle the authoritative wire contracts in the distribution."""

    PLUGIN_NAME = "custom"

    @override
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        """Include the repository contracts when packaging from a source checkout."""
        if version == "editable":
            return  # an editable install runs from the source tree, which finds contracts/ by walking up
        root = Path(self.root)
        if (root / "src" / "phasyn_components" / "_contracts" / SCHEMA).is_file():
            return  # building from an sdist: the contracts are already inside the package
        source = root.parent.parent / "contracts"
        if not (source / SCHEMA).is_file():
            raise FileNotFoundError(
                f"{source / SCHEMA} not found: build phasyn-components from the repository"
            )
        target = (
            "phasyn_components/_contracts"
            if self.target_name == "wheel"
            else "src/phasyn_components/_contracts"
        )
        build_data["force_include"][str(source)] = target
