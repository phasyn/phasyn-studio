"""profile extension 的 schema digest 釘值必須等於 recipe schema 的 canonical digest（namespace 改名後重算）。"""

from __future__ import annotations

import pytest

from phasyn_h3.config import EXTENSION_DIGESTS
from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.adapter.profile_rules import PROFILE_EXTENSION_SCHEMAS


pytestmark = pytest.mark.static


def test_pinned_extension_digests_match_schemas() -> None:
    assert set(EXTENSION_DIGESTS) == set(PROFILE_EXTENSION_SCHEMAS)
    for namespace, schema in PROFILE_EXTENSION_SCHEMAS.items():
        assert namespace.startswith("phasyn.sglang_h3."), namespace
        assert schema["title"] == namespace
        assert EXTENSION_DIGESTS[namespace] == canonical_digest(dict(schema)), namespace
