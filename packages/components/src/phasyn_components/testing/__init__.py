"""Test-only providers and synthetic identifiers.

Nothing in this package is a generative model. The ``test.*`` providers let contract, Node and
Controller tests (and machines without a GPU) exercise the whole component lifecycle on a CPU:
registration, start/stop, typed inputs and outputs, file transfer, cancellation, previews and the
preview/final decode pipeline.

They are **not** registered by default. A component process resolves them only when it runs with
``PHASYN_ENABLE_TEST_PROVIDERS=1``; on a Node, set it in the runtime entry's ``env`` map, e.g.
``{"runtime_id": "cpu", "module": "phasyn_components.runtime_host",
"env": {"PHASYN_ENABLE_TEST_PROVIDERS": "1"}}``.

:mod:`phasyn_components.testing.ids` holds the synthetic UUIDs shared by every test suite.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from types import MappingProxyType

from . import ids

ENABLE_ENV = "PHASYN_ENABLE_TEST_PROVIDERS"

PROVIDERS: Mapping[str, str] = MappingProxyType(
    {
        "test.echo": "phasyn_components.testing.echo:EchoProvider",
        "test.synthetic_latent": "phasyn_components.testing.synthetic:SyntheticLatentProvider",
        "test.synthetic_decode": "phasyn_media.testing.synthetic_decode:SyntheticDecodeProvider",
    }
)


def enabled(environ: Mapping[str, str] | None = None) -> bool:
    """True only when ``PHASYN_ENABLE_TEST_PROVIDERS`` is exactly ``"1"``."""
    return (os.environ if environ is None else environ).get(ENABLE_ENV) == "1"


__all__ = ["ENABLE_ENV", "PROVIDERS", "enabled", "ids"]
