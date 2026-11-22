"""The worker's job: every title and caption track of one request, written into the output directory.

Titles become cropped PNG files; identical specs share one file. A caption track becomes one
QuickTime movie whose picture is the box around all captions of the track: the track is cut into
states (``captions.track_states``), and each state is one PNG sample that lasts as many frames
as the state.

Memory stays bounded however large the request is: a caption is planned once to learn its box and
painted again when its sample is written, so no picture outlives the samples that show it (apart
from a small cache of the most recent ones), and the glyph cache has its own budget.

Every native object (fontconfig configuration and patterns, FreeType library, faces and stroker,
HarfBuzz fonts and buffer) is released by :meth:`Engine.close`, on success and on failure.
"""

from __future__ import annotations

import os
from collections import OrderedDict
from collections.abc import Callable, Sequence
from fractions import Fraction
from types import TracebackType
from typing import Any, BinaryIO, NamedTuple, Self

import numpy as np
from numpy.typing import NDArray

from .captions import Span, track_states
from .fc import Fontconfig
from .fonts import FontBook
from .ft import FreeType
from .glyphs import GlyphRasterizer
from .hb import HarfBuzz
from .model import (
    MAX_REPORTED_CODE_POINTS,
    CaptionTrackJob,
    TextFailure,
    TextRequest,
    TextSpec,
)
from .mov import MovieWriter, frame_timing
from .native import require_supported_platform
from .png import encode_rgba
from .raster import Box, Painter, Picture, compose, png_scanlines, union


class _CaptionDestination(NamedTuple):
    output: OutputDirectory
    name: str


MAX_OUTPUT_BYTES = (
    2**31 - 1
)  # all files of a request together; also keeps every movie offset 32-bit
_PICTURE_CACHE_BYTES = 64 * 1024 * 1024


def _png(pixels: NDArray[np.uint8]) -> bytes:
    rows, columns = pixels.shape[:2]
    return encode_rgba(columns, rows, png_scanlines(pixels))


def _geometry(box: Box) -> dict[str, int]:
    return {"x": box.x0, "y": box.y0, "width": box.width, "height": box.height}


class _Missing:
    """Characters drawn as ``.notdef`` in a request: the distinct ones in order, and the items they occur in."""

    def __init__(self) -> None:
        self._code_points: dict[str, None] = {}
        self._items: list[tuple[str, int | None]] = []

    def add(self, job_id: str, item: int | None, code_points: Sequence[str]) -> None:
        if code_points:
            self._items.append((job_id, item))
            self._code_points.update(dict.fromkeys(code_points))

    def wire(self) -> dict[str, Any] | None:
        if not self._items:
            return None
        return {
            "code_points": list(self._code_points)[:MAX_REPORTED_CODE_POINTS],
            "count": len(self._code_points),
            "items": [[job_id, item] for job_id, item in self._items],
        }


class OutputDirectory:
    """Creates the files of a request inside the caller's directory, never over an existing name."""

    def __init__(self, path: str) -> None:
        """Open the validated directory for output publication."""
        self._directory = os.open(
            path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        )
        self._bytes = 0

    def __enter__(self) -> Self:
        """Open the managed resource for the duration of the context."""
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        trace: TracebackType | None,
    ) -> None:
        """Release the managed resource when its context exits."""
        os.close(self._directory)

    def create(self, name: str) -> BinaryIO:
        """Create a render output within the opened directory."""
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
        return os.fdopen(os.open(name, flags, 0o600, dir_fd=self._directory), "wb")

    def charge(self, size: int) -> None:
        """Count bytes about to be written against the budget of the request."""
        self._bytes += size
        if self._bytes > MAX_OUTPUT_BYTES:
            raise TextFailure("text_too_large", "output larger than 2 GiB")


class _RecentPictures:
    """Paints the distinct captions of a track on demand and keeps the most recently used ones."""

    def __init__(self, painter: Painter, specs: Sequence[TextSpec]) -> None:
        self._painter = painter
        self._specs = specs
        self._pictures: OrderedDict[int, Picture] = OrderedDict()
        self._bytes = 0

    def get(self, index: int) -> Picture:
        picture = self._pictures.get(index)
        if picture is not None:
            self._pictures.move_to_end(index)
            return picture
        picture = self._painter.paint(self._painter.plan(self._specs[index]))
        self._pictures[index] = picture
        self._bytes += picture.pixels.nbytes
        while self._bytes > _PICTURE_CACHE_BYTES and len(self._pictures) > 1:
            _, dropped = self._pictures.popitem(last=False)
            self._bytes -= dropped.pixels.nbytes
        return picture


class Engine:
    """The loaded libraries, the fonts and the glyph cache of one worker process."""

    def __init__(self) -> None:
        """Prepare the worker's text layout and rendering resources."""
        require_supported_platform()  # the structure layouts are LP64 Linux ones
        self._closers: list[Callable[[], None]] = []
        try:
            self._freetype = FreeType()
            self._closers.append(self._freetype.close)
            self._harfbuzz = HarfBuzz()
            self._closers.append(self._harfbuzz.close)
            self._fontconfig = Fontconfig()
            self._closers.append(self._fontconfig.close)
            self._book = FontBook(self._freetype, self._harfbuzz, self._fontconfig)
            self._closers.append(self._book.close)
        except BaseException:
            self.close()
            raise
        self._rasterizer = GlyphRasterizer(self._book, self._freetype)

    def close(self) -> None:
        """Release everything, newest first: faces before the libraries they came from (idempotent)."""
        while self._closers:
            self._closers.pop()()

    def render(self, request: TextRequest, out_dir: str) -> dict[str, Any]:
        """Render a validated request and return the wire result."""
        painter = Painter(
            self._book, self._harfbuzz, self._rasterizer, request.width, request.height
        )
        missing = _Missing()
        try:
            with OutputDirectory(out_dir) as output:
                titles = self._titles(request, painter, output, missing)
                tracks = self._caption_tracks(request, painter, output, missing)
        except OSError as exc:
            raise TextFailure(
                "text_render_failed", f"cannot write output (errno {exc.errno})"
            ) from exc
        return {
            "titles": titles,
            "caption_tracks": tracks,
            "fonts": self._book.used_fonts(),
            "skipped_fonts": self._book.skipped_fonts(),
            "missing_glyphs": missing.wire(),
            "engine": {
                "freetype": self._freetype.version(),
                "harfbuzz": self._harfbuzz.version(),
                "fontconfig": self._fontconfig.version(),
            },
        }

    @staticmethod
    def _titles(
        request: TextRequest,
        painter: Painter,
        output: OutputDirectory,
        missing: _Missing,
    ) -> dict[str, dict[str, Any]]:
        written: dict[tuple[Any, ...], dict[str, Any]] = {}
        titles: dict[str, dict[str, Any]] = {}
        for job in request.titles:
            try:
                plan = painter.plan(job.spec)
                identity = job.spec.identity()
                if identity not in written:
                    picture = painter.paint(plan)
                    name = f"title-{len(written)}.png"
                    data = _png(picture.pixels)
                    output.charge(len(data))
                    with output.create(name) as stream:
                        stream.write(data)
                    written[identity] = {"file": name, **_geometry(picture.box)}
            except TextFailure as failure:
                raise failure.for_job(job.job_id) from None
            missing.add(job.job_id, None, plan.missing)
            titles[job.job_id] = written[identity]
        return titles

    def _caption_tracks(
        self,
        request: TextRequest,
        painter: Painter,
        output: OutputDirectory,
        missing: _Missing,
    ) -> dict[str, dict[str, Any] | None]:
        tracks: dict[str, dict[str, Any] | None] = {}
        files = 0
        for track in request.caption_tracks:
            try:
                entry = self._caption_track(
                    track,
                    request.fps,
                    painter,
                    _CaptionDestination(output, f"captions-{files}.mov"),
                    missing,
                )
            except TextFailure as failure:
                raise failure.for_job(track.job_id) from None
            files += entry is not None
            tracks[track.job_id] = entry
        return tracks

    @staticmethod
    def _caption_track(
        track: CaptionTrackJob,
        fps: Fraction,
        painter: Painter,
        destination: _CaptionDestination,
        missing: _Missing,
    ) -> dict[str, Any] | None:
        """Write one track movie; ``None`` (and no file) when no caption of the track shows a pixel."""
        output, name = destination
        indices: dict[tuple[Any, ...], int] = {}
        specs: list[TextSpec] = []
        spans: list[Span] = []
        boxes: list[Box | None] = []
        for item, event in enumerate(track.events):
            try:
                plan = painter.plan(event.spec)
            except TextFailure as failure:
                raise failure.for_item(item) from None
            index = indices.setdefault(event.spec.identity(), len(specs))
            if index == len(specs):
                specs.append(event.spec)
                boxes.append(plan.box)
            missing.add(track.job_id, item, plan.missing)
            if (
                boxes[index] is not None
            ):  # a caption that shows no pixel takes no part in the track
                spans.append(Span(event.start_frame, event.end_frame, index))
        frame = union(box for box in boxes if box is not None)
        if frame is None:
            return None
        pictures = _RecentPictures(painter, specs)
        blank: bytes | None = None
        with output.create(name) as stream:
            timescale, frame_ticks = frame_timing(fps)
            movie = MovieWriter(stream, frame.width, frame.height, timescale)
            samples_bytes = 0
            for state in track_states(track.frames, spans):
                if state.pictures:
                    sample = _png(
                        compose(
                            (pictures.get(index) for index in state.pictures), frame
                        )
                    )
                else:
                    blank = sample = blank or _png(
                        np.zeros((frame.height, frame.width, 4), dtype=np.uint8)
                    )
                output.charge(len(sample))
                samples_bytes += len(sample)
                movie.add_sample(sample, (state.end - state.start) * frame_ticks)
            output.charge(movie.finish() - samples_bytes)
        return {
            "file": name,
            **_geometry(frame),
            "frames": track.frames,
            "samples": movie.samples,
        }
