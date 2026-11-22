"""Reference image orientation and embedded colour normalization for isolated image runtimes."""

from __future__ import annotations

import io
from importlib import import_module
from typing import Any


NORMALIZATION_VERSION = "exif-icc-srgb/1"


class ColorProfileError(ValueError):
    """The embedded color profile cannot be converted to sRGB."""


def to_srgb(source: Any) -> Any:
    """Embedded color profile → sRGB with a separate alpha; images without a profile are returned unchanged."""
    cms = import_module("PIL.ImageCms")

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
        converted = cms.profileToProfile(
            color,
            cms.ImageCmsProfile(io.BytesIO(profile)),
            cms.createProfile("sRGB"),
            outputMode="RGB",
            renderingIntent=cms.Intent.PERCEPTUAL,
        )
        _restore_alpha(converted, alpha)
    except (cms.PyCMSError, OSError, ValueError, TypeError) as error:
        raise ColorProfileError(f"{type(error).__name__}: {error}"[:500]) from error
    return converted


def _restore_alpha(converted: Any, alpha: Any) -> None:
    if converted is None:
        raise ValueError("ICC conversion returned no image")
    if alpha is not None:
        converted.putalpha(alpha)


def normalized(source: Any) -> Any:
    """EXIF orientation → sRGB → palette transparency as RGBA (alpha is kept; the caller picks the final mode)."""
    ops = import_module("PIL.ImageOps")
    colored = to_srgb(ops.exif_transpose(source))
    if colored.mode == "P" and "transparency" in colored.info:
        colored = colored.convert("RGBA")
    return colored
