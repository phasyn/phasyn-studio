"""Bounded media probing of uploaded materials.

``probe`` only accepts a single regular local file within ``MediaLimits``.
ffprobe runs as a supervised child with ``-protocol_whitelist file`` and a
demuxer whitelist (no playlists, concat lists, image sequences or URLs), a
timeout and a bounded output; only header-level fields are requested.  When a
container has no frame count (e.g. Matroska) the packets of the chosen video
stream are counted by demuxing only (no decoding), still within the timeout.
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from fractions import Fraction
from typing import Any, TypedDict

from .errors import MediaError
from .files import LocalFile, check_local_file, unchanged_since
from .limits import DEFAULT_LIMITS, MediaLimits
from .seek import SourceTiming, lacks_start, source_timing
from .tools import find_ffprobe, input_url, redact, run_tool, summarize_stderr


TIMING_ENTRIES = "format=start_time:stream=index,codec_type,time_base,start_pts,sample_rate:stream_disposition=attached_pic"
FIRST_PACKETS = 64


def probe_source_timing(
    path: str | os.PathLike[str],
    *,
    limits: MediaLimits = DEFAULT_LIMITS,
    cancel: Any = None,
) -> SourceTiming:
    """Clocks of a file from its header; a stream the header gives no start for starts at its first packet."""
    header = run_ffprobe_json(
        path,
        ["-show_entries", TIMING_ENTRIES],
        limits=limits,
        cancel=cancel,
        max_output_bytes=65536,
    )
    if not lacks_start(header):
        return source_timing(header)
    first = run_ffprobe_json(
        path,
        [
            "-read_intervals",
            f"%+#{FIRST_PACKETS}",
            "-show_entries",
            "packet=stream_index,pts",
        ],
        limits=limits,
        cancel=cancel,
        max_output_bytes=65536,
    )
    starts: dict[int, int] = {}
    for packet in first.get("packets") or []:
        index, pts = packet.get("stream_index"), packet.get("pts")
        if isinstance(index, int) and isinstance(pts, int):
            starts[index] = min(pts, starts.get(index, pts))
    return source_timing(header, starts)


IMAGE_DEMUXERS = frozenset(
    {"png_pipe", "jpeg_pipe", "webp_pipe", "bmp_pipe", "tiff_pipe"}
)


_STREAM_ENTRIES = (
    "index,codec_type,codec_name,profile,width,height,pix_fmt,sample_rate,channels,channel_layout,"
    "r_frame_rate,avg_frame_rate,nb_frames,duration,start_time,time_base,color_range,color_space,"
    "color_primaries,color_transfer,has_b_frames,initial_padding"
)
SHOW_ENTRIES = (
    "format=format_name,duration,size,nb_streams,start_time"
    f":stream={_STREAM_ENTRIES}"
    ":stream_disposition=attached_pic,default"
    ":stream_side_data=side_data_type,rotation"
)


@dataclass(frozen=True)
class MediaInfo:
    """Video and audio properties identified by ffprobe."""

    kind: str  # image | video | audio
    format_name: str
    duration_seconds: float | None
    width: int | None
    height: int | None
    fps_num: int | None
    fps_den: int | None
    frame_count: int | None
    pixel_format: str | None
    color_primaries: str | None
    color_transfer: str | None
    color_space: str | None
    color_range: str | None
    has_audio: bool
    audio_sample_rate: int | None
    audio_channels: int | None
    audio_channel_layout: str | None
    video_codec: str | None
    audio_codec: str | None
    size_bytes: int = 0
    frame_count_exact: bool = True
    rotation_degrees: int | None = None
    video_streams: int = 0
    audio_streams: int = 0
    has_b_frames: int | None = None

    def as_dict(self) -> dict[str, Any]:
        """Return the serializable field values."""
        return asdict(self)


# --------------------------------------------------------------------------- ffprobe helpers


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except ValueError:
        return None


def _float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(str(value).strip())
    except ValueError:
        return None
    return out if math.isfinite(out) else None


def _rate(value: Any) -> Fraction | None:
    if not isinstance(value, str) or "/" not in value:
        return None
    num, _, den = value.partition("/")
    n, d = _int(num), _int(den)
    if n is None or d is None or n <= 0 or d <= 0:
        return None
    return Fraction(n, d)


def _tag(value: Any) -> str | None:
    if (
        not isinstance(value, str)
        or not value
        or value in ("unknown", "unspecified", "N/A")
    ):
        return None
    return value[:64]


def _constant_clock(
    stream: dict[str, Any], frames: list[dict[str, Any]]
) -> tuple[Fraction, Fraction, int]:
    tick = Fraction(stream["time_base"])
    rate = Fraction(stream["avg_frame_rate"])
    first = int(frames[0]["pts"])
    if tick <= 0 or rate <= 0 or rate * tick > 1:
        raise ValueError
    previous = first - 1
    ticks_per_frame = 1 / (rate * tick)
    for index, frame in enumerate(frames):
        pts = int(frame["pts"])
        if pts <= previous or abs(pts - first - index * ticks_per_frame) > Fraction(
            1, 2
        ):
            raise ValueError
        previous = pts
    duration = frames[-1].get("duration", frames[-1].get("pkt_duration"))
    if (
        duration is None
        or abs(int(duration) - ticks_per_frame) > 1
        or int(duration) < 1
    ):
        raise ValueError
    return tick, rate, first


def measured_frame_clock(
    path: str | os.PathLike[str], ref: Mapping[str, Any], *, cancel: Any, timeout: float
) -> dict[str, Any]:
    """Certify a constant presentation clock only when the decoded frame timestamps support it."""
    local = check_local_file(path)
    doc = run_ffprobe_json(
        local.path,
        [
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_streams",
            "-show_entries",
            "stream=time_base,avg_frame_rate:frame=pts,duration,pkt_duration",
        ],
        limits=DEFAULT_LIMITS,
        cancel=cancel,
        timeout=timeout,
        max_output_bytes=16 * 1024 * 1024,
    )
    if not unchanged_since(local) or local.size_bytes != ref["size_bytes"]:
        raise MediaError("INVALID_ARGUMENT", "探測期間來源檔案已變更")
    streams, frames = doc.get("streams") or [], doc.get("frames") or []
    if len(streams) != 1 or not 0 < len(frames) <= DEFAULT_LIMITS.max_frames:
        raise MediaError(
            "INVALID_ARGUMENT", "來源影片沒有可驗證的影格時鐘或超出分析範圍"
        )
    try:
        tick, rate, first = _constant_clock(streams[0], frames)
    except (TypeError, ValueError, KeyError, ZeroDivisionError) as error:
        raise MediaError("INVALID_ARGUMENT", "影格時間戳未能證實固定幀率") from error
    return {
        "kind": "cfr",
        "fps": {"num": rate.numerator, "den": rate.denominator},
        "frame_count": len(frames),
        "source_sha256": ref["sha256"],
        "source_size_bytes": local.size_bytes,
        "first_pts": first,
        "time_base": {"num": tick.numerator, "den": tick.denominator},
    }


def run_ffprobe_json(  # noqa: PLR0913 - Preserve the public keyword signature.
    path: str | os.PathLike[str],
    args: Sequence[str],
    *,
    limits: MediaLimits,
    ffprobe: str | None = None,
    cancel: Any = None,
    timeout: float | None = None,
    max_output_bytes: int = 4 * 1024 * 1024,
    redactions: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run ffprobe on one local file with whitelists; return parsed JSON."""
    exe = ffprobe or find_ffprobe()
    url = input_url(path)
    argv = [
        exe,
        "-hide_banner",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        limits.format_whitelist,
        *limits.decoder_flags,
        *args,
        "-of",
        "json",
        url,
    ]
    result = run_tool(
        argv,
        timeout=timeout or limits.probe_timeout_seconds,
        cancel=cancel,
        max_stdout_bytes=max_output_bytes,
        max_stderr_bytes=limits.max_stderr_bytes,
        what="ffprobe",
    )
    marks = {os.fspath(path): "<input>", url: "<input>", **(redactions or {})}
    if result.returncode < 0:
        raise MediaError(
            "MEDIA_TOOL_FAILED", f"ffprobe 異常結束（signal {-result.returncode}）"
        )
    if result.returncode != 0:
        detail = summarize_stderr(redact(result.stderr, marks), 600)
        raise MediaError(
            "INVALID_ARGUMENT",
            "無法辨識的媒體檔案，或格式不在允許清單"
            + (f"：{detail}" if detail else ""),
        )
    try:
        doc = json.loads(result.stdout.decode("utf-8", errors="replace") or "{}")
    except json.JSONDecodeError as exc:
        raise MediaError(
            "MEDIA_TOOL_FAILED", f"ffprobe 輸出不是合法 JSON：{exc.msg}"
        ) from exc
    if not isinstance(doc, dict):
        raise MediaError("MEDIA_TOOL_FAILED", "ffprobe 輸出格式不符")
    return doc


def count_packets(
    path: str | os.PathLike[str],
    stream_index: int,
    *,
    limits: MediaLimits,
    ffprobe: str | None = None,
    cancel: Any = None,
) -> int:
    """Count the packets in the chosen media stream."""
    doc = run_ffprobe_json(
        path,
        [
            "-count_packets",
            "-select_streams",
            str(int(stream_index)),
            "-show_entries",
            "stream=nb_read_packets",
        ],
        limits=limits,
        ffprobe=ffprobe,
        cancel=cancel,
    )
    streams = doc.get("streams") or []
    value = _int(streams[0].get("nb_read_packets")) if streams else None
    if value is None or value < 0:
        raise MediaError("MEDIA_TOOL_FAILED", "無法計算 video packets 數量")
    return value


def _is_attached_picture(stream: Mapping[str, Any]) -> bool:
    disposition = stream.get("disposition") or {}
    return bool(disposition.get("attached_pic"))


def _rotation(stream: Mapping[str, Any]) -> int | None:
    for item in stream.get("side_data_list") or []:
        if isinstance(item, Mapping) and item.get("rotation") is not None:
            value = _float(item.get("rotation"))
            if value is not None:
                return round(value) % 360
    return None


def _pick(streams: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    if not streams:
        return None
    for stream in streams:
        if (stream.get("disposition") or {}).get("default"):
            return stream
    return streams[0]


def _reject(message: str, *, expected: Any = None, actual: Any = None) -> MediaError:
    return MediaError("INVALID_ARGUMENT", message, expected=expected, actual=actual)


def _check_geometry(stream: Mapping[str, Any], limits: MediaLimits) -> tuple[int, int]:
    width, height = _int(stream.get("width")), _int(stream.get("height"))
    if width is None or height is None or width <= 0 or height <= 0:
        raise _reject("無法取得影像尺寸")
    if width > limits.max_width or height > limits.max_height:
        raise _reject(
            "影像尺寸超過上限",
            expected=f"<= {limits.max_width}x{limits.max_height}",
            actual=f"{width}x{height}",
        )
    if width * height > limits.max_pixels:
        raise _reject(
            "影像像素數超過上限",
            expected=f"<= {limits.max_pixels}",
            actual=str(width * height),
        )
    return width, height


def _check_audio(stream: Mapping[str, Any], limits: MediaLimits) -> tuple[int, int]:
    rate, channels = _int(stream.get("sample_rate")), _int(stream.get("channels"))
    if rate is None or rate <= 0 or channels is None or channels <= 0:
        raise _reject("無法取得音訊取樣率或聲道數")
    if rate > limits.max_sample_rate:
        raise _reject(
            "音訊取樣率超過上限",
            expected=f"<= {limits.max_sample_rate}",
            actual=str(rate),
        )
    if channels > limits.max_audio_channels:
        raise _reject(
            "音訊聲道數超過上限",
            expected=f"<= {limits.max_audio_channels}",
            actual=str(channels),
        )
    return rate, channels


# --------------------------------------------------------------------------- public API


def probe(  # noqa: PLR0913 - Preserve the public keyword signature.
    path: str | os.PathLike[str],
    *,
    limits: MediaLimits = DEFAULT_LIMITS,
    allowed_roots: Sequence[str | os.PathLike[str]] | None = None,
    count_frames: bool = True,
    ffprobe: str | None = None,
    cancel: Any = None,
) -> MediaInfo:
    """Probe one uploaded local media file within ``limits``.

    Raises ``MediaError("INVALID_ARGUMENT")`` for anything that is not a
    single regular local file, an unknown/unsupported container, or any value
    beyond the limits; ``MEDIA_TOOL_FAILED`` when ffprobe itself fails.
    """
    local = check_local_file(path, limits=limits, allowed_roots=allowed_roots)
    doc = run_ffprobe_json(
        local.path,
        ["-show_entries", SHOW_ENTRIES],
        limits=limits,
        ffprobe=ffprobe,
        cancel=cancel,
    )
    fmt, format_name, video_streams, audio_streams = _media_streams(doc, limits)

    kind = _media_kind(format_name, video_streams, audio_streams)

    video = _pick(video_streams)
    audio = _pick(audio_streams)
    width = height = fps_num = fps_den = frame_count = None
    frame_count_exact = True
    duration: float | None = None
    if video is not None:
        width, height = _check_geometry(video, limits)

    if kind == "image":
        frame_count = 1
    else:
        duration = _media_duration(video if kind == "video" else audio, fmt, limits)
    if kind == "video":
        fps_num, fps_den, frame_count, frame_count_exact = _video_frames(
            video,
            duration,
            local,
            limits,
            {"count_frames": count_frames, "ffprobe": ffprobe, "cancel": cancel},
        )
    if not unchanged_since(local):
        raise MediaError("INTEGRITY_MISMATCH", "媒體檔案在 probe 期間被修改")

    audio_rate = audio_channels = None
    if audio is not None:
        audio_rate, audio_channels = _check_audio(audio, limits)
    return MediaInfo(
        kind=kind,
        format_name=format_name[:128],
        duration_seconds=duration,
        width=width,
        height=height,
        fps_num=fps_num,
        fps_den=fps_den,
        frame_count=frame_count,
        pixel_format=_tag(video.get("pix_fmt")) if video is not None else None,
        color_primaries=_tag(video.get("color_primaries"))
        if video is not None
        else None,
        color_transfer=_tag(video.get("color_transfer")) if video is not None else None,
        color_space=_tag(video.get("color_space")) if video is not None else None,
        color_range=_tag(video.get("color_range")) if video is not None else None,
        has_audio=audio is not None,
        audio_sample_rate=audio_rate,
        audio_channels=audio_channels,
        audio_channel_layout=_tag(audio.get("channel_layout"))
        if audio is not None
        else None,
        video_codec=_tag(video.get("codec_name")) if video is not None else None,
        audio_codec=_tag(audio.get("codec_name")) if audio is not None else None,
        size_bytes=local.size_bytes,
        frame_count_exact=frame_count_exact,
        rotation_degrees=_rotation(video) if video is not None else None,
        video_streams=len(video_streams),
        audio_streams=len(audio_streams),
        has_b_frames=_int(video.get("has_b_frames")) if video is not None else None,
    )


def _media_streams(
    doc: Mapping[str, Any], limits: MediaLimits
) -> tuple[Mapping[str, Any], str, list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    fmt = doc.get("format") or {}
    streams = [s for s in (doc.get("streams") or []) if isinstance(s, Mapping)]
    nb_streams = _int(fmt.get("nb_streams")) or len(streams)
    if nb_streams > limits.max_streams or len(streams) > limits.max_streams:
        raise _reject(
            "串流數量超過上限",
            expected=f"<= {limits.max_streams}",
            actual=str(max(nb_streams, len(streams))),
        )
    format_name = str(fmt.get("format_name") or "")
    video_streams = [
        s
        for s in streams
        if s.get("codec_type") == "video" and not _is_attached_picture(s)
    ]
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    for stream in video_streams:
        _check_geometry(stream, limits)
    for stream in audio_streams:
        _check_audio(stream, limits)
    return fmt, format_name, video_streams, audio_streams


def _media_kind(
    format_name: str,
    video_streams: Sequence[Mapping[str, Any]],
    audio_streams: Sequence[Mapping[str, Any]],
) -> str:
    if format_name in IMAGE_DEMUXERS and video_streams:
        kind = "image"
    elif video_streams:
        kind = "video"
    elif audio_streams:
        kind = "audio"
    else:
        raise _reject("檔案沒有可用的影像或音訊串流")
    return kind


def _media_duration(
    primary: Mapping[str, Any] | None, fmt: Mapping[str, Any], limits: MediaLimits
) -> float:
    if primary is None:
        raise _reject("找不到可用的影音串流")
    duration = _float(primary.get("duration")) or _float(fmt.get("duration"))
    if duration is None or duration <= 0:
        raise _reject("無法取得媒體時長")
    if duration > limits.max_duration_seconds:
        raise _reject(
            "媒體時長超過上限",
            expected=f"<= {limits.max_duration_seconds} s",
            actual=f"{duration:.3f} s",
        )
    return duration


class _ProbeReadOptions(TypedDict):
    count_frames: bool
    ffprobe: str | None
    cancel: Any


def _video_frames(
    video: Mapping[str, Any] | None,
    duration: float | None,
    local: LocalFile,
    limits: MediaLimits,
    options: _ProbeReadOptions,
) -> tuple[int, int, int, bool]:
    count_frames = options["count_frames"]
    ffprobe = options.get("ffprobe")
    cancel = options.get("cancel")
    frame_count_exact = True
    if video is None or duration is None:
        raise _reject("找不到可用的影音串流")
    rate = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate"))
    if rate is None:
        raise _reject("無法判定 frame rate")
    fps_num, fps_den = rate.numerator, rate.denominator
    estimate = math.ceil(duration * rate)
    if estimate > limits.max_frames * 2:
        raise _reject(
            "frame 數超過上限",
            expected=f"<= {limits.max_frames}",
            actual=f"約 {estimate}",
        )
    frame_count = _int(video.get("nb_frames"))
    if frame_count is None or frame_count <= 0:
        if count_frames:
            frame_count = count_packets(
                local.path,
                int(video.get("index", 0)),
                limits=limits,
                ffprobe=ffprobe,
                cancel=cancel,
            )
        else:
            frame_count, frame_count_exact = estimate, False
    if frame_count > limits.max_frames:
        raise _reject(
            "frame 數超過上限",
            expected=f"<= {limits.max_frames}",
            actual=str(frame_count),
        )
    return fps_num, fps_den, frame_count, frame_count_exact
