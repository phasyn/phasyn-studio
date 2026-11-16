# SPDX-License-Identifier: Apache-2.0
# Portions adapted from diffusers 578c9b2 (src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py,
# calculate_dimensions and the white-matte reference conversion), Copyright 2026 Qwen-Image Team,
# The HuggingFace Team; modified by the Phasyn Studio authors.
"""``qimg.prepare`` (CPU): reference images (≤ 4, ordered) + mask → ``qimg.prepared.v1`` bundle.

The numeric rules are fixed (no math changes):

* Input normalization (``input-normalization/2``): PNG/JPEG/WebP only, ≤ 24 MiB, ≤ 20 megapixels, longest
  side ≤ 8192; EXIF orientation applied; an embedded ICC profile is converted to sRGB (perceptual; a profile
  that cannot be converted is rejected, colors are never guessed); palette transparency → RGBA; references
  keep alpha (RGBA) or stay RGB, masks become L.
* Reference resizing follows step 1 of diffusers ``QwenImage21Pipeline.__call__``: convert to RGBA →
  ``calculate_dimensions(reference_resolution², width/height)`` (both sides rounded to a multiple of 32) → one
  LANCZOS resize; the same result feeds the VAE (``ref_rgba_i``, 4 channels) and Qwen3-VL (``ref_rgb_i`` =
  alpha flattened on white).
* Mask: convert to L → LANCZOS resize to the output size → optional inversion; the compositing base is
  reference ``base_index`` converted to RGBA and LANCZOS-resized to the output size. Compositing itself
  happens in ``image.compose``.

Identical inputs give a bit-identical bundle (meta holds no times or random ids).
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from phasyn_components import upstream
from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Part,
    Port,
    RunContext,
)
from phasyn_components.typed import check_fileref

from . import KIND_PREPARED, SIZE_MULTIPLE, TYPE_IMAGE_FILE, TYPE_PREPARED, TYPE_REFERENCES, VAE_SCALE_FACTOR
from .config import (
    MAX_REFERENCES,
    build_settings_schema,
    check_load,
    check_output_size,
    default_settings,
    parameters_schema,
    resolve_params,
    runtime_problem,
)
from .imaging import ACCEPTED_FORMATS, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, MAX_INPUT_BYTES, ColorProfileError, normalized

if TYPE_CHECKING:  # pragma: no cover
    import numpy as np
    from PIL import Image

NORMALIZATION_VERSION = "input-normalization/2"
REFERENCE_KEYS = {"file", "label"}


def open_normalized(path: Path, *, kind: str, what: str) -> tuple[Image.Image, dict[str, Any]]:
    """Read and normalize one input image; kind=reference → RGB/RGBA, kind=mask → L."""
    from PIL import Image, UnidentifiedImageError

    size = path.stat().st_size
    if size == 0:
        raise ComponentError("INVALID_ARGUMENT", f"{what} 是空檔")
    if size > MAX_INPUT_BYTES:
        raise ComponentError(
            "INPUT_TOO_LARGE", f"{what} 為 {size} bytes，超過 24 MiB", details={"bytes": size, "limit": MAX_INPUT_BYTES}
        )
    try:
        with Image.open(path) as source:
            if source.format not in ACCEPTED_FORMATS:
                raise ComponentError("INVALID_ARGUMENT", f"{what} 只接受 PNG、JPEG 或 WebP（收到 {source.format}）")
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ComponentError(
                    "INPUT_TOO_LARGE",
                    f"{what} 為 {source.width}×{source.height}，超過 2,000 萬像素",
                    details={"width": source.width, "height": source.height, "limit_pixels": MAX_IMAGE_PIXELS},
                )
            if max(source.size) > MAX_IMAGE_SIDE:
                raise ComponentError("INPUT_TOO_LARGE", f"{what} 最長邊 {max(source.size)} px，超過 8192")
            provenance = {
                "original_format": source.format,
                "original_size": [int(source.width), int(source.height)],
                "original_mode": source.mode,
                "original_frame_count": int(getattr(source, "n_frames", 1)),
                "had_icc_profile": bool(source.info.get("icc_profile")),
            }
            try:
                colored = normalized(source)
            except ColorProfileError as error:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "COLOR_PROFILE_INVALID：無法將內嵌色彩描述檔轉換為 sRGB（不猜色彩）",
                    details={"reason": "COLOR_PROFILE_INVALID", "error": str(error)},
                ) from error
            image = colored.convert("L" if kind == "mask" else "RGBA" if "A" in colored.getbands() else "RGB")
    except ComponentError:
        raise
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ComponentError(
            "INVALID_ARGUMENT", f"{what} 無法解碼，請使用有效的 PNG、JPEG 或 WebP：{type(error).__name__}"
        ) from error
    image.info.clear()  # 正規化結果不帶 EXIF／GPS 或已失效的 ICC 標記
    provenance["normalized_size"] = [int(image.width), int(image.height)]
    provenance["normalized_mode"] = image.mode
    return image, provenance


def calculate_dimensions(target_area: float, ratio: float) -> tuple[int, int]:
    """diffusers ``calculate_dimensions``: area ≈ target_area, both sides rounded to a multiple of 32."""
    width = math.sqrt(target_area * ratio)
    height = width / ratio
    return round(width / 32) * 32, round(height / 32) * 32


def prepare_reference(image: Image.Image, resolution: int, *, what: str) -> dict[str, Any]:
    """One LANCZOS resize → RGBA for the VAE and white-matte RGB for the text encoder (as in the pipeline)."""
    import numpy as np
    from PIL import Image

    rgba = image if image.mode == "RGBA" else image.convert("RGBA")
    width, height = calculate_dimensions(resolution * resolution, rgba.size[0] / rgba.size[1])
    if width < SIZE_MULTIPLE or height < SIZE_MULTIPLE:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"{what} 的長寬比 {rgba.size[0]}:{rgba.size[1]} 太極端：在 reference_resolution={resolution} 下縮放結果是 "
            f"{width}×{height}（至少要 32 px）",
            details={"source_size": list(rgba.size), "prepared_size": [width, height]},
        )
    resized = rgba.resize((width, height), resample=Image.Resampling.LANCZOS, reducing_gap=None)
    white = Image.new("RGB", resized.size, (255, 255, 255))
    white.paste(resized, mask=resized.getchannel("A"))
    return {
        "rgba": np.array(resized, dtype=np.uint8),
        "rgb": np.array(white, dtype=np.uint8),
        "size": (width, height),
    }


def prepare_mask(mask: Image.Image, width: int, height: int, *, invert: bool) -> np.ndarray:
    """Mask: L → LANCZOS resize to the output size → optional inversion."""
    import numpy as np
    from PIL import Image, ImageOps

    scaled = mask.convert("L").resize((width, height), Image.Resampling.LANCZOS)
    if invert:
        scaled = ImageOps.invert(scaled)
    return np.array(scaled, dtype=np.uint8)


def prepare_base(image: Image.Image, width: int, height: int) -> np.ndarray:
    """Compositing base: RGBA → LANCZOS resize to the output size."""
    import numpy as np
    from PIL import Image

    return np.array(image.convert("RGBA").resize((width, height), Image.Resampling.LANCZOS), dtype=np.uint8)


def tensor_digest(array: Any) -> str:
    import numpy as np

    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def _reference_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_REFERENCES:
        raise ComponentError(
            "INVALID_ARGUMENT", f"references 需要 1–{MAX_REFERENCES} 張參考圖：[{{file: FileRef, label?}}, …]（依序）"
        )
    out = []
    for index, item in enumerate(value):
        if not isinstance(item, Mapping) or not isinstance(item.get("file"), Mapping):
            raise ComponentError("INVALID_ARGUMENT", f"references[{index}] 需要 {{file: FileRef}}")
        unknown = sorted(set(item) - REFERENCE_KEYS)
        if unknown:
            raise ComponentError("INVALID_ARGUMENT", f"references[{index}] 有未知欄位：{', '.join(unknown)}")
        label = item.get("label")
        if label is not None and (not isinstance(label, str) or len(label) > 200):
            raise ComponentError("INVALID_ARGUMENT", f"references[{index}].label 必須是 ≤ 200 字的字串")
        out.append({"file": check_fileref(item["file"], where=f"references[{index}].file"), "label": label})
    return out


def build_prepared(
    references: list[tuple[Path, Mapping[str, Any], str | None]],
    mask: tuple[Path, Mapping[str, Any]] | None,
    params: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """純函式：(本機路徑, FileRef, label) 清單＋遮罩 → (meta, tensors)。"""
    width, height = int(params["width"]), int(params["height"])
    check_output_size(width, height)
    resolution = int(params["reference_resolution"])
    base_index = params.get("base_index")
    if base_index is not None and not 0 <= int(base_index) < len(references):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"base_index={base_index} 超出範圍：只有 {len(references)} 張參考圖",
            details={"base_index": base_index, "references": len(references)},
        )
    if mask is not None and base_index is None:
        raise ComponentError("INVALID_ARGUMENT", "接了遮罩但 base_index=null：遮罩合成需要指定底圖（第幾張參考圖）")
    tensors: dict[str, Any] = {}
    refs_meta: list[dict[str, Any]] = []
    normalized: list[Any] = []
    for index, (path, ref, label) in enumerate(references):
        image, provenance = open_normalized(path, kind="reference", what=f"參考圖 {index + 1}")
        normalized.append(image)
        prepared = prepare_reference(image, resolution, what=f"參考圖 {index + 1}")
        tensors[f"ref_rgb_{index}"] = prepared["rgb"]
        tensors[f"ref_rgba_{index}"] = prepared["rgba"]
        width_i, height_i = prepared["size"]
        refs_meta.append(
            {
                "index": index,
                "label": label,
                "source_file_id": ref.get("file_id"),
                "source_sha256": ref.get("sha256"),
                "source_size": provenance["normalized_size"],
                "source": provenance,
                "prepared_size": [width_i, height_i],
                "latent_grid": [height_i // VAE_SCALE_FACTOR, width_i // VAE_SCALE_FACTOR],
                "has_alpha": image.mode == "RGBA",
            }
        )
    mask_meta: dict[str, Any] = {"present": mask is not None, "invert": bool(params.get("mask_invert"))}
    if mask is not None:
        mask_path, mask_ref = mask
        mask_image, mask_provenance = open_normalized(mask_path, kind="mask", what="遮罩")
        tensors["mask_l"] = prepare_mask(mask_image, width, height, invert=bool(params.get("mask_invert")))
        tensors["base_rgba"] = prepare_base(normalized[int(base_index)], width, height)  # type: ignore[arg-type]
        mask_meta.update(
            {
                "source_file_id": mask_ref.get("file_id"),
                "source_sha256": mask_ref.get("sha256"),
                "source_size": mask_provenance["normalized_size"],
                "source": mask_provenance,
            }
        )
    meta = {
        "width": width,
        "height": height,
        "reference_resolution": resolution,
        "refs": refs_meta,
        "base_index": base_index,
        "mask": mask_meta,
        "digests": {name: tensor_digest(array) for name, array in sorted(tensors.items())},
        "normalization_version": NORMALIZATION_VERSION,
        "resample": "lanczos",
        "rule": "diffusers QwenImage21Pipeline calculate_dimensions + LANCZOS (pipeline_qwenimage21.py:648-663)",
    }
    return meta, tensors


class PrepareProvider(BaseProvider):
    provider_id = "qimg.prepare"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        reason = runtime_problem("prepare")
        empty = {"type": "object", "properties": {}}
        return Description(
            provider_id=cls.provider_id,
            kind="image.prepare",
            label="Qwen-Image 參考圖／遮罩前處理（CPU；EXIF、ICC→sRGB、縮放到 reference_resolution²）",
            inputs=[
                Port(
                    "references",
                    TYPE_REFERENCES,
                    True,
                    "inline",
                    "參考圖清單 [{file: FileRef, label?}]（1–4 張，順序＝<image1>…<image4> 與 VAE 參考 latent 的順序）",
                ),
                Port("mask", TYPE_IMAGE_FILE, False, "file", "編輯遮罩（白＝重新生成、黑＝保留底圖、灰＝混合）"),
            ],
            outputs=[
                Port(
                    "prepared",
                    TYPE_PREPARED,
                    True,
                    "file",
                    "qimg bundle：ref_rgb_i（白底 RGB，給 Qwen3-VL）、ref_rgba_i（RGBA，給 VAE）、mask_l、base_rgba",
                )
            ],
            parts=[Part("preprocess", "preprocess", empty, ["host_ms"], "full", None)],
            settings_schema=build_settings_schema("prepare"),
            parameters_schema=parameters_schema("prepare"),
            default_settings=default_settings("prepare"),
            available=reason is None,
            unavailable_code="PROVIDER_NOT_INSTALLED" if reason else None,
            unavailable_reason=reason,
        )

    def load(self, ctx: LoadContext) -> LoadResult:
        check_load("prepare", ctx.load)
        return LoadResult(
            effective_load=ctx.load,
            observed={"libraries": upstream.library_versions(("pillow", "numpy", "safetensors"), vcs=())},
            expanded_parts=ctx.expanded_parts,
        )

    def invoke(self, ctx: RunContext) -> None:
        from .bundle import write_bundle

        rec = ctx.recorder
        params = resolve_params("prepare", ctx.parameters)
        items = _reference_list(ctx.input("references").value)
        references: list[tuple[Path, Mapping[str, Any], str | None]] = []
        with rec.span("qimg.prepare.resolve", part="preprocess"):
            for item in items:
                references.append((ctx.resolve_file(item["file"]), item["file"], item["label"]))
            mask_item = ctx.optional_input("mask")
            mask = None
            if mask_item is not None and mask_item.file is not None:
                mask = (mask_item.require_path("mask"), dict(mask_item.file))
        ctx.check_cancelled()
        with rec.span("qimg.prepare.images", part="preprocess"):
            meta, tensors = build_prepared(references, mask, params)
        ctx.check_cancelled()
        rec.set_metric(
            "input_frame_count", len(references), unit="count", scope="component_call", method="runtime_hook"
        )
        with rec.span("qimg.prepare.write", part="preprocess"):
            write_bundle(ctx, "prepared", kind=KIND_PREPARED, meta=meta, tensors=tensors)
        rec.log(
            "info",
            "參考圖前處理完成",
            references=[{"source_size": r["source_size"], "prepared_size": r["prepared_size"]} for r in meta["refs"]],
            mask=meta["mask"]["present"],
            width=meta["width"],
            height=meta["height"],
        )


__all__ = [
    "PrepareProvider",
    "build_prepared",
    "calculate_dimensions",
    "open_normalized",
    "prepare_base",
    "prepare_mask",
    "prepare_reference",
]
