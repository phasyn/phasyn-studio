"""Read a bounded, immutable sequence of browser-painted PNGs on a native frame clock."""

from __future__ import annotations

import hashlib
import json
import struct
import zlib
from dataclasses import dataclass
from fractions import Fraction
from math import lcm
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO

from phasyn_components import contracts
from phasyn_components.errors import ComponentError


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext


MAX_BYTES = 512 * 1024**2
HEADER_BYTES = 1024**2
FRAME_BYTES = 32 * 1024**2
MAX_FRAMES = 1800
MAX_PIXELS = 8_388_608
TOTAL_PIXELS = 1_000_000_000
MAX_FPS = 240
PNG_HEADER_BYTES = 33
CHANNEL_BITS = 8
MAX_CHUNKS = 8192
SAMPLE_RATE = 48_000
MAX_TIMESCALE = 2**31 - 1
PNG = b"\x89PNG\r\n\x1a\n"
ID = {"type": "string", "minLength": 1, "maxLength": 200}
HASH = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
INT = {"type": "integer", "minimum": 0, "maximum": MAX_TIMESCALE}
POS = {**INT, "minimum": 1}


def _object(props: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
    }


SOURCE = _object({"item_id": ID, "sha256": HASH})
HEADER = _object(
    {
        "project_id": ID,
        "revision": INT,
        "shot_id": ID,
        "start": INT,
        "end": POS,
        "fps_num": POS,
        "fps_den": POS,
        "width": POS,
        "height": POS,
        "depth": {"type": "boolean"},
        "scene": {"type": "object"},
        "layer_sources": {"type": "array", "items": SOURCE, "maxItems": 256},
        "audio": {
            "anyOf": [
                {"type": "null"},
                _object({"item_id": ID, "sha256": HASH, "start_sample": INT}),
            ]
        },
    }
)


@dataclass(frozen=True)
class Animation:
    """Timing and source identities of a fully decoded frame bundle."""

    header: dict[str, Any]
    fps: Fraction
    count: int
    samples: int
    scene_hash: str


def _header(raw: bytes) -> Animation:
    try:
        h = json.loads(raw)
    except (ValueError, RecursionError) as exc:
        raise ComponentError(
            "INVALID_ARGUMENT", "Invalid animatic header JSON."
        ) from exc
    contracts.validate_with_schema(
        HEADER, h, code="INVALID_ARGUMENT", what="Animatic header"
    )
    contracts.validate("StudioPrevis", h["scene"])
    for k in ("revision", "start", "end", "fps_num", "fps_den", "width", "height"):
        if type(h[k]) is not int:
            raise ComponentError(
                "INVALID_ARGUMENT", "Frame and clock fields must be integers."
            )
    if h["audio"] is not None and type(h["audio"]["start_sample"]) is not int:
        raise ComponentError(
            "INVALID_ARGUMENT", "The audio sample offset must be an integer."
        )
    count = h["end"] - h["start"]
    pixels = h["width"] * h["height"]
    if (
        not 1 <= count <= MAX_FRAMES
        or pixels > MAX_PIXELS
        or count * pixels > TOTAL_PIXELS
    ):
        raise ComponentError(
            "INPUT_TOO_LARGE",
            "Animatic frame count or decoded pixel volume exceeds capacity.",
        )
    if h["width"] % 2 or h["height"] % 2:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "H.264 playback requires an even canvas width and height.",
        )
    fps = Fraction(h["fps_num"], h["fps_den"])
    if not 1 <= fps <= MAX_FPS or lcm(fps.numerator, SAMPLE_RATE) > MAX_TIMESCALE:
        raise ComponentError(
            "INVALID_ARGUMENT", "This exact project clock cannot be stored in MP4."
        )
    expected = {
        layer["item_id"] for layer in h["scene"]["layers"] if layer["kind"] == "image"
    }
    supplied = [item["item_id"] for item in h["layer_sources"]]
    if len(supplied) != len(set(supplied)) or expected != set(supplied):
        raise ComponentError(
            "INVALID_ARGUMENT", "Layer references do not match the frozen scene."
        )
    samples = (2 * count * SAMPLE_RATE * fps.denominator + fps.numerator) // (
        2 * fps.numerator
    )
    return Animation(h, fps, count, samples, hashlib.sha256(raw).hexdigest())


def _read(handle: BinaryIO, count: int, digest: Any) -> bytes:
    data = handle.read(count)
    if len(data) != count:
        raise ComponentError(
            "MEDIA_INCOMPLETE", "The animatic frame bundle ended early."
        )
    digest.update(data)
    return data


def _block(handle: BinaryIO, limit: int, digest: Any) -> bytes:
    length = int.from_bytes(_read(handle, 4, digest), "big")
    if not 0 < length <= limit:
        raise ComponentError(
            "INPUT_TOO_LARGE", "Animatic record exceeds its size limit."
        )
    return _read(handle, length, digest)


def _png(data: bytes, width: int, height: int, dest: Path) -> None:
    if (
        not data.startswith(PNG + b"\x00\x00\x00\rIHDR")
        or len(data) < PNG_HEADER_BYTES
        or struct.unpack_from(">II", data, 16) != (width, height)
        or data[24] != CHANNEL_BITS
        or data[25] not in (2, 6)
        or data[26:29] != b"\0\0\0"
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            "Expected a single RGB/RGBA PNG of the declared canvas size.",
        )
    # The canvas is sRGB. Only pass pixel chunks to FFmpeg, excluding ancillary compressed metadata.
    view = memoryview(data)
    pos = len(PNG)
    has_pixels = False
    with dest.open("xb") as out:
        out.write(PNG)
        for _ in range(MAX_CHUNKS):
            if pos + 12 > len(data):
                break
            size, kind = struct.unpack_from(">I4s", data, pos)
            end = pos + size + 12
            if (
                end > len(data)
                or zlib.crc32(view[pos + 4 : end - 4])
                != struct.unpack_from(">I", data, end - 4)[0]
            ):
                raise ComponentError(
                    "MEDIA_INCOMPLETE", "Invalid frame chunk or checksum."
                )
            if kind in {b"acTL", b"fcTL", b"fdAT"} or (
                kind == b"IHDR" and pos != len(PNG)
            ):
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "Each source record must contain one still frame.",
                )
            if kind in {b"IHDR", b"IDAT", b"IEND"}:
                out.write(view[pos:end])
            has_pixels |= kind == b"IDAT" and size > 0
            pos = end
            if kind == b"IEND":
                if size == 0 and pos == len(data) and has_pixels:
                    return
                break
    raise ComponentError(
        "MEDIA_INCOMPLETE", "Invalid or excessively fragmented PNG frame."
    )


def unpack(ctx: RunContext, folder: Path) -> Animation:
    """Verify the source digest while writing only locally numbered temporary PNGs."""
    item = ctx.input("frames")
    ref = item.file
    if ref is None or not 0 < ref["size_bytes"] <= MAX_BYTES:
        raise ComponentError(
            "INPUT_TOO_LARGE", "Animatic frame input must fit the 512 MiB bundle limit."
        )
    digest = hashlib.sha256()
    with item.require_path("frames").open("rb") as handle:
        if _read(handle, 8, digest) != b"PHANIM01":
            raise ComponentError(
                "INVALID_ARGUMENT", "Unsupported Phasyn animatic stream format."
            )
        clip = _header(_block(handle, HEADER_BYTES, digest))
        for index in range(clip.count):
            ctx.check_cancelled()
            data = _block(
                handle, min(FRAME_BYTES, ref["size_bytes"] - handle.tell()), digest
            )
            _png(
                data,
                clip.header["width"],
                clip.header["height"],
                folder / f"{index:06d}.png",
            )
        if (
            handle.tell() != ref["size_bytes"]
            or handle.read(1)
            or digest.hexdigest() != ref["sha256"]
        ):
            raise ComponentError(
                "INTEGRITY_MISMATCH",
                "Animatic bundle content differs from its published reference.",
            )
    return clip
