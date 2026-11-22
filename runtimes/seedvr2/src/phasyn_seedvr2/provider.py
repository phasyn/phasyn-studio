"""Isolated SeedVR2 restoration component for Studio video takes."""

from __future__ import annotations

import os
import sys
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
from phasyn_media.errors import MediaError
from phasyn_media.files import file_sha256
from phasyn_media.providers._failure import media_failure
from phasyn_media.tools import run_tool, tool_env

from .sources import (
    ENGINE_REVISION,
    WEIGHT_REVISION,
    unpack_engine,
    verify_weights,
    weight_plan,
)


if TYPE_CHECKING:
    from collections.abc import Mapping

    from phasyn_components.provider import LoadContext, RunContext, UnloadContext
    from phasyn_components.weights import WeightPlan


PARAMETERS = {
    "short_side": {
        "type": "integer",
        "minimum": 128,
        "maximum": 1536,
        "multipleOf": 2,
        "default": 512,
    },
    "seed": {"type": "integer", "minimum": 0, "maximum": 2_147_483_647, "default": 42},
    "start_frame": {"type": "integer", "minimum": 0, "default": 0},
    "end_frame": {"type": ["integer", "null"], "minimum": 1, "default": None},
    "strength": {"type": "number", "minimum": 0, "maximum": 1, "default": 1},
}
IDENTITY = {
    "method": "seedvr2-3b",
    "weight_revision": WEIGHT_REVISION,
    "engine_revision": ENGINE_REVISION,
}


class RestorationProvider(BaseProvider):
    """Verify local inputs on load and run restoration within the assigned GPU runtime."""

    provider_id: ClassVar[str] = "media.restore"
    directory: TemporaryDirectory[str] | None = None
    weights_root: Path | None = None

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Advertise the fixed offline engine without importing it or initializing CUDA."""
        del settings
        available = all(
            find_spec(package) is not None
            for package in ("torch", "rotary_embedding_torch", "cv2")
        )
        return Description(
            provider_id=cls.provider_id,
            kind=cls.provider_id,
            label="影片修復（SeedVR2-3B）",
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
                    description="修復後的影片",
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
                provider_options={"engine_archive": {"type": "string", "minLength": 1}},
                device_kinds=("cuda",),
            ),
            parameters_schema={
                "type": "object",
                "properties": PARAMETERS,
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "model_path": "/path/to/models/SeedVR2-3B",
                    "provider_options": {
                        "engine_archive": "/path/to/engines/SeedVR2_VideoUpscaler-4490bd1.tar.gz"
                    },
                    "device": {
                        "kind": "cuda",
                        "id": "GPU-REPLACE",
                        "resource_group": "gpu",
                    },
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            available=available,
            unavailable_code=None if available else "PROVIDER_NOT_INSTALLED",
            unavailable_reason=None
            if available
            else "此 runtime 缺少 SeedVR2 推論套件",
            facts=IDENTITY,
        )

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """Return the four checksummed files of the official checkpoint."""
        return weight_plan(settings)

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Prepare the trusted engine and verify the official weights before accepting work."""
        load = ctx.load
        root = Path(load["model_path"])
        archive = (load.get("provider_options") or {}).get("engine_archive")
        if not isinstance(archive, str) or not archive:
            raise ComponentError("INVALID_ARGUMENT", "請設定 SeedVR2 推論程式封存檔")
        ctx.work_dir.mkdir(exist_ok=True, parents=True)
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None
            self.weights_root = None
        directory = TemporaryDirectory(dir=ctx.work_dir, prefix="seedvr-engine-")
        try:
            with ctx.recorder.phase("verify_engine"):
                unpack_engine(Path(archive), Path(directory.name) / "engine")
            with ctx.recorder.phase("verify_weights"):
                verify_weights(root)
        except (ValueError, OSError, ComponentError) as exc:
            directory.cleanup()
            raise ComponentError(
                "INTEGRITY_MISMATCH", "SeedVR2 推論來源或權重驗證失敗"
            ) from exc
        self.directory = directory
        self.weights_root = root
        return LoadResult(
            effective_load=load,
            expanded_parts=ctx.expanded_parts,
            runtime_identity={"engine_revision": ENGINE_REVISION},
            model_identity=IDENTITY,
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the private engine tree and forget the verified checkpoint."""
        with ctx.recorder.phase("unload"):
            if self.directory is not None:
                self.directory.cleanup()
                self.directory = None
            self.weights_root = None

    def invoke(self, ctx: RunContext) -> None:
        """Produce a new asset and preserve its source identity and effective recipe."""
        if self.directory is None or self.weights_root is None:
            raise ComponentError("COMPONENT_NOT_READY", "請先載入 SeedVR2 修復元件")
        directory, root = Path(self.directory.name), self.weights_root
        source = ctx.input("video_file")
        path = source.require_path("video_file")
        if source.file is None:
            raise ComponentError("INVALID_ARGUMENT", "影片修復需要來源檔案參照")
        result = ctx.new_file(
            None, "video/mp4", {"role": "restoration"}, type_id="media.video.v1"
        )

        def restore(clip: Path, output: Path, short_side: int, seed: int) -> None:
            ctx.check_cancelled()
            command = [
                sys.executable,
                "-I",
                "-m",
                "phasyn_seedvr2.runner",
                str(directory / "engine"),
                str(root),
                str(clip),
                str(output),
                str(short_side),
                str(seed),
            ]
            env = tool_env(
                {
                    "PHASYN_SEEDVR_PARENT_PID": str(os.getpid()),
                    "HF_HUB_OFFLINE": "1",
                    "HOME": str(output.parent),
                    "XDG_CACHE_HOME": str(output.parent / ".cache"),
                }
            )
            proc = run_tool(
                command,
                timeout=ctx.remaining_seconds(),
                cancel=ctx.cancel_token,
                env=env,
                max_stdout_bytes=1024 * 1024,
                what="SeedVR2",
            )
            if proc.returncode:
                raise ComponentError(
                    "RUNTIME_ERROR",
                    "SeedVR2 影片修復失敗",
                    details={"returncode": proc.returncode},
                )

        with TemporaryDirectory(dir=ctx.work_dir, prefix="seedvr-output-") as workspace:
            temp = Path(workspace) / "restored.mp4"
            try:
                with ctx.recorder.phase("restore"):
                    report = import_module("phasyn_seedvr2.video").render(
                        path,
                        temp,
                        parameters=ctx.parameters,
                        restore=restore,
                        cancel=ctx.cancel_token,
                    )
                digest, size = file_sha256(temp, cancel=ctx.cancel_token)
                ctx.check_cancelled()
                result.adopt_file(temp, sha256=digest, size=size)
            except MediaError as exc:
                raise media_failure(ctx, exc, what="影片修復失敗") from exc
        settings = {
            **IDENTITY,
            **report,
            "source": {
                key: source.file[key] for key in ("node_id", "file_id", "sha256")
            },
            "backend": "sdpa",
            "loaded_weight_dtype": "float16",
            "blocks_to_swap": 32,
        }
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
            "actual_settings": {"restoration": settings},
        }
        contracts.validate("Asset", asset, code="RUNTIME_ERROR", what="修復產物")
        ctx.set_output("asset", asset)
        if ctx.output_type("video_file"):
            ctx.set_file_output("video_file", result)
