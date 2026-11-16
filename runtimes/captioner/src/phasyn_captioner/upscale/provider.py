"""``media.upscale`` (kind media.upscale): one video → the same video at 2×, 1440p or 2160p (Anime4K v4 VL, MIT).

The source is a complete ``media.asset.v1`` (a take) or a ``media.video.v1`` file. Frames are decoded once with
FFmpeg, run through the resident Anime4K chain on the component's GPU in halo tiles (``tile_pixels``), optionally
resized to the target height, and encoded as H.264 yuv420p (CRF ``crf``, no B-frames) at the source's exact frame
rate and frame count; the source's audio stream is copied unchanged. The output is one complete ``media.asset.v1``
whose ``actual_settings.upscale`` records the method, the source identity, sizes, durations, measured wall-clock
times and the allocator's peak bytes. Cached CUDA memory is released after every call; the weights stay resident.
"""

from __future__ import annotations

import importlib.util
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components import model_identity as identity
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Part,
    Port,
    RunContext,
    UnloadContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording
from phasyn_media.errors import MediaError
from phasyn_media.providers._failure import media_failure

from . import plan
from .report import actual_settings
from .shader import SHADER_DIR, SHADER_FILE, MethodSpec, load_vendored, method_spec

PART = "anime4k"
DTYPES = ("fp16", "fp32")
ASSET = "media.asset.v1"


def _schema() -> dict[str, Any]:
    return settings_schema(
        precision_properties={"compute_dtype": {"enum": list(DTYPES)}},
        provider_options=plan.PROVIDER_OPTIONS,
        invoke_properties=plan.PARAMS,
        device_kinds=("cuda",),
    )


def _source(ctx: RunContext) -> tuple[dict[str, Any], Path, Mapping[str, Any] | None]:
    """Exactly one of ``video`` (a complete media.asset.v1) or ``video_file`` → (FileRef, local path, asset)."""
    asset_item, file_item = ctx.optional_input("video"), ctx.optional_input("video_file")
    if (asset_item is None) == (file_item is None):
        raise ComponentError("INVALID_ARGUMENT", "video（media.asset.v1）與 video_file（media.video.v1）需要恰好接一個")
    if asset_item is not None:
        asset = asset_item.value
        if not isinstance(asset, Mapping) or not isinstance(asset.get("file"), Mapping):
            raise ComponentError("INVALID_ARGUMENT", "video 需要 media.asset.v1（含 file）")
        if not asset.get("complete"):
            raise ComponentError("MEDIA_INCOMPLETE", "影片 Asset 尚未完整（complete=false），不超分半成品")
        return dict(asset["file"]), ctx.resolve_file(asset["file"]), asset
    assert file_item is not None
    if file_item.file is None:
        raise ComponentError("INVALID_ARGUMENT", "video_file 需要 FileRef")
    return dict(file_item.file), file_item.require_path("video_file"), None


class UpscaleProvider(BaseProvider):
    provider_id = "media.upscale"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        missing = [m for m in ("torch", "numpy") if importlib.util.find_spec(m) is None]
        reason = f"此 runtime 沒有安裝 {', '.join(missing)}" if missing else None
        return Description(
            provider_id=cls.provider_id,
            kind="media.upscale",
            label="影片超分（Anime4K v4 Upscale_CNN_x2_VL，MIT；2×／1440p／2160p，保留 fps、幀數與原音訊）",
            inputs=[
                Port("video", ASSET, False, "inline", "完整影片 Asset（例如一個 take）；與 video_file 二擇一"),
                Port("video_file", "media.video.v1", False, "file", "影片檔；與 video 二擇一"),
            ],
            outputs=[
                Port(
                    "asset",
                    ASSET,
                    True,
                    "inline",
                    "超分後的完整 MP4 Asset（H.264＋原音訊；actual_settings.upscale 記錄方法與來源）",
                )
            ],
            parts=[
                Part(
                    PART,
                    "postprocess",
                    {"type": "object", "properties": {}},
                    ["host_ms", "input_frame_count", "output_frame_count"],
                    "full",
                    None,
                )
            ],
            settings_schema=_schema(),
            parameters_schema={"type": "object", "properties": plan.PARAMS, "additionalProperties": False},
            default_settings={
                "load": {
                    "device": {"kind": "cuda", "id": "GPU-REPLACE", "resource_group": "gpu"},
                    "precision": {"compute_dtype": "fp16"},
                    "provider_options": {k: v["default"] for k, v in plan.PROVIDER_OPTIONS.items()},
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            available=reason is None,
            unavailable_code="PROVIDER_NOT_INSTALLED" if reason else None,
            unavailable_reason=reason,
            notes=[
                "權重是內建的 Anime4K GLSL（third_party/anime4k，MIT），載入時解析並常駐；不讀 load.model_path",
                "分塊讀取時每邊多讀 halo 個像素，結果與整張相同；顯存上限看 tile_pixels 與 cuda_memory_cap_bytes",
            ],
        )

    def load(self, ctx: LoadContext) -> LoadResult:
        import torch
        from phasyn_components.recorder.gpu import AllocatorWindow, runtime_identity, torch_backend_flags

        load = ctx.load
        self.options = plan.resolve_load_options(load.get("provider_options") or {})
        dtype_name = (load.get("precision") or {}).get("compute_dtype", "fp16")
        if dtype_name not in DTYPES:
            raise ComponentError("UNSUPPORTED_SETTING", f"compute_dtype 必須是 {'、'.join(DTYPES)}")
        if not torch.cuda.is_available():
            raise ComponentError("RUNTIME_UNAVAILABLE", "此元件程序看不到 CUDA GPU")
        self.device = torch.device("cuda", 0)  # the Node narrows CUDA_VISIBLE_DEVICES to the component's GPU
        self.dtype_name = dtype_name
        self.dtype = torch.float16 if dtype_name == "fp16" else torch.float32
        total = int(torch.cuda.get_device_properties(self.device).total_memory)
        cap = self.options.cuda_memory_cap_bytes
        if cap is not None:
            torch.cuda.set_per_process_memory_fraction(min(1.0, cap / total), self.device)
        from .model import Anime4KModel

        allocator = AllocatorWindow(0)
        allocator.start()
        with ctx.recorder.phase("load"):
            self.spec = load_vendored()
            self.model = Anime4KModel(self.spec, self.device, self.dtype)
            # Soft_VL is a per-call choice; its few extra weights stay resident beside the default chain
            self.methods: dict[str, MethodSpec] = {
                plan.METHOD_ID: method_spec(plan.METHOD_ID, plan.METHOD_LABEL, self.spec, restore_and_clamp=False),
                plan.SOFT_VL_ID: method_spec(plan.SOFT_VL_ID, plan.SOFT_VL_LABEL, self.spec, restore_and_clamp=True),
            }
            self.models = {
                plan.METHOD_ID: self.model,
                plan.SOFT_VL_ID: Anime4KModel(self.methods[plan.SOFT_VL_ID], self.device, self.dtype),
            }
        allocator.finish(ctx.recorder, scope="load")
        self.identity = identity.model_identity(
            None,
            {"shader": SHADER_DIR / SHADER_FILE},
            method=plan.METHOD_ID,
            upstream="bloc97/Anime4K v4.0",
            license="MIT",
            shader_sha256=self.spec.sha256,
        )
        observed = {
            "method": plan.METHOD_ID,
            "shader_sha256": self.spec.sha256,
            "conv_stages": len(self.spec.stages),
            "parameter_count": self.model.parameter_count(),
            "halo_pixels": self.spec.halo,
            "methods": {
                m.method_id: {
                    "shaders": [{"file": f, "sha256": s} for f, s in m.shaders],
                    "halo_pixels": m.halo,
                    "parameter_count": self.models[m.method_id].parameter_count(),
                }
                for m in self.methods.values()
            },
            "compute_dtype": dtype_name,
            "tile_pixels": self.options.tile_pixels,
            "cuda_memory_cap_bytes": cap,
            "cuda_total_bytes": total,
            "backend_flags": torch_backend_flags(),
        }
        return LoadResult(
            effective_load=load,
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity=self.identity,
            runtime_identity=runtime_identity(),
        )

    def unload(self, ctx: UnloadContext) -> None:
        import torch

        del self.model
        self.models = {}
        torch.cuda.empty_cache()

    def invoke(self, ctx: RunContext) -> None:
        import torch

        try:
            self._invoke(ctx)
        finally:
            torch.cuda.empty_cache()

    def _invoke(self, ctx: RunContext) -> None:
        from phasyn_components.recorder.gpu import AllocatorWindow

        from .video import inspect_source

        rec = ctx.recorder
        params = plan.resolve_params(ctx.parameters)
        ref, path, asset = _source(ctx)
        started = time.perf_counter()
        try:
            with rec.phase("input"):
                source = inspect_source(path, cancel=ctx.cancel_token)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="來源影片檢查失敗") from exc
        plan.check_frames(source.frames, self.options.max_frames)
        geometry = plan.output_geometry(source.width, source.height, scale=params.scale, target=params.target)
        rec.set_metric(
            "input_frame_count", source.frames, unit="count", scope="component_call", method="ffprobe_packets"
        )
        metadata = {
            "role": "media.upscale.asset",
            "method": params.method,
            "source_sha256": ref.get("sha256"),
            "width": geometry.output_width,
            "height": geometry.output_height,
            "frames": source.frames,
        }
        result = ctx.new_file(None, "video/mp4", metadata, type_id="media.video.v1")
        work_dir = Path(ctx.work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        track_path = plan.work_path(work_dir, f"{result.file_id}.track.mp4")
        final_path = plan.work_path(work_dir, f"{result.file_id}.mp4")
        allocator = AllocatorWindow(0)
        allocator.start()
        try:
            track, model_seconds, tiles = self._encode(ctx, source, geometry, params, track_path)
            sha256, size = self._finish_file(ctx, source, track, track_path, final_path)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="超分失敗") from exc
        finally:
            track_path.unlink(missing_ok=True)
        allocator.finish(rec, scope="invoke")
        result.adopt_file(final_path, sha256=sha256, size=size)
        wall = time.perf_counter() - started
        rec.set_metric(
            "output_frame_count", track.frames, unit="count", scope="component_call", method="ffprobe_packets"
        )
        rec.record_cost(
            "upscale",
            work=track.frames * geometry.output_width * geometry.output_height,
            unit="pixel_frame",
            compute_ms=wall * 1000,
            frames=track.frames,
            source_width=source.width,
            source_height=source.height,
            target=params.target,
        )
        settings = actual_settings(
            self.provider_id,
            self.methods[params.method],
            self.dtype_name,
            self.options.tile_pixels,
            ref=ref,
            asset=asset,
            source=source,
            geometry=geometry,
            params=params,
            track=track,
            size=size,
            sha256=sha256,
        )
        settings["upscale"]["timing"] = {
            "wall_seconds": round(wall, 3),
            "model_seconds": round(model_seconds, 3),
            "method": "host_monotonic_with_per_frame_copy_back",
        }
        settings["upscale"]["memory"] = {
            "torch_allocated_peak_bytes": allocator.peak_allocated if allocator.available else None,
            "torch_reserved_peak_bytes": allocator.peak_reserved if allocator.available else None,
            "scope": "process_torch_caching_allocator",
            "reason": allocator.reason,
            "tiles_per_frame": tiles,
        }
        value = {
            "asset_id": new_id(),
            "kind": "final",
            "file": ctx.file_ref(result),
            "source_latent": (asset or {}).get("source_latent"),
            "frame_count": track.frames,
            "fps": {"num": source.fps.numerator, "den": source.fps.denominator},
            "width": geometry.output_width,
            "height": geometry.output_height,
            "complete": True,
            "actual_settings": settings,
        }
        contracts.validate("Asset", value, code="RUNTIME_ERROR", what="輸出 asset")
        ctx.set_output("asset", value, type_id=ASSET)
        rec.log(
            "info", "超分完成", frames=track.frames, size=[geometry.output_width, geometry.output_height], wall_s=wall
        )

    def _encode(
        self, ctx: RunContext, source: Any, geometry: plan.Geometry, params: plan.UpscaleParams, track_path: Path
    ) -> tuple[Any, float, int]:
        """Decode → model → resize → encode, one frame at a time → (EncodedTrack, model seconds, tiles per frame)."""
        import torch
        from phasyn_media.encode import StreamingVideoEncoder

        from .model import from_uint8, resize_to, to_uint8
        from .video import FrameReader

        model_seconds = 0.0
        tiles = 0
        encoder = StreamingVideoEncoder(
            track_path,
            width=geometry.output_width,
            height=geometry.output_height,
            fps_num=source.fps.numerator,
            fps_den=source.fps.denominator,
            codec="h264",
            pixel_format="yuv420p",
            quality=params.crf,
            provider="cpu_ffmpeg",
            cancel=ctx.cancel_token,
            expected_frames=source.frames,
        )
        rec = ctx.recorder
        with FrameReader(source, cancel=ctx.cancel_token) as reader, encoder, torch.inference_mode():
            with rec.phase("upscale", part=PART):
                for frame in reader.frames():
                    ctx.check_cancelled()
                    t0 = time.perf_counter()
                    doubled, tiles = self.models[params.method].upscale_frame(
                        from_uint8(frame, self.device, self.dtype), self.options.tile_pixels
                    )
                    pixels = to_uint8(resize_to(doubled, geometry.output_width, geometry.output_height))
                    del doubled
                    model_seconds += time.perf_counter() - t0
                    encoder.write_chunk(pixels)
            with rec.phase("encode"):
                track = encoder.finish()
        return track, model_seconds, tiles

    def _finish_file(
        self, ctx: RunContext, source: Any, track: Any, track_path: Path, final_path: Path
    ) -> tuple[str, int]:
        from .video import attach_audio

        if source.audio is None:
            track_path.replace(final_path)
            return str(track.sha256), int(track.size_bytes)
        with ctx.recorder.phase("mux"):
            return attach_audio(track_path, source, final_path, frames=track.frames, cancel=ctx.cancel_token)


__all__ = ["UpscaleProvider"]
