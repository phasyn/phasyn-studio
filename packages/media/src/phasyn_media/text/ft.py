"""FreeType through ``ctypes``: faces, unhinted outlines, emboldening, stroking and grey rasterisation.

Only the public structures this package reads are declared, in the layout of the FreeType 2
headers for LP64 (``FT_Pos``, ``FT_Fixed`` and ``FT_Long`` are ``long``); ``FT_FaceRec`` and
``FT_GlyphSlotRec`` stop at the last field that is used. Every function has its prototype set and
every error code is checked. Coordinates are 26.6 fixed point with the y axis pointing up, as in
FreeType.

Ownership: the library and the stroker belong to the :class:`FreeType` object (:meth:`FreeType.close`
frees both); a face belongs to whoever opened it and is closed with :meth:`FreeType.close_face`. Glyph
outlines live in their face's glyph slot and are only used until the next load; stroke outlines and
coverage bitmaps are written into memory Python owns.
"""

from __future__ import annotations

import ctypes
from collections.abc import Mapping
from ctypes import (
    POINTER,
    Structure,
    byref,
    c_char_p,
    c_int,
    c_long,
    c_short,
    c_ubyte,
    c_uint,
    c_ulong,
    c_ushort,
    c_void_p,
)
from dataclasses import dataclass
from typing import Any

from .model import TextFailure
from .native import bind, load

SONAME = "libfreetype.so.6"
# Unhinted outlines at their exact scale; embedded bitmap strikes are never used.
LOAD_FLAGS = 0x2 | 0x8  # FT_LOAD_NO_HINTING | FT_LOAD_NO_BITMAP

_GLYPH_FORMAT_OUTLINE = 0x6F75746C  # 'outl'
_ENCODING_UNICODE = 0x756E6963  # 'unic'
_FACE_FLAG_SCALABLE = 0x1
_PIXEL_MODE_GRAY = 2
_STROKER_LINECAP_ROUND = 1
_STROKER_LINEJOIN_ROUND = 0
_ERR_INVALID_ARGUMENT = 0x06
_MAX_OUTLINE_ITEMS = 32767  # n_points and n_contours were signed 16-bit before FreeType 2.13.3
_MAX_BITMAP_BYTES = 1 << 28

FaceHandle = Any  # FT_Face as a ctypes pointer to FaceRec


class Vector(Structure):
    _fields_ = (("x", c_long), ("y", c_long))


class _BBox(Structure):
    _fields_ = (("x_min", c_long), ("y_min", c_long), ("x_max", c_long), ("y_max", c_long))


class _Matrix(Structure):
    _fields_ = (("xx", c_long), ("xy", c_long), ("yx", c_long), ("yy", c_long))


class _Generic(Structure):
    _fields_ = (("data", c_void_p), ("finalizer", c_void_p))


class _Bitmap(Structure):
    _fields_ = (
        ("rows", c_uint),
        ("width", c_uint),
        ("pitch", c_int),
        ("buffer", POINTER(c_ubyte)),
        ("num_grays", c_ushort),
        ("pixel_mode", c_ubyte),
        ("palette_mode", c_ubyte),
        ("palette", c_void_p),
    )


class Outline(Structure):
    """``FT_Outline``; the two counts are unsigned since FreeType 2.13.3 and never exceed 32767 here."""

    _fields_ = (
        ("n_contours", c_ushort),
        ("n_points", c_ushort),
        ("points", POINTER(Vector)),
        ("tags", POINTER(c_ubyte)),
        ("contours", POINTER(c_ushort)),
        ("flags", c_int),
    )


class _GlyphMetrics(Structure):
    _fields_ = (
        ("width", c_long),
        ("height", c_long),
        ("hori_bearing_x", c_long),
        ("hori_bearing_y", c_long),
        ("hori_advance", c_long),
        ("vert_bearing_x", c_long),
        ("vert_bearing_y", c_long),
        ("vert_advance", c_long),
    )


class GlyphSlotRec(Structure):
    """``FT_GlyphSlotRec`` up to ``outline``."""

    _fields_ = (
        ("library", c_void_p),
        ("face", c_void_p),
        ("next", c_void_p),
        ("glyph_index", c_uint),
        ("generic", _Generic),
        ("metrics", _GlyphMetrics),
        ("linear_hori_advance", c_long),
        ("linear_vert_advance", c_long),
        ("advance", Vector),
        ("format", c_uint),
        ("bitmap", _Bitmap),
        ("bitmap_left", c_int),
        ("bitmap_top", c_int),
        ("outline", Outline),
    )


class _CharMapRec(Structure):
    _fields_ = (("face", c_void_p), ("encoding", c_uint), ("platform_id", c_ushort), ("encoding_id", c_ushort))


class FaceRec(Structure):
    """``FT_FaceRec`` up to ``charmap`` (the public part)."""

    _fields_ = (
        ("num_faces", c_long),
        ("face_index", c_long),
        ("face_flags", c_long),
        ("style_flags", c_long),
        ("num_glyphs", c_long),
        ("family_name", c_char_p),
        ("style_name", c_char_p),
        ("num_fixed_sizes", c_int),
        ("available_sizes", c_void_p),
        ("num_charmaps", c_int),
        ("charmaps", c_void_p),
        ("generic", _Generic),
        ("bbox", _BBox),
        ("units_per_em", c_ushort),
        ("ascender", c_short),
        ("descender", c_short),
        ("height", c_short),
        ("max_advance_width", c_short),
        ("max_advance_height", c_short),
        ("underline_position", c_short),
        ("underline_thickness", c_short),
        ("glyph", POINTER(GlyphSlotRec)),
        ("size", c_void_p),
        ("charmap", POINTER(_CharMapRec)),
    )


class _VarAxis(Structure):
    _fields_ = (
        ("name", c_char_p),
        ("minimum", c_long),
        ("default", c_long),
        ("maximum", c_long),
        ("tag", c_ulong),
        ("strid", c_uint),
    )


class _MMVar(Structure):
    _fields_ = (
        ("num_axis", c_uint),
        ("num_designs", c_uint),
        ("num_namedstyles", c_uint),
        ("axis", POINTER(_VarAxis)),
        ("namedstyle", c_void_p),
    )


@dataclass(frozen=True)
class FaceMetrics:
    """Design-space metrics of a face (font units)."""

    units_per_em: int
    ascender: int
    descender: int  # negative below the baseline, as in the font


@dataclass(frozen=True)
class Coverage:
    """An 8-bit coverage bitmap, top row first, and where it sits relative to the outline origin."""

    buffer: ctypes.Array[c_ubyte]
    width: int
    rows: int
    left: int  # pixels from the origin to the left column
    top: int  # pixels from the origin up to the top edge of the first row


class StrokeOutline:
    """The outline of a stroke, in memory owned by Python."""

    def __init__(self, points: int, contours: int) -> None:
        self._points = (Vector * points)()
        self._tags = (c_ubyte * points)()
        self._contours = (c_ushort * contours)()
        self.outline = Outline(0, 0, self._points, self._tags, self._contours, 0)


def _failed(call: str, code: int) -> TextFailure:
    return TextFailure("text_render_failed", f"{call} error {code}")


class FreeType:
    """One FreeType library instance and one stroker; lives as long as the worker process."""

    def __init__(self) -> None:
        lib = load(SONAME)
        outline = POINTER(Outline)
        face = POINTER(FaceRec)
        self._init = bind(lib, "FT_Init_FreeType", c_int, POINTER(c_void_p))
        self._done_library = bind(lib, "FT_Done_FreeType", c_int, c_void_p)
        self._library_version = bind(
            lib, "FT_Library_Version", None, c_void_p, POINTER(c_int), POINTER(c_int), POINTER(c_int)
        )
        self._new_face = bind(lib, "FT_New_Face", c_int, c_void_p, c_char_p, c_long, POINTER(face))
        self._done_face = bind(lib, "FT_Done_Face", c_int, face)
        self._set_char_size = bind(lib, "FT_Set_Char_Size", c_int, face, c_long, c_long, c_uint, c_uint)
        self._get_char_index = bind(lib, "FT_Get_Char_Index", c_uint, face, c_ulong)
        self._load_glyph = bind(lib, "FT_Load_Glyph", c_int, face, c_uint, c_int)
        self._load_sfnt_table = bind(
            lib, "FT_Load_Sfnt_Table", c_int, face, c_ulong, c_long, c_char_p, POINTER(c_ulong)
        )
        self._get_mm_var = bind(lib, "FT_Get_MM_Var", c_int, face, POINTER(POINTER(_MMVar)))
        self._done_mm_var = bind(lib, "FT_Done_MM_Var", c_int, c_void_p, POINTER(_MMVar))
        self._get_design = bind(lib, "FT_Get_Var_Design_Coordinates", c_int, face, c_uint, POINTER(c_long))
        self._set_design = bind(lib, "FT_Set_Var_Design_Coordinates", c_int, face, c_uint, POINTER(c_long))
        self._outline_embolden = bind(lib, "FT_Outline_Embolden", c_int, outline, c_long)
        self._outline_transform = bind(lib, "FT_Outline_Transform", None, outline, POINTER(_Matrix))
        self._outline_translate = bind(lib, "FT_Outline_Translate", None, outline, c_long, c_long)
        self._outline_cbox = bind(lib, "FT_Outline_Get_CBox", None, outline, POINTER(_BBox))
        self._outline_bitmap = bind(lib, "FT_Outline_Get_Bitmap", c_int, c_void_p, outline, POINTER(_Bitmap))
        self._stroker_new = bind(lib, "FT_Stroker_New", c_int, c_void_p, POINTER(c_void_p))
        self._stroker_set = bind(lib, "FT_Stroker_Set", None, c_void_p, c_long, c_int, c_int, c_long)
        self._stroker_parse = bind(lib, "FT_Stroker_ParseOutline", c_int, c_void_p, outline, c_ubyte)
        self._stroker_counts = bind(lib, "FT_Stroker_GetCounts", c_int, c_void_p, POINTER(c_uint), POINTER(c_uint))
        self._stroker_export = bind(lib, "FT_Stroker_Export", None, c_void_p, outline)
        self._stroker_done = bind(lib, "FT_Stroker_Done", None, c_void_p)
        self._library = c_void_p()
        self._stroker = c_void_p()
        self._check("FT_Init_FreeType", self._init(byref(self._library)))
        try:
            self._check("FT_Stroker_New", self._stroker_new(self._library, byref(self._stroker)))
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """Free the stroker and the library (which frees any face still open); idempotent."""
        if self._stroker:
            self._stroker_done(self._stroker)
            self._stroker = c_void_p()
        if self._library:
            self._done_library(self._library)
            self._library = c_void_p()

    @staticmethod
    def _check(call: str, code: int) -> None:
        if code != 0:
            raise _failed(call, code)

    def version(self) -> str:
        major, minor, patch = c_int(), c_int(), c_int()
        self._library_version(self._library, byref(major), byref(minor), byref(patch))
        return f"{major.value}.{minor.value}.{patch.value}"

    # ----------------------------------------------------------------------- faces

    def open_face(self, path: bytes, index: int) -> FaceHandle | None:
        """Open a face of a font file (``index`` carries a named instance in its upper 16 bits).

        ``None`` when FreeType cannot use the file as a scalable face with a Unicode character map.
        The caller closes a returned face with :meth:`close_face`.
        """
        face = POINTER(FaceRec)()
        if self._new_face(self._library, path, index, byref(face)) != 0:
            return None
        record = face.contents
        charmap = record.charmap
        if not record.face_flags & _FACE_FLAG_SCALABLE or not charmap or charmap.contents.encoding != _ENCODING_UNICODE:
            self.close_face(face)
            return None
        return face

    def close_face(self, face: FaceHandle) -> None:
        """Release a face this object opened (HarfBuzz keeps its own reference until its font is destroyed)."""
        self._check("FT_Done_Face", self._done_face(face))

    @staticmethod
    def metrics(face: FaceHandle) -> FaceMetrics:
        record = face.contents
        return FaceMetrics(record.units_per_em, record.ascender, record.descender)

    def set_size(self, face: FaceHandle, size: int) -> None:
        """Scale the face to ``size`` pixels per em (26.6); fractional sizes scale exactly."""
        self._check("FT_Set_Char_Size", self._set_char_size(face, size, size, 72, 72))

    def char_index(self, face: FaceHandle, code: int) -> int:
        """The glyph of a character, 0 when the face has none."""
        return int(self._get_char_index(face, code))

    def sfnt_table(self, face: FaceHandle, tag: bytes, offset: int, length: int) -> bytes | None:
        """``length`` bytes of an SFNT table from ``offset``; ``None`` when there is no such table or it is shorter.

        FreeType checks a read against the font file only, not against the table, so the table's own
        length is asked first: a short table never yields the bytes of the table after it.
        """
        name = int.from_bytes(tag, "big")
        table = c_ulong(0)
        if self._load_sfnt_table(face, name, 0, None, byref(table)) != 0 or offset + length > table.value:
            return None
        buffer = ctypes.create_string_buffer(length)
        size = c_ulong(length)
        if self._load_sfnt_table(face, name, offset, buffer, byref(size)) != 0:
            return None
        return buffer.raw if size.value == length else None

    def set_design_coordinates(self, face: FaceHandle, settings: Mapping[str, float]) -> None:
        """Move a variable face along the axes named in ``settings`` (four-letter tag -> design value)."""
        master = POINTER(_MMVar)()
        self._check("FT_Get_MM_Var", self._get_mm_var(face, byref(master)))
        try:
            count = master.contents.num_axis
            coordinates = (c_long * count)()
            self._check("FT_Get_Var_Design_Coordinates", self._get_design(face, count, coordinates))
            for position in range(count):
                axis = master.contents.axis[position]
                value = settings.get(axis.tag.to_bytes(4, "big").decode("latin-1"))
                if value is not None:
                    coordinates[position] = min(max(round(value * 65536), axis.minimum), axis.maximum)
            self._check("FT_Set_Var_Design_Coordinates", self._set_design(face, count, coordinates))
        finally:
            self._check("FT_Done_MM_Var", self._done_mm_var(self._library, master))

    # ----------------------------------------------------------------------- outlines

    def load_outline(self, face: FaceHandle, glyph: int) -> Outline:
        """The scaled, unhinted outline of a glyph.

        The outline lives in the glyph slot of the face: it may be changed in place and is replaced
        by the next load.
        """
        self._check("FT_Load_Glyph", self._load_glyph(face, glyph, LOAD_FLAGS))
        slot = face.contents.glyph.contents
        if slot.format != _GLYPH_FORMAT_OUTLINE:
            raise TextFailure("text_render_failed", "glyph is not an outline")
        outline: Outline = slot.outline
        return outline

    def embolden(self, outline: Outline, strength: int) -> None:
        """Synthetic bold: grow the outline by ``strength`` (26.6) to the right and upwards.

        Like ``FT_GlyphSlot_Embolden``, an outline FreeType cannot orient (a degenerate contour)
        is left as it is.
        """
        code = self._outline_embolden(byref(outline), strength)
        if code not in {0, _ERR_INVALID_ARGUMENT}:
            raise _failed("FT_Outline_Embolden", code)

    def stroke(self, outline: Outline, radius: int) -> StrokeOutline:
        """The outline of a round-joined pen of ``radius`` (26.6) drawn along every contour."""
        self._stroker_set(self._stroker, radius, _STROKER_LINECAP_ROUND, _STROKER_LINEJOIN_ROUND, 0)
        self._check("FT_Stroker_ParseOutline", self._stroker_parse(self._stroker, byref(outline), 0))
        points, contours = c_uint(), c_uint()
        self._check("FT_Stroker_GetCounts", self._stroker_counts(self._stroker, byref(points), byref(contours)))
        if points.value > _MAX_OUTLINE_ITEMS or contours.value > _MAX_OUTLINE_ITEMS:
            raise TextFailure("text_render_failed", "stroke outline too complex")
        stroke = StrokeOutline(points.value, contours.value)
        self._stroker_export(self._stroker, byref(stroke.outline))
        return stroke

    def place(self, outline: Outline, x_scale: int, dx: int, dy: int) -> None:
        """Scale an outline horizontally by ``x_scale`` (16.16) about its origin, then move it by 26.6 offsets."""
        if x_scale != 0x10000:
            matrix = _Matrix(x_scale, 0, 0, 0x10000)
            self._outline_transform(byref(outline), byref(matrix))
        self._outline_translate(byref(outline), dx, dy)

    def render(self, outline: Outline) -> Coverage | None:
        """Rasterise an outline (non-zero winding, 256 grey levels); ``None`` when it encloses nothing.

        The outline is moved in the process and must not be used afterwards.
        """
        box = _BBox()
        self._outline_cbox(byref(outline), byref(box))
        left, bottom = box.x_min >> 6, box.y_min >> 6
        width, rows = ((box.x_max + 63) >> 6) - left, ((box.y_max + 63) >> 6) - bottom
        if width <= 0 or rows <= 0:
            return None
        if width * rows > _MAX_BITMAP_BYTES:
            raise TextFailure("text_too_large", "glyph bitmap too large")
        buffer = (c_ubyte * (width * rows))()
        bitmap = _Bitmap(rows, width, width, buffer, 256, _PIXEL_MODE_GRAY, 0, None)
        self._outline_translate(byref(outline), -left * 64, -bottom * 64)
        self._check("FT_Outline_Get_Bitmap", self._outline_bitmap(self._library, byref(outline), byref(bitmap)))
        return Coverage(buffer, width, rows, left, bottom + rows)
