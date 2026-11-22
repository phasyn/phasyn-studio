"""A QuickTime movie with one video track of PNG samples (standard library only).

Layout: ``ftyp``, ``mdat`` (the samples, written as they are produced), ``moov`` (written last).
The track is what FFmpeg's ``mov`` demuxer needs and nothing more: a ``png `` sample description
of depth 32, one chunk, a size and a duration per sample, no sync table (every sample is a key
frame) and no edit list (the media starts at time zero). All dates are zero, so the bytes depend
on the samples only.

Durations are exact for every frame rate, fractional ones included (:func:`frame_timing`).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from fractions import Fraction
from itertools import groupby
from typing import BinaryIO


_TRACK_HEADER_BYTES = 84
_MEDIA_HEADER_BYTES = 24
_SIZE_HEADER_BYTES = 12
_MIN_DESCRIPTION_BYTES = 16


_ATOM_HEADER = struct.Struct(">I4s")
_IDENTITY_MATRIX = struct.pack(">9i", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
_TRACK_ID = 1
_TRACK_ENABLED_IN_MOVIE = 0x00000F
_SELF_CONTAINED = 0x000001
_LOSSLESS_QUALITY = 0x400
_DPI_72 = 0x00480000
_DEPTH_RGBA = 32
_NO_COLOR_TABLE = -1
_MAX_MOVIE_ATOM = 64 * 1024 * 1024


def frame_timing(fps: Fraction) -> tuple[int, int]:
    """The media time scale and the ticks of one frame for a frame rate ``n/d``: ``(2n, 2d)``.

    A sample shown for ``k`` frames lasts ``2dk`` ticks of ``1/(2n)`` s. The factor 2 keeps every
    duration above one tick: FFmpeg (6.1 and later) takes a final frame of exactly one tick for a
    made-up duration and plays it as long as the frame before it, which lengthened tracks ending in a
    one-frame caption at integer frame rates.
    """
    return 2 * fps.numerator, 2 * fps.denominator


def _atom(kind: bytes, *parts: bytes) -> bytes:
    payload = b"".join(parts)
    return _ATOM_HEADER.pack(_ATOM_HEADER.size + len(payload), kind) + payload


def _full_atom(kind: bytes, flags: int, *parts: bytes) -> bytes:
    return _atom(kind, struct.pack(">I", flags), *parts)  # version 0 in the top byte


def _pascal(text: bytes) -> bytes:
    return bytes([len(text)]) + text


_FILE_TYPE = _atom(b"ftyp", b"qt  ", struct.pack(">I", 0x200), b"qt  ")


class MovieWriter:
    """Writes the movie to a seekable stream positioned at its start."""

    def __init__(
        self, stream: BinaryIO, width: int, height: int, timescale: int
    ) -> None:
        """Prepare the frame samples and movie destination."""
        self._stream = stream
        self._width = width
        self._height = height
        self._timescale = timescale
        self._sizes: list[int] = []
        self._durations: list[int] = []
        stream.write(_FILE_TYPE)
        stream.write(_ATOM_HEADER.pack(0, b"mdat"))  # the size is filled in by finish()

    @property
    def samples(self) -> int:
        """Return the number of samples written to the movie."""
        return len(self._sizes)

    def add_sample(self, data: bytes, duration: int) -> None:
        """Append one PNG picture shown for ``duration`` media time units."""
        self._stream.write(data)
        self._sizes.append(len(data))
        self._durations.append(duration)

    def finish(self) -> int:
        """Complete the file and return its size in bytes."""
        media_bytes = _ATOM_HEADER.size + sum(self._sizes)
        self._stream.seek(len(_FILE_TYPE))
        self._stream.write(_ATOM_HEADER.pack(media_bytes, b"mdat"))
        self._stream.seek(len(_FILE_TYPE) + media_bytes)
        movie = self._movie_atom(first_sample_at=len(_FILE_TYPE) + _ATOM_HEADER.size)
        self._stream.write(movie)
        return len(_FILE_TYPE) + media_bytes + len(movie)

    def _movie_atom(self, first_sample_at: int) -> bytes:
        duration = sum(self._durations)
        header = _full_atom(
            b"mvhd",
            0,
            struct.pack(">IIII", 0, 0, self._timescale, duration),
            struct.pack(">IH", 0x10000, 0x100),  # preferred rate 1.0, volume 1.0
            bytes(10),
            _IDENTITY_MATRIX,
            bytes(24),  # preview, poster, selection and current times
            struct.pack(">I", _TRACK_ID + 1),
        )
        track_header = _full_atom(
            b"tkhd",
            _TRACK_ENABLED_IN_MOVIE,
            struct.pack(">IIIII", 0, 0, _TRACK_ID, 0, duration),
            bytes(8),
            struct.pack(
                ">hhhH", 0, 0, 0, 0
            ),  # layer, alternate group, volume, reserved
            _IDENTITY_MATRIX,
            struct.pack(">II", self._width << 16, self._height << 16),
        )
        media_header = _full_atom(
            b"mdhd", 0, struct.pack(">IIIIHH", 0, 0, self._timescale, duration, 0, 0)
        )
        media_handler = _full_atom(
            b"hdlr", 0, b"mhlr", b"vide", bytes(12), _pascal(b"VideoHandler")
        )
        video_header = _full_atom(
            b"vmhd", 1, struct.pack(">HHHH", 0x40, 0x8000, 0x8000, 0x8000)
        )
        data_handler = _full_atom(
            b"hdlr", 0, b"dhlr", b"alis", bytes(12), _pascal(b"DataHandler")
        )
        data_reference = _full_atom(
            b"dref", 0, struct.pack(">I", 1), _full_atom(b"alis", _SELF_CONTAINED)
        )
        media_information = _atom(
            b"minf",
            video_header,
            data_handler,
            _atom(b"dinf", data_reference),
            self._sample_table(first_sample_at),
        )
        media = _atom(b"mdia", media_header, media_handler, media_information)
        return _atom(b"moov", header, _atom(b"trak", track_header, media))

    def _sample_table(self, first_sample_at: int) -> bytes:
        description = _atom(
            b"png ",
            bytes(6),
            struct.pack(">H", 1),  # data reference index
            struct.pack(
                ">HHIII", 0, 0, 0, 0, _LOSSLESS_QUALITY
            ),  # version, revision, vendor, qualities
            struct.pack(">HHIIIH", self._width, self._height, _DPI_72, _DPI_72, 0, 1),
            _pascal(b"PNG").ljust(32, b"\0"),
            struct.pack(">Hh", _DEPTH_RGBA, _NO_COLOR_TABLE),
        )
        runs = [
            (len(list(group)), duration) for duration, group in groupby(self._durations)
        ]
        return _atom(
            b"stbl",
            _full_atom(b"stsd", 0, struct.pack(">I", 1), description),
            _full_atom(
                b"stts",
                0,
                struct.pack(">I", len(runs)),
                *(struct.pack(">II", *run) for run in runs),
            ),
            _full_atom(
                b"stsc", 0, struct.pack(">IIII", 1, 1, len(self._sizes), 1)
            ),  # one chunk holds every sample
            _full_atom(
                b"stsz",
                0,
                struct.pack(">II", 0, len(self._sizes)),
                struct.pack(f">{len(self._sizes)}I", *self._sizes),
            ),
            _full_atom(b"stco", 0, struct.pack(">II", 1, first_sample_at)),
        )


@dataclass(frozen=True)
class MovieSummary:
    """What the parent checks of a movie the worker wrote."""

    width: int
    height: int
    timescale: int
    duration: int
    samples: int
    codec: bytes


def _children(payload: bytes) -> dict[bytes, bytes]:
    """The first child atom of each kind in a container payload (empty when the payload is malformed)."""
    out: dict[bytes, bytes] = {}
    offset = 0
    while offset < len(payload):
        if len(payload) - offset < _ATOM_HEADER.size:
            return {}
        size, kind = _ATOM_HEADER.unpack_from(payload, offset)
        if size < _ATOM_HEADER.size or offset + size > len(payload):
            return {}
        out.setdefault(kind, payload[offset + _ATOM_HEADER.size : offset + size])
        offset += size
    return out


def _movie_atom(stream: BinaryIO, file_size: int) -> bytes | None:
    offset = 0
    while offset + _ATOM_HEADER.size <= file_size:
        stream.seek(offset)
        header = stream.read(_ATOM_HEADER.size)
        if len(header) != _ATOM_HEADER.size:
            return None
        size, kind = _ATOM_HEADER.unpack(header)
        if size < _ATOM_HEADER.size or offset + size > file_size:
            return None
        if kind == b"moov":
            return (
                stream.read(size - _ATOM_HEADER.size)
                if size <= _MAX_MOVIE_ATOM
                else None
            )
        offset += size
    return None


def read_summary(stream: BinaryIO, file_size: int) -> MovieSummary | None:
    """The track facts of a movie written by :class:`MovieWriter`; ``None`` for anything else."""
    movie = _movie_atom(stream, file_size)
    if movie is None:
        return None
    track = _children(_children(movie).get(b"trak", b""))
    media = _children(track.get(b"mdia", b""))
    table = _children(_children(media.get(b"minf", b"")).get(b"stbl", b""))
    track_header, media_header = track.get(b"tkhd", b""), media.get(b"mdhd", b"")
    sizes, description = table.get(b"stsz", b""), table.get(b"stsd", b"")
    if (
        len(track_header) != _TRACK_HEADER_BYTES
        or len(media_header) != _MEDIA_HEADER_BYTES
        or len(sizes) < _SIZE_HEADER_BYTES
        or len(description) < _MIN_DESCRIPTION_BYTES
    ):
        return None
    width, height = struct.unpack_from(">II", track_header, 76)
    timescale, duration = struct.unpack_from(">II", media_header, 12)
    (samples,) = struct.unpack_from(">I", sizes, 8)
    return MovieSummary(
        width >> 16, height >> 16, timescale, duration, samples, description[12:16]
    )
