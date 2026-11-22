"""Phasyn component for interpolating selected intervals of a take."""

from __future__ import annotations

from importlib import import_module
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any, ClassVar, override

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadResult,
    Port,
    settings_schema,
)
from phasyn_components.settings import normalize_recording
from phasyn_components.weights import WeightPlan
from phasyn_media.errors import MediaError
from phasyn_media.files import file_sha256
from phasyn_media.providers._failure import media_failure

from . import WEIGHTS_SHA256


if TYPE_CHECKING:
    from collections.abc import Mapping

    from phasyn_components.provider import LoadContext, RunContext, UnloadContext

    from .model import RifeModel


RANGE = {
    "type": "object",
    "required": ["start_frame", "end_frame"],
    "additionalProperties": False,
    "properties": {
        name: {"type": "integer", "minimum": 0} for name in ("start_frame", "end_frame")
    },
}
RANGES = {"type": "array", "items": RANGE, "maxItems": 256, "default": []}
PARAMETERS = {
    "multiplier": {"type": "integer", "minimum": 2, "maximum": 4, "default": 2},
    "mode": {"enum": ["smooth", "slow"], "default": "smooth"},
    "ranges": RANGES,
    "holds": RANGES,
    "scene_threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.3},
    "crf": {"type": "integer", "minimum": 1, "maximum": 51, "default": 16},
    "audio_policy": {"enum": ["preserve", "drop"], "default": "preserve"},
}


class InterpolationProvider(BaseProvider):
    """Load a verified RIFE checkpoint and produce a separate derived video."""

    provider_id: ClassVar[str] = "media.interpolate"
    model: RifeModel | None = None

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Return ports, parameter limits and model identity without loading CUDA."""
        del settings
        available = find_spec("torch") is not None
        return Description(
            provider_id=cls.provider_id,
            kind=cls.provider_id,
            label="選區補幀（RIFE 4.26）",
            inputs=[
                Port(
                    "video_file",
                    "media.video.v1",
                    transport="file",
                    description="來源影片",
                )
            ],
            outputs=[
                Port(
                    "asset",
                    "media.asset.v1",
                    transport="inline",
                    description="補幀後的影片",
                ),
                Port(
                    "video_file",
                    "media.video.v1",
                    transport="file",
                    description="影片檔",
                ),
            ],
            settings_schema=settings_schema(
                require_model_path=True,
                invoke_properties=PARAMETERS,
                device_kinds=("cuda",),
            ),
            parameters_schema={
                "type": "object",
                "properties": PARAMETERS,
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "device": {
                        "kind": "cuda",
                        "id": "GPU-REPLACE",
                        "resource_group": "gpu",
                    },
                    "model_path": "/path/to/models/practical-rife-4.26/RIFEv4.26_0921.zip",
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            available=available,
            unavailable_code=None if available else "PROVIDER_NOT_INSTALLED",
            unavailable_reason=None if available else "此 runtime 缺少 PyTorch",
            facts={"method": "rife-4.26", "weights_sha256": WEIGHTS_SHA256},
        )

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """Identify the upstream manual download for the configured checkpoint."""
        archive = ((settings or {}).get("load") or {}).get("model_path")
        return WeightPlan(
            root=str(Path(archive).parent) if archive else None,
            notes=("Practical-RIFE 4.26: RIFEv4.26_0921.zip (22,867,954 bytes)",),
        )

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Load the fixed model into the CUDA device assigned by the Node."""
        torch = import_module("torch")
        if not torch.cuda.is_available():
            raise ComponentError("RUNTIME_UNAVAILABLE", "補幀元件無法使用 CUDA")
        with ctx.recorder.phase("load"):
            try:
                self.model = import_module("phasyn_rife.model").RifeModel(
                    Path(ctx.load["model_path"]), torch.device("cuda", 0)
                )
            except OSError as exc:
                raise ComponentError(
                    "INVALID_ARGUMENT", "無法讀取 RIFE 權重檔"
                ) from exc
            except ValueError as exc:
                raise ComponentError("INTEGRITY_MISMATCH", "RIFE 權重驗證失敗") from exc
        return LoadResult(
            effective_load=ctx.load,
            expanded_parts=ctx.expanded_parts,
            model_identity={"method": "rife-4.26", "sha256": WEIGHTS_SHA256},
            runtime_identity={
                "torch": str(torch.__version__),
                "cuda": torch.version.cuda,
            },
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the resident weights when the component unloads."""
        with ctx.recorder.phase("unload"):
            self.model = None

    def invoke(self, ctx: RunContext) -> None:
        """Render into a new file and publish it together with the source mapping."""
        if self.model is None:
            raise ComponentError("COMPONENT_NOT_READY", "請先載入補幀模型")
        source = ctx.input("video_file")
        path = source.require_path("video_file")
        if source.file is None:
            raise ComponentError("INVALID_ARGUMENT", "補幀輸入需要影片檔案參照")
        ctx.work_dir.mkdir(parents=True, exist_ok=True)
        result = ctx.new_file(
            None, "video/mp4", {"role": "interpolation"}, type_id="media.video.v1"
        )
        with TemporaryDirectory(dir=ctx.work_dir, prefix="interpolate-") as directory:
            temp = Path(directory) / "interpolated.mp4"
            try:
                with ctx.recorder.phase("interpolate"):
                    report = import_module("phasyn_rife.video").render(
                        path,
                        temp,
                        parameters=ctx.parameters,
                        interpolate=self.model,
                        cancel=ctx.cancel_token,
                    )
                digest, size = file_sha256(temp, cancel=ctx.cancel_token)
                ctx.check_cancelled()
                result.adopt_file(temp, sha256=digest, size=size)
            except MediaError as exc:
                raise media_failure(ctx, exc, what="影片補幀失敗") from exc
        asset = {
            "asset_id": new_id(),
            "kind": "final",
            "file": ctx.file_ref(result),
            "source_latent": None,
            "complete": True,
            "has_audio": report["has_audio"],
            "frame_count": report["frames"],
            "fps": report["fps"],
            "width": report["width"],
            "height": report["height"],
            "actual_settings": {
                "interpolation": {
                    **report,
                    "method": "rife-4.26",
                    "weights_sha256": WEIGHTS_SHA256,
                    "source": {
                        key: source.file[key]
                        for key in ("node_id", "file_id", "sha256")
                    },
                },
            },
        }
        contracts.validate("Asset", asset, code="RUNTIME_ERROR", what="補幀產物")
        ctx.set_output("asset", asset)
        if ctx.output_type("video_file"):
            ctx.set_file_output("video_file", result)
