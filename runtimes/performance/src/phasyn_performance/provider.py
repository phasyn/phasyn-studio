"""Discoverable CPU components for body pose capture and character performance transfer."""

from __future__ import annotations

from collections.abc import Mapping
from importlib import import_module
from importlib.util import find_spec
from pathlib import Path
from typing import Any, ClassVar, override

from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Port,
    RunContext,
    UnloadContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording
from phasyn_media.errors import MediaError
from phasyn_media.providers._failure import media_failure

from .capture import WEIGHTS, Capture, model_bytes


class PoseControlProvider(BaseProvider):
    """Produce frame-aligned body landmarks, a skeleton video, and a reusable Asset."""

    provider_id: ClassVar[str] = "media.pose_control"
    kind: ClassVar[str] = "pose"
    animate: ClassVar[bool] = False
    label: ClassVar[str] = "Body pose control sequence"
    detector: Capture | None = None

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Describe supported input and output kinds without opening model files."""
        del settings
        parameters = (
            {
                "strength": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.5,
                    "default": 1.0,
                },
                "copy_audio": {"type": "boolean", "default": True},
            }
            if cls.animate
            else {}
        )
        inputs = [
            Port(
                "video_file",
                "media.video.v1",
                transport="file",
                description="Driving performance video",
            )
        ]
        if cls.animate:
            inputs.append(
                Port(
                    "character",
                    "media.image.v1",
                    transport="file",
                    description=(
                        "Front-facing character portrait"
                        if cls.kind == "face"
                        else "Single full-body character image"
                    ),
                )
            )
        checkpoint, _, digest = WEIGHTS[cls.kind]
        engine = "cv2" if cls.kind == "depth" else "mediapipe"
        available = find_spec(engine) is not None
        return Description(
            provider_id=cls.provider_id,
            kind=cls.provider_id,
            label=cls.label,
            inputs=inputs,
            outputs=[
                Port("asset", "media.asset.v1", transport="inline"),
                Port("video_file", "media.video.v1", transport="file"),
                Port("landmarks", "media.landmarks.v1", transport="file"),
            ],
            settings_schema=settings_schema(
                require_model_path=True,
                device_kinds=("cpu",),
                invoke_properties=parameters,
            ),
            parameters_schema={
                "type": "object",
                "properties": parameters,
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "device": {
                        "kind": "cpu",
                        "id": "cpu",
                        "resource_group": "cpu-performance",
                    },
                    "model_path": "/path/to/models/"
                    + ("midas/" if cls.kind == "depth" else "mediapipe/")
                    + checkpoint,
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            available=available,
            unavailable_code=None if available else "PROVIDER_NOT_INSTALLED",
            unavailable_reason=None
            if available
            else f"Install the performance CPU runtime providing {engine}.",
            facts={
                **(
                    {
                        "studio_creative": {
                            "version": 1,
                            "medium": "video",
                            "output": "asset",
                            "inputs": {
                                "character_image": "character",
                                "performance_video": "video_file",
                            },
                        }
                    }
                    if cls.animate
                    else {}
                ),
                "model_sha256": digest,
                "mode": cls.kind,
                "max_frames": 900,
                "single_subject": True,
            },
        )

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Verify the configured model, then open it on CPU."""
        try:
            model = model_bytes(Path(ctx.load["model_path"]), self.kind)
            self.detector = Capture(self.kind, model)
        except OSError as exc:
            raise ComponentError(
                "INVALID_ARGUMENT", "Unable to open the configured landmark model."
            ) from exc
        return LoadResult(
            effective_load=ctx.load,
            expanded_parts=ctx.expanded_parts,
            model_identity={"sha256": WEIGHTS[self.kind][2], "kind": self.kind},
            runtime_identity={"mediapipe": self.detector.mp.__version__},
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the detector owned by this component."""
        del ctx
        if self.detector:
            self.detector.close()
            self.detector = None

    def invoke(self, ctx: RunContext) -> None:
        """Write a derived video and measured landmark sequence."""
        if self.detector is None:
            raise ComponentError(
                "COMPONENT_NOT_READY",
                "Load the landmark detector before running capture.",
            )
        try:
            with ctx.recorder.phase("performance"):
                import_module("phasyn_performance.render").render(
                    ctx, self.detector, animate=self.animate
                )
        except MediaError as exc:
            raise media_failure(ctx, exc, what="Performance capture failed") from exc


class PortraitPerformanceProvider(PoseControlProvider):
    """Transfer one driving face's relative 2D motion onto a single portrait."""

    provider_id: ClassVar[str] = "media.portrait_performance"
    kind: ClassVar[str] = "face"
    animate: ClassVar[bool] = True
    label: ClassVar[str] = "Portrait performance (2D facial mesh)"


class BodyPerformanceProvider(PoseControlProvider):
    """Drive the visible joints of a fully framed character with a single person's measured pose."""

    provider_id: ClassVar[str] = "media.body_performance"
    animate: ClassVar[bool] = True
    label: ClassVar[str] = "Body performance (2D character mesh)"
