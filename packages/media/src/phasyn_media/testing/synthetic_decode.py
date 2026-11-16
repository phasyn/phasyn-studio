"""``test.synthetic_decode``: decodes ``test.synthetic_latent`` into a real MP4 (a test fixture).

CPU only and ``synthetic=true``: the latent's first three channels become RGB after ``tanh``; a
preview keeps every frame, the FPS and the aspect ratio and is only downsized after RGB; frames are
fed through the bounded :class:`~phasyn_media.encode.StreamingVideoEncoder` queue. Registered only
when test providers are enabled (see :mod:`phasyn_components.testing`).
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Port,
    RunContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording
from phasyn_components.testing.synthetic import LATENT_SPACE, SPATIAL, node_id_of, read_latent_input

from ..encode import StreamingVideoEncoder
from ..errors import MediaError

DECODE_OPTIONS: dict[str, dict[str, Any]] = {
    "output_kind": {"enum": ["preview", "final"], "default": "final"},
    "preview_scale": {"type": "number", "exclusiveMinimum": 0, "maximum": 1, "default": 0.5},
    "frame_batch": {"type": "integer", "minimum": 1, "maximum": 256, "default": 8},
    "frame_queue": {"type": "integer", "minimum": 1, "maximum": 4, "default": 4},
    "codec": {"enum": ["h264", "hevc", "av1"], "default": "h264"},
    "crf": {"type": "integer", "minimum": 1, "maximum": 51},
    "preset": {"type": "string"},
    "encode_provider": {"enum": ["cpu_ffmpeg", "nvenc"], "default": "cpu_ffmpeg"},
    "simulated_frame_ms": {"type": "number", "minimum": 0, "maximum": 10000, "default": 0},
}


class SyntheticDecodeProvider(BaseProvider):
    provider_id = "test.synthetic_decode"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        options = ((settings or {}).get("load") or {}).get("provider_options") or {}
        kind = "decode.preview" if options.get("output_kind") == "preview" else "decode.final"
        return Description(
            provider_id=cls.provider_id,
            kind=kind,
            label="合成 latent 解碼器（test fixture；只讀 test.synthetic-rgbdiv8.v1）",
            inputs=[Port("latent", "video.final-latent.v1", True, "file", "final latent manifest（附 blob）")],
            outputs=[Port("asset", "media.asset.v1", True, "inline", "完整 MP4 Asset（complete 後才回報）")],
            settings_schema=settings_schema(provider_options=DECODE_OPTIONS, device_kinds=("cpu",)),
            parameters_schema={"type": "object", "properties": {}, "additionalProperties": False},
            default_settings={
                "load": {
                    "device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-fixture"},
                    "provider_options": {"output_kind": "final"},
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            synthetic=True,
        )

    def load(self, ctx: LoadContext) -> LoadResult:
        options: dict[str, Any] = {k: v.get("default") for k, v in DECODE_OPTIONS.items() if "default" in v}
        options.update(ctx.load.get("provider_options") or {})
        self.options: dict[str, Any] = options
        effective = dict(ctx.load)
        effective["provider_options"] = options
        return LoadResult(
            effective_load=effective,
            observed={"decoder": "synthetic", "streaming": True},
            model_identity={"model": LATENT_SPACE, "identity_strength": "builtin", "synthetic": True},
            runtime_identity={"provider_id": self.provider_id},
        )

    def invoke(self, ctx: RunContext) -> None:
        rec = ctx.recorder
        opts = self.options
        manifest, _manifest_sha, blob_path, latent_ref = read_latent_input(ctx)
        if manifest.get("latent_space_id") != LATENT_SPACE:
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                f"此解碼器只接受 {LATENT_SPACE}，收到 {manifest.get('latent_space_id')}（不猜 normalization、不 reshape）",
            )
        tensor = manifest["tensor"]
        target = manifest["target"]
        if tensor.get("layout") != "BCTHW" or tensor.get("dtype") != "F16":
            raise ComponentError("LATENT_MISMATCH", "合成 latent 需要 BCTHW／F16")
        b, c, t, h, w = (int(x) for x in tensor["shape"])
        if (
            b != 1
            or t != int(target["frames"])
            or h * SPATIAL != int(target["height"])
            or w * SPATIAL != int(target["width"])
        ):
            raise ComponentError("LATENT_MISMATCH", "latent shape 與 target 幾何不一致")
        expected = b * c * t * h * w * 2
        if blob_path.stat().st_size != expected:
            raise ComponentError("FILE_TRUNCATED", f"latent blob 大小 {blob_path.stat().st_size} ≠ 預期 {expected}")
        latent = np.memmap(blob_path, dtype="<f2", mode="r", shape=(b, c, t, h, w))
        fps = target["fps"]
        width, height = int(target["width"]), int(target["height"])
        if opts["output_kind"] == "preview":
            scale = float(opts["preview_scale"])
            width = max(2, round(width * scale / 2) * 2)
            height = max(2, round(height * scale / 2) * 2)
        out = ctx.new_file(
            None, "video/mp4", {"kind": opts["output_kind"], "synthetic": True}, type_id="media.video.v1"
        )
        tmp = ctx.work_dir / f"{out.file_id}.mp4"
        encoder = StreamingVideoEncoder(
            tmp,
            width=width,
            height=height,
            fps_num=int(fps["num"]),
            fps_den=int(fps["den"]),
            codec=opts["codec"],
            quality=int(opts.get("crf") or (23 if opts["output_kind"] == "preview" else 18)),
            preset=opts.get("preset") or ("veryfast" if opts["output_kind"] == "preview" else "medium"),
            max_queue_chunks=int(opts["frame_queue"]),
            cancel=ctx.cancel_token,
            expected_frames=t,
        )
        rec.declare("decode_forward_count", "output_frame_count", "frame_callback_count")
        backpressure_ms = 0.0
        batch = int(opts["frame_batch"])
        sim_ms = float(opts.get("simulated_frame_ms") or 0)
        try:
            for start in range(0, t, batch):
                ctx.check_cancelled()
                stop = min(t, start + batch)
                with rec.span("decode.chunk", part="synthetic.decoder", step_index=start // batch):
                    chunk = np.asarray(latent[0, :3, start:stop], dtype=np.float32)  # [3,F,h,w]
                    rgb = np.clip((np.tanh(chunk) * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
                    rgb = np.repeat(np.repeat(rgb, SPATIAL, axis=2), SPATIAL, axis=3)  # [3,F,H,W]
                    frames = np.ascontiguousarray(np.transpose(rgb, (1, 2, 3, 0)))  # [F,H,W,3]
                    if (frames.shape[1], frames.shape[2]) != (height, width):
                        ys = (np.arange(height) * frames.shape[1] // height).astype(np.int64)
                        xs = (np.arange(width) * frames.shape[2] // width).astype(np.int64)
                        frames = np.ascontiguousarray(frames[:, ys][:, :, xs])  # RGB 之後等比縮小，不改 latent 網格
                    if sim_ms:
                        time.sleep(sim_ms * frames.shape[0] / 1000)
                rec.count("decode_forward_count")
                rec.count("frame_callback_count")
                t0 = time.perf_counter_ns()
                encoder.write_chunk(frames)
                backpressure_ms += (time.perf_counter_ns() - t0) / 1e6
                rec.count("output_frame_count", frames.shape[0])
            with rec.phase("encode"):
                track = encoder.finish()
        except MediaError as exc:
            encoder.abort()
            if exc.code == "CANCELLED":
                raise
            raise ComponentError("MEDIA_INCOMPLETE", f"編碼失敗：{exc.message}") from exc
        except BaseException:
            encoder.abort()
            raise
        rec.set_metric("encoder_backpressure_ms", backpressure_ms, method="host_monotonic_write_block")
        rec.set_metric(
            "output_buffer_bytes",
            width * height * 3 * batch * (int(opts["frame_queue"]) + 1),
            quality="derived",
            method="queue_bound_x_chunk_bytes",
            reason=None,
        )
        if track.frames != t:
            raise ComponentError("MEDIA_INCOMPLETE", f"編碼後 frame 數 {track.frames} ≠ latent frames {t}")
        out.adopt_file(Path(track.path), sha256=track.sha256, size=track.size_bytes)
        file_ref = {
            "node_id": node_id_of(ctx),
            "file_id": out.file_id,
            "size_bytes": track.size_bytes,
            "sha256": track.sha256,
            "media_type": "video/mp4",
            "metadata": out.metadata,
        }
        ctx.set_output(
            "asset",
            {
                "asset_id": new_id(),
                "kind": opts["output_kind"],
                "file": file_ref,
                "source_latent": latent_ref,
                "frame_count": track.frames,
                "fps": {"num": int(fps["num"]), "den": int(fps["den"])},
                "width": width,
                "height": height,
                "complete": True,
                "actual_settings": {
                    "codec": track.codec,
                    "pixel_format": track.pixel_format,
                    "encode_provider": track.provider,
                    "frame_queue": int(opts["frame_queue"]),
                    "frame_batch": batch,
                    "preview_scale": opts.get("preview_scale"),
                    "synthetic": True,
                },
            },
        )


__all__ = ["DECODE_OPTIONS", "SyntheticDecodeProvider"]
