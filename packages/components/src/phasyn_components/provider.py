"""The provider SDK: the public facade every runtime imports.

A provider implements ``describe`` (without loading a GPU), ``load``, ``invoke`` and ``unload``; it
receives a Recorder and a file resolver through its contexts. The control plane never imports a
provider's GPU code: a provider only runs inside its own runtime process.

This module defines the provider-facing types and re-exports the call contexts
(:mod:`.context`), output files (:mod:`.outputs`) and preview helpers (:mod:`.preview`), so
``from phasyn_components.provider import RunContext, OutputFile, ...`` stays the one entry point.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Protocol

from .canonical import canonical_json
from .context import CancelToken, InputValue, LoadContext, RunContext, UnloadContext
from .errors import ComponentError
from .outputs import OutputFile
from .preview import (
    PREVIEW_MAX_BYTES,
    PREVIEW_MAX_SIDE,
    PREVIEW_MEDIA_TYPES,
    PREVIEW_NOTE_MAX,
    PreviewFrame,
    PreviewSink,
    preview_image_size,
)

FACTS_MAX_BYTES = 16 * 1024


DEVICE_ID_PATTERN = "^[^\\x00-\\x1f\\x7f]*$"  # a device id never holds control characters


@dataclass
class Port:
    name: str
    type_id: str
    required: bool = True
    transport: str = "either"  # inline | file | either
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type_id": self.type_id,
            "required": self.required,
            "transport": self.transport,
            "description": self.description,
        }


@dataclass
class Part:
    path: str
    kind: str
    settings_schema: dict[str, Any] = field(default_factory=lambda: {"type": "object", "properties": {}})
    observable: list[str] = field(default_factory=list)
    coverage: str = "full"
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "kind": self.kind,
            "settings_schema": self.settings_schema,
            "observable": list(self.observable),
            "coverage": self.coverage,
            "reason": self.reason,
        }


@dataclass
class Description:
    provider_id: str
    kind: str
    label: str
    inputs: list[Port]
    outputs: list[Port]
    settings_schema: dict[str, Any]
    parameters_schema: dict[str, Any]
    parts: list[Part] = field(default_factory=list)
    default_settings: dict[str, Any] | None = None
    available: bool = True
    unavailable_code: str | None = None
    unavailable_reason: str | None = None
    synthetic: bool = False
    notes: list[str] = field(default_factory=list)
    # Free-form JSON facts for clients (e.g. ``cost_model`` for the ETA estimator); at most 16 KiB.
    facts: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.facts, Mapping):
            raise ComponentError("RUNTIME_ERROR", "provider describe 的 facts 必須是 JSON object")
        size = len(canonical_json(dict(self.facts)))
        if size > FACTS_MAX_BYTES:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"provider describe 的 facts 序列化後 {size} bytes，超過上限 {FACTS_MAX_BYTES} bytes",
                details={"size_bytes": size, "max_bytes": FACTS_MAX_BYTES},
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "kind": self.kind,
            "label": self.label,
            "inputs": [p.to_dict() for p in self.inputs],
            "outputs": [p.to_dict() for p in self.outputs],
            "parts": [p.to_dict() for p in self.parts],
            "settings_schema": self.settings_schema,
            "parameters_schema": self.parameters_schema,
            "default_settings": self.default_settings,
            "available": self.available,
            "unavailable_code": self.unavailable_code,
            "unavailable_reason": self.unavailable_reason,
            "synthetic": self.synthetic,
            "notes": list(self.notes),
            "facts": dict(self.facts),
        }


@dataclass
class LoadResult:
    """load 後實際生效的設定與觀測事實。"""

    effective_load: dict[str, Any]
    observed: dict[str, Any] = field(default_factory=dict)
    expanded_parts: dict[str, dict[str, Any]] = field(default_factory=dict)
    model_identity: dict[str, Any] = field(default_factory=dict)
    runtime_identity: dict[str, Any] = field(default_factory=dict)
    parts: list[Part] | None = None


class ProviderHost:
    """provider 建構時取得的程序環境（非控制面物件）。"""

    def __init__(
        self,
        *,
        node_id: str,
        component_id: str,
        data_dir: Path,
        work_dir: Path,
        device: Mapping[str, Any],
        process_instance_id: str,
    ) -> None:
        self.node_id = node_id
        self.component_id = component_id
        self.data_dir = data_dir
        self.work_dir = work_dir
        self.device = dict(device)
        self.process_instance_id = process_instance_id


class Provider(Protocol):
    provider_id: ClassVar[str]

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description: ...

    def load(self, ctx: LoadContext) -> LoadResult: ...

    def invoke(self, ctx: RunContext) -> None: ...

    def unload(self, ctx: UnloadContext) -> None: ...


class BaseProvider:
    """方便的基底類別：預設 unload 不做事、load 回傳原設定。"""

    provider_id: ClassVar[str] = ""

    def __init__(self, host: ProviderHost) -> None:
        self.host = host

    def load(self, ctx: LoadContext) -> LoadResult:
        return LoadResult(effective_load=ctx.load, expanded_parts=ctx.expanded_parts)

    def unload(self, ctx: UnloadContext) -> None:
        return None


def settings_schema(
    *,
    load_properties: Mapping[str, Any] | None = None,
    invoke_properties: Mapping[str, Any] | None = None,
    precision_properties: Mapping[str, Any] | None = None,
    offload_schema: Mapping[str, Any] | None = None,
    provider_options: Mapping[str, Any] | None = None,
    require_model_path: bool = False,
    device_kinds: tuple[str, ...] = ("cpu", "cuda"),
) -> dict[str, Any]:
    """組合 provider 的 InstanceSettings schema：未宣告的欄位一律 422（additionalProperties=false）。"""
    load_props: dict[str, Any] = {
        "model_path": {"type": "string", "description": "Node 本機模型路徑（使用者提供，不由主控下載）"},
        "model_revision": {"type": ["string", "null"]},
        "device": {
            "type": "object",
            "properties": {
                "kind": {"enum": list(device_kinds)},
                # it becomes CUDA_VISIBLE_DEVICES of the component process: no control characters
                "id": {"type": "string", "maxLength": 16384, "pattern": DEVICE_ID_PATTERN},
                "resource_group": {"type": "string"},
            },
            "required": ["kind", "id", "resource_group"],
            "additionalProperties": False,
        },
        "precision": {
            "type": "object",
            "properties": dict(precision_properties or {}),
            "additionalProperties": False,
        },
        "offload": dict(offload_schema or {"type": "object", "properties": {}, "additionalProperties": False}),
        "part_overrides": {"type": "array"},
        "provider_options": {
            "type": "object",
            "properties": dict(provider_options or {}),
            "additionalProperties": False,
        },
    }
    load_props.update(load_properties or {})
    required = ["device", *(["model_path"] if require_model_path else [])]
    return {
        "type": "object",
        "properties": {
            "load": {"type": "object", "properties": load_props, "required": required, "additionalProperties": False},
            "invoke": {"type": "object", "properties": dict(invoke_properties or {}), "additionalProperties": False},
            "recording": {"type": "object"},
        },
        "required": ["load", "invoke", "recording"],
        "additionalProperties": False,
    }


__all__ = [
    "FACTS_MAX_BYTES",
    "PREVIEW_MAX_BYTES",
    "PREVIEW_MAX_SIDE",
    "PREVIEW_MEDIA_TYPES",
    "PREVIEW_NOTE_MAX",
    "BaseProvider",
    "CancelToken",
    "Description",
    "InputValue",
    "LoadContext",
    "LoadResult",
    "OutputFile",
    "Part",
    "Port",
    "PreviewFrame",
    "PreviewSink",
    "Provider",
    "ProviderHost",
    "RunContext",
    "UnloadContext",
    "preview_image_size",
    "settings_schema",
]
