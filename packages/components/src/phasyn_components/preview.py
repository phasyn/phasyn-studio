"""Intermediate previews (x-phasyn-extension): limits, image-header parsing and argument checks.

``RunContext.publish_preview`` hands one JPEG/PNG (never a final result) to the runtime host,
which forwards it to the Node; the Node keeps only the newest preview of a call and drops it when
the call ends. The Node and the controller share these limits.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from .errors import ComponentError


# 中間預覽（publish_preview）的界限：Node 與主控使用同一組常數
PREVIEW_MEDIA_TYPES: tuple[str, ...] = ("image/jpeg", "image/png")
PREVIEW_MAX_BYTES = 2 * 1024 * 1024
PREVIEW_MAX_SIDE = 8192
PREVIEW_NOTE_MAX = 500
_PNG_SIZE_BYTES = 24
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SOF_EXCLUDED = (0xC4, 0xC8, 0xCC)  # DHT／JPG／DAC 不是 SOF


def _png_size(data: bytes) -> tuple[int, int] | None:
    if (
        len(data) < _PNG_SIZE_BYTES
        or not data.startswith(_PNG_SIGNATURE)
        or data[12:16] != b"IHDR"
    ):
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


_JPEG_START = bytes((0xFF, 0xD8))
_JPEG_PREFIX = 0xFF
_JPEG_MIN_HEADER = 4
_JPEG_LENGTH_BYTES = 2
_JPEG_SOF_SIZE_BYTES = 7
_JPEG_STANDALONE = frozenset((0x01, *range(0xD0, 0xD9)))
_JPEG_SOF = frozenset(range(0xC0, 0xD0)).difference(_JPEG_SOF_EXCLUDED)


def _jpeg_segments(data: bytes) -> Iterator[tuple[int, int, int]]:
    """Yield complete length-prefixed segments up to the scan or end marker."""
    index = len(_JPEG_START)
    while index < len(data) and data[index] == _JPEG_PREFIX:
        while index < len(data) and data[index] == _JPEG_PREFIX:
            index += 1
        if index == len(data):
            break
        marker = data[index]
        index += 1
        if marker in _JPEG_STANDALONE:
            continue
        if marker in (0xD9, 0xDA) or index + _JPEG_LENGTH_BYTES > len(data):
            break
        length = int.from_bytes(data[index : index + _JPEG_LENGTH_BYTES], "big")
        if length < _JPEG_LENGTH_BYTES or index + length > len(data):
            break
        yield marker, index, length
        index += length


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < _JPEG_MIN_HEADER or not data.startswith(_JPEG_START):
        return None
    for marker, index, length in _jpeg_segments(data):
        if marker in _JPEG_SOF:
            if length < _JPEG_SOF_SIZE_BYTES:
                return None
            height = int.from_bytes(data[index + 3 : index + 5], "big")
            width = int.from_bytes(data[index + 5 : index + 7], "big")
            return width, height
    return None


def preview_image_size(data: bytes, media_type: str) -> tuple[int, int] | None:
    """預覽影像標頭（PNG IHDR／JPEG SOF）記載的 (width, height)；不是該格式或標頭不完整 → None."""
    if media_type == "image/png":
        return _png_size(data)
    if media_type == "image/jpeg":
        return _jpeg_size(data)
    return None


@dataclass(frozen=True)
class PreviewFrame:
    """一張中間預覽（非最終結果）。``published_ns`` 是 provider 呼叫 publish_preview 的 monotonic 時間."""

    call_id: str
    step: int
    total: int
    data: bytes
    media_type: str
    width: int
    height: int
    note: str | None
    published_ns: int


# runtime host 提供的轉送：True=已接手（之後仍可能被更新的預覽取代），False=這張被丟棄
PreviewSink = Callable[[PreviewFrame], bool]


def preview_int(name: str, value: Any, minimum: int, maximum: int) -> int:
    """Validate a bounded integer preview field."""
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ComponentError(
            "RUNTIME_ERROR",
            f"publish_preview 的 {name} 必須是 {minimum}\N{EN DASH}{maximum} 的整數（收到 {value!r}）；這是 provider 的程式錯誤",
            details={"field": name},
        )
    return value


def checked_preview(  # noqa: PLR0913 - Keep the published positional and keyword API.
    *,
    step: int,
    total: int,
    data: bytes | bytearray | memoryview,
    media_type: str,
    width: int,
    height: int,
    note: str | None,
) -> tuple[bytes, int, int, int, int]:
    """Validate ``publish_preview`` arguments; return ``(payload, step, total, width, height)``.

    A wrong type or range, a media type not allowed, bytes that are not that image type, or a size
    that differs from the image header is a provider programming error: ``RUNTIME_ERROR``.
    """
    total = preview_int("total", total, 1, 2**53 - 1)
    step = preview_int("step", step, 0, total)
    width = preview_int("width", width, 1, PREVIEW_MAX_SIDE)
    height = preview_int("height", height, 1, PREVIEW_MAX_SIDE)
    if media_type not in PREVIEW_MEDIA_TYPES:
        raise ComponentError(
            "RUNTIME_ERROR",
            f"publish_preview 的 media_type 只接受 {'、'.join(PREVIEW_MEDIA_TYPES)}（收到 {media_type!r}）",
            details={"field": "media_type"},
        )
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ComponentError(
            "RUNTIME_ERROR",
            f"publish_preview 的 data 必須是 bytes（收到 {type(data).__name__}）",
            details={"field": "data"},
        )
    if note is not None and not isinstance(note, str):
        raise ComponentError(
            "RUNTIME_ERROR",
            "publish_preview 的 note 必須是字串或 None",
            details={"field": "note"},
        )
    payload = bytes(
        data
    )  # a bytearray/memoryview is copied: the provider may reuse its own buffer afterwards
    size = preview_image_size(payload, media_type)
    if size is None:
        raise ComponentError(
            "RUNTIME_ERROR",
            f"publish_preview 的 data 不是有效的 {media_type}（找不到影像標頭）",
            details={"field": "data", "size_bytes": len(payload)},
        )
    if size != (width, height):
        raise ComponentError(
            "RUNTIME_ERROR",
            f"publish_preview 的 {width}×{height} 與影像標頭記載的 {size[0]}×{size[1]} 不同",
            details={
                "field": "width/height",
                "declared": [width, height],
                "actual": list(size),
            },
        )
    return payload, step, total, width, height


__all__ = [
    "PREVIEW_MAX_BYTES",
    "PREVIEW_MAX_SIDE",
    "PREVIEW_MEDIA_TYPES",
    "PREVIEW_NOTE_MAX",
    "PreviewFrame",
    "PreviewSink",
    "checked_preview",
    "preview_image_size",
    "preview_int",
]
