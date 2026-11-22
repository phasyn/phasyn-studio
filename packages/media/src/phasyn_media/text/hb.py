"""HarfBuzz through ``ctypes``: shaping runs of code points with FreeType-backed fonts.

A font is created from an open ``FT_Face`` (``hb_ft_font_create_referenced``), so advances come
from FreeType with the same load flags the rasteriser uses, and its scale is the size last set on
that face: positions are 26.6 pixels. Text is always left to right; the language asks pan-CJK
fonts for their Traditional Chinese (Taiwan) forms and has no effect on other fonts. The default
features apply (kerning and standard ligatures included), as on a browser canvas.

``hb_glyph_info_t`` and ``hb_glyph_position_t`` are five 32-bit fields each (public ABI):
``codepoint, mask, cluster, var1, var2`` and ``x_advance, y_advance, x_offset, y_offset, var``.
They are copied out of the buffer before it is shaped again.

Ownership: the shaping buffer belongs to the :class:`HarfBuzz` object (:meth:`HarfBuzz.close`); a font
belongs to whoever created it and is released with :meth:`HarfBuzz.destroy_font`, which also drops the
font's reference to its FreeType face.
"""

from __future__ import annotations

from ctypes import (
    POINTER,
    byref,
    c_char_p,
    c_float,
    c_int,
    c_int32,
    c_uint,
    c_uint32,
    c_void_p,
)
from typing import Any, NamedTuple

from .ft import LOAD_FLAGS
from .model import TextFailure
from .native import bind, load


SONAME = "libharfbuzz.so.0"
LANGUAGE = "zh-Hant-TW"
# FT_GlyphSlot_Embolden's strength as a fraction of the em; HarfBuzz widens the advances by the same amount.
SYNTHETIC_BOLD = 1 / 24


def _script(tag: str) -> int:
    return int.from_bytes(tag.encode("ascii"), "big")


SCRIPT_COMMON = _script("Zyyy")
# Characters of these scripts take the script of their neighbours.
WEAK_SCRIPTS = frozenset({SCRIPT_COMMON, _script("Zinh"), _script("Zzzz")})

_DIRECTION_LTR = 4
_REMOVE_DEFAULT_IGNORABLES = 0x8
_FIELDS = 5


class ShapedGlyph(NamedTuple):
    """A glyph identifier, offset, and advance from HarfBuzz."""

    glyph: int  # glyph index in the font, 0 for a missing glyph
    cluster: int  # index of the first code point it came from
    x_advance: int
    x_offset: int
    y_offset: int  # upwards


def synthetic_bold_strength(size: int) -> int:
    """The 26.6 widening HarfBuzz applies to a glyph at ``size`` (``roundf(scale * embolden)``)."""
    return (size + 12) // 24


class HarfBuzz:
    """The HarfBuzz library and one reusable shaping buffer."""

    def __init__(self) -> None:
        """Load and bind the native shaping functions."""
        lib = load(SONAME)
        self._version_string = bind(lib, "hb_version_string", c_char_p)
        self._font_destroy = bind(lib, "hb_font_destroy", None, c_void_p)
        self._buffer_destroy = bind(lib, "hb_buffer_destroy", None, c_void_p)
        self._unicode_script = bind(
            lib, "hb_unicode_script", c_uint32, c_void_p, c_uint32
        )
        self._font_create = bind(
            lib, "hb_ft_font_create_referenced", c_void_p, c_void_p
        )
        self._font_set_load_flags = bind(
            lib, "hb_ft_font_set_load_flags", None, c_void_p, c_int
        )
        self._font_changed = bind(lib, "hb_ft_font_changed", None, c_void_p)
        self._font_set_synthetic_bold = bind(
            lib, "hb_font_set_synthetic_bold", None, c_void_p, c_float, c_float, c_int
        )
        self._buffer_clear = bind(lib, "hb_buffer_clear_contents", None, c_void_p)
        self._buffer_add = bind(
            lib,
            "hb_buffer_add_codepoints",
            None,
            c_void_p,
            POINTER(c_uint32),
            c_int,
            c_uint,
            c_int,
        )
        self._buffer_set_direction = bind(
            lib, "hb_buffer_set_direction", None, c_void_p, c_int
        )
        self._buffer_set_script = bind(
            lib, "hb_buffer_set_script", None, c_void_p, c_uint32
        )
        self._buffer_set_language = bind(
            lib, "hb_buffer_set_language", None, c_void_p, c_void_p
        )
        self._buffer_ok = bind(lib, "hb_buffer_allocation_successful", c_int, c_void_p)
        self._shape = bind(lib, "hb_shape", None, c_void_p, c_void_p, c_void_p, c_uint)
        self._glyph_infos = bind(
            lib, "hb_buffer_get_glyph_infos", c_void_p, c_void_p, POINTER(c_uint)
        )
        self._glyph_positions = bind(
            lib, "hb_buffer_get_glyph_positions", c_void_p, c_void_p, POINTER(c_uint)
        )
        self._empty_font = bind(lib, "hb_font_get_empty", c_void_p)()
        self._unicode = bind(lib, "hb_unicode_funcs_get_default", c_void_p)()
        set_flags = bind(lib, "hb_buffer_set_flags", None, c_void_p, c_int)
        self._language = bind(
            lib, "hb_language_from_string", c_void_p, c_char_p, c_int
        )(LANGUAGE.encode("ascii"), -1)
        self._buffer: int | None = bind(lib, "hb_buffer_create", c_void_p)()
        set_flags(self._buffer, _REMOVE_DEFAULT_IGNORABLES)
        if not self._language or not self._buffer_ok(self._buffer):
            self.close()
            raise TextFailure("text_render_failed", "HarfBuzz allocation failed")
        self._scripts: dict[str, int] = {}

    def close(self) -> None:
        """Destroy the shaping buffer (idempotent)."""
        if self._buffer:
            self._buffer_destroy(self._buffer)
            self._buffer = None

    def version(self) -> str:
        """Return the loaded native library version."""
        return str(self._version_string().decode("ascii", "replace"))

    def script(self, char: str) -> int:
        """The ISO 15924 tag of a character's script as HarfBuzz's own Unicode tables give it."""
        script = self._scripts.get(char)
        if script is None:
            script = self._scripts[char] = int(
                self._unicode_script(self._unicode, ord(char))
            )
        return script

    def font(self, face: Any, *, embolden: bool) -> int:
        """A font for an open FreeType face (``FaceHandle``); it follows the size set on that face."""
        font = self._font_create(face)
        if not font or font == self._empty_font:
            raise TextFailure("text_render_failed", "HarfBuzz could not create a font")
        self._font_set_load_flags(font, LOAD_FLAGS)
        if embolden:
            self._font_set_synthetic_bold(font, SYNTHETIC_BOLD, SYNTHETIC_BOLD, 0)
        return int(font)

    def destroy_font(self, font: int) -> None:
        """Release a font made by :meth:`font`."""
        self._font_destroy(font)

    def font_changed(self, font: int) -> None:
        """Take over the size (and variation coordinates) just set on the font's FreeType face."""
        self._font_changed(font)

    @staticmethod
    def code_points(text: str) -> Any:
        """The UTF-32 array ``shape`` takes."""
        return (c_uint32 * len(text))(*map(ord, text))

    def _shape_run(
        self, font: int, text: Any, start: int, length: int, script: int
    ) -> tuple[int, int, int]:
        """Shape into the buffer; returns the glyph count and the addresses of the info and position arrays."""
        buffer = self._buffer
        if not buffer:
            raise TextFailure("text_render_failed", "HarfBuzz already closed")
        self._buffer_clear(buffer)
        self._buffer_add(buffer, text, len(text), start, length)
        self._buffer_set_direction(buffer, _DIRECTION_LTR)
        self._buffer_set_script(buffer, script)
        self._buffer_set_language(buffer, self._language)
        self._shape(font, buffer, None, 0)
        if not self._buffer_ok(buffer):
            raise TextFailure("text_render_failed", "HarfBuzz allocation failed")
        count, placed = c_uint(), c_uint()
        infos = self._glyph_infos(buffer, byref(count))
        positions = self._glyph_positions(buffer, byref(placed))
        if count.value and (not infos or not positions or placed.value != count.value):
            raise TextFailure(
                "text_render_failed", "HarfBuzz returned no glyph positions"
            )
        return count.value, infos or 0, positions or 0

    def advance(
        self, font: int, text: Any, start: int, length: int, script: int
    ) -> int:
        """The summed advance (26.6) of ``length`` code points of ``text`` from ``start``."""
        count, _, positions = self._shape_run(font, text, start, length, script)
        if count == 0:
            return 0
        return sum((c_int32 * (count * _FIELDS)).from_address(positions)[::_FIELDS])

    def shape(
        self, font: int, text: Any, start: int, length: int, script: int
    ) -> list[ShapedGlyph]:
        """Shape ``length`` code points of ``text`` from ``start``; the rest of the line is context only."""
        count, infos, positions = self._shape_run(font, text, start, length, script)
        if count == 0:
            return []
        values = count * _FIELDS
        info = (c_uint32 * values).from_address(infos)[:]
        position = (c_int32 * values).from_address(positions)[:]
        return [
            ShapedGlyph(
                info[at], info[at + 2], position[at], position[at + 2], position[at + 3]
            )
            for at in range(0, values, _FIELDS)
        ]
