"""decode_video: VideoVAE decode streamed chunk-by-chunk into the frozen delivery.

Upstream recipe (``S/stages/decoding.py:425-535``): reverse-normalize, decode
in the profile's precision, ``decode_base(..., on_frames=…)`` which hands every
final frame exactly once and in order (``klvae.py:666-781``),
``processor.revert_tensor`` clamp to [0,1], crop to the target canvas,
``(x*255).clamp(0,255).to(uint8)`` (``runtime/entrypoints/utils.py:552``).

Precision (``components.video_vae.compute_dtype``, policy.py): ``native``/``fp32``
decode without autocast with FP32 decoder weights (official precision, exact;
``component_precisions={"video_vae": "fp32"}`` keeps the loader from rounding
them, vae_loader.py:267-311); ``fp16`` is the pinned pipeline recipe — decoder
linears held in FP16, FP16 autocast (approximate profiles only).  The resolved
SGLang decode dtype must equal the policy's or the stage fails.

Weight streaming (``provider_options.weight_streaming``, opt-in): when the loader
built a streaming shell (``vae_weight_streaming.streaming_state``), the decode runs
inside ``weight_streaming_scope`` (the decoder blocks stream through device slots,
layer-major over the tiles of a clip; same values) with the early release of each
clip's output; tile batching stays off.  Every other video VAE takes the path above
unchanged.

The encoder is resolved *before* the VAE is loaded: ``auto_validated`` goes
through ``phasyn_media.capabilities.route_codec`` with this node's FFmpeg encoders
and this actor's own GPU; the decision is recorded (requested/effective).

Delivery (frozen by ``output.frame_delivery``):

* ``local_encode`` — chunks flow through ``phasyn_media.encode.StreamingVideoEncoder``
  (bounded queue ≤ 4 chunks); output ``video_track``;
* ``materialized_chunks`` — chunks are written straight to disk as U8
  ``[F,H,W,3]`` tensors of one safetensors payload; output ``frames``
  (``decoded_frames`` bundle).

Cancel is checked between chunks; any failure aborts the encoder / payload.
"""

from __future__ import annotations

import contextlib
import os
import time
from pathlib import Path
from typing import Any

from phasyn_h3.recipe.abi import media_types
from phasyn_h3.recipe.abi.stage import OutputFile, StageResult

from .. import SGLANG_SOURCE_REVISION
from ..bundles import (
    SafetensorsStreamWriter,
    TensorDecl,
    finalize_tensor_bundle,
    load_bundle_manifest,
    payload_metadata,
    read_bundle_metadata,
    resolve_payload,
)
from ..errors import InvalidStageInput, UnsupportedCombination
from ..measure import video_vae_decode_flop
from .common import StageRun, requested
from .normalization import ensure_vae_arch, normalization_digest
from .tensor_io import load_tensors
from .vae_fp32_accel import DEFAULT_TILE_BATCH, STRICT_FP32_CONV, choose_tile_batch, fp32_decode_scope
from .vae_streaming import streaming_decode_scope
from .vae_weight_streaming import streaming_state, weight_streaming_scope


def load_target_latents(run: StageRun, name: str) -> tuple[Any, dict[str, Any]]:
    item = run.require_input("target_latents")
    manifest = load_bundle_manifest(Path(item.path))
    if manifest["normalization_config_digest"] != normalization_digest(run.plan):
        raise InvalidStageInput("LATENT_NORMALIZATION", "target_latents 的 normalization_config_digest 與本環境不符")
    payload = resolve_payload(manifest, run.ctx.attachments)
    meta = read_bundle_metadata(payload, manifest)
    return load_tensors(payload, [name])[name], meta


def _gpu_entry(run: StageRun) -> dict[str, Any] | None:
    """This actor's own GPU for NVENC rules (the actor only sees this device)."""
    device = run.ctx.device
    uuid = device.get("device_uuid")
    if device.get("device_index") is None or not str(uuid or "").startswith("GPU-"):
        return None
    sm = run.provider.backend.facts().sm
    return {
        "index": 0 if os.environ.get("PHASYN_ACTOR_CUDA_NARROWED") == "1" else int(device["device_index"]),
        "uuid": str(uuid),
        "sm": f"{sm[0]}.{sm[1]}" if sm else None,
        "kind": "cuda",
    }


def resolve_encode_provider(run: StageRun) -> tuple[str, dict[str, Any]]:
    """Concrete encoder for ``local_encode``: (provider, decision facts).

    An explicit ``cpu_ffmpeg``/``nvenc`` request is honoured as is (the encoder
    validates it); ``auto_validated`` is routed by ``route_codec`` over the
    encoders compiled into this node's FFmpeg — a documented NVENC entry is
    probed (one tiny encode on this GPU) only when no CPU encoder can serve.
    """
    output = requested(run.plan).get("output") or {}
    provider = str(output.get("encode_provider", "auto_validated"))
    if provider != "auto_validated":
        return provider, {"requested_provider": provider, "provider": provider, "reason_code": "EXPLICIT"}
    from phasyn_media.capabilities import detect_encoder_capabilities, route_codec

    codec = str(output.get("video_codec", "h264"))
    gpu = _gpu_entry(run)
    gpus = [gpu] if gpu is not None else []

    def route(probe: bool) -> Any:
        caps = detect_encoder_capabilities(gpus, probe=probe, codecs=[codec])
        return route_codec(
            codec=codec,
            pixel_format=str(output.get("pixel_format", "yuv420p")),
            container=str(output.get("container", "mp4")),
            audio_codec=str(output.get("audio_codec", "aac")),
            provider=provider,
            device=gpu,
            capabilities=caps,
        )

    decision = route(probe=False)
    if not decision.allowed and gpu is not None:
        decision = route(probe=True)  # only a probe-validated NVENC may serve auto_validated
    if not decision.allowed or decision.provider not in ("cpu_ffmpeg", "nvenc"):
        raise UnsupportedCombination(
            "ENCODE_PROVIDER_UNRESOLVED",
            f"auto_validated 沒有可用的 encoder：{decision.reason}",
            field_path="output.encode_provider",
            actual=decision.reason_code,
        )
    return str(decision.provider), decision.as_dict()


class _ChunkSink:
    """Materialized U8 chunks: one payload, tensors written as chunks arrive."""

    def __init__(
        self, run: StageRun, *, frames: int, height: int, width: int, chunk: int, metadata: dict[str, Any]
    ) -> None:
        self.run, self.height, self.width = run, height, width
        sizes = [chunk] * (frames // chunk) + ([frames % chunk] if frames % chunk else [])
        self.decls = [TensorDecl(f"chunk_{i:05d}", "U8", (n, height, width, 3), "F,H,W,C") for i, n in enumerate(sizes)]
        self.metadata = {**metadata, "chunk_frames": chunk, "chunks": len(sizes)}
        self.path = run.output_dir / "frames.payload.safetensors"
        self.writer = SafetensorsStreamWriter(self.path, self.decls, metadata=payload_metadata(self.metadata))
        self.index = 0
        self.pending = 0

    def write(self, frames_u8: Any) -> None:
        view = memoryview(frames_u8.reshape(-1))
        per_frame = self.height * self.width * 3
        offset = 0
        total = len(view)
        while offset < total:
            decl = self.decls[self.index]
            want = decl.shape[0] * per_frame - self.pending
            take = min(want, total - offset)
            self.writer.write(decl.name, view[offset : offset + take])
            offset += take
            self.pending += take
            if self.pending == decl.shape[0] * per_frame:
                self.index += 1
                self.pending = 0

    def finish(self) -> list[OutputFile]:
        self.writer.close()
        outputs, _ = finalize_tensor_bundle(
            self.run.output_dir,
            "frames",
            self.path,
            self.decls,
            kind="decoded_frames",
            identity=self.run.bundle_identity(normalization_digest(self.run.plan)),
            metadata=self.metadata,
        )
        return outputs

    def abort(self) -> None:
        self.writer.abort()


class _EncoderSink:
    def __init__(self, run: StageRun, width: int, height: int, route: tuple[str, dict[str, Any]]):
        from phasyn_media.encode import StreamingVideoEncoder

        output = requested(run.plan).get("output") or {}
        geometry = run.geometry
        provider, decision = route
        self.path = run.output_dir / "video_track.mp4"
        self.encoder = StreamingVideoEncoder(
            self.path,
            width=width,
            height=height,
            fps_num=int(geometry.get("fps_numerator", 24)),
            fps_den=int(geometry.get("fps_denominator", 1)),
            codec=str(output.get("video_codec", "h264")),
            pixel_format=str(output.get("pixel_format", "yuv420p")),
            quality=int(output.get("quality", 18)),
            provider=provider,
            gpu_uuid=decision.get("device_uuid") if provider == "nvenc" else None,
            gpu_index=run.ctx.device.get("device_index") if provider == "nvenc" else None,
            max_queue_chunks=4,
            cancel=run.ctx.cancel,
        )
        self.encoder.__enter__()
        self.track: Any = None

    def write(self, frames_u8: Any) -> None:
        self.encoder.write_chunk(frames_u8)

    def finish(self) -> list[OutputFile]:
        self.track = self.encoder.finish()
        self.encoder.__exit__(None, None, None)
        return [OutputFile(name="video_track", path=self.path, media_type=media_types.VIDEO_TRACK, kind="media")]

    def abort(self) -> None:
        try:
            self.encoder.abort()
        finally:
            self.encoder.__exit__(None, None, None)


def run(run: StageRun) -> StageResult:
    import torch
    from sglang.multimodal_gen.runtime.managers.forward_context import set_forward_context
    from sglang.multimodal_gen.runtime.models.vaes.fast_path_gate import use_vae_fast_path
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.stages.decoding import (
        _reverse_normalize_latents,
    )
    from sglang.multimodal_gen.runtime.utils.precision import (
        autocast_context,
        autocast_enabled_for_device,
        resolve_decode_precision,
    )

    geometry = run.geometry
    width, height = int(geometry["width"]), int(geometry["height"])
    frames_expected = int(geometry["generated_frames"])
    delivery = str((requested(run.plan).get("output") or {}).get("frame_delivery", "local_encode"))
    if delivery not in ("local_encode", "materialized_chunks"):
        raise InvalidStageInput("FRAME_DELIVERY", f"未知 frame_delivery {delivery}")
    latent, _meta = load_target_latents(run, "video_latent")
    if list(latent.shape) != list(geometry["video_latent_shape"]):
        raise InvalidStageInput(
            "VIDEO_LATENT_SHAPE", f"video_latent {list(latent.shape)} ≠ geometry {geometry['video_latent_shape']}"
        )
    # before the VAE is loaded: a missing encoder must not cost a 10 GiB load
    route = resolve_encode_provider(run) if delivery == "local_encode" else None
    if route is not None:
        run.fact("ENCODE_ROUTE", route[1])
    precision = str(run.policy.components["video_vae"].compute_dtype)
    want_dtype = torch.float32 if precision == "fp32" else torch.float16
    counted = {"frames": 0, "chunks": 0}
    timings: dict[str, Any] = {}
    sink: Any = None
    with run.provider.use_component(run, "video_vae") as vae:
        server_args = run.provider.server_args()
        arch = ensure_vae_arch(run.plan, "video_vae", server_args.pipeline_config.vae_config)
        tile, overlap = int(run.policy.vae.get("spatial_tile", 256)), int(run.policy.vae.get("spatial_overlap", 64))
        if (tile, overlap) != (int(arch.vae_tile_size), int(arch.vae_tile_overlap_min)):
            raise UnsupportedCombination(
                "VAE_TILE_OVERRIDE_NOT_WIRED",
                f"profile tile {tile}/{overlap} ≠ checkpoint VAE 設定 "
                f"{arch.vae_tile_size}/{arch.vae_tile_overlap_min}；shim 未接入覆寫",
                field_path="vae.spatial_tile",
            )
        device = run.provider.torch_device()
        z = _reverse_normalize_latents(
            latent.to(device=device, dtype=torch.float32),
            mean_values=arch.latents_mean,
            std_values=arch.latents_std,
            name="video_vae",
        )
        dtype = resolve_decode_precision(server_args, "video_vae")
        if dtype != want_dtype:
            raise UnsupportedCombination(
                "VAE_DECODE_PRECISION_MISMATCH",
                f"SGLang 解析出的 video VAE decode dtype {dtype} ≠ profile 要求的 {precision}",
                field_path="components.video_vae.compute_dtype",
                expected=str(want_dtype),
                actual=str(dtype),
            )
        streamed = streaming_state(vae)  # None unless the loader built a weight-streaming shell (opt-in)
        if streamed is not None:
            streamed.check_precision(precision)
        enabled = autocast_enabled_for_device(z, dtype, server_args.disable_autocast)
        if precision == "fp16":
            if not enabled:
                raise UnsupportedCombination(
                    "VAE_FP16_AUTOCAST_UNAVAILABLE",
                    "fp16 解碼需要 CUDA FP16 autocast（裝置或 disable_autocast 不允許）",
                    field_path="components.video_vae.compute_dtype",
                )
            vae.prepare_decoder_autocast_weights(dtype)
        else:
            held = streamed.slot_linear_dtypes() if streamed is not None else _decoder_linear_dtypes(vae)
            if held != {torch.float32}:
                raise UnsupportedCombination(
                    "VAE_DECODER_WEIGHTS_NOT_FP32",
                    f"FP32 解碼要求 decoder linear 權重為 FP32，實際 {sorted(str(d) for d in held)}",
                    field_path="components.video_vae.compute_dtype",
                )
        tile_batch = 1
        if precision == "fp32" and streamed is None:
            # FP32 frame buffer _decode_temporal_streaming allocates after the first clip
            # (klvae.py:695-698): [1, 3, frames, latent_h * ratio, latent_w * ratio]
            ratio = int(vae.vae_ratio)
            output_bytes = 3 * frames_expected * int(z.shape[-2]) * ratio * int(z.shape[-1]) * ratio * 4
            tile_batch = choose_tile_batch(torch, device, requested=DEFAULT_TILE_BATCH, output_bytes=output_bytes)
        if delivery == "materialized_chunks":
            budget = int(run.policy.vae.get("max_frame_buffer_bytes", 512 * 1024 * 1024))
            chunk = max(1, min(frames_expected, budget // (width * height * 3)))
            sink = _ChunkSink(
                run,
                frames=frames_expected,
                height=height,
                width=width,
                chunk=chunk,
                metadata={"sglang": SGLANG_SOURCE_REVISION, "frames": frames_expected},
            )
        else:
            assert route is not None
            sink = _EncoderSink(run, width, height, route)

        def on_frames(chunk: Any) -> None:
            run.check_cancel()  # safe boundary: between chunks
            frames = vae.processor.revert_tensor(chunk)  # [1,3,t,H',W'] in [0,1]
            frames = frames[..., :height, :width]
            u8 = (frames[0] * 255).clamp(0, 255).to(torch.uint8).permute(1, 2, 3, 0).contiguous().cpu().numpy()
            sink.write(u8)
            counted["frames"] += int(u8.shape[0])
            counted["chunks"] += 1
            run.progress("vae_decode", "frames", counted["frames"], frames_expected)

        # FP32: tiles decoded tile_batch at a time, bit-identical (vae_fp32_accel.py)
        fp32_scope: contextlib.AbstractContextManager[dict[str, Any]] = (
            fp32_decode_scope(vae, tile_batch=tile_batch, w2_per_tile=True, strict_fp32_conv=STRICT_FP32_CONV)
            if precision == "fp32"
            else contextlib.nullcontext({})
        )
        # weight streaming: blocks through device slots, layer-major over a clip's tiles (vae_weight_streaming.py)
        stream_scope: contextlib.AbstractContextManager[dict[str, Any] | None] = (
            weight_streaming_scope(vae, device=device, precision=precision)
            if streamed is not None
            else contextlib.nullcontext(None)
        )
        # ETA work before the decode, so an out-of-memory failure still reports its size
        run.cost(
            "decode_video",
            work=frames_expected * width * height,
            unit="pixel_frame",
            frames=frames_expected,
            width=width,
            height=height,
        )
        try:
            started = time.perf_counter()
            with (
                torch.inference_mode(),
                autocast_context(dtype, server_args.disable_autocast, enabled=enabled)
                if precision == "fp16"
                else contextlib.nullcontext(),
                use_vae_fast_path(vae, False),  # exact path: no lossless/high fast path
                set_forward_context(current_timestep=0, attn_metadata=None),
                fp32_scope as accel,
                stream_scope as weight_streaming,
                streaming_decode_scope(vae, release_clip_outputs=streamed is not None) as streaming,
            ):
                decoded = vae.decode_base(z, on_frames=on_frames)
            timings["streaming"] = streaming
            timings["fp32_accel"] = {**accel, "tile_batch_requested": DEFAULT_TILE_BATCH} if accel else None
            if weight_streaming is not None:
                timings["weight_streaming"] = weight_streaming
            if z.is_cuda:
                torch.cuda.synchronize(z.device)
            timings["decode_seconds"] = round(time.perf_counter() - started, 6)
            run.cost_seconds("decode_video", timings["decode_seconds"])
            if z.is_cuda:
                timings["peak_allocated_bytes"] = int(torch.cuda.max_memory_allocated(z.device))
            del decoded
            if counted["frames"] != frames_expected:
                raise InvalidStageInput(
                    "FRAME_COUNT_MISMATCH", f"decode 產出 {counted['frames']} frames，plan 預期 {frames_expected}"
                )
            run.outputs.extend(sink.finish())
            sink = None
        finally:
            if sink is not None:
                sink.abort()
    run.measure(
        compute_seconds=timings.get("decode_seconds"),
        flop=video_vae_decode_flop(frames_expected, height, width),
        frames=counted["frames"],
        chunks=counted["chunks"],
    )
    run.fact(
        "VIDEO_DECODE",
        {
            "frames": counted["frames"],
            "chunks": counted["chunks"],
            "delivery": delivery,
            "decode_precision_requested": precision,
            "decode_dtype": str(dtype),
            "autocast": bool(precision == "fp16"),
            "tile": {"spatial_tile": tile, "spatial_overlap": overlap},
            "encoder": None if route is None else route[0],
            **timings,
        },
    )
    return run.result()


def _decoder_linear_dtypes(vae: Any) -> set[Any]:
    """dtypes of the decoder-block linears the fp16 recipe would round."""
    out = set()
    for block in getattr(getattr(vae, "decoder", None), "transformer_blocks", None) or []:
        for linear in (block.attn.to_qkv, block.attn.to_out, block.ff.w1, block.ff.w2):
            out.add(linear.weight.dtype)
    return out


__all__ = ["load_target_latents", "resolve_encode_provider", "run"]
