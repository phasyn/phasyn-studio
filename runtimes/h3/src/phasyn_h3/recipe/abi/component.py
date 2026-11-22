"""Component load specs and registry leases (one component process holds one CUDA runtime)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ComponentLoadSpec:
    """Identify the weights and settings for one resident component."""

    model_id: str
    model_revision: str
    component_id: str
    kind: str
    path: str
    weight_format: str
    compute_dtype: str
    quantization: Mapping[str, Any]
    offload: str
    resident_layers: int
    prefetch_depth: int
    max_pinned_bytes: int
    device_index: int | None
    # what else changes the loaded module beyond the files (e.g. "adaln=fixed;lora=<digest>"):
    # a DiT with LoRA factors or another AdaLN mode must never be reused by a job without them
    variant_key: str = ""

    @property
    def single_flight_key(self) -> str:
        """Build the key used to coalesce identical loading requests."""
        q = self.quantization or {}
        parts = [
            self.model_id,
            self.model_revision,
            self.component_id,
            self.weight_format,
            self.compute_dtype,
            str(q.get("scheme", "none")),
            str(q.get("provider", "native")),
            self.offload,
            str(self.device_index),
        ]
        if self.variant_key:
            parts.append(self.variant_key)
        return ":".join(parts)


@dataclass
class ComponentLease:
    """Identify the loaded instance held by a stage."""

    component_key: str
    spec: ComponentLoadSpec
    actor_instance_id: str
    state: str = "loading"
    reference_count: int = 0
    allocated_bytes: int | None = None
    peak_loading_bytes: int | None = None
    handle: Any = None


__all__ = ["ComponentLease", "ComponentLoadSpec"]
