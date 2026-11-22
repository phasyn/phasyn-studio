"""The parent side of the text renderer: validate the request, run the worker, check what it wrote.

``render_texts`` is the only way native text code runs. One supervised child process per request
(``tools.run_tool``: argument list, own process group, minimal environment, timeout, cancel,
bounded output) loads the system libraries and writes the files; the parent, a long-lived service
component, loads none of them. The child is ``python -I`` running a bootstrap that puts the
directories of this ``phasyn_media`` package and of the ``phasyn_components`` the parent imported
first on ``sys.path``, so it runs the same source trees whether they are installed or found through
``PYTHONPATH``.

Nothing the child says is trusted more than necessary: file names must be the ones the worker
generates, every file must be a regular single-link file directly in the output directory with the
geometry it reports, inside the canvas, and any other outcome (a crash, a timeout, a non-zero exit,
oversized or malformed output) is a :class:`TextRenderError`.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
import sys
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO

import phasyn_components

from phasyn_media._validate import numeric_value

from .._paths import absolute
from ..errors import MediaCanceled, MediaError
from ..tools import ToolResult, run_tool, tool_env
from .errors import TextRenderError
from .model import (
    MAX_REPORTED_CODE_POINTS,
    MAX_SKIPPED_FONTS,
    REASONS,
    SKIPPED_FONT_REASONS,
    CaptionTrack,
    CaptionTrackJob,
    MissingGlyphs,
    TextFailure,
    TextRequest,
    TextResult,
    TitleRaster,
    check_request,
    request_to_wire,
)
from .mov import MovieSummary, frame_timing, read_summary
from .png import HEADER_BYTES, read_rgba_size


_FONT_ENTRY_FIELDS = 2


_BOOTSTRAP = (
    "import runpy, sys; sys.path[0:0] = sys.argv[1:]; "
    "runpy.run_module('phasyn_media.text.worker', run_name='__main__', alter_sys=True)"
)
# The sys.path entries of this package (<root>/phasyn_media/text/runner.py) and of phasyn_components (the generated
# document bounds), from where the parent itself imported them.
_PACKAGE_ROOTS = tuple(
    dict.fromkeys(
        (
            str(absolute(__file__).parents[2]),
            str(absolute(phasyn_components.__file__).parents[1]),
        )
    )
)
_MAX_ANSWER_BYTES = 8 * 1024 * 1024
_MAX_FONTS = 1024
# The worker does no linear algebra; without these NumPy's BLAS starts (and spins) one thread per core.
_SINGLE_THREADED = {
    "OPENBLAS_NUM_THREADS": "1",
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
}
_TITLE_FILE = re.compile(r"title-(?:0|[1-9][0-9]{0,5})\.png")
_TRACK_FILE = re.compile(r"captions-(?:0|[1-9][0-9]{0,5})\.mov")
_SAFE_DETAIL = re.compile(r"[A-Za-z0-9 _+.:=,()-]{1,160}")
_CODE_POINT = re.compile(r"U\+[0-9A-F]{4,6}")
_FONT_FIELDS = {
    "family": str,
    "style": str,
    "file": str,
    "index": int,
    "synthetic_bold": bool,
    "variations": str,
}
_ENGINE_FIELDS = ("freetype", "harfbuzz", "fontconfig")


def _failed(detail: str) -> TextRenderError:
    return TextRenderError("text_render_failed", detail=detail)


def _invalid_result() -> TextRenderError:
    return _failed("worker returned an invalid result")


def _empty_directory(out_dir: Path) -> str:
    """The absolute path of ``out_dir``, which must be an existing empty directory (not a link to one)."""
    path = str(absolute(out_dir))
    try:
        usable = stat.S_ISDIR(Path(path).lstat().st_mode) and not any(
            Path(path).iterdir()
        )
    except OSError:
        usable = False
    if not usable:
        raise TextRenderError(
            "text_render_failed",
            detail="output directory is not an empty directory",
            invalid_request=True,
        )
    return path


def _reported(error: Mapping[str, Any], request: TextRequest) -> TextRenderError:
    """The worker's own refusal.

    The job must be one of the request, the item an event of that caption track and the detail
    plain diagnostic text; anything else is dropped, the reason stays.
    """
    job_id, item, detail = error.get("job_id"), error.get("item"), error.get("detail")
    events = {track.job_id: len(track.events) for track in request.caption_tracks}
    known = (
        job_id
        if isinstance(job_id, str) and (job_id in events or _is_title(request, job_id))
        else None
    )
    in_track = (
        known is not None and type(item) is int and 0 <= item < events.get(known, 0)
    )
    return TextRenderError(
        error["reason"],
        job_id=known,
        item=item if in_track else None,
        detail=detail
        if isinstance(detail, str) and _SAFE_DETAIL.fullmatch(detail)
        else None,
    )


def _is_title(request: TextRequest, job_id: str) -> bool:
    return any(job.job_id == job_id for job in request.titles)


def _answer(done: ToolResult, request: TextRequest) -> Mapping[str, Any]:
    """The result document of a finished worker; everything else raises."""
    if done.returncode < 0:
        raise _failed(f"worker killed by signal {-done.returncode}")
    try:
        document = json.loads(done.stdout)
    except (ValueError, RecursionError):
        document = None
    if isinstance(document, dict):
        error = document.get("error")
        if isinstance(error, dict) and error.get("reason") in REASONS:
            raise _reported(error, request)
        result = document.get("result")
        if done.returncode == 0 and isinstance(result, dict):
            return result
    raise _failed(f"worker exit status {done.returncode} without an answer")


@contextmanager
def _worker_file(
    out_dir: Path, name: Any, pattern: re.Pattern[str]
) -> Iterator[tuple[BinaryIO, int]]:
    """Open a file the worker named and yield it with its size.

    The name must be one the worker generates, and the file a regular, single-link file directly
    in ``out_dir`` (a link, a directory, a FIFO or a name with a directory part is refused).
    """
    if not isinstance(name, str) or pattern.fullmatch(name) is None:
        raise _invalid_result()
    descriptor = os.open(
        Path(out_dir) / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    )
    try:
        status = _regular_output_status(descriptor)
        stream = os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise
    with stream:
        yield stream, status.st_size


def _geometry(entry: Any, request: TextRequest) -> tuple[int, int, int, int]:
    """``x, y, width, height`` of a returned picture: integers, not empty, inside the canvas."""
    if not isinstance(entry, dict):
        raise _invalid_result()
    values: list[Any] = [entry.get(name) for name in ("x", "y", "width", "height")]
    if not all(type(value) is int for value in values):
        raise _invalid_result()
    x, y, width, height = values
    if (
        x < 0
        or y < 0
        or width < 1
        or height < 1
        or x + width > request.width
        or y + height > request.height
    ):
        raise _invalid_result()
    return x, y, width, height


def _title(entry: Any, request: TextRequest, out_dir: Path) -> TitleRaster:
    x, y, width, height = _geometry(entry, request)
    with _worker_file(out_dir, entry.get("file"), _TITLE_FILE) as (stream, _):
        header = stream.read(HEADER_BYTES)
    if read_rgba_size(header) != (width, height):
        raise _invalid_result()
    return TitleRaster(Path(out_dir) / entry["file"], x, y, width, height)


def _caption_track(
    entry: Any, track: CaptionTrackJob, request: TextRequest, out_dir: Path
) -> CaptionTrack | None:
    if entry is None:
        return None
    x, y, width, height = _geometry(entry, request)
    samples = entry.get("samples")
    if entry.get("frames") != track.frames or type(samples) is not int or samples < 1:
        raise _invalid_result()
    with _worker_file(out_dir, entry.get("file"), _TRACK_FILE) as (stream, size):
        summary = read_summary(stream, size)
    timescale, frame_ticks = frame_timing(request.fps)
    if summary != MovieSummary(
        width, height, timescale, track.frames * frame_ticks, samples, b"png "
    ):
        raise _invalid_result()
    return CaptionTrack(
        Path(out_dir) / entry["file"], x, y, width, height, track.frames, samples
    )


def _fonts(value: Any) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, list) or len(value) > _MAX_FONTS:
        raise _invalid_result()
    for font in value:
        typed = isinstance(font, dict) and all(
            type(font.get(name)) is kind for name, kind in _FONT_FIELDS.items()
        )
        if not typed or len(font) != len(_FONT_FIELDS) or os.sep in font["file"]:
            raise _invalid_result()
    return tuple(value)


def _skipped_fonts(value: Any) -> tuple[Mapping[str, str], ...]:
    if not isinstance(value, list) or len(value) > MAX_SKIPPED_FONTS:
        raise _invalid_result()
    for font in value:
        if (
            not isinstance(font, dict)
            or set(font) != {"file", "reason"}
            or font["reason"] not in SKIPPED_FONT_REASONS
        ):
            raise _invalid_result()
        if (
            not isinstance(font["file"], str)
            or not font["file"]
            or os.sep in font["file"]
        ):
            raise _invalid_result()
    return tuple(value)


def _missing_item(entry: Any, request: TextRequest) -> tuple[str, int | None]:
    """A ``[job_id, item]`` pair: a title job with no item, or a caption track job and one of its events."""
    if (
        not isinstance(entry, list)
        or len(entry) != _FONT_ENTRY_FIELDS
        or not isinstance(entry[0], str)
    ):
        raise _invalid_result()
    job_id, item = entry
    events = {track.job_id: len(track.events) for track in request.caption_tracks}
    if item is None and _is_title(request, job_id):
        return job_id, None
    if type(item) is int and 0 <= item < events.get(job_id, 0):
        return job_id, item
    raise _invalid_result()


def _missing_glyphs(value: Any, request: TextRequest) -> MissingGlyphs | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"code_points", "count", "items"}:
        raise _invalid_result()
    code_points, count, items = value["code_points"], value["count"], value["items"]
    limit = len(request.titles) + sum(
        len(track.events) for track in request.caption_tracks
    )
    named = (
        isinstance(code_points, list)
        and 0 < len(code_points) <= MAX_REPORTED_CODE_POINTS
    )
    if not named or not all(
        isinstance(code, str) and _CODE_POINT.fullmatch(code) for code in code_points
    ):
        raise _invalid_result()
    if (
        type(count) is not int
        or count < len(code_points)
        or not isinstance(items, list)
        or not 0 < len(items) <= limit
    ):
        raise _invalid_result()
    return MissingGlyphs(
        tuple(code_points),
        count,
        tuple(_missing_item(entry, request) for entry in items),
    )


def _engine(value: Any) -> Mapping[str, str]:
    if not isinstance(value, dict) or not all(
        isinstance(value.get(name), str) for name in _ENGINE_FIELDS
    ):
        raise _invalid_result()
    return {name: value[name] for name in _ENGINE_FIELDS}


def _result(
    answer: Mapping[str, Any], request: TextRequest, out_dir: Path
) -> TextResult:
    titles, tracks = answer.get("titles"), answer.get("caption_tracks")
    if not isinstance(titles, dict) or not isinstance(tracks, dict):
        raise _invalid_result()
    if set(titles) != {job.job_id for job in request.titles} or set(tracks) != {
        job.job_id for job in request.caption_tracks
    }:
        raise _invalid_result()
    return TextResult(
        titles={
            job.job_id: _title(titles[job.job_id], request, out_dir)
            for job in request.titles
        },
        caption_tracks={
            track.job_id: _caption_track(tracks[track.job_id], track, request, out_dir)
            for track in request.caption_tracks
        },
        fonts=_fonts(answer.get("fonts")),
        engine=_engine(answer.get("engine")),
        missing_glyphs=_missing_glyphs(answer.get("missing_glyphs"), request),
        skipped_fonts=_skipped_fonts(answer.get("skipped_fonts")),
    )


def render_texts(
    request: TextRequest, out_dir: Path, *, timeout: float, cancel: Any = None
) -> TextResult:
    """Render every title and caption track of ``request`` into ``out_dir``.

    ``out_dir`` is an empty directory the caller created for this call; the files left in it are
    ``title-<n>.png`` and ``captions-<n>.mov`` (after a failure it may hold some of them). The
    child process is killed after ``timeout`` seconds or when ``cancel`` is set (``MediaCanceled``).
    Every other refusal or failure raises :class:`TextRenderError`.
    """
    try:
        check_request(request)
    except TextFailure as failure:
        raise TextRenderError.from_failure(failure, invalid_request=True) from None
    if not numeric_value(timeout) or not math.isfinite(timeout) or timeout <= 0:
        raise TextRenderError(
            "text_render_failed", detail="invalid timeout", invalid_request=True
        )
    directory = _empty_directory(out_dir)
    if not sys.executable:
        raise TextRenderError(
            "text_renderer_unavailable", detail="no Python executable"
        )
    wire = json.dumps(
        request_to_wire(request, directory), ensure_ascii=True, separators=(",", ":")
    )
    try:
        done = run_tool(
            [sys.executable, "-I", "-c", _BOOTSTRAP, *_PACKAGE_ROOTS],
            timeout=timeout,
            cancel=cancel,
            max_stdout_bytes=_MAX_ANSWER_BYTES,
            env=tool_env(_SINGLE_THREADED),
            stdin_data=wire.encode("ascii"),
            what="文字排版",
        )
    except MediaCanceled:
        raise
    except MediaError as exc:
        oversized = exc.code == "RESOURCE_EXHAUSTED"
        raise _failed(
            "worker output too large"
            if oversized
            else "worker timed out or could not start"
        ) from exc
    try:
        return _result(_answer(done, request), request, out_dir)
    except OSError as exc:  # a named file that is missing, a link or unreadable
        raise _invalid_result() from exc


def _regular_output_status(descriptor: int) -> os.stat_result:
    status = os.fstat(descriptor)
    if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
        raise _invalid_result()
    return status
