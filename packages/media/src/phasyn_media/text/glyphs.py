"""Glyph coverage masks: one glyph rasterised for fill and for stroke, cached.

A glyph is drawn at an exact 26.6 position: the integer pixel is where its masks are stamped, the
1/64 pixel remainder is part of the cache key and is rasterised into the masks. A mask is the 8-bit
coverage of one shape, trimmed to its non-zero rows and columns, so the box of a stamped mask is
the box of pixels it touches.

The cache is bounded by the bytes of its masks; the least recently used glyphs go first and are
rasterised again when they come back.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from typing import NamedTuple

import numpy as np
from numpy.typing import NDArray

from .fonts import FontBook
from .ft import Coverage, FreeType
from .hb import synthetic_bold_strength

UNSCALED = 0x10000
_CACHE_BYTES = 128 * 1024 * 1024


class GlyphKey(NamedTuple):
    """Everything that decides the masks of a glyph."""

    face: int  # FontBook face id
    size: int  # pixels per em, 26.6
    radius: int  # stroke radius, 26.6
    glyph: int
    fx: int  # sub-pixel position to the right, 0..63
    fy: int  # sub-pixel position downwards, 0..63
    x_scale: int  # horizontal squeeze, 16.16


@dataclass(frozen=True)
class Mask:
    """Coverage of one shape and its offset from the pen pixel (columns to the right, rows downwards)."""

    pixels: NDArray[np.uint8]
    left: int
    top: int


@dataclass(frozen=True)
class GlyphMasks:
    fill: Mask | None  # None: nothing to draw (a space, or a shape thinner than any pixel sample)
    stroke: Mask | None

    @property
    def nbytes(self) -> int:
        return sum(mask.pixels.nbytes for mask in (self.fill, self.stroke) if mask is not None)


def _mask(coverage: Coverage | None) -> Mask | None:
    if coverage is None:
        return None
    pixels = np.frombuffer(coverage.buffer, dtype=np.uint8).reshape(coverage.rows, coverage.width)
    rows = np.flatnonzero(pixels.any(axis=1))
    if rows.size == 0:
        return None
    columns = np.flatnonzero(pixels.any(axis=0))
    top, left = int(rows[0]), int(columns[0])
    trimmed = pixels[top : int(rows[-1]) + 1, left : int(columns[-1]) + 1].copy()
    return Mask(trimmed, coverage.left + left, top - coverage.top)


class GlyphRasterizer:
    """Rasterises glyphs of the font book's faces and remembers the result."""

    def __init__(self, book: FontBook, freetype: FreeType) -> None:
        self._book = book
        self._freetype = freetype
        self._cache: OrderedDict[GlyphKey, GlyphMasks] = OrderedDict()
        self._cached_bytes = 0

    def masks(self, key: GlyphKey) -> GlyphMasks:
        masks = self._cache.get(key)
        if masks is not None:
            self._cache.move_to_end(key)
            return masks
        masks = self._rasterize(key)
        self._cache[key] = masks
        self._cached_bytes += masks.nbytes
        while self._cached_bytes > _CACHE_BYTES and len(self._cache) > 1:
            _, dropped = self._cache.popitem(last=False)
            self._cached_bytes -= dropped.nbytes
        return masks

    def _rasterize(self, key: GlyphKey) -> GlyphMasks:
        """Fill and stroke of one glyph, as a canvas scaled by ``x_scale`` would draw them.

        The stroke is taken from the unsqueezed outline (round joins, radius ``key.radius``) and
        squeezed afterwards, exactly like a pen drawn through a horizontally scaled canvas.
        """
        freetype = self._freetype
        face = self._book.face(key.face)
        face.at_size(key.size)
        outline = freetype.load_outline(face.handle, key.glyph)
        if outline.n_contours == 0:
            return GlyphMasks(None, None)
        if face.record.embolden:
            freetype.embolden(outline, synthetic_bold_strength(key.size))
        stroke = freetype.stroke(outline, key.radius)
        freetype.place(outline, key.x_scale, key.fx, -key.fy)
        fill_mask = _mask(freetype.render(outline))
        freetype.place(stroke.outline, key.x_scale, key.fx, -key.fy)
        return GlyphMasks(fill_mask, _mask(freetype.render(stroke.outline)))
