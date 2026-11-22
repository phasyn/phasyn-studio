"""A minimal PNG writer and header reader for 8-bit RGBA pictures (standard library only).

The encoder writes exactly three chunks (IHDR, one IDAT, IEND): no time stamp, no text and no
colour chunks, and one fixed deflate setting, so the same pixels always give the same bytes with
the same zlib. Scan lines are stored unfiltered and deflated at level 3: measured on caption
rasters, the Sub and Up filters made the files about a third larger, and level 6 saves a tenth of
the size for almost three times the time.
"""

from __future__ import annotations

import struct
import zlib


SIGNATURE = b"\x89PNG\r\n\x1a\n"
NO_FILTER = 0
BYTES_PER_PIXEL = 4
HEADER_BYTES = 33  # signature, then the complete IHDR chunk

_IHDR = struct.Struct(">IIBBBBB")
_RGBA_8 = (
    8,
    6,
    0,
    0,
    0,
)  # bit depth, colour type RGBA, deflate, adaptive filtering, no interlace
_COMPRESSION_LEVEL = 3


def _chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload))
    )


def encode_rgba(width: int, height: int, scanlines: bytes) -> bytes:
    """A PNG file from filtered scan lines.

    ``scanlines`` is ``height`` rows, each a filter-type byte followed by ``width`` RGBA pixels
    filtered accordingly (see ``raster.png_scanlines``).
    """
    if len(scanlines) != height * (1 + width * BYTES_PER_PIXEL):
        raise ValueError("scan line data does not match the picture size")
    header = _IHDR.pack(width, height, *_RGBA_8)
    data = zlib.compress(scanlines, _COMPRESSION_LEVEL)
    return (
        SIGNATURE
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", data)
        + _chunk(b"IEND", b"")
    )


def read_rgba_size(header: bytes) -> tuple[int, int] | None:
    """Width and height from the first :data:`HEADER_BYTES` of an 8-bit RGBA PNG, else ``None``."""
    if len(header) < HEADER_BYTES or not header.startswith(SIGNATURE):
        return None
    length, kind = struct.unpack_from(">I4s", header, len(SIGNATURE))
    if length != _IHDR.size or kind != b"IHDR":
        return None
    width, height, *form = _IHDR.unpack_from(header, len(SIGNATURE) + 8)
    return (width, height) if tuple(form) == _RGBA_8 else None
