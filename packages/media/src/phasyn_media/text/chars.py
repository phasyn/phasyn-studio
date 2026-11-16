"""Character rules of the text renderer (pure: ``unicodedata`` only).

These decide what reaches the shaper and which font list a character asks first:

- right-to-left text is refused (no bidirectional layout is implemented);
- like a browser canvas, ASCII white space draws as a space; the remaining control characters
  and unpaired surrogates draw nothing and are dropped;
- a cluster is a base character with the combining marks, variation selectors and joiners that
  must come from the same font;
- East Asian wide, full-width and half-width characters ask the Traditional Chinese font list first.
"""

from __future__ import annotations

import unicodedata
from enum import Enum
from functools import lru_cache

_RTL_CLASSES = frozenset({"R", "AL", "RLE", "RLO", "RLI"})
# The canvas text preparation replaces ASCII white space by U+0020; the two Unicode line separators
# (never a line break in the editor's layout) are treated the same way.
_DRAWN_AS_SPACE = frozenset("\t\n\f\r\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}")
_DROPPED_CATEGORIES = frozenset({"Cc", "Cs"})
_ZWJ = "\N{ZERO WIDTH JOINER}"
_JOINERS = frozenset({"\N{ZERO WIDTH NON-JOINER}", _ZWJ})
_CJK_WIDTHS = frozenset({"W", "F", "H"})
# The code points HarfBuzz hides when a font has no glyph for them (hb_unicode_funcs_t::is_default_ignorable).
_DEFAULT_IGNORABLE_RANGES = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x17B4, 0x17B5),
    (0x180B, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFF0, 0xFFF8),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)


def text_direction_problem(text: str) -> bool:
    """True when the text needs right-to-left layout.

    That is any character of bidirectional class R or AL (Hebrew, Arabic, ..., including the
    right-to-left mark) or an explicit right-to-left embedding, override or isolate.
    """
    return any(unicodedata.bidirectional(char) in _RTL_CLASSES for char in text)


class _Role(Enum):
    BASE = 0  # starts a cluster
    JOINS = 1  # a combining mark or joiner: stays with the character before it
    SPACE = 2  # drawn as U+0020
    DROPPED = 3  # draws nothing


@lru_cache(maxsize=8192)
def _role(char: str) -> _Role:
    if char in _DRAWN_AS_SPACE:
        return _Role.SPACE
    category = unicodedata.category(char)
    if category in _DROPPED_CATEGORIES:
        return _Role.DROPPED
    return _Role.JOINS if char in _JOINERS or category.startswith("M") else _Role.BASE


def clusters(text: str) -> list[str]:
    """The font-fallback clusters of a line, in the form that reaches the shaper.

    White space becomes U+0020 and characters that draw nothing are left out. Combining marks
    (which include the variation selectors), ZWNJ and ZWJ stay with the character before them, and
    the character after a ZWJ stays with the joiner.
    """
    out: list[str] = []
    glued = False
    for char in text:
        role = _role(char)
        if role is _Role.DROPPED:
            continue
        drawn = " " if role is _Role.SPACE else char
        if out and (glued or role is _Role.JOINS):
            out[-1] += drawn
        else:
            out.append(drawn)
        glued = char == _ZWJ
    return out


def is_cjk(char: str) -> bool:
    """Han, Kana, Bopomofo, Hangul, CJK punctuation and the full-width and half-width forms."""
    return unicodedata.east_asian_width(char) in _CJK_WIDTHS


def needs_glyph(char: str) -> bool:
    """False for the default-ignorable characters the shaper removes instead of drawing."""
    code = ord(char)
    return not any(first <= code <= last for first, last in _DEFAULT_IGNORABLE_RANGES)


def code_point_label(char: str) -> str:
    """``U+XXXX`` for diagnostics (never the character itself)."""
    return f"U+{ord(char):04X}"
