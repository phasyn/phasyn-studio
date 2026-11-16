"""Shared helpers for the H3 tests: the public ``examples/`` templates, the DiT generator and a descriptor catalog.

Everything here is offline and torch-free; no model weights are read.
"""

from __future__ import annotations

import importlib.util
import json
import os
from functools import cache
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[3]
EXAMPLES = REPO / "examples"
COMPONENTS = EXAMPLES / "components"
PIPELINES = EXAMPLES / "pipelines"
# Real-weight checks run only when this points at a models root (``<dir>/MiniMax-H3/...``); otherwise they skip.
MODELS_DIR_ENV = "PHASYN_TEST_MODELS_DIR"


def models_dir() -> Path:
    """The models root for real-file checks, or skip (a skip is not a pass)."""
    raw = os.environ.get(MODELS_DIR_ENV)
    if not raw or not Path(raw).is_dir():
        pytest.skip(f"{MODELS_DIR_ENV} 未指向模型根目錄（需要真實權重檔，未驗證，不算通過）")
    return Path(raw)


def component(component_id: str) -> dict[str, Any]:
    return json.loads((COMPONENTS / f"{component_id}.json").read_text(encoding="utf-8"))


def pipeline(pipeline_id: str) -> dict[str, Any]:
    return json.loads((PIPELINES / f"{pipeline_id}.json").read_text(encoding="utf-8"))


def h3_components() -> dict[str, dict[str, Any]]:
    """Every H3 template in ``examples/components`` (image templates are tested by runtimes/qimg)."""
    docs = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(COMPONENTS.glob("*.json"))}
    return {cid: doc for cid, doc in docs.items() if str(doc.get("provider_id", "")).startswith("h3.")}


@cache
def generator() -> ModuleType:
    """``examples/generate_dit_components.py`` imported as a module (it is a standalone stdlib script)."""
    spec = importlib.util.spec_from_file_location("generate_dit_components", EXAMPLES / "generate_dit_components.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def provider_classes() -> dict[str, Any]:
    from phasyn_h3 import providers

    return {
        "h3.conditioning": providers.ConditioningProvider,
        "h3.reference": providers.ReferenceProvider,
        "h3.video_encode": providers.VideoEncodeProvider,
        "h3.audio_encode": providers.AudioEncodeProvider,
        "h3.dit": providers.DitProvider,
        "h3.video_decode": providers.VideoDecodeProvider,
        "h3.audio_decode": providers.AudioDecodeProvider,
    }


def descriptor(provider_id: str) -> dict[str, Any]:
    """The catalog entry ``validate_pipeline`` needs (ports and parameters schema)."""
    if provider_id == "media.mux":
        from phasyn_media.providers.mux import MuxProvider

        desc = MuxProvider.describe(None)
    else:
        desc = provider_classes()[provider_id].describe(None)
    return {
        "inputs": [p.to_dict() for p in desc.inputs],
        "outputs": [p.to_dict() for p in desc.outputs],
        "settings": {"parameters_schema": desc.parameters_schema},
    }


def catalog_for(doc: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    """Descriptors for every step of a pipeline, resolved from the H3 templates (plus the CPU mux)."""
    templates = h3_components()
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for step in doc["steps"]:
        cid = step["component_id"]
        provider_id = "media.mux" if cid == "mux" else templates[cid]["provider_id"]
        out[(step["node_id"], cid)] = descriptor(provider_id)
    return out


__all__ = [
    "COMPONENTS",
    "EXAMPLES",
    "MODELS_DIR_ENV",
    "PIPELINES",
    "REPO",
    "catalog_for",
    "component",
    "descriptor",
    "generator",
    "h3_components",
    "models_dir",
    "pipeline",
    "provider_classes",
]
