"""Shaping a line of text: clusters to fonts, fonts and scripts to runs, runs through HarfBuzz.

A line is cut into clusters (:func:`~phasyn_media.text.chars.clusters`) and every cluster gets
the first font that can draw it. Neighbouring clusters of one font form a font run; inside it,
characters without a script of their own (spaces, digits, punctuation, combining marks) take the
script of the character before them, or of the first scripted character when they lead. Each
stretch of one font and one script is shaped on its own, with the whole line as context, and the
glyphs are laid end to end.

The width of a line is the sum of its advances. That is the ``measure`` the layout is given, and
the line that is finally drawn is shaped the same way, so what was measured is what is drawn.

A glyph index of 0 is the font's ``.notdef``: it is drawn (a browser draws it too) and the
characters of its cluster that the font lacks are added to :attr:`LineShaper.missing`.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .chars import clusters, code_point_label, needs_glyph
from .fonts import Face, FontBook
from .hb import SCRIPT_COMMON, WEAK_SCRIPTS, HarfBuzz, ShapedGlyph


@dataclass(frozen=True)
class PlacedGlyph:
    """A glyph of a shaped line: its origin relative to the start of the line, on the baseline."""

    face: int  # FontBook face id
    glyph: int
    x: int  # 26.6, to the right
    y: int  # 26.6, upwards


@dataclass(frozen=True)
class ShapedLine:
    width: int  # 26.6 sum of the advances
    glyphs: tuple[PlacedGlyph, ...]


@dataclass(frozen=True)
class _Run:
    """A stretch of one font and one script: ``length`` code points from ``start``."""

    face: Face
    script: int
    start: int
    length: int


def _cluster_ends(shaped: Sequence[ShapedGlyph], end: int) -> dict[int, int]:
    """Where each cluster of a left-to-right run ends (index into the line's code points, exclusive)."""
    starts = sorted({glyph.cluster for glyph in shaped})
    return dict(zip(starts, [*starts[1:], end], strict=True))


def _resolve(scripts: list[int]) -> list[int]:
    """Give the characters of one font run that have no script of their own their neighbour's."""
    current = next((script for script in scripts if script not in WEAK_SCRIPTS), SCRIPT_COMMON)
    resolved = []
    for script in scripts:
        if script not in WEAK_SCRIPTS:
            current = script
        resolved.append(current)
    return resolved


class LineShaper:
    """Shapes the lines of one item: one family, one weight, one pixel size (26.6)."""

    def __init__(self, book: FontBook, harfbuzz: HarfBuzz, family: str, bold: bool, size: int) -> None:
        self._book = book
        self._harfbuzz = harfbuzz
        self._family = family
        self._bold = bold
        self._size = size
        self._widths: dict[str, int] = {}
        self._clusters: dict[str, tuple[Face, int]] = {}
        self.missing: dict[str, None] = {}  # "U+XXXX" of characters drawn as .notdef, in order of appearance

    def measure(self, text: str) -> float:
        """The width of ``text`` in pixels."""
        width = self._widths.get(text)
        if width is None:
            code_points, runs = self._itemize(text)
            advance = self._harfbuzz.advance
            width = sum(advance(run.face.font, code_points, run.start, run.length, run.script) for run in runs)
            self._widths[text] = width
        return width / 64

    def shape(self, text: str) -> ShapedLine:
        """The positioned glyphs of ``text``; a character no font has is drawn as ``.notdef`` and named."""
        code_points, runs = self._itemize(text)
        glyphs: list[PlacedGlyph] = []
        pen = 0
        for run in runs:
            shaped = self._harfbuzz.shape(run.face.font, code_points, run.start, run.length, run.script)
            ends = _cluster_ends(shaped, run.start + run.length)
            for glyph in shaped:
                if glyph.glyph == 0:
                    self._name_missing(run.face, code_points[glyph.cluster : ends[glyph.cluster]])
                glyphs.append(PlacedGlyph(run.face.id, glyph.glyph, pen + glyph.x_offset, glyph.y_offset))
                pen += glyph.x_advance
        return ShapedLine(pen, tuple(glyphs))

    def _name_missing(self, face: Face, cluster: Sequence[int]) -> None:
        """The characters of a cluster drawn as ``.notdef``: those the face lacks (else the first one)."""
        chars = [chr(code) for code in cluster]
        lacking = [char for char in chars if needs_glyph(char) and not face.has_glyph(char)] or chars[:1]
        for char in lacking:
            self.missing.setdefault(code_point_label(char))

    def _itemize(self, text: str) -> tuple[Any, list[_Run]]:
        """The code points that reach the shaper and their runs; every face involved is at this size."""
        parts = clusters(text)
        chosen = [self._cluster(part) for part in parts]
        runs: list[_Run] = []
        start = 0
        first = 0
        while first < len(parts):
            face = chosen[first][0]
            last = first
            while last < len(parts) and chosen[last][0] is face:
                last += 1
            face.at_size(self._size)
            scripts = _resolve([script for _, script in chosen[first:last]])
            run_start, run_script = start, scripts[0]
            for part, script in zip(parts[first:last], scripts, strict=True):
                if script != run_script:
                    runs.append(_Run(face, run_script, run_start, start - run_start))
                    run_start, run_script = start, script
                start += len(part)
            runs.append(_Run(face, run_script, run_start, start - run_start))
            first = last
        return self._harfbuzz.code_points("".join(parts)), runs

    def _cluster(self, part: str) -> tuple[Face, int]:
        """The face that draws a cluster and the script of its first character."""
        chosen = self._clusters.get(part)
        if chosen is None:
            face = self._book.face_for(self._family, self._bold, part)
            chosen = self._clusters[part] = (face, self._harfbuzz.script(part[0]))
        return chosen
