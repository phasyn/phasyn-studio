"""Native Wan speech and performance providers with local-only model activation."""

from __future__ import annotations

import json
import shutil
import time
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any, ClassVar, override

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import BaseProvider, Description, LoadResult, Port
from phasyn_media.errors import MediaError
from phasyn_media.files import file_sha256
from phasyn_media.providers._failure import media_failure

from . import conditioning, media, sandbox, sources


if TYPE_CHECKING:
    from collections.abc import Mapping

    from phasyn_components.provider import LoadContext, RunContext, UnloadContext


_MAX_PROMPT_CHARS = 16_384


def _prompt(ctx: RunContext) -> str:
    typed = ctx.optional_input("prompt")
    if typed is None:
        return ""
    value = typed.value
    if isinstance(value, dict):
        value = value.get("text")
    if not isinstance(value, str) or len(value) > _MAX_PROMPT_CHARS or "\0" in value:
        raise ComponentError("INVALID_ARGUMENT", "請提供有效的文字提示")
    return value


class _NativeProvider(BaseProvider):
    role: ClassVar[str]
    activation: TemporaryDirectory[str] | None = None
    install: sources.Installation | None = None
    recent: conditioning.RecentControls | None = None
    conditioning_abi: str = ""
    load_profile: dict[str, Any]
    invocation_ordinal: int = 0

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Read the packaged declaration without importing the CUDA stack or opening weight files."""
        del settings
        doc = json.loads(
            (
                Path(__file__).parent
                / "native_capabilities"
                / f"{cls.provider_id}.json"
            ).read_bytes()
        )
        ready = all(
            find_spec(name) is not None for name in doc["resources"]["required_modules"]
        )
        ready = ready and all(
            shutil.which(name) for name in doc["resources"]["executables"]
        )
        return Description(
            provider_id=cls.provider_id,
            kind=cls.provider_id,
            label=doc["label"],
            inputs=[Port(**item) for item in doc["inputs"]],
            outputs=[Port(**item) for item in doc["outputs"]],
            parameters_schema=doc["parameters_schema"],
            settings_schema=doc["settings_schema"],
            default_settings=doc["default_settings"],
            available=ready,
            unavailable_code=None if ready else "PROVIDER_NOT_INSTALLED",
            unavailable_reason=None
            if ready
            else "Wan 專用環境缺少 GPU、媒體或隔離執行套件",
            facts={
                "upstream_revision": sources.ENGINE_REVISION,
                "model_revision": sources.MODELS[cls.role][1],
                "studio_creative": {
                    "version": 1,
                    "medium": "video",
                    "output": "asset",
                    "inputs": {
                        "prompt": "prompt",
                        "character_image": "character",
                        **(
                            {"source_audio": "audio"}
                            if cls.role == "speech"
                            else {"performance_video": "driving"}
                        ),
                    },
                },
            },
        )

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Validate explicit local paths against the fixed source and checkpoint revisions."""
        load_start = time.perf_counter_ns()
        load = ctx.load
        name, revision = sources.MODELS[self.role]
        options = load.get("provider_options") or {}
        engine, weights = options.get("engine_path"), load.get("model_path")
        if (
            not isinstance(engine, str)
            or not isinstance(weights, str)
            or load.get("model_revision") not in (revision, None)
            or ctx.device.get("kind") != "cuda"
        ):
            raise ComponentError(
                "INVALID_ARGUMENT",
                "請設定固定版本的本機 Wan source、weights 及 CUDA device",
            )
        ctx.work_dir.mkdir(parents=True, exist_ok=True)
        activation = TemporaryDirectory(dir=ctx.work_dir, prefix="wan-engine-")
        try:
            target = Path(activation.name)
            with ctx.recorder.phase("verify-engine"):
                sources.stage_engine(Path(engine), target)
            with (
                ctx.recorder.phase("native-preflight"),
                TemporaryDirectory(dir=ctx.work_dir, prefix="wan-check-") as work,
            ):
                runtime = sandbox.preflight(
                    str(ctx.device["id"]), target, Path(work), self.role
                )
            with ctx.recorder.phase("verify-weights"):
                install = sources.verified_installation(
                    Path(weights), target, self.role
                )
        except BaseException:
            activation.cleanup()
            raise
        if self.activation is not None:
            self.activation.cleanup()
        self.activation, self.install = activation, install
        self.invocation_ordinal = 0
        self.load_profile = {
            "activation_id": new_id(),
            "activation_ns": time.perf_counter_ns() - load_start,
            "node_id": str(ctx.recorder.node_id),
            "cuda_device": str(ctx.device["id"]),
            "runtime": runtime,
        }
        self.recent = (
            conditioning.RecentControls() if self.role == "performance" else None
        )
        self.conditioning_abi = str(runtime.get("conditioning_abi", ""))
        return LoadResult(
            effective_load=load,
            expanded_parts=ctx.expanded_parts,
            model_identity={
                "model_id": name,
                "source_revision": revision,
                "verified_files": len(install.files),
            },
            runtime_identity={
                "upstream_revision": sources.ENGINE_REVISION,
                "engine": "Wan2.2 native",
                **runtime,
            },
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release private verified source files; inference workers live for one invocation."""
        with ctx.recorder.phase("unload"):
            if self.activation is not None:
                self.activation.cleanup()
            self.activation, self.install, self.recent = None, None, None

    def invoke(self, ctx: RunContext) -> None:
        """Publish a complete video and an immutable FileRef after probing the generated media."""
        if self.install is None:
            raise ComponentError("COMPONENT_NOT_READY", "請先載入本機 Wan 模型")
        self.invocation_ordinal += 1
        try:
            with TemporaryDirectory(dir=ctx.work_dir, prefix="wan-call-") as name:
                self._render(ctx, Path(name), self.install)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="Wan 影音處理") from exc

    def _render(
        self, ctx: RunContext, work: Path, install: sources.Installation
    ) -> None:
        start = time.perf_counter_ns()
        with ctx.recorder.phase("prepare"):
            material = media.prepare(ctx, work, self.role)
        placement = ctx.settings["load"].get("provider_options", {})
        options = {
            "convert_model_dtype": placement.get("convert_model_dtype", False),
            "dit_offload": placement.get("dit_offload", "native"),
            "chunk_frames": ctx.parameters.get(
                "chunk_frames", 80 if self.role == "speech" else 77
            ),
            "role": self.role,
            "seed": ctx.parameters.get("seed", 42),
            "steps": ctx.parameters.get("steps", 40 if self.role == "speech" else 20),
            "prompt": _prompt(ctx),
            "speech_frames": material.frames,
            "size": ctx.parameters.get(
                "size", "832*480" if self.role == "speech" else "1280*720"
            ),
        }
        prepared = time.perf_counter_ns()
        controls = self.recent
        settings = None
        reuse = "not_applicable"
        directory = work / "processed"
        if controls is not None:
            settings = conditioning.recipe(
                ctx, str(options["size"]), self.conditioning_abi
            )
            with ctx.recorder.phase("restore-controls"):
                reuse = controls.restore(ctx, settings, directory)
            options["prepared_controls"] = reuse != "miss"
        invoke_start = time.perf_counter_ns()
        with ctx.recorder.phase("native-generate"):
            inputs = {"driving": material.driving} if self.role == "performance" else {}
            geometry = sandbox.run_native(ctx, install, work, inputs, options)
        generated = time.perf_counter_ns()
        with ctx.recorder.phase("publish"):
            path, info, audio_hash = media.deliver(ctx, work, material, geometry)
            sha, size = file_sha256(path, cancel=ctx.cancel_token)
            ctx.check_cancelled()
            mime = "video/mp4" if path.suffix == ".mp4" else "video/x-matroska"
            output = ctx.new_file("video_file", mime, {"kind": "wan_native_video"})
            output.adopt_file(path, sha256=sha, size=size)
            selected = ("character", "audio" if self.role == "speech" else "driving")
            controls_ref = None
            if settings is not None and controls is not None:
                controls_ref = conditioning.publish(ctx, directory, settings)
            identity = {
                "provider_id": self.provider_id,
                "model": sources.MODELS[self.role][0],
                "model_revision": sources.MODELS[self.role][1],
                "engine_revision": sources.ENGINE_REVISION,
                "seed": options["seed"],
                "steps": options["steps"],
                "area": options["size"],
                "convert_model_dtype": options["convert_model_dtype"],
                "dit_offload": options["dit_offload"],
                "chunk_frames": options["chunk_frames"],
                "cuda_peak_allocated_bytes": geometry["cuda_peak_allocated_bytes"],
                "cuda_peak_reserved_bytes": geometry["cuda_peak_reserved_bytes"],
                "native_profile": {
                    **self.load_profile,
                    "invocation_ordinal": self.invocation_ordinal,
                    **{
                        key: value
                        for key, value in geometry.items()
                        if key.endswith(("_ns", "_bytes"))
                    },
                    "media_preparation_ns": prepared - start,
                    "restore_controls_ns": invoke_start - prepared,
                    "worker_wall_ns": generated - invoke_start,
                    "media_delivery_ns": time.perf_counter_ns() - generated,
                    "conditioning_reuse": reuse,
                    "conditioning_recipe_sha256": conditioning.digest(settings)
                    if settings is not None
                    else None,
                },
                "source_files": {name: ctx.input(name).file for name in selected},
                "soundtrack": "original_stream_copy" if audio_hash else "silent",
                "decoded_audio_sha256": audio_hash,
                "source_audio_offset_seconds": material.offset,
            }
            asset = {
                "asset_id": new_id(),
                "kind": "final",
                "complete": True,
                "source_latent": None,
                "has_audio": audio_hash is not None,
                "file": ctx.file_ref(output),
                "width": info.width,
                "height": info.height,
                "frame_count": info.frame_count,
                "fps": {"num": info.fps_num, "den": info.fps_den},
                "actual_settings": identity,
            }
            contracts.validate("Asset", asset)
            ctx.set_file_output("video_file", output)
            ctx.set_output("asset", asset)
            if (
                controls_ref is not None
                and settings is not None
                and controls is not None
            ):
                controls.remember(settings, controls_ref)


class SpeechProvider(_NativeProvider):
    """Generate speech-conditioned video from a still character reference."""

    provider_id: ClassVar[str] = "wan.speech"
    role: ClassVar[str] = "speech"


class PerformanceProvider(_NativeProvider):
    """Retarget a single driving performance onto a character through native Wan-Animate."""

    provider_id: ClassVar[str] = "wan.performance"
    role: ClassVar[str] = "performance"
