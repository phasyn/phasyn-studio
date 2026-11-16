"""Inputs and outputs of plan resolution (:meth:`phasyn_h3.recipe.adapter.H3Adapter.resolve`)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class TaskPolicy:
    """Material policy of one registered task (validated by the adapter)."""

    task: str
    variants: tuple[str, ...]
    roles: Mapping[str, tuple[int, int]]
    total: tuple[int, int]
    label_zh: str
    requires_visual_reference: bool = False
    notes_zh: tuple[str, ...] = ()


@dataclass
class ResolveContext:
    """Inputs of plan compilation; all mappings are already schema-valid."""

    request: Mapping[str, Any]
    model: Mapping[str, Any]
    profile: Mapping[str, Any]
    config: Mapping[str, Any]
    material_metadata: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # component_id -> facts detected from real file headers
    # ({"format", "quantization": {...}, "architecture": {...}, "total_bytes"})
    model_facts: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # LoRA bindings of the profile's lora[] entries (manifest frozen into the plan)
    lora_bindings: Sequence[Mapping[str, Any]] = field(default_factory=tuple)


@dataclass
class ModelInputPlan:
    geometry: dict[str, Any]
    schedule: dict[str, Any]
    # binary sigma grids (safetensors); its sha256 is schedule.sigmas_digest
    sigma_payload: bytes | None
    materials: list[dict[str, Any]]
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)


__all__ = ["ModelInputPlan", "ResolveContext", "TaskPolicy"]
