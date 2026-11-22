"""Container timeline verification by a bounded packet scan.

The audio timeline is taken from container metadata, not from the raw PCM
length: the stream ``start_time`` already includes the encoder priming that
the container tells players to skip (MP4 edit list / Matroska CodecDelay ->
``skip_samples``), and the end is the last packet's ``pts + duration`` (MP4
truncates the final AAC packet to the real sample count through the edit list;
Matroska cannot signal the tail padding, so it remains visible there and is
reported).  Video must sit on the constant-frame-rate grid ``start + i/fps``
within one container tick, which also proves there is no accumulated drift.
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from .errors import MediaError
from .limits import DEFAULT_LIMITS, MediaLimits
from .probe import _float, _int, _rate, _tag, run_ffprobe_json
from .tools import find_ffprobe, input_url, redact, run_tool, summarize_stderr


@dataclass
class _PacketAcc:
    count: int = 0
    first_pts: int | None = None
    min_pts: int | None = None
    end_ts: int | None = None
    last_dts: int | None = None
    last_pts: int | None = None
    dts_increasing: bool = True
    pts_increasing: bool = True
    pts_equals_dts: bool = True
    missing: int = 0


@dataclass(frozen=True)
class StreamTimeline:
    """Presentation timestamps and timing metadata for one stream."""

    index: int
    codec_type: str
    codec_name: str | None
    time_base: Fraction
    packets: int
    start_seconds: float
    end_seconds: float
    first_packet_pts_seconds: float | None
    dts_monotonic: bool
    pts_monotonic: bool
    pts_equals_dts: bool
    missing_timestamps: int
    # video
    width: int | None = None
    height: int | None = None
    pixel_format: str | None = None
    has_b_frames: int | None = None
    fps: Fraction | None = None
    grid_max_drift_seconds: float | None = None
    color_primaries: str | None = None
    color_transfer: str | None = None
    color_space: str | None = None
    color_range: str | None = None
    # audio
    sample_rate: int | None = None
    channels: int | None = None
    channel_layout: str | None = None
    initial_padding: int | None = None
    attached_picture: bool = False

    @property
    def tick_seconds(self) -> float:
        """Return the duration of one timebase tick in seconds."""
        return float(self.time_base)

    @property
    def timestamps_monotonic(self) -> bool:
        """Check whether presentation timestamps are monotonic."""
        if self.missing_timestamps or not self.dts_monotonic:
            return False
        if self.codec_type == "audio":
            return self.pts_monotonic
        return True

    @property
    def priming_samples(self) -> int:
        """Encoder delay the container asks players to skip (edit list or CodecDelay)."""
        primed = 0
        if (
            self.sample_rate
            and self.first_packet_pts_seconds is not None
            and self.first_packet_pts_seconds < 0
        ):
            primed = round(-self.first_packet_pts_seconds * self.sample_rate)
        return max(primed, self.initial_padding or 0)


@dataclass(frozen=True)
class FileTimeline:
    """The presentation timelines of the streams in a file."""

    format_name: str
    duration_seconds: float | None
    streams: tuple[StreamTimeline, ...]

    def of_type(self, codec_type: str) -> list[StreamTimeline]:
        """Return the timelines matching the requested stream type."""
        return [s for s in self.streams if s.codec_type == codec_type]


class _PacketParser:
    """Incremental parser of ``ffprobe -show_entries packet=... -of compact`` lines."""

    def __init__(
        self, *, max_packets: int, max_bytes: int, video_pts: dict[int, list[int]]
    ) -> None:
        self.accs: dict[int, _PacketAcc] = {}
        self._video_pts = video_pts
        self._max_packets = max_packets
        self._max_bytes = max_bytes
        self._total = 0
        self._bytes = 0
        self._rest = b""

    def feed(self, chunk: bytes) -> None:
        self._bytes += len(chunk)
        if self._bytes > self._max_bytes:
            raise MediaError("RESOURCE_EXHAUSTED", "packet 掃描輸出超過上限")
        data = self._rest + chunk
        lines = data.split(b"\n")
        self._rest = lines.pop()
        for raw in lines:
            self._line(raw)

    def finish(self) -> dict[int, _PacketAcc]:
        if self._rest:
            self._line(self._rest)
            self._rest = b""
        return self.accs

    def _line(self, raw: bytes) -> None:
        raw = raw.strip()
        if not raw:
            return
        fields = _packet_fields(raw)
        index = _int(fields.get("stream_index"))
        if index is None:
            return
        self._total += 1
        if self._total > self._max_packets:
            raise MediaError(
                "RESOURCE_EXHAUSTED", f"packet 數量超過掃描上限 {self._max_packets}"
            )
        acc = self.accs.setdefault(index, _PacketAcc())
        pts, dts, duration = (
            _int(fields.get("pts")),
            _int(fields.get("dts")),
            _int(fields.get("duration")),
        )
        acc.count += 1
        if pts is None or dts is None:
            acc.missing += 1
            return
        if acc.first_pts is None:
            acc.first_pts = pts
        acc.min_pts = pts if acc.min_pts is None else min(acc.min_pts, pts)
        end = pts + max(duration or 0, 0)
        acc.end_ts = end if acc.end_ts is None else max(acc.end_ts, end)
        if acc.last_dts is not None and dts <= acc.last_dts:
            acc.dts_increasing = False
        if acc.last_pts is not None and pts <= acc.last_pts:
            acc.pts_increasing = False
        if pts != dts:
            acc.pts_equals_dts = False
        acc.last_dts, acc.last_pts = dts, pts
        if index in self._video_pts:
            self._video_pts[index].append(pts)


def _grid_drift(pts: list[int], tb: Fraction, fps: Fraction, start: Fraction) -> float:
    """Max |pts_i - (start + i/fps)| in seconds over presentation order."""
    if not pts:
        return math.inf
    worst = Fraction(0)
    step = 1 / fps
    for i, value in enumerate(sorted(pts)):
        worst = max(worst, abs(value * tb - (start + i * step)))
    return float(worst)


def scan_timeline(
    path: str | os.PathLike[str],
    *,
    limits: MediaLimits = DEFAULT_LIMITS,
    ffprobe: str | None = None,
    cancel: Any = None,
    expected_fps: Fraction | None = None,
) -> FileTimeline:
    """Header + bounded packet scan of a produced media file."""
    exe = ffprobe or find_ffprobe()
    try:
        head = run_ffprobe_json(
            path,
            [
                "-show_entries",
                "format=format_name,duration,nb_streams:stream=index,codec_type,codec_name,width,height,pix_fmt,sample_rate,channels,channel_layout,r_frame_rate,avg_frame_rate,start_time,time_base,has_b_frames,initial_padding,color_range,color_space,color_primaries,color_transfer:stream_disposition=attached_pic",
            ],
            limits=limits,
            ffprobe=exe,
            cancel=cancel,
        )
    except MediaError as exc:
        if exc.code != "INVALID_ARGUMENT":
            raise
        # an artifact we (or an upstream stage) produced that ffprobe cannot parse is a broken file
        raise MediaError(
            "INTEGRITY_MISMATCH", f"媒體檔無法解析：{exc.message}"
        ) from exc
    streams_doc = [s for s in head.get("streams") or [] if isinstance(s, Mapping)]
    if not streams_doc or len(streams_doc) > limits.max_streams:
        raise MediaError("INTEGRITY_MISMATCH", "輸出檔的串流數量不符")
    video_pts: dict[int, list[int]] = {
        int(s["index"]): []
        for s in streams_doc
        if s.get("codec_type") == "video" and _int(s.get("index")) is not None
    }

    url = input_url(path)
    parser = _PacketParser(
        max_packets=limits.max_scan_packets,
        max_bytes=limits.max_tool_output_bytes,
        video_pts=video_pts,
    )
    result = run_tool(
        [
            exe,
            "-hide_banner",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            limits.format_whitelist,
            *limits.decoder_flags,
            "-show_entries",
            "packet=stream_index,pts,dts,duration",
            "-of",
            "compact=p=0:nk=0",
            url,
        ],
        timeout=limits.process_timeout_seconds,
        cancel=cancel,
        stdout_sink=parser.feed,
        max_stderr_bytes=limits.max_stderr_bytes,
        what="ffprobe packet scan",
    )
    if result.returncode != 0:
        detail = summarize_stderr(
            redact(result.stderr, {os.fspath(path): "<output>", url: "<output>"}), 600
        )
        raise MediaError(
            "MEDIA_TOOL_FAILED", "packet 掃描失敗" + (f"：{detail}" if detail else "")
        )
    accs = parser.finish()

    timelines: list[StreamTimeline] = []
    for doc in streams_doc:
        index = _int(doc.get("index"))
        tb = _rate(doc.get("time_base"))
        if index is None or tb is None:
            raise MediaError("INTEGRITY_MISMATCH", "輸出檔缺少 time_base")
        acc = accs.get(index, _PacketAcc())
        start_meta = _float(doc.get("start_time"))
        first_pts = None if acc.first_pts is None else float(acc.first_pts * tb)
        min_pts = None if acc.min_pts is None else acc.min_pts * tb
        start = (
            start_meta
            if start_meta is not None
            else (float(min_pts) if min_pts is not None else 0.0)
        )
        end = float(acc.end_ts * tb) if acc.end_ts is not None else start
        codec_type = str(doc.get("codec_type") or "")
        fps = None
        drift = None
        if codec_type == "video":
            fps = (
                expected_fps
                or _rate(doc.get("avg_frame_rate"))
                or _rate(doc.get("r_frame_rate"))
            )
            if fps is not None and min_pts is not None:
                drift = _grid_drift(video_pts.get(index, []), tb, fps, min_pts)
        timelines.append(
            StreamTimeline(
                index=index,
                codec_type=codec_type,
                codec_name=_tag(doc.get("codec_name")),
                time_base=tb,
                packets=acc.count,
                start_seconds=start,
                end_seconds=end,
                first_packet_pts_seconds=first_pts,
                dts_monotonic=acc.dts_increasing,
                pts_monotonic=acc.pts_increasing,
                pts_equals_dts=acc.pts_equals_dts,
                missing_timestamps=acc.missing,
                width=_int(doc.get("width")),
                height=_int(doc.get("height")),
                pixel_format=_tag(doc.get("pix_fmt")),
                has_b_frames=_int(doc.get("has_b_frames")),
                fps=fps,
                grid_max_drift_seconds=drift,
                color_primaries=_tag(doc.get("color_primaries")),
                color_transfer=_tag(doc.get("color_transfer")),
                color_space=_tag(doc.get("color_space")),
                color_range=_tag(doc.get("color_range")),
                sample_rate=_int(doc.get("sample_rate")),
                channels=_int(doc.get("channels")),
                channel_layout=_tag(doc.get("channel_layout")),
                initial_padding=_int(doc.get("initial_padding")),
                attached_picture=bool(
                    (doc.get("disposition") or {}).get("attached_pic")
                ),
            )
        )
    fmt = head.get("format") or {}
    return FileTimeline(
        format_name=str(fmt.get("format_name") or ""),
        duration_seconds=_float(fmt.get("duration")),
        streams=tuple(timelines),
    )


@dataclass(frozen=True)
class TrackCheck:
    """Result of validating track timing against its expected duration."""

    frames: int
    start_seconds: float
    duration_seconds: float
    grid_max_drift_seconds: float
    timestamps_monotonic: bool
    reorder_free: bool
    stream: StreamTimeline


def check_video_stream(  # noqa: PLR0913 - Preserve the public keyword signature.
    stream: StreamTimeline,
    *,
    fps: Fraction,
    expected_frames: int | None = None,
    width: int | None = None,
    height: int | None = None,
    codec: str | None = None,
    pixel_format: str | None = None,
) -> TrackCheck:
    """Validate one video stream against the frozen delivery contract."""
    problems: list[str] = []
    if expected_frames is not None and stream.packets != expected_frames:
        problems.append(f"frame 數 {stream.packets} ≠ 預期 {expected_frames}")
    if stream.packets <= 0:
        problems.append("沒有任何 video frame")
    if (width is not None and stream.width != width) or (
        height is not None and stream.height != height
    ):
        problems.append(f"尺寸 {stream.width}x{stream.height} ≠ {width}x{height}")
    if codec is not None and stream.codec_name != codec:
        problems.append(f"codec {stream.codec_name} ≠ {codec}")
    if pixel_format is not None and stream.pixel_format != pixel_format:
        problems.append(f"pixel format {stream.pixel_format} ≠ {pixel_format}")
    if not stream.timestamps_monotonic:
        problems.append("video timestamps 非單調或缺漏")
    tick = max(stream.tick_seconds, 1e-9)
    drift = stream.grid_max_drift_seconds
    if drift is None or drift > tick + 1e-9:
        problems.append(f"video timestamps 偏離 {fps} fps 時間格（最大偏差 {drift}）")
    if problems:
        raise MediaError("INTEGRITY_MISMATCH", "影片軌驗證失敗：" + "；".join(problems))
    frames = stream.packets
    return TrackCheck(
        frames=frames,
        start_seconds=stream.start_seconds,
        duration_seconds=float(frames / fps),
        grid_max_drift_seconds=float(drift or 0.0),
        timestamps_monotonic=True,
        reorder_free=stream.pts_equals_dts and (stream.has_b_frames or 0) == 0,
        stream=stream,
    )


def _packet_fields(raw: bytes) -> dict[str, str]:
    fields: dict[str, str] = {}
    for part in raw.decode("ascii", errors="replace").split("|"):
        key, sep, value = part.partition("=")
        if sep:
            fields[key] = value
    return fields
