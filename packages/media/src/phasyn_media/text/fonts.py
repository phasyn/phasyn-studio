"""Font selection: the editor's family stacks resolved through fontconfig, with per-cluster fallback.

For a family (``sans``, ``serif`` or ``mono``) and a weight there are two sorted font lists: the
plain one, and one that prefers fonts covering Traditional Chinese (``lang=zh-tw``). A cluster of
East Asian characters walks the second list, any other cluster the first, and the first font with
glyphs for the whole cluster draws it, as a browser falls back character by character. A cluster no
usable font covers is drawn by the primary face, which gives ``.notdef`` for what it lacks (the
shaper names those characters); nothing is left out silently.

The first usable font of the plain list is the *primary* face. As in a browser, it alone decides
where the baseline sits in the line box: canvas ``textBaseline = "top"`` puts the top of its em
box at the given y. The em box is one em split between ascent and descent in the ratio of the OS/2
typographic ascender and descender (the font's ``hhea`` values when those are missing), which is
how Chromium and Firefox compute it; every fallback font draws on that same baseline.

A font file larger than :data:`MAX_FONT_FILE_BYTES`, or one FreeType cannot use as a scalable face
with a Unicode character map, is not opened; it is named in :meth:`FontBook.skipped_fonts`.
"""

from __future__ import annotations

import os
import struct
import unicodedata
from collections.abc import Mapping
from typing import Any

from .chars import is_cjk, needs_glyph
from .fc import Fontconfig, FontRecord
from .ft import FaceHandle, FreeType
from .hb import HarfBuzz
from .model import MAX_SKIPPED_FONTS, TextFailure

# TITLE_FONT_FAMILIES of the editor (titleLayout.ts); the last name of each stack is the generic family.
FONT_STACKS: Mapping[str, tuple[str, ...]] = {
    "sans": ("PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "system-ui", "sans-serif"),
    "serif": ("Noto Serif TC", "Songti TC", "PMingLiU", "serif"),
    "mono": ("ui-monospace", "Noto Sans Mono", "Cascadia Mono", "monospace"),
}
CJK_LANGUAGE = "zh-tw"
BOLD_FROM_WEIGHT = 600  # CSS weights from 600 select the bold face (or synthetic bold)
# FreeType maps a whole font file; the largest pan-CJK collections are well below this.
MAX_FONT_FILE_BYTES = 256 * 1024 * 1024

_TYPO_METRICS_OFFSET = 68  # sTypoAscender, sTypoDescender in the OS/2 table
_FALLBACK_EM_SPLIT = (4, 1)  # a font without usable vertical metrics: ascent 0.8 em


def _valid_split(ascent: int, descent: int) -> bool:
    return ascent + descent > 0 and 0 <= ascent <= ascent + descent


def _parse_variations(text: str) -> dict[str, float]:
    """``"wght=700,wdth=100"`` as fontconfig writes design coordinates."""
    settings: dict[str, float] = {}
    for item in text.split(","):
        tag, _, value = item.partition("=")
        try:
            settings[tag.strip()] = float(value)
        except ValueError as exc:
            raise TextFailure("text_render_failed", "unreadable font variations") from exc
    return settings


def _em_split(handle: FaceHandle, freetype: FreeType) -> tuple[int, int]:
    typo = freetype.sfnt_table(handle, b"OS/2", _TYPO_METRICS_OFFSET, 4)
    if typo is not None:
        ascender, descender = struct.unpack(">hh", typo)
        if ascender > 0 and _valid_split(ascender, -descender):
            return ascender, -descender
    metrics = freetype.metrics(handle)
    if _valid_split(metrics.ascender, -metrics.descender):
        return metrics.ascender, -metrics.descender
    return _FALLBACK_EM_SPLIT


class Face:
    """An open font face with its HarfBuzz font; one object serves every size."""

    def __init__(self, face_id: int, record: FontRecord, handle: FaceHandle, freetype: FreeType, harfbuzz: HarfBuzz):
        self.id = face_id
        self.record = record
        self.handle = handle
        self._freetype = freetype
        self._harfbuzz = harfbuzz
        self._size = 0
        self._glyphs: dict[str, bool] = {}
        self._em = _em_split(handle, freetype)
        self.font = harfbuzz.font(handle, embolden=record.embolden)  # last: nothing after it can fail

    def at_size(self, size: int) -> None:
        """Make ``size`` (pixels per em, 26.6) the size of the next shaping and glyph loads."""
        if size != self._size:
            self._freetype.set_size(self.handle, size)
            self._harfbuzz.font_changed(self.font)
            self._size = size

    def has_glyph(self, char: str) -> bool:
        known = self._glyphs.get(char)
        if known is None:
            known = self._glyphs[char] = self._freetype.char_index(self.handle, ord(char)) != 0
        return known

    def em_ascent(self, size: int) -> int:
        """Distance from the top of the em box to the baseline at ``size``, 26.6 (rounded to 1/64 px)."""
        ascent, descent = self._em
        return (2 * ascent * size + ascent + descent) // (2 * (ascent + descent))

    def description(self) -> dict[str, Any]:
        """What the result reports about a font: never more of its path than the base name."""
        record = self.record
        return {
            "family": record.family,
            "style": record.style,
            "file": os.fsdecode(os.path.basename(record.file)),
            "index": record.index,
            "synthetic_bold": record.embolden,
            "variations": record.variations,
        }


class FontBook:
    """The fonts of one worker run: sorted lists per family and weight, faces opened on first use."""

    def __init__(self, freetype: FreeType, harfbuzz: HarfBuzz, fontconfig: Fontconfig) -> None:
        self._freetype = freetype
        self._harfbuzz = harfbuzz
        self._fontconfig = fontconfig
        self._lists: dict[tuple[str, bool, bool], list[FontRecord]] = {}
        self._opened: dict[tuple[bytes, int, str, bool], Face | None] = {}
        self._choices: dict[tuple[str, bool, str], Face] = {}
        self._primaries: dict[tuple[str, bool], Face] = {}
        self._faces: list[Face] = []
        self._used: dict[int, None] = {}  # face ids in the order they first drew a cluster
        self._skipped: dict[bytes, str] = {}  # font file -> too_large | unusable

    def close(self) -> None:
        """Release every face: its HarfBuzz font, then the FreeType face (idempotent)."""
        while self._faces:
            face = self._faces.pop()
            self._harfbuzz.destroy_font(face.font)
            self._freetype.close_face(face.handle)
        self._opened.clear()
        self._choices.clear()
        self._primaries.clear()

    def face(self, face_id: int) -> Face:
        return self._faces[face_id]

    def used_fonts(self) -> list[dict[str, Any]]:
        return [self._faces[face_id].description() for face_id in self._used]

    def skipped_fonts(self) -> list[dict[str, str]]:
        """Fonts fontconfig offered that were not opened, base names only (at most ``MAX_SKIPPED_FONTS``)."""
        named = list(self._skipped.items())[:MAX_SKIPPED_FONTS]
        return [{"file": os.fsdecode(os.path.basename(file)), "reason": reason} for file, reason in named]

    def primary(self, family: str, bold: bool) -> Face:
        """The face whose em box positions the baseline (the first usable font of the plain list)."""
        key = (family, bold)
        face = self._primaries.get(key)
        if face is None:
            opened = (self._open(record) for record in self._records(family, bold, cjk=False))
            face = next((candidate for candidate in opened if candidate is not None), None)
            if face is None:
                raise TextFailure("text_font_missing", f"no usable font for {family}")
            self._primaries[key] = face
        return face

    def face_for(self, family: str, bold: bool, cluster: str) -> Face:
        """The face that draws a cluster: the first of the matching list with glyphs for all of it."""
        key = (family, bold, cluster)
        face = self._choices.get(key)
        if face is None:
            face = self._choices[key] = self._choose(family, bold, cluster)
        self._used.setdefault(face.id)
        return face

    def _choose(self, family: str, bold: bool, cluster: str) -> Face:
        needed = "".join(char for char in cluster if needs_glyph(char))
        if not needed:
            return self.primary(family, bold)
        # HarfBuzz composes or decomposes a cluster when the font only has the other form.
        forms = dict.fromkeys((needed, unicodedata.normalize("NFC", needed), unicodedata.normalize("NFD", needed)))
        for record in self._records(family, bold, cjk=is_cjk(needed[0])):
            for form in forms:
                if all(self._fontconfig.has_char(record, ord(char)) for char in form):
                    face = self._open(record)
                    if face is not None and all(face.has_glyph(char) for char in form):
                        return face
        # No usable font covers the cluster: the primary face draws its .notdef, which the shaper names.
        return self.primary(family, bold)

    def _records(self, family: str, bold: bool, *, cjk: bool) -> list[FontRecord]:
        key = (family, bold, cjk)
        records = self._lists.get(key)
        if records is None:
            language = CJK_LANGUAGE if cjk else None
            records = self._fontconfig.sorted_fonts(FONT_STACKS[family], bold=bold, language=language)
            self._lists[key] = records
        return records

    def _open(self, record: FontRecord) -> Face | None:
        """The face of a record, ``None`` when the file is not used (the next font is tried)."""
        key = (record.file, record.index, record.variations, record.embolden)
        if key not in self._opened:
            self._opened[key] = self._open_face(record)
        return self._opened[key]

    def _open_face(self, record: FontRecord) -> Face | None:
        try:
            size = os.stat(record.file).st_size
        except OSError:
            size = None
        if size is None or size > MAX_FONT_FILE_BYTES:
            self._skipped.setdefault(record.file, "unusable" if size is None else "too_large")
            return None
        handle = self._freetype.open_face(record.file, record.index)
        if handle is None:
            self._skipped.setdefault(record.file, "unusable")
            return None
        try:
            if record.variations:
                self._freetype.set_design_coordinates(handle, _parse_variations(record.variations))
            face = Face(len(self._faces), record, handle, self._freetype, self._harfbuzz)
        except BaseException:
            self._freetype.close_face(handle)
            raise
        self._faces.append(face)
        return face
