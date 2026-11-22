"""Request and result shapes of the text renderer, their bounds and their wire form.

Standard library only (and the generated document bounds of ``phasyn_components.timeline_limits``): the
parent validates and encodes with this module and the worker process decodes with it, so the worker
never imports the parent's side of the package.

A character no usable font can draw is not a refusal: it is drawn as the ``.notdef`` glyph of the
primary font, as a browser does, and named in the result (:class:`MissingGlyphs`) so the export
records it. Fonts fontconfig offers that the renderer does not open are named too (``skipped_fonts``).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass, fields
from fractions import Fraction
from pathlib import Path
from typing import Any

from phasyn_components.timeline_limits import MAX_TEXT_CHARS

from .chars import text_direction_problem
from .mov import frame_timing


_MIN_FONT_SIZE = 8
_MAX_FONT_SIZE = 300


POSITIONS = ("top", "center", "bottom", "lower_third")
SIZES = ("small", "medium", "large")
FONT_FAMILIES = ("sans", "serif", "mono")
FONT_WEIGHTS = (400, 700)
ALIGNMENTS = ("left", "center", "right")

MAX_CANVAS_PIXELS = 40_000_000
MAX_CANVAS_SIDE = 16_384  # far above any sequence; keeps every coordinate small and the movie fields 16-bit
MAX_TITLE_JOBS = 2_000
MAX_CAPTION_TRACKS = 2_000
MAX_CAPTION_EVENTS = 20_000
MAX_JOB_ID_CHARS = 200
MAX_REPORTED_CODE_POINTS = (
    64  # distinct characters drawn as .notdef that a result names (the count is exact)
)
MAX_SKIPPED_FONTS = 64  # fonts a result names as offered by fontconfig but not opened
SKIPPED_FONT_REASONS = ("too_large", "unusable")
MAX_MEDIA_TICKS = 2**31 - 1  # QuickTime time scale and duration fields

REASONS = (
    "text_renderer_unavailable",
    "text_font_missing",
    "text_direction_unsupported",
    "text_too_large",
    "text_render_failed",
)

_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
_KEY_DOMAIN = "phasyn.text/1"


class TextFailure(Exception):  # noqa: N818 - Published exception name.
    """A refusal or failure of the text renderer: a stable reason, the job it concerns and a safe detail.

    This is what validation and the worker raise and what crosses the process boundary; the parent
    turns it into :class:`~phasyn_media.text.errors.TextRenderError`. The detail is diagnostic text
    without paths (a code point, a field name, a library name or an error number). ``item`` is the
    position of the caption event inside a caption track job, when the failure belongs to one event.
    """

    def __init__(
        self,
        reason: str,
        detail: str | None = None,
        *,
        job_id: str | None = None,
        item: int | None = None,
    ) -> None:
        """Store the structured reason for a rejected text request."""
        super().__init__(reason if detail is None else f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail
        self.job_id = job_id
        self.item = item

    def for_job(self, job_id: str) -> TextFailure:
        """The same failure attributed to a job (an attribution made deeper in the call stack wins)."""
        if self.job_id is not None:
            return self
        return TextFailure(self.reason, self.detail, job_id=job_id, item=self.item)

    def for_item(self, item: int) -> TextFailure:
        """The same failure attributed to one caption event of its track (the first attribution wins)."""
        return (
            self
            if self.item is not None
            else TextFailure(self.reason, self.detail, job_id=self.job_id, item=item)
        )


@dataclass(frozen=True)
class TextStyle:
    """``MediaClipTitleStyle``: an explicit font, colour, alignment and anchor."""

    font_family: str  # "sans" | "serif" | "mono"
    font_size: float  # px at a 1080-line frame, 8..300
    font_weight: int  # 400 | 700
    color: str  # "#rrggbb"
    align: str  # "left" | "center" | "right"
    x: float  # 0..1 anchor of the alignment
    y: float  # 0..1 vertical centre of the text block


@dataclass(frozen=True)
class TextSpec:
    """What one title or caption looks like; a spec without a style uses the legacy presets."""

    text: str
    position: str
    size: str
    style: TextStyle | None

    @classmethod
    def from_document(cls, doc: Mapping[str, Any]) -> TextSpec:
        """The look of a ``MediaClipTitle`` or ``TimelineCaption`` document.

        The document has passed the contract schema, so its values are taken as they are;
        :func:`~phasyn_media.text.runner.render_texts` checks every spec again and refuses a
        malformed one together with the job it belongs to.
        """
        values: Any = doc  # untyped JSON: nothing is assumed about a value before check_spec has seen it
        style = values.get("style")
        if isinstance(style, Mapping):
            members: dict[str, Any] = {
                member.name: style.get(member.name) for member in fields(TextStyle)
            }
            style = TextStyle(**members)
        return cls(
            text=values.get("text"),
            position=values.get("position"),
            size=values.get("size"),
            style=style,
        )

    def identity(self) -> tuple[Any, ...]:
        """The values that decide the pixels: two specs with the same identity share one raster."""
        style = self.style
        if style is None:
            return ("legacy", self.text, self.position, self.size)
        return (
            "styled",
            self.text,
            style.font_family,
            _canonical_number(style.font_size),
            style.font_weight,
            _color_identity(style.color),
            style.align,
            _canonical_number(style.x),
            _canonical_number(style.y),
        )

    def key(self, width: int, height: int) -> str:
        """A stable identity of the raster of this spec on a ``width`` x ``height`` canvas (hex SHA-256)."""
        material = json.dumps(
            [_KEY_DOMAIN, width, height, *self.identity()],
            ensure_ascii=True,
            default=repr,
        )
        return hashlib.sha256(material.encode("ascii")).hexdigest()


@dataclass(frozen=True)
class TitleJob:
    """A title render and its requested duration."""

    job_id: str
    spec: TextSpec


@dataclass(frozen=True)
class CaptionEvent:
    """One caption on ``[start_frame, end_frame)``, in frames relative to the start of its track."""

    start_frame: int
    end_frame: int
    spec: TextSpec


@dataclass(frozen=True)
class CaptionTrackJob:
    """The timed captions to render into one track."""

    job_id: str
    frames: int
    events: tuple[CaptionEvent, ...]


@dataclass(frozen=True)
class TextRequest:
    """Inputs, output location, and policy for a text render."""

    width: int
    height: int
    fps: Fraction
    titles: tuple[TitleJob, ...]
    caption_tracks: tuple[CaptionTrackJob, ...]


@dataclass(frozen=True)
class TitleRaster:
    """A cropped straight-alpha RGBA PNG and the canvas position of its top-left pixel."""

    path: Path
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class CaptionTrack:
    """A QuickTime movie of PNG samples covering ``frames`` frames, and where its picture sits on the canvas."""

    path: Path
    x: int
    y: int
    width: int
    height: int
    frames: int
    samples: int


@dataclass(frozen=True)
class MissingGlyphs:
    """Characters no usable font has, drawn as ``.notdef``, and the items that show them."""

    code_points: tuple[
        str, ...
    ]  # "U+XXXX": the first MAX_REPORTED_CODE_POINTS distinct ones, in order
    count: int  # distinct characters in all
    items: tuple[
        tuple[str, int | None], ...
    ]  # (job_id, caption event of that track, or None for a title job)


@dataclass(frozen=True)
class TextResult:
    """The completed text artifact and its render metadata."""

    titles: Mapping[str, TitleRaster]
    caption_tracks: Mapping[
        str, CaptionTrack | None
    ]  # None: the track shows nothing and has no file
    fonts: tuple[
        Mapping[str, Any], ...
    ]  # family, style, file (base name), index, synthetic_bold, variations
    engine: Mapping[str, str]  # freetype, harfbuzz and fontconfig versions
    missing_glyphs: MissingGlyphs | None = None
    skipped_fonts: tuple[
        Mapping[str, str], ...
    ] = ()  # file (base name) and reason: too_large | unusable


# --------------------------------------------------------------------------- validation


def _canonical_number(value: Any) -> Any:
    return float(value) if _is_number(value) else value


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _invalid(field: str) -> TextFailure:
    return TextFailure("text_render_failed", f"invalid {field}")


def _check_style(style: Any) -> None:
    if not isinstance(style, TextStyle):
        raise _invalid("style")
    if style.font_family not in FONT_FAMILIES:
        raise _invalid("style.font_family")
    if (
        not _is_number(style.font_size)
        or not _MIN_FONT_SIZE <= style.font_size <= _MAX_FONT_SIZE
    ):
        raise _invalid("style.font_size")
    if not _is_number(style.font_weight) or style.font_weight not in FONT_WEIGHTS:
        raise _invalid("style.font_weight")
    if not _valid_color(style.color):
        raise _invalid("style.color")
    if style.align not in ALIGNMENTS:
        raise _invalid("style.align")
    for name, value in (("x", style.x), ("y", style.y)):
        if not _is_number(value) or not 0 <= value <= 1:
            raise _invalid(f"style.{name}")


def check_spec(spec: Any) -> None:
    """Refuse a spec the contract schema would not accept, or text that needs right-to-left layout."""
    if not isinstance(spec, TextSpec):
        raise _invalid("spec")
    if not _has_text(spec.text):
        raise _invalid("text")
    if len(spec.text) > MAX_TEXT_CHARS:
        raise TextFailure(
            "text_too_large", f"text longer than {MAX_TEXT_CHARS} characters"
        )
    if spec.position not in POSITIONS:
        raise _invalid("position")
    if spec.size not in SIZES:
        raise _invalid("size")
    if spec.style is not None:
        _check_style(spec.style)
    if text_direction_problem(spec.text):
        raise TextFailure("text_direction_unsupported")


def _check_job_ids(jobs: tuple[Any, ...], kind: str) -> None:
    seen: set[str] = set()
    for job in jobs:
        job_id = getattr(job, "job_id", None)
        if (
            not isinstance(job_id, str)
            or not 1 <= len(job_id) <= MAX_JOB_ID_CHARS
            or job_id in seen
        ):
            raise _invalid(f"{kind} job_id")
        seen.add(job_id)


def _check_canvas(request: TextRequest) -> None:
    if (
        not _is_int(request.width)
        or not _is_int(request.height)
        or request.width < 1
        or request.height < 1
    ):
        raise _invalid("canvas size")
    if (
        max(request.width, request.height) > MAX_CANVAS_SIDE
        or request.width * request.height > MAX_CANVAS_PIXELS
    ):
        raise TextFailure(
            "text_too_large", f"canvas larger than {MAX_CANVAS_PIXELS} pixels"
        )
    fps = request.fps
    if not _positive_fps(fps):
        raise _invalid("fps")
    if frame_timing(fps)[0] > MAX_MEDIA_TICKS:
        raise TextFailure("text_too_large", "frame rate numerator too large")


def _check_track(track: CaptionTrackJob, fps: Fraction) -> None:
    if not _is_int(track.frames) or track.frames < 1:
        raise _invalid("frames")
    if track.frames * frame_timing(fps)[1] > MAX_MEDIA_TICKS:
        raise TextFailure("text_too_large", "caption track too long")
    for item, event in enumerate(track.events):
        try:
            if not _frame_event(event):
                raise _invalid("caption event")
            if not 0 <= event.start_frame < event.end_frame <= track.frames:
                raise _invalid("caption event range")
            check_spec(event.spec)
        except TextFailure as failure:
            raise failure.for_item(item) from None


def check_request(request: Any) -> None:
    """Refuse a request outside the bounds of the renderer (raises :class:`TextFailure`)."""
    if not isinstance(request, TextRequest):
        raise _invalid("request")
    _check_canvas(request)
    if not _job_collections(request.titles, request.caption_tracks):
        raise _invalid("jobs")
    if len(request.titles) > MAX_TITLE_JOBS:
        raise TextFailure("text_too_large", f"more than {MAX_TITLE_JOBS} titles")
    if len(request.caption_tracks) > MAX_CAPTION_TRACKS:
        raise TextFailure(
            "text_too_large", f"more than {MAX_CAPTION_TRACKS} caption tracks"
        )
    _check_job_ids(request.titles, "title")
    _check_job_ids(request.caption_tracks, "caption track")
    for title in request.titles:
        try:
            check_spec(title.spec)
        except TextFailure as failure:
            raise failure.for_job(title.job_id) from None
    _check_caption_tracks(request)


# --------------------------------------------------------------------------- wire form


def request_to_wire(request: TextRequest, out_dir: str) -> dict[str, Any]:
    """The JSON document the parent writes to the worker's standard input."""
    return {
        "out_dir": out_dir,
        "width": request.width,
        "height": request.height,
        "fps": [request.fps.numerator, request.fps.denominator],
        "titles": [
            {"job_id": job.job_id, "spec": asdict(job.spec)} for job in request.titles
        ],
        "caption_tracks": [
            {
                "job_id": track.job_id,
                "frames": track.frames,
                "events": [
                    [event.start_frame, event.end_frame, asdict(event.spec)]
                    for event in track.events
                ],
            }
            for track in request.caption_tracks
        ],
    }


def _spec_from_wire(doc: Mapping[str, Any]) -> TextSpec:
    style = doc["style"]
    return TextSpec(
        text=doc["text"],
        position=doc["position"],
        size=doc["size"],
        style=None if style is None else TextStyle(**style),
    )


def request_from_wire(doc: Mapping[str, Any]) -> tuple[TextRequest, str]:
    """The request and output directory of a document made by :func:`request_to_wire`."""
    request = TextRequest(
        width=doc["width"],
        height=doc["height"],
        fps=Fraction(*doc["fps"]),
        titles=tuple(
            TitleJob(job["job_id"], _spec_from_wire(job["spec"]))
            for job in doc["titles"]
        ),
        caption_tracks=tuple(
            CaptionTrackJob(
                track["job_id"],
                track["frames"],
                tuple(
                    CaptionEvent(start, end, _spec_from_wire(spec))
                    for start, end, spec in track["events"]
                ),
            )
            for track in doc["caption_tracks"]
        ),
    )
    return request, doc["out_dir"]


def _color_identity(value: object) -> object:
    return value.lower() if isinstance(value, str) else value


def _valid_color(value: object) -> bool:
    return isinstance(value, str) and _COLOR.fullmatch(value) is not None


def _has_text(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def _positive_fps(value: object) -> bool:
    return isinstance(value, Fraction) and value > 0


def _frame_event(value: object) -> bool:
    return (
        isinstance(value, CaptionEvent)
        and _is_int(value.start_frame)
        and _is_int(value.end_frame)
    )


def _job_collections(titles: object, captions: object) -> bool:
    return isinstance(titles, tuple) and isinstance(captions, tuple)


def _check_caption_tracks(request: TextRequest) -> None:
    events = 0
    for track in request.caption_tracks:
        if not isinstance(track.events, tuple):
            raise _invalid("caption events").for_job(track.job_id)
        events += len(track.events)
        if events > MAX_CAPTION_EVENTS:
            raise TextFailure(
                "text_too_large", f"more than {MAX_CAPTION_EVENTS} caption events"
            )
        try:
            _check_track(track, request.fps)
        except TextFailure as failure:
            raise failure.for_job(track.job_id) from None
