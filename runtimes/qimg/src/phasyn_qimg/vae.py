# SPDX-License-Identifier: Apache-2.0
# Portions adapted from diffusers 578c9b2 (src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py,
# _encode_vae_image and the decode path of __call__; src/diffusers/image_processor.py,
# VaeImageProcessor.preprocess/postprocess), Copyright 2026 Qwen-Image Team, The HuggingFace Team and
# Copyright 2026 The HuggingFace Team; modified by the Phasyn Studio authors (split into encode-only and
# decode-only providers working on bundles; the packed latent layout lives in latents.py).
"""``qimg.vae_encode``/``qimg.vae_decode``: the Qwen-Image 2.1 VAE (AutoencoderKLQwenImage21, z_dim 64, 16× spatial).

The numeric path follows ``QwenImage21Pipeline`` line by line:

* encode: RGBA uint8 → the float32 [-1, 1] of ``VaeImageProcessor.preprocess`` (``/255`` → NCHW → ``2x-1``) →
  (1,4,1,H,W) → cast to the VAE dtype → ``vae.encode(...).latent_dist.mode()`` (argmax, no sampling) →
  ``(z - latents_mean) / latents_std`` → ``_pack_latents`` (flatten space, (1,HW/256,z)); several references are
  concatenated along the sequence dimension in order.
* decode: ``_unpack_latents`` → cast to the VAE dtype → ``z * std + mean`` → ``vae.decode`` frame 0 →
  ``VaeImageProcessor.postprocess`` (``(x*0.5+0.5).clamp(0,1)`` in the decode dtype → float32 → ``(x*255).round()``).

Each component keeps only the half it needs (encode drops decoder + post_quant_conv, decode drops encoder +
quant_conv; neither uses the other, so the numbers are unchanged). Tiling is an explicit parameter, never
switched by size; tile sizes use the diffusers defaults and are recorded.
"""

from __future__ import annotations

import contextlib
import io
import json
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, ClassVar

from phasyn_components import upstream
from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.model_identity import model_identity
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Part,
    Port,
    RunContext,
    UnloadContext,
)
from phasyn_components.timeutil import mono_ns
from phasyn_components.weights import WeightPlan

from . import (
    KIND_LATENT,
    KIND_PREPARED,
    KIND_REF_LATENTS,
    TYPE_IMAGE_ASSET,
    TYPE_LATENT,
    TYPE_PREPARED,
    TYPE_REF_LATENTS,
    VAE_SCALE_FACTOR,
)
from .config import (
    QIMG_LIBRARIES,
    RESEARCH_USE_NOTE,
    build_settings_schema,
    check_load,
    check_output_size,
    compute_dtype_name,
    default_settings,
    model_dir,
    model_problem,
    model_root,
    parameters_schema,
    resolve_params,
    runtime_problem,
)
from .instrument import (
    CallMemory,
    HostResidency,
    allocator_window,
    check_vram,
    drop_frame_locals,
    dtype_census,
    finish_allocator,
    module_bytes,
    timed_stage,
)
from .latents import pack_latents, unpack_latents

if TYPE_CHECKING:  # pragma: no cover
    import numpy as np
    import torch

ASSET_INLINE_BUDGET = 200 * 1024


# ----------------------------------------------------------------------------- pure numerics
def vae_input(rgba: np.ndarray) -> torch.Tensor:
    """``VaeImageProcessor.preprocess``（PIL RGBA，已是目標尺寸）的數值＋pipeline 的 ``unsqueeze(2)``。"""
    import numpy as np
    import torch

    if rgba.dtype != np.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ComponentError("LATENT_MISMATCH", f"參考圖必須是 uint8 HWC RGBA（收到 {rgba.dtype} {list(rgba.shape)}）")
    images = np.stack([rgba.astype(np.float32) / 255.0], axis=0)  # pil_to_numpy
    tensor = torch.from_numpy(images.transpose(0, 3, 1, 2))  # numpy_to_pt
    return (2.0 * tensor - 1.0).unsqueeze(2)  # normalize → (1, 4, 1, H, W)


def _latent_stats(vae: Any, like: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    import torch

    z_dim = int(vae.config.z_dim)
    mean = torch.tensor(vae.config.latents_mean).view(1, z_dim, 1, 1, 1).to(like.device, like.dtype)
    std = torch.tensor(vae.config.latents_std).view(1, z_dim, 1, 1, 1).to(like.device, like.dtype)
    return mean, std


def encode_reference(vae: Any, rgba: np.ndarray, *, device: Any, dtype: Any) -> torch.Tensor:
    """一張 RGBA → 正規化後的 latent (1, z, 1, H/16, W/16)（pipeline ``_encode_vae_image``，argmax）。"""
    image = vae_input(rgba).to(device=device, dtype=dtype)
    latents = vae.encode(image).latent_dist.mode()
    mean, std = _latent_stats(vae, latents)
    return (latents - mean) / std


def decode_latents(vae: Any, packed: torch.Tensor, *, width: int, height: int, device: Any) -> np.ndarray:
    """packed latent（正規化空間）→ uint8 HWC（pipeline:828-842＋postprocess(output_type='pil') 的數值）。"""
    import numpy as np

    latents = unpack_latents(packed.to(device), width=width, height=height)
    latents = latents.to(vae.dtype)
    mean, std = _latent_stats(vae, latents)
    latents = latents * std + mean
    image = vae.decode(latents, return_dict=False)[0][:, :, 0]
    image = (image * 0.5 + 0.5).clamp(0, 1)  # VaeImageProcessor.denormalize（在解碼 dtype 上）
    array = image.cpu().permute(0, 2, 3, 1).float().numpy()  # pt_to_numpy
    return np.asarray((array * 255).round().astype("uint8")[0])  # numpy_to_pil 的數值


def encode_png(array: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(array).save(buf, format="PNG")
    return buf.getvalue()


def tiling_info(vae: Any) -> dict[str, int]:
    return {
        "tile_sample_min_height": int(vae.tile_sample_min_height),
        "tile_sample_min_width": int(vae.tile_sample_min_width),
        "tile_sample_stride_height": int(vae.tile_sample_stride_height),
        "tile_sample_stride_width": int(vae.tile_sample_stride_width),
    }


def set_tiling(vae: Any, enabled: bool) -> None:
    if enabled:
        vae.enable_tiling()  # diffusers defaults (tile 256, stride 192), kept unchanged
    else:
        vae.disable_tiling()


# ----------------------------------------------------------------------------- providers
class _VaeProvider(BaseProvider):
    role: ClassVar[str] = ""
    scope: ClassVar[str] = ""
    part: ClassVar[str] = ""
    # allocator reading at the start of the current call's GPU work (None: no GPU work yet in this call)
    _call_memory: CallMemory | None = None

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """The pinned Qwen-Image 2.1 directory this provider reads."""
        from .weights import image_plan

        return image_plan(cls.role, settings)

    @classmethod
    def _availability(cls, settings: Mapping[str, Any] | None) -> tuple[bool, str | None, str | None]:
        reason = runtime_problem(cls.role)
        code = "PROVIDER_NOT_INSTALLED" if reason else None
        if reason is None and settings is not None:
            reason = model_problem(cls.role, settings)
            code = "COMPONENT_NOT_CONFIGURED" if reason else None
        available = reason is None or (settings is None and code != "PROVIDER_NOT_INSTALLED")
        return available, code, reason

    def load(self, ctx: LoadContext) -> LoadResult:
        import torch
        from diffusers import AutoencoderKLQwenImage21
        from phasyn_components.recorder.gpu import runtime_identity, torch_backend_flags

        load = ctx.load
        offload = check_load(self.role, load)
        missing = runtime_problem(self.role)
        if missing:
            raise ComponentError("PROVIDER_NOT_INSTALLED", missing)
        problem = model_problem(self.role, ctx.settings)
        if problem:
            raise ComponentError("COMPONENT_NOT_CONFIGURED", problem)
        base = model_dir(load)
        config = json.loads((base / "vae" / "config.json").read_text(encoding="utf-8"))
        if config.get("_class_name") != "AutoencoderKLQwenImage21":
            raise ComponentError(
                "MODEL_INCOMPATIBLE", f"vae 類別 {config.get('_class_name')} 不是 AutoencoderKLQwenImage21"
            )
        dtype_name = compute_dtype_name(load)
        self.dtype = torch.bfloat16 if dtype_name == "bf16" else torch.float32
        self.dtype_name = dtype_name
        self.cuda = (load.get("device") or {}).get("kind") == "cuda"
        self.device = torch.device("cuda", 0) if self.cuda else torch.device("cpu")
        window = allocator_window(self.cuda)
        with ctx.recorder.phase("load", part=self.part):
            vae = AutoencoderKLQwenImage21.from_pretrained(
                str(base / "vae"), local_files_only=True, torch_dtype=self.dtype, use_safetensors=True
            )
            vae.eval()
            full_bytes = module_bytes(vae)
            if self.scope == "encode_only":
                vae.decoder = None
                vae.post_quant_conv = None
            else:
                vae.encoder = None
                vae.quant_conv = None
            self.weight_bytes = module_bytes(vae)
            self.residency: HostResidency | None = None
            placement: dict[str, Any] = {"scope": self.scope, **offload}
            if self.cuda and offload["after_use"] == "keep":
                placement.update(
                    check_vram(self.device, self.weight_bytes, what="VAE 常駐", hint="請改用 after_use=host")
                )
                vae.to(self.device)
                placement["placement"] = "resident"
            elif self.cuda:
                self.residency = HostResidency(vae, device=self.device, pinned=bool(offload["pinned"]))
                placement["placement"] = (
                    "pinned host（每次呼叫搬上 GPU）" if offload["pinned"] else "host（每次呼叫搬上 GPU）"
                )
            else:
                placement["placement"] = "cpu"
        finish_allocator(ctx.recorder, window, scope="load", cuda=self.cuda)
        self.vae = vae
        self.identity = model_identity(model_root(load), {"vae": base / "vae"}, config_class=config.get("_class_name"))
        self.libraries = upstream.library_versions(QIMG_LIBRARIES, vcs=())
        self.calls = 0
        observed = {
            "parameter_dtypes": dtype_census(vae),
            "weight_bytes": self.weight_bytes,
            "full_vae_bytes": full_bytes,
            "z_dim": int(vae.config.z_dim),
            "placement": placement,
            "native_weight_dtype": "F32（diffusion_pytorch_model.safetensors）",
            "libraries": self.libraries,
            "diffusers_source": upstream.vcs_source("diffusers"),
            "tiling_defaults": tiling_info(vae),
        }
        if self.cuda:
            observed["backend_flags"] = torch_backend_flags()
        return LoadResult(
            effective_load={**load, "offload": offload},
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity=self.identity,
            # CPU 元件不初始化 CUDA（runtime_identity 會讀裝置屬性 → 建立 CUDA context）
            runtime_identity=runtime_identity() if self.cuda else {"torch": torch.__version__, "device": "cpu"},
        )

    def unload(self, ctx: UnloadContext) -> None:
        with contextlib.suppress(Exception):
            import torch

            self.residency = None
            del self.vae
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def after_failure(self, code: str) -> dict[str, Any] | None:
        """Runs after the host has cleared the failed call's frames: drop what the VAE itself still holds, move the
        weights back to the host and report whether the process is back at its allocation before the call."""
        self._discard_call_state()
        residency = getattr(self, "residency", None)
        if residency is not None and residency.on_device:
            with contextlib.suppress(Exception):
                residency.restore()
        memory, self._call_memory = self._call_memory, None
        if memory is not None:
            return memory.settle(code)
        with contextlib.suppress(Exception):
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        return None

    def _discard_call_state(self) -> None:
        """Drop the decoder/encoder feature cache diffusers keeps on the VAE module.

        ``_feat_map``/``_enc_feat_map`` hold activations of every causal conv during a decode/encode and are reset
        only when one finishes; after a failure in between (an OOM) they keep GiBs of device memory referenced, out of
        reach of frame clearing and ``empty_cache``, until the next call. ``clear_cache()`` is the reset diffusers
        itself runs at the start of every decode/encode, so the numbers of later calls do not change.
        """
        clear = getattr(getattr(self, "vae", None), "clear_cache", None)
        if callable(clear):
            with contextlib.suppress(Exception):
                clear()

    def _begin(self, ctx: RunContext) -> Any:
        ctx.recorder.set_metric(
            "qimg.warm_call", 1 if self.calls else 0, unit="bool", scope="process", method="runtime_hook"
        )
        self.calls += 1
        window = allocator_window(self.cuda)
        self._call_memory = CallMemory.start(self.device, window)
        if self.residency is not None:
            self.residency.to_device(ctx.recorder, part=self.part, what="VAE 搬上 GPU")
        return window

    def _end(self, ctx: RunContext, window: Any) -> None:
        if self.residency is not None:
            self.residency.release(ctx.recorder, part=self.part)
        finish_allocator(ctx.recorder, window, scope="invoke", cuda=self.cuda)

    def _settings_summary(self) -> dict[str, Any]:
        return {
            "compute_dtype": self.dtype_name,
            "device": str(self.device),
            "vae_identity": self.identity,
            "lib_versions": self.libraries,
        }


class VaeEncodeProvider(_VaeProvider):
    provider_id = "qimg.vae_encode"
    role = "vae_encode"
    scope = "encode_only"
    part = "vae.encoder"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        available, code, reason = cls._availability(settings)
        empty = {"type": "object", "properties": {}}
        return Description(
            provider_id=cls.provider_id,
            kind="image.reference_encode",
            label="Qwen-Image 2.1 參考圖 VAE encode（RGBA 4 通道、argmax、正規化＋攤平；只載入 encoder）",
            inputs=[Port("prepared", TYPE_PREPARED, True, "file", "qimg.prepare 的輸出（使用 ref_rgba_i）")],
            outputs=[
                Port(
                    "ref_latents",
                    TYPE_REF_LATENTS,
                    True,
                    "file",
                    "qimg bundle：ref_latents BF16 (1, Σ h·w, z)＋ref_offsets（每張參考圖在序列上的起點）",
                )
            ],
            parts=[
                Part(cls.part, "vae_encoder", empty, ["host_ms", "gpu_event_ms"], "partial", "以每張參考圖為單位量測")
            ],
            settings_schema=build_settings_schema(cls.role),
            parameters_schema=parameters_schema(cls.role),
            default_settings=default_settings(cls.role),
            available=available,
            unavailable_code=code,
            unavailable_reason=reason,
            notes=[RESEARCH_USE_NOTE],
        )

    def invoke(self, ctx: RunContext) -> None:
        import torch

        from .bundle import input_identity, read_bundle, write_bundle

        self._call_memory = None
        rec = ctx.recorder
        params = resolve_params(self.role, ctx.parameters)
        with rec.span("qimg.vae.read_prepared", part=self.part):
            prepared, tensors = read_bundle(ctx, "prepared", kind=KIND_PREPARED)
        refs = prepared.get("refs") or []
        if not refs:
            raise ComponentError("INVALID_ARGUMENT", "prepared 沒有參考圖")
        set_tiling(self.vae, bool(params["tiling"]))
        window = self._begin(ctx)
        latents: list[torch.Tensor] = []
        shapes: list[list[int]] = []
        timings: list[float | None] = []
        try:
            with torch.inference_mode():
                for ref in refs:
                    index = int(ref["index"])
                    rgba = tensors[f"ref_rgba_{index}"].numpy()
                    t0 = mono_ns()
                    with timed_stage(rec, "qimg.vae.encode", part=self.part, cuda=self.cuda):
                        encoded = encode_reference(self.vae, rgba, device=self.device, dtype=self.dtype)
                        packed = pack_latents(encoded).to("cpu")
                    timings.append((mono_ns() - t0) / 1e6)
                    _b, _c, _f, h, w = encoded.shape
                    width_i, height_i = (int(x) for x in ref["prepared_size"])
                    expected = [height_i // VAE_SCALE_FACTOR, width_i // VAE_SCALE_FACTOR]
                    if [int(h), int(w)] != expected:
                        raise ComponentError(
                            "RUNTIME_ERROR",
                            f"參考圖 {index} 的 latent 網格 {[h, w]} 與 prepared 尺寸推得的 {expected} 不同",
                        )
                    shapes.append([int(h), int(w)])
                    latents.append(packed)
                    ctx.check_cancelled()
        except BaseException as exc:
            # frame locals and the module's feature cache both hold device tensors of the failed encode;
            # drop them so the release in _end() can free that memory
            drop_frame_locals(exc)
            self._discard_call_state()
            raise
        finally:
            self._end(ctx, window)
        packed_all = torch.cat(latents, dim=1)
        cast = None
        if packed_all.dtype != torch.bfloat16:
            cast = f"{packed_all.dtype}→torch.bfloat16（DiT 以 BF16 相接）"
            packed_all = packed_all.to(torch.bfloat16)
        offsets = [0]
        for h, w in shapes:
            offsets.append(offsets[-1] + h * w)
        z_dim = int(self.vae.config.z_dim)
        meta = {
            "shapes": shapes,
            "img_shapes": [[1, h, w] for h, w in shapes],
            "offsets": offsets,
            "z_dim": z_dim,
            "dtype": "BF16",
            "cast": cast,
            "normalization": {
                "space": "qwen_image_2_1.vae.normalized",
                "latents_mean_sha256": _list_digest(self.vae.config.latents_mean),
                "latents_std_sha256": _list_digest(self.vae.config.latents_std),
                "mode": "argmax（latent_dist.mode()，不取樣）",
            },
            "tiling": bool(params["tiling"]),
            "tiling_params": tiling_info(self.vae) if params["tiling"] else None,
            "prepared": input_identity(ctx, "prepared"),
            "target": {"width": int(prepared["width"]), "height": int(prepared["height"])},
            "references": [
                {"index": int(r["index"]), "prepared_size": r["prepared_size"], "source_sha256": r.get("source_sha256")}
                for r in refs
            ],
            **self._settings_summary(),
        }
        rec.set_metric("output_frame_count", len(shapes), unit="count", scope="component_call", method="runtime_hook")
        out = {
            "ref_latents": packed_all,
            "ref_offsets": torch.tensor(offsets, dtype=torch.int64),
        }
        with rec.span("qimg.vae.write", part=self.part):
            write_bundle(ctx, "ref_latents", kind=KIND_REF_LATENTS, meta=meta, tensors=out)
        rec.log("info", "參考圖 VAE encode 完成", shapes=shapes, encode_ms=timings, tiling=bool(params["tiling"]))


def _list_digest(values: Any) -> str:
    from phasyn_components.canonical import sha256_hex

    return sha256_hex(canonical_json([float(v) for v in values]))


class VaeDecodeProvider(_VaeProvider):
    """``qimg.vae_decode``. ETA work (``cost.stages``): ``decode`` in ``pixel`` = output width x height."""

    provider_id = "qimg.vae_decode"
    role = "vae_decode"
    scope = "decode_only"
    part = "vae.decoder"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        available, code, reason = cls._availability(settings)
        empty = {"type": "object", "properties": {}}
        return Description(
            provider_id=cls.provider_id,
            kind="image.decode",
            label="Qwen-Image 2.1 VAE decode → RGBA PNG（full／tiled 明確選擇；只載入 decoder）",
            inputs=[Port("latent", TYPE_LATENT, True, "file", "qimg.dit 的最終 latent（正規化空間，packed）")],
            outputs=[
                Port(
                    "image",
                    TYPE_IMAGE_ASSET,
                    True,
                    "inline",
                    "ImageAsset（file＝RGBA PNG；actual_settings 帶 latent 的 seed／steps／sigmas 與 VAE 身分）",
                )
            ],
            parts=[Part(cls.part, "vae_decoder", empty, ["host_ms", "gpu_event_ms"], "partial", "以整次 decode 量測")],
            settings_schema=build_settings_schema(cls.role),
            parameters_schema=parameters_schema(cls.role),
            default_settings=default_settings(cls.role),
            available=available,
            unavailable_code=code,
            unavailable_reason=reason,
            notes=[RESEARCH_USE_NOTE],
        )

    def invoke(self, ctx: RunContext) -> None:
        import numpy as np
        import torch

        from .bundle import input_identity, read_bundle

        self._call_memory = None
        rec = ctx.recorder
        params = resolve_params(self.role, ctx.parameters)
        with rec.span("qimg.vae.read_latent", part=self.part):
            latent_meta, tensors = read_bundle(ctx, "latent", kind=KIND_LATENT)
        if "latent" not in tensors:
            raise ComponentError("LATENT_MISMATCH", "latent bundle 沒有 latent tensor")
        packed = tensors["latent"]
        try:
            width, height = int(latent_meta["width"]), int(latent_meta["height"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ComponentError("LATENT_MISMATCH", "latent bundle 的 meta 缺少 width／height") from exc
        check_output_size(width, height)
        z_dim = int(self.vae.config.z_dim)
        grid = [height // VAE_SCALE_FACTOR, width // VAE_SCALE_FACTOR]
        latent_info = latent_meta.get("latent")
        declared_hw = latent_info.get("latent_hw") if isinstance(latent_info, dict) else None
        if declared_hw is not None and [int(x) for x in declared_hw] != grid:
            raise ComponentError(
                "LATENT_MISMATCH",
                f"latent meta 的 latent_hw {declared_hw} 與 {width}×{height} 的網格 {grid} 不同",
                details={"latent_hw": declared_hw, "expected": grid},
            )
        tokens = grid[0] * grid[1]
        if packed.ndim != 3 or list(packed.shape) != [1, tokens, z_dim]:
            raise ComponentError(
                "LATENT_MISMATCH",
                f"latent 形狀 {list(packed.shape)} 與 {width}×{height} 需要的 [1, {tokens}, {z_dim}] 不同（不 reshape、不猜）",
                details={"shape": list(packed.shape), "expected": [1, tokens, z_dim]},
            )
        if not packed.is_floating_point():
            raise ComponentError("LATENT_MISMATCH", f"latent dtype {packed.dtype} 不是浮點數")
        mode = str(params["mode"])
        set_tiling(self.vae, mode == "tiled")
        if mode == "tiled":
            rec.note("tiled 解碼：分塊之間可能出現接縫（Qwen-Image 2.1 VAE 的已知風險）")
        window = self._begin(ctx)
        try:
            with torch.inference_mode():
                t0 = mono_ns()
                with timed_stage(rec, "qimg.vae.decode", part=self.part, cuda=self.cuda):
                    array = decode_latents(self.vae, packed, width=width, height=height, device=self.device)
                decode_ms = (mono_ns() - t0) / 1e6
            rec.record_cost(
                "decode",
                work=float(width * height),
                unit="pixel",
                compute_ms=decode_ms,
                width=width,
                height=height,
                mode=mode,
            )
        except BaseException as exc:
            # after an OOM the decode_latents/VAE frames and the module's feature cache still hold activations until
            # the next call; drop both first so the release → empty_cache in _end() can free them
            drop_frame_locals(exc)
            self._discard_call_state()
            raise
        finally:
            self._end(ctx, window)
        ctx.check_cancelled()
        with rec.span("qimg.vae.png", part=self.part):
            t1 = mono_ns()
            data = encode_png(array)
            png_ms = (mono_ns() - t1) / 1e6
            channels = int(array.shape[2]) if array.ndim == 3 else 1
            mode_name = {4: "RGBA", 3: "RGB"}.get(channels)
            if mode_name is None:
                raise ComponentError("RUNTIME_ERROR", f"VAE 輸出 {channels} 個通道，無法存成 RGB／RGBA PNG")
            has_alpha = bool(channels == 4 and bool(np.any(array[..., 3] < 255)))
            out = ctx.new_file(
                None,
                "image/png",
                {"role": "qimg.decoded", "width": width, "height": height, "mode": mode_name},
                type_id="media.image.v1",
            )
            out.write(data)
            out.finish()
        actual = {
            "provider_id": self.provider_id,
            "decode": {
                "mode": mode,
                "tiling_params": tiling_info(self.vae) if mode == "tiled" else None,
                "latent_dtype": str(packed.dtype),
                **self._settings_summary(),
            },
            "latent": latent_meta,
            "latent_source": input_identity(ctx, "latent"),
            "timings_ms": {"decode": decode_ms, "png_encode": png_ms},
        }
        asset = {
            "asset_id": new_id(),
            "file": ctx.file_ref(out),
            "width": width,
            "height": height,
            "mode": mode_name,
            "has_alpha": has_alpha,
            "white_matte": False,
            "source_take": None,
            "actual_settings": actual,
        }
        if len(canonical_json(asset)) > ASSET_INLINE_BUDGET:
            keep = ("width", "height", "steps", "seed", "cfg", "mu", "guidance", "sigma_schedule")
            actual["latent"] = {k: latent_meta.get(k) for k in keep if k in latent_meta}
            actual["latent_truncated"] = "latent meta 太大，只保留摘要欄位；完整內容在 latent bundle（latent_source）"
        from phasyn_components import contracts

        contracts.validate("ImageAsset", asset, code="RUNTIME_ERROR", what="ImageAsset")
        ctx.set_output("image", asset, type_id=TYPE_IMAGE_ASSET)
        rec.set_metric("output_frame_count", 1, unit="count", scope="component_call", method="runtime_hook")
        rec.log(
            "info", "VAE decode 完成", width=width, height=height, mode=mode, decode_ms=decode_ms, has_alpha=has_alpha
        )


__all__ = [
    "VaeDecodeProvider",
    "VaeEncodeProvider",
    "decode_latents",
    "encode_png",
    "encode_reference",
    "vae_input",
]
