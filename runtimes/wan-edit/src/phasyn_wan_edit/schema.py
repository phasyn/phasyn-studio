"""Static provider descriptions shared by native discovery and the running component."""

from __future__ import annotations

import json
from collections.abc import Mapping
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from phasyn_components.provider import Description, Port


ROOT = Path(__file__).parent
GENERATE = "wan.generate"
EDIT = "wan.vace"
DIFFUSERS_COMMIT = "578c9b2c6636ab2424a0e56186268b83623656b2"


def describe(provider: str) -> Description:
    """Advertise ports and typed operations without loading model code or weights."""
    folder = ROOT / "native_capabilities"
    native = json.loads((folder / f"{provider}.json").read_text("utf-8"))
    index = json.loads((folder / "legacy-index.json").read_text("utf-8"))
    missing = [
        name
        for name in native["resources"]["required_modules"]
        if find_spec(name) is None
    ]
    facts = json.loads((ROOT / "bindings.json").read_text("utf-8"))[provider]
    return Description(
        provider_id=provider,
        label=native["label"],
        kind=native["kind"],
        inputs=[Port(**row) for row in native["inputs"]],
        outputs=[Port(**row) for row in native["outputs"]],
        parameters_schema=native["parameters_schema"],
        settings_schema=native["settings_schema"],
        default_settings=index["providers"][provider]["default_settings"],
        available=not missing,
        unavailable_code="RUNTIME_UNAVAILABLE" if missing else None,
        unavailable_reason=f"Missing runtime modules: {', '.join(missing)}"
        if missing
        else None,
        facts=facts,
    )


def load_path(settings: Mapping[str, Any] | None) -> str | None:
    """Read the configured local directory used by both weight planning and loading."""
    value = (settings or {}).get("load")
    path = value.get("model_path") if isinstance(value, Mapping) else None
    return path if isinstance(path, str) and path else None
