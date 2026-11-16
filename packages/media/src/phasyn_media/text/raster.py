"""From a text spec to pixels, following ``drawTitle`` of the editor.

Planning lays the text out, shapes every line and decides where each glyph is stamped; painting
composites, in ``drawTitle``'s order, the lower-third band and then for every line its stroke and
its fill. A plan carries no pixels, only glyph keys, so it is cheap to make again.

Coverage rules:

- the stroke of a line is one shape: the stroke masks of its glyphs are combined with ``max``, so
  where the outlines of neighbouring glyphs overlap the stroke is not darker;
- the fill of a line adds the coverage of its glyphs (saturating): glyph shapes do not overlap, so
  two glyphs sharing an edge pixel cover it together and no seam shows the stroke underneath;
- a line wider than ``maxWidth`` is squeezed horizontally about its anchor, stroke included, as
  ``fillText(text, x, y, maxWidth)`` does;
- the baseline is the top of the primary face's em box (see ``fonts``) plus its em ascent.

Every layer is either black (band, stroke) or the fill colour, so a pixel is fully described by its
alpha and by how much of the fill colour it holds. Those two premultiplied float planes are
composited source-over and converted to straight-alpha 8-bit RGBA once at the end; this equals
compositing premultiplied RGBA. All coverage is 8-bit, and any non-zero coverage leaves a non-zero
alpha, so the box of a plan (the union of its stamped masks, clipped to the canvas) is exactly the
box of its visible pixels. An item that leaves no pixel on the canvas (laid out outside it, or only
characters that draw nothing) has no box and paints one transparent pixel, as the browser shows nothing.
"""

from __future__ import annotations

import math
from collections import OrderedDict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any, NamedTuple

import numpy as np
from numpy.typing import NDArray

from .fonts import BOLD_FROM_WEIGHT, FontBook
from .glyphs import UNSCALED, GlyphKey, GlyphRasterizer, Mask
from .hb import HarfBuzz
from .layout import LEGACY_FONT_FAMILY, LEGACY_FONT_WEIGHT, Band, TitleLayout, js_round, layout_title
from .model import TextSpec, TextStyle
from .png import NO_FILTER
from .shaping import LineShaper, ShapedLine

STROKE_OPACITY = 0.85  # rgba(0, 0, 0, 0.85)
BAND_OPACITY = 0.55  # rgba(0, 0, 0, 0.55)

_FULL = np.float32(255)
_PLAN_CACHE_STAMPS = 100_000


class Box(NamedTuple):
    """Canvas pixels ``[x0, x1) x [y0, y1)``."""

    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    def within(self, outer: Box) -> tuple[slice, slice]:
        """Index of this box in an array that covers ``outer``."""
        return slice(self.y0 - outer.y0, self.y1 - outer.y0), slice(self.x0 - outer.x0, self.x1 - outer.x0)


def union(boxes: Iterable[Box]) -> Box | None:
    """The smallest box around all the given ones; ``None`` for none."""
    found = list(boxes)
    if not found:
        return None
    return Box(
        min(box.x0 for box in found),
        min(box.y0 for box in found),
        max(box.x1 for box in found),
        max(box.y1 for box in found),
    )


@dataclass(frozen=True, slots=True)
class Stamp:
    """A glyph at its pen pixel on the canvas."""

    key: GlyphKey
    x: int
    y: int


@dataclass(frozen=True, slots=True)
class LinePlan:
    box: Box | None  # the visible pixels of the line; None when it draws nothing
    stamps: tuple[Stamp, ...]


@dataclass(frozen=True, slots=True)
class Plan:
    """Where one item draws: its visible box on the canvas (``None``: nothing visible) and what goes into it."""

    box: Box | None
    band: Band | None
    lines: tuple[LinePlan, ...]
    color: tuple[int, int, int]
    missing: tuple[str, ...] = ()  # "U+XXXX" of the characters drawn as .notdef

    @property
    def stamps(self) -> int:
        return sum(len(line.stamps) for line in self.lines)


@dataclass(frozen=True)
class Picture:
    """A cropped raster: straight-alpha RGBA rows and the canvas position of the top-left pixel."""

    x: int
    y: int
    pixels: NDArray[np.uint8]

    @property
    def box(self) -> Box:
        rows, columns = self.pixels.shape[:2]
        return Box(self.x, self.y, self.x + columns, self.y + rows)


def _visible_box(mask: Mask, stamp: Stamp, canvas: Box) -> Box | None:
    """The canvas pixels a stamped mask touches."""
    x, y = stamp.x + mask.left, stamp.y + mask.top
    rows, columns = mask.pixels.shape
    x0, y0, x1, y1 = max(x, canvas.x0), max(y, canvas.y0), min(x + columns, canvas.x1), min(y + rows, canvas.y1)
    if x0 >= x1 or y0 >= y1:
        return None
    if (x1 - x0, y1 - y0) == (columns, rows):
        return Box(x0, y0, x1, y1)  # masks are trimmed: all of the rectangle is visible
    inside = mask.pixels[y0 - y : y1 - y, x0 - x : x1 - x]
    seen_rows = np.flatnonzero(inside.any(axis=1))
    if seen_rows.size == 0:
        return None
    seen_columns = np.flatnonzero(inside.any(axis=0))
    return Box(
        x0 + int(seen_columns[0]), y0 + int(seen_rows[0]), x0 + int(seen_columns[-1]) + 1, y0 + int(seen_rows[-1]) + 1
    )


def _stamp_into(target: NDArray[np.generic], box: Box, mask: Mask, stamp: Stamp, combine: np.ufunc) -> None:
    """Combine a stamped mask into ``target``, an array covering ``box``."""
    x, y = stamp.x + mask.left, stamp.y + mask.top
    rows, columns = mask.pixels.shape
    x0, y0, x1, y1 = max(x, box.x0), max(y, box.y0), min(x + columns, box.x1), min(y + rows, box.y1)
    if x0 < x1 and y0 < y1:
        part = target[y0 - box.y0 : y1 - box.y0, x0 - box.x0 : x1 - box.x0]
        combine(part, mask.pixels[y0 - y : y1 - y, x0 - x : x1 - x], out=part)


def _edge_coverage(low: float, high: float, limit: int) -> tuple[int, NDArray[np.float64]]:
    """How much of each pixel in ``[0, limit)`` the interval ``[low, high)`` covers, from the first touched pixel."""
    first, last = max(0, math.floor(low)), min(limit, math.ceil(high))
    if last <= first:
        return first, np.zeros(0)
    edges = np.arange(first, last + 1, dtype=np.float64)
    return first, np.clip(np.minimum(edges[1:], high) - np.maximum(edges[:-1], low), 0.0, 1.0)


def _band_mask(band: Band, canvas: Box) -> tuple[Box, NDArray[np.uint8]] | None:
    """8-bit coverage of the band rectangle (fractional edges cover their pixel partly), trimmed."""
    x, across = _edge_coverage(band.x, band.x + band.width, canvas.x1)
    y, down = _edge_coverage(band.y, band.y + band.height, canvas.y1)
    coverage = np.rint(np.outer(down, across) * 255).astype(np.uint8)
    rows = np.flatnonzero(coverage.any(axis=1))
    if rows.size == 0:
        return None
    columns = np.flatnonzero(coverage.any(axis=0))
    top, left = int(rows[0]), int(columns[0])
    trimmed = coverage[top : int(rows[-1]) + 1, left : int(columns[-1]) + 1]
    return Box(x + left, y + top, x + left + trimmed.shape[1], y + top + trimmed.shape[0]), trimmed


def _lay_black(
    alpha: NDArray[np.float32], ink: NDArray[np.float32], coverage: NDArray[np.generic], opacity: float
) -> None:
    """Source-over of translucent black through ``coverage`` (in place)."""
    cover = coverage.astype(np.float32) * np.float32(opacity) / _FULL
    keep = np.float32(1) - cover
    ink *= keep
    alpha *= keep
    alpha += cover


def _lay_ink(alpha: NDArray[np.float32], ink: NDArray[np.float32], coverage: NDArray[np.generic]) -> None:
    """Source-over of the opaque fill colour through ``coverage`` (in place)."""
    cover = coverage.astype(np.float32) / _FULL
    keep = np.float32(1) - cover
    ink *= keep
    ink += cover
    alpha *= keep
    alpha += cover


def _to_rgba(alpha: NDArray[np.float32], ink: NDArray[np.float32], color: tuple[int, int, int]) -> NDArray[np.uint8]:
    """Straight-alpha 8-bit RGBA from the premultiplied planes; transparent pixels are all zero."""
    share = np.divide(ink, alpha, out=np.zeros_like(ink), where=alpha > 0)
    np.minimum(share, np.float32(1), out=share)
    pixels = np.empty((*alpha.shape, 4), dtype=np.uint8)
    levels: dict[int, NDArray[np.float32]] = {}
    for channel, value in enumerate(color):
        if value not in levels:
            levels[value] = np.rint(share * np.float32(value))
        pixels[..., channel] = levels[value]
    pixels[..., 3] = np.rint(np.minimum(alpha, np.float32(1)) * _FULL)
    return pixels


def _rgb(color: str) -> tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


class Painter:
    """Plans and paints the items of one canvas size."""

    def __init__(
        self, book: FontBook, harfbuzz: HarfBuzz, rasterizer: GlyphRasterizer, width: int, height: int
    ) -> None:
        self._book = book
        self._harfbuzz = harfbuzz
        self._rasterizer = rasterizer
        self._canvas = Box(0, 0, width, height)
        self._plans: OrderedDict[tuple[Any, ...], Plan] = OrderedDict()
        self._planned_stamps = 0

    def plan(self, spec: TextSpec) -> Plan:
        """Lay out and shape ``spec``; refuse an item that leaves no visible pixel on the canvas.

        The most recent plans are remembered (bounded by their glyph count), so asking for the box
        of a caption first and for its pixels later usually lays it out once.
        """
        identity = spec.identity()
        plan = self._plans.get(identity)
        if plan is not None:
            self._plans.move_to_end(identity)
            return plan
        plan = self._plans[identity] = self._plan(spec)
        self._planned_stamps += plan.stamps
        while self._planned_stamps > _PLAN_CACHE_STAMPS and len(self._plans) > 1:
            _, dropped = self._plans.popitem(last=False)
            self._planned_stamps -= dropped.stamps
        return plan

    def _plan(self, spec: TextSpec) -> Plan:
        style = spec.style
        family = style.font_family if style else LEGACY_FONT_FAMILY
        bold = (style.font_weight if style else LEGACY_FONT_WEIGHT) >= BOLD_FROM_WEIGHT
        shapers: dict[int, LineShaper] = {}

        def shaper_at(font_px: float) -> LineShaper:
            size = js_round(font_px * 64)
            if size not in shapers:
                shapers[size] = LineShaper(self._book, self._harfbuzz, family, bold, size)
            return shapers[size]

        def measure(text: str, font_px: float, _style: TextStyle | None) -> float:
            return shaper_at(font_px).measure(text)

        layout = layout_title(spec, self._canvas.x1, self._canvas.y1, measure)
        size = js_round(layout.font_px * 64)
        ascent = self._book.primary(family, bold).em_ascent(size)
        drawing = shaper_at(layout.font_px)
        lines = []
        for index, text in enumerate(layout.lines):
            baseline = js_round(layout.line_top(index) * 64) + ascent
            stamps = tuple(self._stamps(drawing.shape(text), layout, baseline, size))
            lines.append(LinePlan(union(self._stamp_boxes(stamps)), stamps))
        boxes = [line.box for line in lines if line.box is not None]
        band = _band_mask(layout.band, self._canvas) if layout.band is not None else None
        if band is not None:
            boxes.append(band[0])
        return Plan(union(boxes), layout.band, tuple(lines), _rgb(layout.color), tuple(drawing.missing))

    def _stamps(self, line: ShapedLine, layout: TitleLayout, baseline: int, size: int) -> Iterator[Stamp]:
        """The glyphs of a shaped line at their canvas positions (26.6 split into pixel and remainder)."""
        limit = layout.max_width * 64
        x_scale = UNSCALED if line.width <= limit else (limit << 16) // line.width
        drawn = min(line.width, limit)
        anchor = js_round(layout.x * 64)
        start = anchor if layout.align == "left" else anchor - drawn if layout.align == "right" else anchor - drawn // 2
        radius = layout.stroke_px * 32  # half the line width, 26.6
        for glyph in line.glyphs:
            x = start + (glyph.x if x_scale == UNSCALED else (glyph.x * x_scale + 0x8000) >> 16)
            y = baseline - glyph.y
            key = GlyphKey(glyph.face, size, radius, glyph.glyph, x & 63, y & 63, x_scale)
            yield Stamp(key, x >> 6, y >> 6)

    def _stamp_boxes(self, stamps: Iterable[Stamp]) -> Iterator[Box]:
        for stamp in stamps:
            masks = self._rasterizer.masks(stamp.key)
            for mask in (masks.fill, masks.stroke):
                box = _visible_box(mask, stamp, self._canvas) if mask is not None else None
                if box is not None:
                    yield box

    def paint(self, plan: Plan) -> Picture:
        """Composite a plan into its box; a plan without one is a single transparent pixel at the origin."""
        box = plan.box
        if box is None:
            return Picture(0, 0, np.zeros((1, 1, 4), dtype=np.uint8))
        alpha = np.zeros((box.height, box.width), dtype=np.float32)
        ink = np.zeros((box.height, box.width), dtype=np.float32)
        band = _band_mask(plan.band, self._canvas) if plan.band is not None else None
        if band is not None:
            where = band[0].within(box)
            _lay_black(alpha[where], ink[where], band[1], BAND_OPACITY)
        for line in plan.lines:
            if line.box is not None:
                self._paint_line(line.stamps, line.box, alpha[line.box.within(box)], ink[line.box.within(box)])
        return Picture(box.x0, box.y0, _to_rgba(alpha, ink, plan.color))

    def _paint_line(
        self, stamps: tuple[Stamp, ...], box: Box, alpha: NDArray[np.float32], ink: NDArray[np.float32]
    ) -> None:
        stroke = np.zeros((box.height, box.width), dtype=np.uint8)
        fill = np.zeros((box.height, box.width), dtype=np.uint16)
        for stamp in stamps:
            masks = self._rasterizer.masks(stamp.key)
            if masks.stroke is not None:
                _stamp_into(stroke, box, masks.stroke, stamp, np.maximum)
            if masks.fill is not None:
                _stamp_into(fill, box, masks.fill, stamp, np.add)
        _lay_black(alpha, ink, stroke, STROKE_OPACITY)
        _lay_ink(alpha, ink, np.minimum(fill, 255))


def compose(pictures: Iterable[Picture], box: Box) -> NDArray[np.uint8]:
    """The pictures composited source-over, first at the bottom, onto a transparent frame covering ``box``.

    Straight-alpha 8-bit in and out, in exact integer arithmetic (results round half up): with
    ``A = 255 * top_alpha + under_alpha * (255 - top_alpha)`` the alpha is ``A / 255`` and a colour
    channel is ``(255 * top * top_alpha + under * under_alpha * (255 - top_alpha)) / A``. A picture
    over a transparent area is copied unchanged.
    """
    frame = np.zeros((box.height, box.width, 4), dtype=np.uint8)
    for picture in pictures:
        under = frame[picture.box.within(box)]
        if not under[..., 3].any():
            under[...] = picture.pixels
            continue
        top_alpha = picture.pixels[..., 3:].astype(np.uint32)
        under_weight = under[..., 3:] * (255 - top_alpha)
        total = 255 * top_alpha + under_weight
        color = 255 * top_alpha * picture.pixels[..., :3] + under_weight * under[..., :3]
        under[..., :3] = (2 * color + total) // np.maximum(2 * total, 1)
        under[..., 3:] = (total + 127) // 255
    return frame


def png_scanlines(pixels: NDArray[np.uint8]) -> bytes:
    """Unfiltered PNG scan lines of an RGBA array: every row behind a filter-type byte of zero."""
    rows, columns = pixels.shape[:2]
    lines = np.empty((rows, 1 + columns * 4), dtype=np.uint8)
    lines[:, 0] = NO_FILTER
    lines[:, 1:] = pixels.reshape(rows, columns * 4)
    return lines.tobytes()
