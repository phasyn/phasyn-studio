"""Server-side text rasterisation for the export: titles as PNG pictures, captions as QuickTime tracks.

The product's FFmpeg has no ``drawtext`` (it is built without libfreetype), so text is drawn here
with the system libraries ``drawtext`` itself would need, loaded through ``ctypes``: fontconfig
selects fonts, HarfBuzz shapes, FreeType rasterises. Layout follows the editor's
``apps/frontend/src/features/studio/model/titleLayout.ts`` statement by statement, so with the same
fonts the export breaks lines where the preview does; fonts are the Node's (see ``fonts``).

All native code runs in one short-lived worker process per request (:func:`render_texts`): the
long-lived parent never loads a native library, and a crash, a hang or a missing library there is
a :class:`TextRenderError` with a stable ``reason``.

- ``model``: request and result shapes, bounds, wire form (pure)
- ``layout``, ``chars``, ``captions``: the editor's layout, character rules, caption states (pure)
- ``png``, ``mov``: the two output formats (pure)
- ``runner``, ``errors``: the parent side (validation, the supervised worker, result checks)
- ``worker``, ``engine``, ``raster``, ``glyphs``, ``shaping``, ``fonts``, ``ft``, ``hb``, ``fc``,
  ``native``: the worker side

Importing the package loads no native library and starts no process. ``render_texts`` and
``TextRenderError`` are resolved on first use, so the worker (which imports this package too)
needs nothing but this directory, the standard library and NumPy.
"""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

from .chars import text_direction_problem
from .model import (
    CaptionEvent,
    CaptionTrack,
    CaptionTrackJob,
    MissingGlyphs,
    TextRequest,
    TextResult,
    TextSpec,
    TextStyle,
    TitleJob,
    TitleRaster,
)

if TYPE_CHECKING:
    from .errors import TextRenderError
    from .runner import render_texts

_PARENT_SIDE = {"TextRenderError": "errors", "render_texts": "runner"}


def __getattr__(name: str) -> Any:
    module = _PARENT_SIDE.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(import_module(f"{__name__}.{module}"), name)


__all__ = [
    "CaptionEvent",
    "CaptionTrack",
    "CaptionTrackJob",
    "MissingGlyphs",
    "TextRenderError",
    "TextRequest",
    "TextResult",
    "TextSpec",
    "TextStyle",
    "TitleJob",
    "TitleRaster",
    "render_texts",
    "text_direction_problem",
]
