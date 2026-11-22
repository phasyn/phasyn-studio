"""Prompt templates and model-side JSON schemas (data files; names are internal constants, never model output).

``prompts/*.txt`` and ``schemas/*.json`` are fixed data files: a template fingerprint is the SHA-256 of its
UTF-8 text and a schema fingerprint is the SHA-256 of its canonical JSON. Both fingerprints are recorded in
each result's provenance, so any edit to a template or schema is a deliberate, visible change.
"""

from __future__ import annotations

import hashlib
import json
from functools import cache
from pathlib import Path
from typing import Any

from phasyn_components.canonical import digest


HERE = Path(__file__).resolve().parent
TEMPLATE_NAMES = frozenset(
    {
        "qwen_caption",
        "qwen_analyze",
        "qwen_compare",
        "qwen_pairwise",
        "qwen_revise",
        "qwen_repair",
        "qwen_scene_inline",
        "qwen_scene_inline_repair",
        "qwen_compare_flat",
        "qwen_compare_flat_repair",
        "qwen_pairwise_4b",
        "qwen_pairwise_4b_repair",
    }
)
SCHEMA_NAMES = frozenset(
    {"SceneDraft", "Comparison", "Pairwise", "CompactScene", "CompactComparison"}
)
TEMPLATE_SOURCE = "phasyn_qimg/vision/prompts"


@cache
def template(name: str) -> str:
    """Load the named prompt template."""
    if name not in TEMPLATE_NAMES:
        raise ValueError(f"未知的模板 {name!r}")
    return (HERE / "prompts" / f"{name}.txt").read_text(encoding="utf-8")


def template_fingerprint(name: str) -> str:
    """Hash the prompt template used for the call."""
    return hashlib.sha256(template(name).encode("utf-8")).hexdigest()


@cache
def _schema_text(name: str) -> str:
    if name not in SCHEMA_NAMES:
        raise ValueError(f"未知的 schema {name!r}")
    return (HERE / "schemas" / f"{name}.json").read_text(encoding="utf-8")


def model_schema(name: str) -> dict[str, Any]:
    """每次回傳新的 dict（呼叫端不可能改到快取）."""
    value = json.loads(_schema_text(name))
    if not isinstance(value, dict):
        raise ValueError(f"schema {name} 不是 JSON object")  # noqa: TRY004 - Malformed schema documents raise ValueError by contract.
    return value


def schema_fingerprint(name: str) -> str:
    """Hash the schema used for this output."""
    return digest(model_schema(name))


__all__ = [
    "SCHEMA_NAMES",
    "TEMPLATE_NAMES",
    "TEMPLATE_SOURCE",
    "model_schema",
    "schema_fingerprint",
    "template",
    "template_fingerprint",
]
