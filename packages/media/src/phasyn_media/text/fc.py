"""Fontconfig through ``ctypes``: the sorted list of installed fonts for a family stack.

A pattern of family names, weight and (optionally) language is substituted with the system
configuration and sorted with ``FcFontSort``; each font is then prepared for rendering
(``FcFontRenderPrepare``), which is where fontconfig decides synthetic emboldening and the design
coordinates of a variable font. Only scalable TrueType and CFF outline fonts without colour glyphs
are kept: FreeType renders those as plain outlines. No file name is hard-coded anywhere, and no
path ever comes from a document: the fonts are the ones the system configuration lists (the worker
runs without ``HOME``, so per-user configuration and font directories are not read).

Ownership: the configuration (``FcInitLoadConfigAndFonts``) and every prepared pattern that backs a
kept :class:`FontRecord` (it owns the record's character set) belong to this object and are destroyed
by :meth:`Fontconfig.close`; a record must not be used after that. Search patterns and font sets are
destroyed before the call that made them returns, on every path.
"""

from __future__ import annotations

from collections.abc import Sequence
from ctypes import POINTER, Structure, byref, c_char_p, c_int, c_uint32, c_void_p
from dataclasses import dataclass

from .model import TextFailure
from .native import bind, load, unavailable

SONAME = "libfontconfig.so.1"

_WEIGHT_REGULAR = 80
_WEIGHT_BOLD = 200
_SLANT_ROMAN = 0
_MATCH_PATTERN = 0
_RESULT_MATCH = 0
_OUTLINE_FORMATS = frozenset({b"TrueType", b"CFF"})


class _FontSet(Structure):
    _fields_ = (("nfont", c_int), ("sfont", c_int), ("fonts", POINTER(c_void_p)))


@dataclass(frozen=True)
class FontRecord:
    """One installed font as fontconfig wants it rendered for a request."""

    file: bytes
    index: int  # face index; a named instance of a variable font is in the upper 16 bits
    family: str
    style: str
    embolden: bool  # synthetic bold: the request is bold and the font is not
    variations: str  # design coordinates of a variable font ("wght=700"), else empty
    charset: int  # FcCharSet*, owned by the prepared pattern the Fontconfig object keeps until close()


def _out_of_memory() -> TextFailure:
    return TextFailure("text_render_failed", "fontconfig allocation failed")


class Fontconfig:
    """The system font configuration, loaded once per worker process."""

    def __init__(self) -> None:
        lib = load(SONAME)
        self._version = bind(lib, "FcGetVersion", c_int)
        self._pattern_create = bind(lib, "FcPatternCreate", c_void_p)
        self._pattern_destroy = bind(lib, "FcPatternDestroy", None, c_void_p)
        self._add_string = bind(lib, "FcPatternAddString", c_int, c_void_p, c_char_p, c_char_p)
        self._add_integer = bind(lib, "FcPatternAddInteger", c_int, c_void_p, c_char_p, c_int)
        self._substitute = bind(lib, "FcConfigSubstitute", c_int, c_void_p, c_void_p, c_int)
        self._default_substitute = bind(lib, "FcDefaultSubstitute", None, c_void_p)
        self._font_sort = bind(
            lib, "FcFontSort", POINTER(_FontSet), c_void_p, c_void_p, c_int, c_void_p, POINTER(c_int)
        )
        self._font_set_destroy = bind(lib, "FcFontSetDestroy", None, POINTER(_FontSet))
        self._render_prepare = bind(lib, "FcFontRenderPrepare", c_void_p, c_void_p, c_void_p, c_void_p)
        self._get_string = bind(lib, "FcPatternGetString", c_int, c_void_p, c_char_p, c_int, POINTER(c_char_p))
        self._get_integer = bind(lib, "FcPatternGetInteger", c_int, c_void_p, c_char_p, c_int, POINTER(c_int))
        self._get_bool = bind(lib, "FcPatternGetBool", c_int, c_void_p, c_char_p, c_int, POINTER(c_int))
        self._get_charset = bind(lib, "FcPatternGetCharSet", c_int, c_void_p, c_char_p, c_int, POINTER(c_void_p))
        self._has_char = bind(lib, "FcCharSetHasChar", c_int, c_void_p, c_uint32)
        self._config_destroy = bind(lib, "FcConfigDestroy", None, c_void_p)
        self._kept: list[int] = []  # prepared patterns of kept records
        self._config: int | None = bind(lib, "FcInitLoadConfigAndFonts", c_void_p)()
        if not self._config:
            raise unavailable("fontconfig has no configuration")

    def close(self) -> None:
        """Destroy the kept patterns, then the configuration (idempotent)."""
        while self._kept:
            self._pattern_destroy(self._kept.pop())
        if self._config:
            self._config_destroy(self._config)
            self._config = None

    def version(self) -> str:
        number = int(self._version())
        return f"{number // 10000}.{number // 100 % 100}.{number % 100}"

    def has_char(self, record: FontRecord, code: int) -> bool:
        """Whether fontconfig's coverage of the font includes a code point."""
        return bool(self._has_char(record.charset, code))

    def sorted_fonts(self, families: Sequence[str], *, bold: bool, language: str | None) -> list[FontRecord]:
        """The usable installed fonts, best match first, for upright text of the given weight.

        ``families`` are tried in order (the last one is the generic family); with ``language`` the
        fonts that cover that language are preferred over the generic family's own order.
        """
        if not self._config:
            raise TextFailure("text_render_failed", "fontconfig already closed")
        pattern = self._pattern_create()
        if not pattern:
            raise _out_of_memory()
        try:
            self._fill(pattern, families, bold, language)
            result = c_int()
            fonts = self._font_sort(self._config, pattern, 0, None, byref(result))
            if not fonts:
                return []
            try:
                return [
                    record
                    for record in (
                        self._prepare(pattern, fonts.contents.fonts[at]) for at in range(fonts.contents.nfont)
                    )
                    if record is not None
                ]
            finally:
                self._font_set_destroy(fonts)
        finally:
            self._pattern_destroy(pattern)

    def _fill(self, pattern: int, families: Sequence[str], bold: bool, language: str | None) -> None:
        added = [self._add_string(pattern, b"family", family.encode("utf-8")) for family in families]
        added.append(self._add_integer(pattern, b"weight", _WEIGHT_BOLD if bold else _WEIGHT_REGULAR))
        added.append(self._add_integer(pattern, b"slant", _SLANT_ROMAN))
        if language is not None:
            added.append(self._add_string(pattern, b"lang", language.encode("ascii")))
        if not all(added) or not self._substitute(self._config, pattern, _MATCH_PATTERN):
            raise _out_of_memory()
        self._default_substitute(pattern)

    def _prepare(self, pattern: int, font: int) -> FontRecord | None:
        prepared = self._render_prepare(self._config, pattern, font)
        if not prepared:
            raise _out_of_memory()
        try:
            record = self._record(prepared)
        except BaseException:
            self._pattern_destroy(prepared)
            raise
        if record is None:
            self._pattern_destroy(prepared)
        else:
            self._kept.append(prepared)  # it owns the record's charset
        return record

    def _record(self, prepared: int) -> FontRecord | None:
        file = self._string(prepared, b"file")
        charset = c_void_p()
        usable = (
            file is not None
            and self._string(prepared, b"fontformat") in _OUTLINE_FORMATS
            and self._flag(prepared, b"scalable")
            and self._flag(prepared, b"outline")
            and not self._flag(prepared, b"color")
            and self._get_charset(prepared, b"charset", 0, byref(charset)) == _RESULT_MATCH
        )
        if file is None or not usable or not charset.value:
            return None
        index = c_int()
        if self._get_integer(prepared, b"index", 0, byref(index)) != _RESULT_MATCH:
            return None
        return FontRecord(
            file=file,
            index=index.value,
            family=(self._string(prepared, b"family") or b"").decode("utf-8", "replace"),
            style=(self._string(prepared, b"style") or b"").decode("utf-8", "replace"),
            embolden=self._flag(prepared, b"embolden"),
            variations=(self._string(prepared, b"fontvariations") or b"").decode("ascii", "replace"),
            charset=charset.value,
        )

    def _string(self, pattern: int, name: bytes) -> bytes | None:
        """A string property, copied out of the pattern (the pattern keeps the original)."""
        value = c_char_p()
        if self._get_string(pattern, name, 0, byref(value)) != _RESULT_MATCH:
            return None
        return value.value

    def _flag(self, pattern: int, name: bytes) -> bool:
        """A boolean property; one the font or this fontconfig version does not have is false."""
        value = c_int()
        return self._get_bool(pattern, name, 0, byref(value)) == _RESULT_MATCH and bool(value.value)
