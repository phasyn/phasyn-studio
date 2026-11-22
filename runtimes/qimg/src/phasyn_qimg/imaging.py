"""Shared image normalization of qimg inputs: input limits, EXIF orientation, ICC → sRGB and palette transparency.

Both consumers keep their own result and version string: ``qimg.prepare`` (``input-normalization/2``) keeps alpha and
returns RGB/RGBA or L, while ``qimg.vision`` (``vision-srgb-white/1``) flattens alpha on white. Colors are never
guessed: an embedded profile that cannot be converted raises :class:`ColorProfileError`, which each caller reports as
its own 422. PIL is imported inside the functions only.
"""

from __future__ import annotations

from phasyn_components.image_color import ColorProfileError, normalized, to_srgb


ACCEPTED_FORMATS = ("PNG", "JPEG", "WEBP")
MAX_INPUT_BYTES = 24 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_IMAGE_SIDE = 8192


__all__ = [
    "ACCEPTED_FORMATS",
    "MAX_IMAGE_PIXELS",
    "MAX_IMAGE_SIDE",
    "MAX_INPUT_BYTES",
    "ColorProfileError",
    "normalized",
    "to_srgb",
]
