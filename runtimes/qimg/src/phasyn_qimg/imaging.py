"""Shared image normalization of qimg inputs: input limits, EXIF orientation, ICC → sRGB and palette transparency.

Both consumers keep their own result and version string: ``qimg.prepare`` (``input-normalization/2``) keeps alpha and
returns RGB/RGBA or L, while ``qimg.vision`` (``vision-srgb-white/1``) flattens alpha on white. Colors are never
guessed: an embedded profile that cannot be converted raises :class:`ColorProfileError`, which each caller reports as
its own 422. PIL is imported inside the functions only.
"""

from __future__ import annotations

import io
from typing import Any

ACCEPTED_FORMATS = ("PNG", "JPEG", "WEBP")
MAX_INPUT_BYTES = 24 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_IMAGE_SIDE = 8192


class ColorProfileError(ValueError):
    """The embedded color profile cannot be converted to sRGB."""


def to_srgb(source: Any) -> Any:
    """Embedded color profile → sRGB with a separate alpha; images without a profile are returned unchanged."""
    from PIL import ImageCms

    profile = source.info.get("icc_profile")
    if not profile:
        return source
    try:
        # LittleCMS works on color channels, not palette indices: expand the palette and split alpha first so
        # index transparency survives
        if source.mode == "P":
            source = source.convert("RGBA" if "transparency" in source.info else "RGB")
        alpha = source.getchannel("A") if "A" in source.getbands() else None
        if source.mode == "LA":
            color = source.getchannel("L")
        else:
            color = source.convert("RGB") if alpha is not None else source
        converted = ImageCms.profileToProfile(
            color,
            ImageCms.ImageCmsProfile(io.BytesIO(profile)),
            ImageCms.createProfile("sRGB"),
            outputMode="RGB",
            renderingIntent=ImageCms.Intent.PERCEPTUAL,
        )
        if converted is None:
            raise ValueError("ICC conversion returned no image")
        if alpha is not None:
            converted.putalpha(alpha)
        return converted
    except (ImageCms.PyCMSError, OSError, ValueError, TypeError) as error:
        raise ColorProfileError(f"{type(error).__name__}: {error}"[:500]) from error


def normalized(source: Any) -> Any:
    """EXIF orientation → sRGB → palette transparency as RGBA (alpha is kept; the caller picks the final mode)."""
    from PIL import ImageOps

    colored = to_srgb(ImageOps.exif_transpose(source))
    if colored.mode == "P" and "transparency" in colored.info:
        colored = colored.convert("RGBA")
    return colored


__all__ = [
    "ACCEPTED_FORMATS",
    "MAX_IMAGE_PIXELS",
    "MAX_IMAGE_SIDE",
    "MAX_INPUT_BYTES",
    "ColorProfileError",
    "normalized",
    "to_srgb",
]
