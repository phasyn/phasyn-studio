"""Discover and operate the optional CPU relative-depth and person-matte components."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from importlib import import_module
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, override

from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    Description,
    LoadContext,
    LoadResult,
    Port,
    RunContext,
    UnloadContext,
    settings_schema,
)
from phasyn_media.errors import MediaError
from phasyn_media.providers._failure import media_failure

from .capture import WEIGHTS, model_bytes
from .provider import PoseControlProvider


if TYPE_CHECKING:
    from .control_maps import MapModel


class DepthControlProvider(PoseControlProvider):
    """Produce a model-estimated relative inverse-depth field and synchronized preview."""

    provider_id: ClassVar[str] = "media.depth_control"
    label: ClassVar[str] = "Relative depth control"
    kind: ClassVar[str] = "depth"
    factory: ClassVar[str] = "Depth"
    model: MapModel | None = None

    @classmethod
    @override
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Describe both outputs without loading the inference engine."""
        result = super().describe(settings)
        selection = {
            "frame_index": {
                "type": "integer",
                "minimum": 0,
                "maximum": 899,
                "default": 0,
            }
        }
        return replace(
            result,
            settings_schema=settings_schema(
                require_model_path=True,
                device_kinds=("cpu",),
                invoke_properties=selection,
            ),
            parameters_schema={**result.parameters_schema, "properties": selection},
            facts={
                "model_sha256": WEIGHTS[cls.kind][2],
                "max_frames": 900,
                "field_shape_per_frame": [256, 256],
                "mode": cls.provider_id,
            },
            outputs=[
                *result.outputs[:2],
                Port("field", "media.control-field.v1", transport="file"),
                Port("control_image", "media.image.v1", transport="file"),
            ],
        )

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Load the verified model into this CPU worker."""
        try:
            weights = model_bytes(Path(ctx.load["model_path"]), self.kind)
        except OSError as exc:
            raise ComponentError(
                "INVALID_ARGUMENT", "Unable to open the configured control model."
            ) from exc
        module = import_module("phasyn_performance.control_maps")
        model: MapModel = getattr(module, self.factory)(weights)
        self.model = model
        return LoadResult(
            effective_load=ctx.load,
            expanded_parts=ctx.expanded_parts,
            model_identity={"sha256": WEIGHTS[self.kind][2]},
            runtime_identity={"engine": model.library},
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the native CPU worker."""
        del ctx
        if self.model is not None:
            self.model.close()
            self.model = None

    @override
    def invoke(self, ctx: RunContext) -> None:
        """Measure and encode one complete control sequence."""
        if self.model is None:
            raise ComponentError(
                "COMPONENT_NOT_READY", "Load the control model before invoking it."
            )
        try:
            with ctx.recorder.phase("control"):
                import_module("phasyn_performance.control_maps").control(
                    ctx, self.model
                )
        except MediaError as exc:
            raise media_failure(ctx, exc, what="Control preparation failed") from exc


class PersonMaskProvider(DepthControlProvider):
    """Produce the detected person's soft foreground mask."""

    provider_id: ClassVar[str] = "media.person_mask"
    label: ClassVar[str] = "Person foreground matte"
    factory: ClassVar[str] = "PersonMask"
    kind: ClassVar[str] = "pose"
