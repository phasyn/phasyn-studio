"""Intermediate previews (x-phasyn-extension): limits, image-header parsing and argument checks.

``RunContext.publish_preview`` hands one JPEG/PNG (never a final result) to the runtime host,
which forwards it to the Node; the Node keeps only the newest preview of a call and drops it when
the call ends. The Node and the controller share these limits.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .errors import ComponentError

# 中間預覽（publish_preview）的界限：Node 與主控使用同一組常數
PREVIEW_MEDIA_TYPES: tuple[str, ...] = ("image/jpeg", "image/png")
PREVIEW_MAX_BYTES = 2 * 1024 * 1024
PREVIEW_MAX_SIDE = 8192
PREVIEW_NOTE_MAX = 500
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SOF_EXCLUDED = (0xC4, 0xC8, 0xCC)  # DHT／JPG／DAC 不是 SOF


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or not data.startswith(_PNG_SIGNATURE) or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    """走 JPEG marker 直到第一個 SOF（baseline／progressive 都有），取標頭裡的寬高。"""
    n = len(data)
    if n < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    i = 2
    while i < n:
        if data[i] != 0xFF:
            return None
        while i < n and data[i] == 0xFF:  # marker 前可有填充的 0xFF
            i += 1
        if i >= n:
            return None
        marker = data[i]
        i += 1
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # 沒有長度欄位的獨立 marker
            continue
        if marker in (0xD9, 0xDA):  # EOI／SOS 出現在 SOF 之前：沒有可用的尺寸
            return None
        if i + 2 > n:
            return None
        length = (data[i] << 8) | data[i + 1]
        if length < 2 or i + length > n:
            return None
        if 0xC0 <= marker <= 0xCF and marker not in _JPEG_SOF_EXCLUDED:
            if length < 7:
                return None
            height = (data[i + 3] << 8) | data[i + 4]
            width = (data[i + 5] << 8) | data[i + 6]
            return width, height
        i += length
    return None


def preview_image_size(data: bytes, media_type: str) -> tuple[int, int] | None:
    """預覽影像標頭（PNG IHDR／JPEG SOF）記載的 (width, height)；不是該格式或標頭不完整 → None。"""
    if media_type == "image/png":
        return _png_size(data)
    if media_type == "image/jpeg":
        return _jpeg_size(data)
    return None


@dataclass(frozen=True)
class PreviewFrame:
    """一張中間預覽（非最終結果）。``published_ns`` 是 provider 呼叫 publish_preview 的 monotonic 時間。"""

    call_id: str
    step: int
    total: int
    data: bytes
    media_type: str
    width: int
    height: int
    note: str | None
    published_ns: int


# runtime host 提供的轉送：True＝已接手（之後仍可能被更新的預覽取代），False＝這張被丟棄
PreviewSink = Callable[[PreviewFrame], bool]


def preview_int(name: str, value: Any, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ComponentError(
            "RUNTIME_ERROR",
            f"publish_preview 的 {name} 必須是 {minimum}–{maximum} 的整數（收到 {value!r}）；這是 provider 的程式錯誤",
            details={"field": name},
        )
    return value


def checked_preview(
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
        raise ComponentError("RUNTIME_ERROR", "publish_preview 的 note 必須是字串或 None", details={"field": "note"})
    payload = bytes(data)  # a bytearray/memoryview is copied: the provider may reuse its own buffer afterwards
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
            details={"field": "width/height", "declared": [width, height], "actual": list(size)},
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
