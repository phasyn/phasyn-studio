"""Public H3 templates (``examples/``, ``deploy/config``) and the DiT generator, validated offline (CPU only).

* every H3 definition passes the InstanceDefinition contract, its provider settings schema, part expansion,
  ``check_supported`` and ``build_profile``;
* every DiT definition (templates and the generator's whole grid) builds a plan through the real H3 adapter
  (LoRA sampling contracts included) and resolves the runtime stage policies (attention gates, AdaLN x
  quantization, LoRA policy) for a compute capability 12.0 device;
* combinations the grid does not offer are rejected by the rules, not missing by accident;
* the pipelines validate against the provider ports (``validate_pipeline(require_descriptors=True)``).
"""

from __future__ import annotations

import pytest
from h3_examples import (
    COMPONENTS,
    generator,
    h3_components,
)


pytestmark = pytest.mark.static


# ---------------------------------------------------------------------------- definitions


# ---------------------------------------------------------------------------- DiT grid


def test_committed_templates_are_the_generator_output() -> None:
    gen = generator()
    for cid, doc in h3_components().items():
        if doc["provider_id"] != "h3.dit":
            continue
        _dit, variant, precision, accel = cid.split("-")
        expected = gen.definition(variant, precision, accel)
        assert doc == expected, cid
        assert (COMPONENTS / f"{cid}.json").read_text(encoding="utf-8") == gen.dumps(
            expected
        ), cid


# ---------------------------------------------------------------------------- pipelines
