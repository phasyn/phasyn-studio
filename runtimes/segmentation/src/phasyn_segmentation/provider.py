"""Discover SAM 2 without importing CUDA; allocate model state only for an accepted call."""

from __future__ import annotations

import json
from collections.abc import Mapping
from importlib import import_module
from importlib.util import find_spec
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, override

from phasyn_components.errors import ComponentError
from phasyn_components.provider import BaseProvider, Description, LoadResult, Port
from phasyn_components.upstream import distribution_problem
from phasyn_media.errors import MediaError
from phasyn_media.providers._failure import media_failure

from .model import ENGINE, FILE, REPO, REVISION, predictor, weight_plan


if TYPE_CHECKING:
    from phasyn_components.provider import LoadContext, RunContext, UnloadContext
    from phasyn_components.weights import WeightPlan


class SegmentVideoProvider(BaseProvider):
    """Produce a frame-aligned object mask from point and box corrections."""

    provider_id: ClassVar[str] = "media.segment_video"
    model: Any = None

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Report supported files and annotation semantics without opening weights."""
        del settings
        path = Path(__file__).parent / "native_capabilities" / f"{cls.provider_id}.json"
        native = json.loads(path.read_text(encoding="utf-8"))
        missing = [
            m for m in native["resources"]["required_modules"] if find_spec(m) is None
        ]
        reason = (
            f"Missing runtime modules: {', '.join(missing)}"
            if missing
            else distribution_problem("SAM-2", vcs_commit=ENGINE)
        )
        return Description(
            provider_id=cls.provider_id,
            kind=native["kind"],
            label=native["label"],
            inputs=[Port(**p) for p in native["inputs"]],
            outputs=[Port(**p) for p in native["outputs"]],
            parameters_schema=native["parameters_schema"],
            settings_schema=native["settings_schema"],
            default_settings=native["default_settings"],
            available=reason is None,
            unavailable_code="RUNTIME_UNAVAILABLE" if reason else None,
            unavailable_reason=reason,
            facts={
                "annotation_schema": "media.mask-annotations.v1",
                "coordinates": "native_pixels",
                "source_bound": True,
                "max_frames": 240,
                "object_count": 1,
                "mask_output": "mask_video",
            },
        )

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """Return the exact local checkpoint inventory."""
        root = ((settings or {}).get("load") or {}).get("model_path")
        return weight_plan(root)

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Create the verified predictor in the Node-assigned CUDA process."""
        if ctx.load.get("model_revision") not in (None, REVISION):
            raise ComponentError(
                "INVALID_ARGUMENT",
                "This component requires the pinned SAM 2.1 snapshot.",
            )
        path = ctx.load.get("model_path")
        if not isinstance(path, str) or not path:
            raise ComponentError(
                "INVALID_ARGUMENT", "Configure a local SAM 2 model directory."
            )
        with ctx.recorder.phase("load"):
            self.model = predictor(Path(path))
        torch = import_module("torch")
        return LoadResult(
            effective_load=ctx.load,
            expanded_parts=ctx.expanded_parts,
            model_identity={"repo": REPO, "revision": REVISION, "sha256": FILE.sha256},
            runtime_identity={
                "sam2_commit": ENGINE,
                "torch": str(torch.__version__),
                "cuda": torch.version.cuda,
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        """Build fresh state for this specific source and user revision."""
        if self.model is None:
            raise ComponentError(
                "COMPONENT_NOT_READY", "Load the SAM 2 model before tracking."
            )
        try:
            import_module("phasyn_segmentation.segment").segment(ctx, self.model)
        except MediaError as exc:
            raise media_failure(
                ctx, exc, what="SAM 2 video preparation failed"
            ) from exc

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the worker-owned predictor."""
        del ctx
        self.model = None
