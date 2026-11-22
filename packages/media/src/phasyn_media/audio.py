"""Stereo IEEE-float WAV I/O for the PCM wire layout (``media.audio.v1``: float32 ``[samples, 2]``, L,R).

Files are written as ``WAVE_FORMAT_EXTENSIBLE`` with the IEEE-float sub-format
and ``dwChannelMask = FL|FR`` so the L/R order is explicit to every reader
(FFmpeg reports ``stereo``), plus the ``fact`` chunk required for non-PCM WAV.
The header reader is a bounded RIFF parser (no ``wave`` module: it rejects float WAV)
that also accepts plain ``WAVE_FORMAT_IEEE_FLOAT`` with two channels.
"""

from __future__ import annotations

import hashlib
import os
import struct
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, BinaryIO

import numpy as np

from .errors import MediaError
from .files import (
    check_local_file,
    check_output_path,
    partial_path,
    publish,
    remove_quietly,
)
from .limits import DEFAULT_LIMITS, MediaLimits


_AUDIO_ARRAY_DIMENSIONS = 2
_RIFF_HEADER_BYTES = 12
_CHUNK_HEADER_BYTES = 8
_MIN_FORMAT_BYTES = 16
_MAX_FORMAT_BYTES = 64
_UNKNOWN_CHUNK_SIZE = 0xFFFFFFFF
_EXTENSIBLE_FORMAT_BYTES = 40
_FLOAT_SAMPLE_BITS = 32


WAVE_FORMAT_IEEE_FLOAT = 0x0003
WAVE_FORMAT_EXTENSIBLE = 0xFFFE
KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = bytes.fromhex("0300000000001000800000aa00389b71")
SPEAKER_FRONT_LEFT_RIGHT = 0x3
CHANNELS = 2
BYTES_PER_FRAME = CHANNELS * 4
_MAX_RIFF_DATA = 0xFFFFFFFF - 80  # RIFF sizes are uint32 (no RF64 support)
_MAX_CHUNKS = 64


@dataclass(frozen=True)
class AudioInfo:
    """Decoded audio stream properties used to plan media processing."""

    path: Path
    sample_rate: int
    channels: int
    frames: int  # samples per channel
    duration_seconds: float
    sample_format: str  # "f32le"
    channel_layout: str  # "stereo" (L,R)
    size_bytes: int
    sha256: str | None = None
    peak_abs: float | None = None

    def as_dict(self) -> dict[str, Any]:
        """Return the serializable field values."""
        doc = asdict(self)
        doc.pop("path")
        return doc


@dataclass(frozen=True)
class WavHeader:
    """PCM layout and data bounds from a WAV header."""

    sample_rate: int
    channels: int
    frames: int
    data_offset: int
    data_bytes: int
    format_tag: int
    channel_mask: int | None

    @property
    def duration_seconds(self) -> float:
        """Return the playback duration in seconds."""
        return self.frames / self.sample_rate


def _check_rate(sample_rate: Any, limits: MediaLimits) -> int:
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, (int, np.integer)):
        raise MediaError("INVALID_ARGUMENT", "sample_rate 必須是整數")
    rate = int(sample_rate)
    if not 1 <= rate <= limits.max_sample_rate:
        raise MediaError(
            "INVALID_ARGUMENT",
            "sample_rate 超出範圍",
            expected=f"1..{limits.max_sample_rate}",
            actual=rate,
        )
    return rate


def write_wav_f32(
    path: str | os.PathLike[str],
    samples_lr: np.ndarray,
    sample_rate: int,
    *,
    limits: MediaLimits = DEFAULT_LIMITS,
) -> AudioInfo:
    """Write float32 ``[N,2]`` (L,R) samples as an IEEE-float stereo WAV (atomic)."""
    if not isinstance(samples_lr, np.ndarray):
        raise MediaError("INVALID_ARGUMENT", "samples_lr 必須是 numpy 陣列")
    if samples_lr.dtype != np.float32:
        raise MediaError(
            "INVALID_ARGUMENT",
            "samples_lr 必須是 float32",
            expected="float32",
            actual=str(samples_lr.dtype),
        )
    if (
        samples_lr.ndim != _AUDIO_ARRAY_DIMENSIONS
        or samples_lr.shape[1] != CHANNELS
        or samples_lr.shape[0] < 1
    ):
        raise MediaError(
            "INVALID_ARGUMENT",
            "samples_lr 形狀必須是 [N,2]（L,R）",
            actual=str(samples_lr.shape),
        )
    rate = _check_rate(sample_rate, limits)
    frames = int(samples_lr.shape[0])
    if frames / rate > limits.max_duration_seconds:
        raise MediaError(
            "INVALID_ARGUMENT",
            "音訊時長超過上限",
            expected=f"<= {limits.max_duration_seconds} s",
        )
    data_bytes = frames * BYTES_PER_FRAME
    if data_bytes > _MAX_RIFF_DATA:
        raise MediaError("RESOURCE_EXHAUSTED", "WAV 資料超過 4 GiB RIFF 上限")
    if not np.isfinite(samples_lr).all():
        raise MediaError("INVALID_ARGUMENT", "PCM 含 NaN 或 Inf")
    peak = float(np.max(np.abs(samples_lr))) if frames else 0.0
    payload = np.ascontiguousarray(samples_lr, dtype="<f4")

    fmt = struct.pack(
        "<HHIIHHHHI16s",
        WAVE_FORMAT_EXTENSIBLE,
        CHANNELS,
        rate,
        rate * BYTES_PER_FRAME,
        BYTES_PER_FRAME,
        32,
        22,
        32,
        SPEAKER_FRONT_LEFT_RIGHT,
        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
    )
    fact = struct.pack("<I", frames)
    riff_size = 4 + (8 + len(fmt)) + (8 + len(fact)) + (8 + data_bytes)
    header = b"".join(
        [
            b"RIFF",
            struct.pack("<I", riff_size),
            b"WAVE",
            b"fmt ",
            struct.pack("<I", len(fmt)),
            fmt,
            b"fact",
            struct.pack("<I", len(fact)),
            fact,
            b"data",
            struct.pack("<I", data_bytes),
        ]
    )
    final = check_output_path(path)
    temp = partial_path(final)
    digest = hashlib.sha256()
    try:
        with Path(temp).open("xb") as fh:
            fh.write(header)
            digest.update(header)
            view = memoryview(payload).cast("B")
            fh.write(view)
            digest.update(view)
        publish(temp, final)
    except BaseException:
        remove_quietly(temp)
        raise
    return AudioInfo(
        path=final,
        sample_rate=rate,
        channels=CHANNELS,
        frames=frames,
        duration_seconds=frames / rate,
        sample_format="f32le",
        channel_layout="stereo",
        size_bytes=len(header) + data_bytes,
        sha256=digest.hexdigest(),
        peak_abs=peak,
    )


def read_wav_header(
    path: str | os.PathLike[str], *, limits: MediaLimits = DEFAULT_LIMITS
) -> WavHeader:
    """Parse and validate a stereo float32 WAV header (bounded RIFF walk)."""
    local = check_local_file(path, limits=limits)
    size = local.size_bytes
    with Path(local.path).open("rb") as fh:
        riff = fh.read(12)
        if (
            len(riff) < _RIFF_HEADER_BYTES
            or riff[:4] != b"RIFF"
            or riff[8:12] != b"WAVE"
        ):
            raise MediaError("INVALID_ARGUMENT", "不是 RIFF/WAVE 檔案")
        offset = 12
        fmt: bytes | None = None
        for _ in range(_MAX_CHUNKS):
            head = fh.read(8)
            if len(head) < _CHUNK_HEADER_BYTES:
                break
            chunk_id, chunk_size = head[:4], struct.unpack("<I", head[4:])[0]
            body_offset = offset + 8
            if chunk_id == b"fmt ":
                fmt = _read_wave_format(fh, chunk_size)
            elif chunk_id == b"data":
                if fmt is None:
                    raise MediaError(
                        "INVALID_ARGUMENT", "WAV data chunk 出現在 fmt 之前"
                    )
                if chunk_size == _UNKNOWN_CHUNK_SIZE or body_offset + chunk_size > size:
                    raise MediaError(
                        "INVALID_ARGUMENT",
                        "WAV data chunk 長度超出檔案（截斷或串流式 header）",
                    )
                return _header_from(fmt, body_offset, chunk_size, limits)
            else:
                fh.seek(chunk_size + (chunk_size & 1), os.SEEK_CUR)
            offset = body_offset + chunk_size + (chunk_size & 1)
            if chunk_id == b"fmt " and chunk_size & 1:
                fh.seek(1, os.SEEK_CUR)
            if offset > size:
                break
        raise MediaError("INVALID_ARGUMENT", "WAV 缺少 data chunk 或 chunk 數量過多")


def _header_from(
    fmt: bytes, data_offset: int, data_bytes: int, limits: MediaLimits
) -> WavHeader:
    tag, channels, rate, byte_rate, block_align, bits = struct.unpack(
        "<HHIIHH", fmt[:16]
    )
    mask = _channel_mask(fmt, tag)
    if (
        channels != CHANNELS
        or bits != _FLOAT_SAMPLE_BITS
        or block_align != BYTES_PER_FRAME
    ):
        raise MediaError(
            "INVALID_ARGUMENT",
            "WAV 必須是 2 聲道 32-bit float",
            actual=f"{channels} ch / {bits} bit / align {block_align}",
        )
    _check_rate(rate, limits)
    if byte_rate != rate * BYTES_PER_FRAME:
        raise MediaError("INVALID_ARGUMENT", "WAV byte rate 與取樣率不一致")
    if data_bytes % BYTES_PER_FRAME:
        raise MediaError("INVALID_ARGUMENT", "WAV data 長度不是完整 frame 的倍數")
    frames = data_bytes // BYTES_PER_FRAME
    if frames < 1:
        raise MediaError("INVALID_ARGUMENT", "WAV 沒有音訊樣本")
    if frames / rate > limits.max_duration_seconds:
        raise MediaError(
            "INVALID_ARGUMENT",
            "音訊時長超過上限",
            expected=f"<= {limits.max_duration_seconds} s",
        )
    return WavHeader(rate, channels, frames, data_offset, data_bytes, tag, mask)


def _read_wave_format(fh: BinaryIO, chunk_size: int) -> bytes:
    if not _MIN_FORMAT_BYTES <= chunk_size <= _MAX_FORMAT_BYTES:
        raise MediaError("INVALID_ARGUMENT", "WAV fmt chunk 大小不合法")
    fmt = fh.read(chunk_size)
    if len(fmt) != chunk_size:
        raise MediaError("INVALID_ARGUMENT", "WAV fmt chunk 不完整")
    return fmt


def _channel_mask(fmt: bytes, tag: int) -> int | None:
    mask: int | None = None
    if tag == WAVE_FORMAT_EXTENSIBLE:
        if len(fmt) < _EXTENSIBLE_FORMAT_BYTES:
            raise MediaError(
                "INVALID_ARGUMENT", "WAVE_FORMAT_EXTENSIBLE fmt chunk 不完整"
            )
        _cb, _valid_bits, mask, subformat = struct.unpack("<HHI16s", fmt[16:40])
        if subformat != KSDATAFORMAT_SUBTYPE_IEEE_FLOAT:
            raise MediaError("INVALID_ARGUMENT", "WAV 必須是 IEEE float（float32）")
        if mask not in (0, SPEAKER_FRONT_LEFT_RIGHT):
            raise MediaError(
                "INVALID_ARGUMENT", "WAV 聲道配置必須是 L,R 立體聲", actual=hex(mask)
            )
    elif tag != WAVE_FORMAT_IEEE_FLOAT:
        raise MediaError(
            "INVALID_ARGUMENT", "WAV 必須是 IEEE float（float32）", actual=hex(tag)
        )
    return mask
