r"""The editor's title layout, ported from ``apps/frontend/src/features/studio/model/titleLayout.ts``.

``tokens``, ``wrap`` and ``layout_title`` follow the TypeScript ``tokens``, ``wrap`` and
``layoutTitle`` statement by statement, so the same measure function gives the same lines and the
same numbers in the browser preview and in the export. Two JavaScript behaviours are spelled out
because Python's differ: the white space set of ``\\s`` and ``trim`` (:data:`JS_WHITE_SPACE`) and
``Math.round`` (:func:`js_round`).

One deliberate difference: strings are sequences of code points here, so the ellipsis loop removes
whole characters where the TypeScript removes UTF-16 units (it can cut a surrogate pair in half).
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass

from .model import TextSpec, TextStyle


_HALF_UNIT = 0.5


# measure(text, font_px, style) -> width in pixels; layout and drawing must measure with the same fonts.
Measure = Callable[[str, float, TextStyle | None], float]

TITLE_SIZE_RATIO = {"small": 0.05, "medium": 0.075, "large": 0.11}
TITLE_MAX_LINES = 3
# Items without a style are drawn with CSS weight 600 in the sans stack.
LEGACY_FONT_FAMILY = "sans"
LEGACY_FONT_WEIGHT = 600
LEGACY_COLOR = "#ffffff"

# ECMAScript WhiteSpace and LineTerminator: what ``\s``, ``trim``, ``trimStart`` and ``trimEnd`` treat as space.
JS_WHITE_SPACE = "".join(
    map(
        chr,
        (
            0x09,
            0x0A,
            0x0B,
            0x0C,
            0x0D,
            0x20,
            0xA0,
            0x1680,
            *range(0x2000, 0x200B),
            0x2028,
            0x2029,
            0x202F,
            0x205F,
            0x3000,
            0xFEFF,
        ),
    )
)
_SPACE_CLASS = f"[{re.escape(JS_WHITE_SPACE)}]"
# /[A-Za-z0-9_'\-.,!?:;]+\s*|\s+|./gu : a Latin word with its trailing space, a run of space, or one character.
_TOKEN = re.compile(
    rf"[A-Za-z0-9_'\u2019\-.,!?:;]+{_SPACE_CLASS}*|{_SPACE_CLASS}+|.", re.DOTALL
)
# /^[，。！？、；：）】」』…]+$/u : closing punctuation never starts a line (escaped: a pattern, not a text).
_CLOSING = re.compile(
    r"[\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\uff09\u3011\u300d\u300f\u2026]+"
)
_LINE_BREAK = re.compile(r"\r?\n")


@dataclass(frozen=True)
class Band:
    """The translucent box behind a lower-third item, in canvas pixels."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class TitleLayout:
    """``TitleLayout`` of the editor without the CSS font string (fonts are chosen from the spec)."""

    font_px: float
    line_height: int
    lines: tuple[str, ...]
    align: str
    color: str
    x: float  # anchor of the alignment: left edge, centre line or right edge
    top: float  # top of the first line box
    max_width: int
    stroke_px: int
    band: Band | None

    def line_top(self, index: int) -> float:
        """The y passed to ``fillText`` for a line (text baseline ``top``), as ``drawTitle`` computes it."""
        return (
            self.top
            + index * self.line_height
            + js_round((self.line_height - self.font_px) / 2)
        )


def js_round(value: float) -> int:
    """``Math.round``: the nearest integer, halves towards positive infinity."""
    floor = math.floor(value)
    return floor + 1 if value - floor >= _HALF_UNIT else floor


def _trim(text: str) -> str:
    return text.strip(JS_WHITE_SPACE)


def _trim_start(text: str) -> str:
    return text.lstrip(JS_WHITE_SPACE)


def _trim_end(text: str) -> str:
    return text.rstrip(JS_WHITE_SPACE)


def tokens(text: str) -> list[str]:
    """Breakable units: a Latin word with its trailing space is one, every other character is its own."""
    out: list[str] = []
    for part in _TOKEN.findall(text):
        if out and _CLOSING.fullmatch(part):
            out[-1] += part
        else:
            out.append(part)
    return out


def wrap(
    paragraph: str, max_width: float, measure: Callable[[str], float]
) -> list[str]:
    """Greedy line filling; a single word wider than the line is cut between characters."""
    lines: list[str] = []
    line = ""
    for token in tokens(paragraph):
        if not _trim(line):
            line = _trim_start(token)
        elif measure(_trim_end(line + token)) <= max_width:
            line += token
        else:
            lines.append(_trim_end(line))
            line = _trim_start(token)
        while len(_trim_end(line)) > 1 and measure(_trim_end(line)) > max_width:
            chars = _trim_end(line)
            cut = len(chars) - 1
            while cut > 1 and measure(chars[:cut]) > max_width:
                cut -= 1
            lines.append(chars[:cut])
            line = chars[cut:]
    if _trim(line) or not lines:
        lines.append(_trim_end(line))
    return lines


def _legacy_top(position: str, height: int, block_height: int) -> int:
    if position == "top":
        return js_round(height * 0.08)
    if position == "center":
        return js_round((height - block_height) / 2)
    if position == "bottom":
        return js_round(height * 0.9 - block_height)
    return js_round(height * 0.84 - block_height)


def layout_title(
    spec: TextSpec, width: int, height: int, measure: Measure
) -> TitleLayout:
    """Lay a title or caption out on a ``width`` x ``height`` canvas.

    A styled item uses its font size, colour, alignment and anchor and keeps every line; an item
    without a style keeps the legacy position and size presets, three lines at most (the last one
    ends with an ellipsis) and, at ``lower_third``, the band.
    """
    style = spec.style
    font_px: float = (
        max(1, height * style.font_size / 1080)
        if style
        else max(10, js_round(height * TITLE_SIZE_RATIO[spec.size]))
    )
    line_height = js_round(font_px * 1.3)
    lower_third = style is None and spec.position == "lower_third"
    max_width = js_round(width * (0.78 if lower_third else 0.88))

    def measure_at(text: str) -> float:
        return measure(text, font_px, style)

    lines = [
        line
        for paragraph in _LINE_BREAK.split(spec.text)
        for line in wrap(paragraph, max_width, measure_at)
    ]
    line_limit = len(lines) if style else TITLE_MAX_LINES
    if len(lines) > line_limit:
        last = f"{lines[line_limit - 1]}…"
        while len(last) > 1 and measure_at(last) > max_width:
            last = f"{last[:-2]}…"
        lines = [*lines[: line_limit - 1], last]
    block_height = len(lines) * line_height
    stroke_px = max(2, js_round(font_px * 0.12))
    top: float = (
        style.y * height - block_height / 2
        if style
        else _legacy_top(spec.position, height, block_height)
    )
    x: float = (
        style.x * width
        if style
        else js_round(width * 0.06)
        if lower_third
        else js_round(width / 2)
    )
    band = None
    if lower_third:
        text_width = max(*(measure_at(line) for line in lines), font_px)
        pad = js_round(font_px * 0.45)
        band = Band(
            x - pad,
            top - pad,
            min(width - (x - pad), text_width + pad * 2),
            block_height + pad * 2,
        )
    return TitleLayout(
        font_px=font_px,
        line_height=line_height,
        lines=tuple(lines),
        align=style.align if style else "left" if lower_third else "center",
        color=style.color if style else LEGACY_COLOR,
        x=x,
        top=top,
        max_width=max_width,
        stroke_px=stroke_px,
        band=band,
    )
