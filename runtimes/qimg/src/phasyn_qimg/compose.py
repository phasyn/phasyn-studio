"""``image.compose`` (CPU): decoded image + optional prepared mask/base → final RGBA PNG and white-matte RGB PNG.

* Mask compositing is ``Image.composite(new RGBA, base RGBA, mask L)``: white = newly generated,
  black = keep the base image, gray = blend. ``qimg.prepare`` already resized base and mask to the output
  size; a size mismatch is rejected (never silently resized here).
* A white-matte version is always produced as well (alpha flattened on white, the same way reference images
  are sent to Qwen3-VL, and the same way the H3 runtime reads an image with transparency): Studio uses this
  one as a ref2va reference or an fl2va first frame.
* Both PNGs carry the tEXt chunk ``phasyn`` = metadata JSON (ASCII-escaped canonical JSON: the upstream
  decode's actual_settings — latent seed/steps/sigmas/identities/timings — the composite facts and optional
  request metadata). Identities are path-free (``phasyn_components.model_identity``), so a shared PNG never
  reveals the user's model paths. Content comes only from the inputs, so identical inputs give bit-identical
  PNGs; this component's own timings go to the recorder only.
"""

from __future__ import annotations

import io
import json
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, override

from phasyn_components import contracts, upstream
from phasyn_components.canonical import canonical_json
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
)

from . import KIND_PREPARED, TYPE_IMAGE_ASSET, TYPE_PREPARED
from .bundle import input_identity, read_bundle
from .config import (
    COMPOSE_METADATA_MAX_BYTES,
    build_settings_schema,
    check_load,
    default_settings,
    parameters_schema,
    resolve_params,
    runtime_problem,
)


if TYPE_CHECKING:  # pragma: no cover
    from PIL import Image

_OPAQUE_ALPHA = 255

PNG_TEXT_KEY = "phasyn"
METADATA_SCHEMA = "phasyn.image.v1"
ASSET_INLINE_BUDGET = 200 * 1024
LIBRARIES = ("pillow", "numpy", "safetensors", "torch")


def composite(
    image: Image.Image, base: Image.Image | None, mask: Image.Image | None
) -> Image.Image:
    """Without a mask the image is returned as RGBA; with one, white = new image and black = base image."""
    rgba = image.convert("RGBA")
    if mask is None or base is None:
        return rgba
    from PIL import Image

    if base.size != rgba.size or mask.size != rgba.size:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"解碼圖 {rgba.size} 與遮罩 {mask.size}／底圖 {base.size} 尺寸不同（不在合成時縮放）",
            details={
                "image": list(rgba.size),
                "mask": list(mask.size),
                "base": list(base.size),
            },
        )
    return Image.composite(rgba, base.convert("RGBA"), mask.convert("L"))


def white_matte(image: Image.Image) -> Image.Image:
    """Alpha 鋪在白底上 → RGB（與 pipeline 送進 Qwen3-VL 的參考圖相同做法）."""
    from PIL import Image

    rgba = image.convert("RGBA")
    white = Image.new("RGB", rgba.size, (255, 255, 255))
    white.paste(rgba, mask=rgba.getchannel("A"))
    return white


def png_bytes(image: Image.Image, metadata: Mapping[str, Any]) -> bytes:
    """PNG+tEXt ``phasyn``（ASCII 跳脫的 canonical JSON → 一定是 tEXt，不會變成 iTXt）."""
    from PIL.PngImagePlugin import PngInfo

    text = json.dumps(
        metadata,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    info = PngInfo()
    info.add_text(PNG_TEXT_KEY, text)
    buf = io.BytesIO()
    image.save(buf, format="PNG", pnginfo=info)
    return buf.getvalue()


def read_png_metadata(data: bytes) -> dict[str, Any] | None:
    """The ``phasyn`` metadata of a PNG written by this component, or None when the chunk is absent."""
    from PIL import Image

    with Image.open(io.BytesIO(data)) as img:
        raw = (getattr(img, "text", None) or {}).get(PNG_TEXT_KEY)
    return json.loads(raw) if raw else None


def _input_asset(ctx: RunContext) -> dict[str, Any]:
    value = ctx.input("image").value
    contracts.validate(
        "ImageAsset",
        value,
        code="INVALID_ARGUMENT",
        what="輸入 image（image.asset.v1）",
    )
    return dict(value)


def _fit_asset(asset: dict[str, Any]) -> dict[str, Any]:
    """Inline 值有 256 KiB 上限：超過預算時把上游 decode 設定換成摘要（完整內容仍在 PNG metadata）."""
    if len(canonical_json(asset)) <= ASSET_INLINE_BUDGET:
        return asset
    actual = dict(asset["actual_settings"])
    upstream = actual.pop("upstream", None) or {}
    actual["upstream_summary"] = {
        "provider_id": upstream.get("provider_id"),
        "latent": {
            k: (upstream.get("latent") or {}).get(k)
            for k in ("width", "height", "steps", "seed", "cfg")
        },
        "truncated": "上游 actual_settings 太大；完整內容在 PNG 的 tEXt phasyn",
    }
    return {**asset, "actual_settings": actual}


class ComposeProvider(BaseProvider):
    """Composite decoded pixels with the requested mask and source."""

    provider_id = "image.compose"
    libraries: dict[str, str | None] | None = (
        None  # set by load(); a CPU helper may also be invoked directly
    )

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:  # noqa: ARG003 - Provider and callback signatures accept these argument names.
        """Describe the ports, settings and current runtime availability."""
        reason = runtime_problem("compose")
        empty = {"type": "object", "properties": {}}
        return Description(
            provider_id=cls.provider_id,
            kind="image.compose",
            label="圖片合成（CPU）：遮罩合成\N{FULLWIDTH PLUS SIGN}白底版本\N{FULLWIDTH PLUS SIGN}PNG metadata",
            inputs=[
                Port(
                    "image",
                    TYPE_IMAGE_ASSET,
                    required=True,
                    transport="inline",
                    description="qimg.vae_decode 的 ImageAsset（RGBA PNG）",
                ),
                Port(
                    "prepared",
                    TYPE_PREPARED,
                    required=False,
                    transport="file",
                    description="qimg.prepare 的輸出：有遮罩時以 base_rgba／mask_l 合成；沒有遮罩時只記錄來源",
                ),
            ],
            outputs=[
                Port(
                    "image",
                    TYPE_IMAGE_ASSET,
                    required=True,
                    transport="inline",
                    description="最終圖（RGBA PNG，tEXt phasyn\N{FULLWIDTH EQUALS SIGN}metadata）",
                ),
                Port(
                    "image_white",
                    TYPE_IMAGE_ASSET,
                    required=True,
                    transport="inline",
                    description="白底版本（RGB PNG）：當 H3 ref2va 參考圖或 fl2va 首幀時用這一張",
                ),
            ],
            parts=[Part("compose", "postprocess", empty, ["host_ms"], "full", None)],
            settings_schema=build_settings_schema("compose"),
            parameters_schema=parameters_schema("compose"),
            default_settings=default_settings("compose"),
            available=reason is None,
            unavailable_code="PROVIDER_NOT_INSTALLED" if reason else None,
            unavailable_reason=reason,
        )

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Load the component and report its actual configuration."""
        check_load("compose", ctx.load)
        self.libraries = upstream.library_versions(LIBRARIES, vcs=())
        return LoadResult(
            effective_load=ctx.load,
            observed={"libraries": self.libraries},
            expanded_parts=ctx.expanded_parts,
        )

    def invoke(self, ctx: RunContext) -> None:
        """Run this provider with the validated call context."""
        import numpy as np  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.
        from PIL import Image

        rec = ctx.recorder
        params = resolve_params("compose", ctx.parameters)
        extra = params.get("metadata")
        if (
            extra is not None
            and len(canonical_json(extra)) > COMPOSE_METADATA_MAX_BYTES
        ):
            raise ComponentError("INPUT_TOO_LARGE", "metadata 參數超過 64 KiB")
        asset = _input_asset(ctx)
        with rec.span("qimg.compose.read", part="compose"):
            path = ctx.resolve_file(asset["file"])
            with Image.open(path) as source:
                if source.format != "PNG":
                    raise ComponentError(
                        "INVALID_ARGUMENT",
                        f"輸入 image 的檔案不是 PNG（{source.format}）",
                    )
                decoded = source.convert("RGBA")
            if list(decoded.size) != [int(asset["width"]), int(asset["height"])]:
                raise ComponentError(
                    "MODEL_INCOMPATIBLE",
                    f"輸入 image 宣告 {asset['width']}×{asset['height']}，檔案是 {decoded.size}",
                )
            mask_img = base_img = None
            composite_info: dict[str, Any] = {"mask": False}
            if (
                ctx.optional_input("prepared") is not None
                and ctx.input("prepared").file is not None
            ):
                prepared, tensors = read_bundle(ctx, "prepared", kind=KIND_PREPARED)
                if [int(prepared["width"]), int(prepared["height"])] != list(
                    decoded.size
                ):
                    raise ComponentError(
                        "MODEL_INCOMPATIBLE",
                        f"prepared 的輸出尺寸 {prepared['width']}×{prepared['height']} 與解碼圖 {decoded.size} 不同",
                    )
                mask_meta = prepared.get("mask") or {}
                composite_info = {
                    "mask": bool(mask_meta.get("present")),
                    "mask_invert": bool(mask_meta.get("invert")),
                    "base_index": prepared.get("base_index"),
                    "prepared": input_identity(ctx, "prepared"),
                    "mask_sha256": (prepared.get("digests") or {}).get("mask_l"),
                    "base_sha256": (prepared.get("digests") or {}).get("base_rgba"),
                    "rule": "Image.composite(new, base, mask)：白\N{FULLWIDTH EQUALS SIGN}新生成、黑\N{FULLWIDTH EQUALS SIGN}保留底圖、灰\N{FULLWIDTH EQUALS SIGN}混合",
                }
                if mask_meta.get("present"):
                    mask_img = Image.fromarray(
                        np.ascontiguousarray(tensors["mask_l"].numpy())
                    )
                    base_img = Image.fromarray(
                        np.ascontiguousarray(tensors["base_rgba"].numpy())
                    )
        ctx.check_cancelled()
        with rec.span("qimg.compose.composite", part="compose"):
            final = composite(decoded, base_img, mask_img)
            white = white_matte(final)
            alpha = np.asarray(final.getchannel("A"))
            has_alpha = bool(np.any(alpha < _OPAQUE_ALPHA))
        metadata = {
            "schema": METADATA_SCHEMA,
            "source_image": {
                "sha256": asset["file"].get("sha256"),
                "file_id": asset["file"].get("file_id"),
                "width": asset["width"],
                "height": asset["height"],
            },
            "upstream": asset.get("actual_settings") or {},
            "composite": composite_info,
            "request": extra,
        }
        outputs: dict[str, Any] = {}
        with rec.span("qimg.compose.png", part="compose"):
            for port, image, mode, matte in (
                ("image", final, "RGBA", False),
                ("image_white", white, "RGB", True),
            ):
                data = png_bytes(image, {**metadata, "white_matte": matte})
                out = ctx.new_file(
                    None,
                    "image/png",
                    {
                        "role": f"image.compose.{port}",
                        "width": image.width,
                        "height": image.height,
                        "mode": mode,
                    },
                    type_id="media.image.v1",
                )
                out.write(data)
                out.finish()
                outputs[port] = {
                    "asset_id": new_id(),
                    "file": ctx.file_ref(out),
                    "width": image.width,
                    "height": image.height,
                    "mode": mode,
                    "has_alpha": has_alpha if not matte else False,
                    "white_matte": matte,
                    "source_take": asset.get("source_take"),
                    "actual_settings": {
                        "provider_id": self.provider_id,
                        "composite": composite_info,
                        "white_matte": matte,
                        "png_text_key": PNG_TEXT_KEY,
                        "upstream": asset.get("actual_settings") or {},
                        "lib_versions": self.libraries
                        or upstream.library_versions(LIBRARIES, vcs=()),
                    },
                }
        for port, value in outputs.items():
            fitted = _fit_asset(value)
            contracts.validate(
                "ImageAsset", fitted, code="RUNTIME_ERROR", what=f"輸出 {port}"
            )
            ctx.set_output(port, fitted, type_id=TYPE_IMAGE_ASSET)
        rec.set_metric(
            "output_frame_count",
            2,
            unit="count",
            scope="component_call",
            method="runtime_hook",
        )
        rec.log(
            "info",
            "圖片合成完成",
            mask=composite_info.get("mask"),
            has_alpha=has_alpha,
            size=list(final.size),
        )


__all__ = [
    "METADATA_SCHEMA",
    "PNG_TEXT_KEY",
    "ComposeProvider",
    "composite",
    "png_bytes",
    "read_png_metadata",
    "white_matte",
]
