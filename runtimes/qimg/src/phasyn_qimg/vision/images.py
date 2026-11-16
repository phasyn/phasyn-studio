"""The vision view of an input image: EXIF orientation → ICC to sRGB → alpha flattened on white → RGB.

The original bytes are never changed. Normalization is shared with ``qimg.prepare`` (``phasyn_qimg.imaging``: PNG/JPEG/
WebP, ≤ 24 MiB, ≤ 20 megapixels, longest side ≤ 8192, EXIF transpose, ICC → sRGB perceptual); vision additionally
rejects animated/multi-frame images and flattens alpha on white. An invalid ICC profile is never ignored; crops use
floor on the normalized full-image coordinates and are at least 32×32. PIL is imported inside the functions only.
"""

from __future__ import annotations

import io
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError

from ..imaging import ACCEPTED_FORMATS, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, ColorProfileError, normalized
from ..imaging import MAX_INPUT_BYTES as MAX_IMAGE_BYTES

MIN_CROP_SIDE = 32
NORMALIZATION = "vision-srgb-white/1"


def _invalid(port: str, reason: str, message: str) -> ComponentError:
    return ComponentError("INVALID_ARGUMENT", f"輸入 {port}：{message}", details={"port": port, "reason": reason})


@dataclass
class ViewImage:
    image: Any  # PIL.Image.Image（RGB）
    width: int
    height: int
    source_format: str
    had_alpha: bool
    had_icc_profile: bool


def crop_box(crop: Mapping[str, Any], width: int, height: int) -> tuple[int, int, int, int]:
    """Normalized bbox → pixel box (floor, as PIL does); invalid → 422."""
    x0, y0 = int(float(crop["x0"]) * width), int(float(crop["y0"]) * height)
    x1, y1 = int(float(crop["x1"]) * width), int(float(crop["y1"]) * height)
    view = str(crop.get("view_id", "crop"))
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ComponentError(
            "INVALID_ARGUMENT", f"裁切 {view} 必須位於校正後原圖內（x0<x1、y0<y1）", details={"crop": dict(crop)}
        )
    if x1 - x0 < MIN_CROP_SIDE or y1 - y0 < MIN_CROP_SIDE:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"裁切 {view} 後只有 {x1 - x0}×{y1 - y0} 像素；至少需要 {MIN_CROP_SIDE}×{MIN_CROP_SIDE}",
            details={"crop": dict(crop), "pixels": [x1 - x0, y1 - y0]},
        )
    return x0, y0, x1, y1


def load_view_image(path: Path, port: str) -> ViewImage:
    """Read an input image and build its vision view (RGB, transparent areas white)."""
    from PIL import Image, UnidentifiedImageError

    try:
        size = path.stat().st_size
    except OSError as exc:
        raise _invalid(port, "UNREADABLE", f"無法讀取圖片檔：{exc}") from exc
    if size <= 0 or size > MAX_IMAGE_BYTES:
        raise _invalid(port, "IMAGE_TOO_LARGE", f"圖片必須非空且不超過 24 MiB（{size} bytes）")
    data = path.read_bytes()
    try:
        with Image.open(io.BytesIO(data)) as source:
            fmt = str(source.format or "")
            if fmt not in ACCEPTED_FORMATS:
                raise _invalid(port, "UNSUPPORTED_FORMAT", f"只接受 PNG、JPEG 或 WebP（收到 {fmt or '未知格式'}）")
            if source.width * source.height > MAX_IMAGE_PIXELS or max(source.size) > MAX_IMAGE_SIDE:
                raise _invalid(
                    port,
                    "IMAGE_TOO_LARGE",
                    f"圖片 {source.width}×{source.height} 超過 2,000 萬像素或長邊 {MAX_IMAGE_SIDE}",
                )
            if int(getattr(source, "n_frames", 1)) != 1:
                raise _invalid(port, "UNSUPPORTED_ANIMATION", "分析不接受動畫或多幀圖片（不取第一幀代替）")
            had_icc = bool(source.info.get("icc_profile"))
            try:
                colored = normalized(source)
            except ColorProfileError as exc:
                raise _invalid(
                    port, "COLOR_PROFILE_INVALID", "內嵌色彩描述檔無法轉換為 sRGB（不忽略、不猜顏色）"
                ) from exc
            had_alpha = "A" in colored.getbands()
            rgba = colored.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            rgb = Image.alpha_composite(background, rgba).convert("RGB")
    except ComponentError:
        raise
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise _invalid(port, "INVALID_IMAGE", f"圖片無法解碼：{type(exc).__name__}") from exc
    return ViewImage(rgb, rgb.width, rgb.height, fmt, had_alpha, had_icc)


def crop_view(view: ViewImage, crop: Mapping[str, Any]) -> ViewImage:
    box = crop_box(crop, view.width, view.height)
    cropped = view.image.crop(box)
    return ViewImage(cropped, cropped.width, cropped.height, view.source_format, view.had_alpha, view.had_icc_profile)


__all__ = [
    "MAX_IMAGE_BYTES",
    "MAX_IMAGE_PIXELS",
    "MAX_IMAGE_SIDE",
    "MIN_CROP_SIDE",
    "NORMALIZATION",
    "ViewImage",
    "crop_box",
    "crop_view",
    "load_view_image",
]
