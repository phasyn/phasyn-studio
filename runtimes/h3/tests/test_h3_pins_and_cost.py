"""Upstream pins (one table, the shared guard) and the ETA data: stage work records and describe facts.

Torch-free; the check against an installed SGLang is ``gpu``-marked (it needs a runtime tuple).
"""

from __future__ import annotations

import ast
import re

import pytest
from h3_examples import REPO

from phasyn_h3.recipe.runtime import pins


pytestmark = pytest.mark.static

RECIPE = REPO / "runtimes/h3/src/phasyn_h3/recipe"

# ---------------------------------------------------------------------------------------------- pins


def test_pin_table_is_complete_and_well_formed() -> None:
    labels = [label for group in pins.SOURCES.values() for label in group]
    assert len(labels) == 68 == len(set(labels)) == len(pins.all_pins())
    for group in pins.SOURCES.values():
        for module, qualname, digest in group.values():
            assert module.startswith("sglang.multimodal_gen.runtime.") and qualname
            assert re.fullmatch(r"[0-9a-f]{64}", digest)


def test_only_the_pin_table_hashes_upstream_sources() -> None:
    offenders = [
        f"{path.relative_to(RECIPE)}:{node.lineno}"
        for path in sorted(RECIPE.rglob("*.py"))
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.Attribute) and node.attr == "getsource"
    ]
    assert offenders == []


@pytest.mark.gpu
def test_pins_match_the_installed_sglang() -> None:
    """Run inside a runtime tuple (``CUDA_VISIBLE_DEVICES=`` is enough): every pinned source matches."""
    pytest.importorskip(
        "sglang",
        reason="需要 runtime tuple 環境（deploy/runtimes/*）；未驗證，不算通過",
    )
    from phasyn_h3.recipe.runtime.importcheck import pin_report  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    report = pin_report()
    assert report["mismatches"] == []
    checked, pending = report["checked"], report["requires_gpu"]
    assert isinstance(checked, int) and isinstance(pending, list)
    assert checked + len(pending) == len(pins.all_pins())


# ---------------------------------------------------------------------------------------------- stage work


# ---------------------------------------------------------------------------------------------- cost model facts
