"""Mux an encoded video track with float32 stereo PCM, with AV-sync verification.

Rules:

- ``mp4`` + ``pcm`` is rejected before any file is touched;
- the PCM sample rate and stereo L,R layout are preserved (no resampling);
- video is stream-copied; ``trim_to_seconds`` (the product's
  ``trim_to_requested`` postprocess, never an upstream behaviour) keeps exactly
  ``round(seconds*fps)`` frames by a lossless cut of a reorder-free track and
  cuts the PCM to ``round(delivered_seconds*sample_rate)`` samples with
  ``atrim`` before encoding, so AAC priming/padding is handled by the encoder
  and signalled by the container, never guessed from the PCM length;
- the result is verified with ffprobe: exactly one video + one stereo audio
  stream, delivered frame count on the CFR grid, monotonic packet timestamps
  (bounded scan), sample rate preserved, and |audio - video| <= one frame for
  start, end and duration, using the container's audio timeline (edit list /
  CodecDelay aware) — see ``phasyn_media.timeline``;
- output is written to a hidden temp file and atomically renamed only after
  verification and hashing.  Inputs are immutable files, so a failed mux is
  retryable on its own (``MEDIA_TOOL_FAILED`` is ``retryable=True``).
"""

from __future__ import annotations

import math
import os
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, TypedDict, Unpack

from phasyn_media._options import validate_keywords
from phasyn_media._validate import integer_value

from .audio import WavHeader, read_wav_header
from .errors import MediaError, raise_if_canceled
from .files import (
    LocalFile,
    check_local_file,
    check_output_path,
    file_sha256,
    partial_path,
    publish,
    remove_quietly,
)
from .limits import DEFAULT_LIMITS, MediaLimits
from .timeline import (
    FileTimeline,
    StreamTimeline,
    TrackCheck,
    check_video_stream,
    scan_timeline,
)
from .tools import (
    find_ffmpeg,
    find_ffprobe,
    input_url,
    redact,
    run_tool,
    summarize_stderr,
)


_MIN_AUDIO_BITRATE = 64_000
_MAX_AUDIO_BITRATE = 512_000
_EXPECTED_STREAMS = 2
_STEREO_CHANNELS = 2


AUDIO_CODECS = ("aac", "pcm")
VIDEO_CODECS = ("h264", "hevc", "av1")
CONTAINERS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    # container -> (ffmpeg muxer, media type, accepted output suffixes)
    "mp4": ("mp4", "video/mp4", (".mp4",)),
    "mkv": ("matroska", "video/x-matroska", (".mkv",)),
}
AUDIO_ENCODERS = {"aac": "aac", "pcm": "pcm_f32le"}


def container_for_suffix(suffix: str) -> tuple[str, str, str] | None:
    """``(container, ffmpeg muxer, media type)`` for an output suffix such as ``.mp4``; ``None`` if unknown."""
    lowered = suffix.lower()
    for name, (muxer, media_type, suffixes) in CONTAINERS.items():
        if lowered in suffixes:
            return name, muxer, media_type
    return None


MP4_PCM_MESSAGE = "MP4 不封裝 PCM 音訊；請改用 AAC，或選擇 MKV 容器保留 PCM"


def mp4_pcm_conflict(container: str, audio_codec: str) -> bool:
    """MP4 never carries PCM audio here."""
    return container == "mp4" and audio_codec == "pcm"


def check_container_audio(container: str, audio_codec: str) -> None:
    """Refuse MP4 + PCM before any file is touched."""
    if mp4_pcm_conflict(container, audio_codec):
        raise MediaError(
            "UNSUPPORTED_COMBINATION",
            MP4_PCM_MESSAGE,
            field_paths=["output.container", "output.audio_codec"],
        )


def _exact(value: Any, name: str) -> Fraction:
    if isinstance(value, bool) or not isinstance(value, (int, float, Fraction)):
        raise MediaError("INVALID_ARGUMENT", f"{name} 必須是數值")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise MediaError("INVALID_ARGUMENT", f"{name} 必須是有限數值")
        return Fraction(repr(value))  # decimal intent of the JSON number
    return Fraction(value)


def _round_half_up(value: Fraction) -> int:
    return math.floor(value + Fraction(1, 2))


def frames_for_seconds(seconds: Any, fps_num: int, fps_den: int) -> int:
    """Exact delivered frame count for the trim postprocess: round(seconds * fps)."""
    return _round_half_up(_exact(seconds, "seconds") * Fraction(fps_num, fps_den))


@dataclass(frozen=True)
class MuxResult:
    """A published video with verified stream and timing information."""

    path: Path
    container: str
    media_type: str
    video_codec: str
    audio_codec: str
    audio_encoder_name: str
    audio_bitrate: int | None
    sample_rate: int
    channels: int
    channel_layout: str | None
    fps_num: int
    fps_den: int
    width: int | None
    height: int | None
    pixel_format: str | None
    source_frames: int
    delivered_frames: int
    source_seconds: float
    delivered_seconds: float
    video_seconds: float
    audio_seconds: float
    audio_start_seconds: float
    input_audio_samples: int
    audio_priming_samples: int
    audio_unsignaled_padding_samples: int
    av_delta_seconds: float
    av_start_delta_seconds: float
    av_end_delta_seconds: float
    tolerance_seconds: float
    timestamps_monotonic: bool
    trimmed: bool
    sha256: str
    size_bytes: int
    color_primaries: str | None = None
    color_transfer: str | None = None
    color_space: str | None = None
    color_range: str | None = None

    def as_dict(self) -> dict[str, Any]:
        """Return the serializable field values."""
        doc = asdict(self)
        doc.pop("path")
        return doc


def mux(  # noqa: PLR0913 - Preserve the public keyword signature.
    *,
    video_track: str | os.PathLike[str],
    pcm: str | os.PathLike[str],
    output: str | os.PathLike[str],
    container: str = "mp4",
    audio_codec: str = "aac",
    audio_bitrate: int = 192_000,
    fps_num: int,
    fps_den: int,
    trim_to_seconds: float | None = None,
    cancel: Any = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    limits: MediaLimits = DEFAULT_LIMITS,
    expected_source_frames: int | None = None,
    video_codec: str | None = None,
) -> MuxResult:
    """Mux ``video_track`` + float32 stereo WAV ``pcm`` into ``output`` and verify AV sync."""
    bitrate = _output_bitrate(container, audio_codec, audio_bitrate)
    _check_mux_range(fps_num, fps_den, video_codec, trim_to_seconds)
    raise_if_canceled(cancel, "封裝")

    muxer, media_type = CONTAINERS[container][:2]
    video_local, pcm_local, header, final = _mux_files(
        video_track, pcm, output, container, limits
    )
    ffmpeg = ffmpeg or find_ffmpeg()
    ffprobe = ffprobe or find_ffprobe()
    fps = Fraction(fps_num, fps_den)
    frame = 1 / fps

    # ---------------------------------------------------------------- source track
    source = scan_timeline(
        video_local.path,
        limits=limits,
        ffprobe=ffprobe,
        cancel=cancel,
        expected_fps=fps,
    )
    src, src_stream = _source_stream(source, fps, expected_source_frames, video_codec)

    # ---------------------------------------------------------------- timing plan
    source_frames, rate = src.frames, header.sample_rate
    delivered_frames, trimmed, delivered_seconds, audio_samples = _delivery_timing(
        src, header, fps, trim_to_seconds
    )

    # ---------------------------------------------------------------- mux
    temp = partial_path(final)
    argv = [
        ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
        "-protocol_whitelist", "file", "-format_whitelist", limits.format_whitelist, *limits.decoder_flags,
        "-i", input_url(video_local.path),
        "-protocol_whitelist", "file", "-format_whitelist", "wav",
        "-i", input_url(pcm_local.path),
        "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
        "-c:v", "copy",
    ]  # fmt: skip
    if trimmed:
        argv += ["-frames:v", str(delivered_frames)]
    if src_stream.codec_name == "hevc" and container == "mp4":
        argv += ["-tag:v", "hvc1"]
    if audio_samples < header.frames:
        argv += ["-af", f"atrim=end_sample={audio_samples}"]
    argv += ["-c:a", AUDIO_ENCODERS[audio_codec]]
    if bitrate is not None:
        argv += ["-b:a", str(bitrate)]
    argv += ["-ar", str(rate), "-ac", "2"]
    if container == "mp4":
        argv += ["-movflags", "+faststart"]
    argv += ["-f", muxer, "-n", input_url(temp)]
    marks = {
        str(video_local.path): "<video_track>",
        input_url(video_local.path): "<video_track>",
        str(pcm_local.path): "<pcm>",
        input_url(pcm_local.path): "<pcm>",
        str(temp): "<output>",
        input_url(temp): "<output>",
    }
    try:
        _run_mux(argv, limits, cancel, marks)
        verified = _verify_output(
            temp,
            fps=fps,
            delivered_frames=delivered_frames,
            source_stream=src_stream,
            audio_codec=audio_codec,
            sample_rate=rate,
            input_samples=audio_samples,
            limits=limits,
            ffprobe=ffprobe,
            cancel=cancel,
        )
        sha256, size = file_sha256(temp, cancel=cancel)
        raise_if_canceled(cancel, "封裝")
        publish(temp, final)
    except BaseException:
        remove_quietly(temp)
        raise
    return MuxResult(
        path=final,
        container=container,
        media_type=media_type,
        video_codec=str(src_stream.codec_name),
        audio_codec=audio_codec,
        audio_encoder_name=AUDIO_ENCODERS[audio_codec],
        audio_bitrate=bitrate,
        sample_rate=rate,
        channels=2,
        channel_layout=verified["channel_layout"],
        fps_num=fps_num,
        fps_den=fps_den,
        width=src_stream.width,
        height=src_stream.height,
        pixel_format=src_stream.pixel_format,
        source_frames=source_frames,
        delivered_frames=delivered_frames,
        source_seconds=float(Fraction(source_frames) * frame),
        delivered_seconds=float(delivered_seconds),
        video_seconds=float(delivered_seconds),
        audio_seconds=verified["audio_seconds"],
        audio_start_seconds=verified["audio_start_seconds"],
        input_audio_samples=audio_samples,
        audio_priming_samples=verified["priming_samples"],
        audio_unsignaled_padding_samples=verified["padding_samples"],
        av_delta_seconds=verified["av_delta_seconds"],
        av_start_delta_seconds=verified["av_start_delta_seconds"],
        av_end_delta_seconds=verified["av_end_delta_seconds"],
        tolerance_seconds=float(frame),
        timestamps_monotonic=True,
        trimmed=trimmed,
        sha256=sha256,
        size_bytes=size,
        color_primaries=verified["color_primaries"],
        color_transfer=verified["color_transfer"],
        color_space=verified["color_space"],
        color_range=verified["color_range"],
    )


class _VerificationOptions(TypedDict):
    audio_codec: str
    sample_rate: int
    input_samples: int
    limits: MediaLimits
    ffprobe: str
    cancel: Any


def _verify_output(
    path: Path,
    *,
    fps: Fraction,
    delivered_frames: int,
    source_stream: Any,
    **options: Unpack[_VerificationOptions],
) -> dict[str, Any]:
    validate_keywords(options, _VerificationOptions)
    audio_codec = options["audio_codec"]
    sample_rate = options["sample_rate"]
    input_samples = options["input_samples"]
    limits = options["limits"]
    ffprobe = options["ffprobe"]
    cancel = options["cancel"]
    timeline = scan_timeline(
        path, limits=limits, ffprobe=ffprobe, cancel=cancel, expected_fps=fps
    )
    videos, audios = timeline.of_type("video"), timeline.of_type("audio")
    if (
        len(videos) != 1
        or len(audios) != 1
        or len(timeline.streams) != _EXPECTED_STREAMS
    ):
        raise MediaError(
            "INTEGRITY_MISMATCH", "封裝結果必須恰有一個 video 與一個 audio stream"
        )
    video = check_video_stream(
        videos[0],
        fps=fps,
        expected_frames=delivered_frames,
        width=source_stream.width,
        height=source_stream.height,
        codec=source_stream.codec_name,
        pixel_format=source_stream.pixel_format,
    )
    audio = audios[0]
    problems: list[str] = []
    if audio.channels != _STEREO_CHANNELS:
        problems.append(f"聲道數 {audio.channels} ≠ 2")
    if audio.channel_layout not in (None, "stereo"):
        problems.append(f"聲道配置 {audio.channel_layout} 不是 stereo")
    if audio.sample_rate != sample_rate:
        problems.append(f"取樣率 {audio.sample_rate} ≠ {sample_rate}")
    if audio.codec_name != AUDIO_ENCODERS[audio_codec]:
        problems.append(
            f"audio codec {audio.codec_name} ≠ {AUDIO_ENCODERS[audio_codec]}"
        )
    if not audio.timestamps_monotonic or audio.packets <= 0:
        problems.append("audio timestamps 非單調或缺漏")
    frame = float(1 / fps)
    epsilon = max(audio.tick_seconds, videos[0].tick_seconds) + 1e-9
    video_start = video.start_seconds
    video_end = video_start + video.duration_seconds
    audio_start = audio.start_seconds
    audio_end = audio.end_seconds
    audio_seconds = audio_end - audio_start
    duration_delta = abs(audio_seconds - video.duration_seconds)
    start_delta = abs(audio_start - video_start)
    end_delta = abs(audio_end - video_end)
    for label, delta in (
        ("時長", duration_delta),
        ("起點", start_delta),
        ("終點", end_delta),
    ):
        if delta > frame + epsilon:
            problems.append(
                f"音畫{label}相差 {delta:.6f} 秒，超過一個 frame（{frame:.6f} 秒）"
            )
    if problems:
        raise MediaError(
            "INTEGRITY_MISMATCH", "封裝結果驗證失敗：" + "；".join(problems)
        )
    padding = max(0, round(audio_seconds * sample_rate) - input_samples)
    return {
        "channel_layout": audio.channel_layout,
        "audio_seconds": audio_seconds,
        "audio_start_seconds": audio_start,
        "priming_samples": audio.priming_samples,
        "padding_samples": padding,
        "av_delta_seconds": duration_delta,
        "av_start_delta_seconds": start_delta,
        "av_end_delta_seconds": end_delta,
        "color_primaries": videos[0].color_primaries,
        "color_transfer": videos[0].color_transfer,
        "color_space": videos[0].color_space,
        "color_range": videos[0].color_range,
    }


def _output_bitrate(container: str, audio_codec: str, audio_bitrate: int) -> int | None:
    if container not in CONTAINERS:
        raise MediaError(
            "INVALID_ARGUMENT",
            "container 必須是 mp4 或 mkv",
            field_paths=["output.container"],
        )
    if audio_codec not in AUDIO_CODECS:
        raise MediaError(
            "INVALID_ARGUMENT",
            "audio codec 必須是 aac 或 pcm",
            field_paths=["output.audio_codec"],
        )
    check_container_audio(container, audio_codec)
    bitrate: int | None = None
    if audio_codec == "aac":
        if (
            not integer_value(audio_bitrate)
            or not _MIN_AUDIO_BITRATE <= audio_bitrate <= _MAX_AUDIO_BITRATE
        ):
            raise MediaError(
                "INVALID_ARGUMENT",
                "audio_bitrate 必須介於 64000..512000",
                field_paths=["output.audio_bitrate"],
            )
        bitrate = audio_bitrate
    return bitrate


def _check_mux_range(
    fps_num: int, fps_den: int, video_codec: str | None, trim_to_seconds: float | None
) -> None:
    for name, value, maximum in (
        ("fps_num", fps_num, 240_000),
        ("fps_den", fps_den, 1001),
    ):
        if not integer_value(value) or not 1 <= value <= maximum:
            raise MediaError("INVALID_ARGUMENT", f"{name} 必須是 1..{maximum} 的整數")
    if video_codec is not None and video_codec not in VIDEO_CODECS:
        raise MediaError(
            "INVALID_ARGUMENT", "video codec 不支援", field_paths=["output.video_codec"]
        )
    if trim_to_seconds is not None and _exact(trim_to_seconds, "trim_to_seconds") <= 0:
        raise MediaError(
            "INVALID_ARGUMENT",
            "trim_to_seconds 必須大於 0",
            field_paths=["output.requested_seconds"],
        )


def _source_stream(
    source: FileTimeline,
    fps: Fraction,
    expected_source_frames: int | None,
    video_codec: str | None,
) -> tuple[TrackCheck, StreamTimeline]:
    videos = source.of_type("video")
    if len(videos) != 1:
        raise MediaError("INTEGRITY_MISMATCH", "影片軌必須恰有一個 video stream")
    src = check_video_stream(
        videos[0], fps=fps, expected_frames=expected_source_frames, codec=video_codec
    )
    src_stream = videos[0]
    if src_stream.codec_name not in VIDEO_CODECS:
        raise MediaError(
            "UNSUPPORTED_COMBINATION",
            f"影片軌 codec {src_stream.codec_name} 不在交付允許清單",
        )
    if abs(src.start_seconds) > src_stream.tick_seconds + 1e-9:
        raise MediaError("INTEGRITY_MISMATCH", "影片軌起始時間不是 0")
    return src, src_stream


def _delivery_timing(
    src: TrackCheck, header: WavHeader, fps: Fraction, trim_to_seconds: float | None
) -> tuple[int, bool, Fraction, int]:
    frame = 1 / fps
    fps_num, fps_den = fps.numerator, fps.denominator
    source_frames = src.frames
    delivered_frames = source_frames
    trimmed = False
    if trim_to_seconds is not None:
        target = frames_for_seconds(trim_to_seconds, fps_num, fps_den)
        if target < 1:
            raise MediaError(
                "INVALID_ARGUMENT",
                "裁切後沒有任何 frame",
                field_paths=["output.requested_seconds"],
            )
        if target < source_frames:
            if not src.reorder_free:
                raise MediaError(
                    "UNSUPPORTED_COMBINATION",
                    "影片軌含 frame 重排（B-frames），無法無損精確裁切；請以無 B-frame 的串流編碼重新產生",
                )
            delivered_frames, trimmed = target, True
    delivered_seconds = Fraction(delivered_frames) * frame
    rate = header.sample_rate
    audio_samples = header.frames
    if trimmed:
        audio_samples = min(header.frames, _round_half_up(delivered_seconds * rate))
    used_audio = Fraction(audio_samples, rate)
    if abs(used_audio - delivered_seconds) > frame:
        raise MediaError(
            "INTEGRITY_MISMATCH",
            "音訊與影像長度相差超過一個 frame（末端錯位），拒絕封裝",
            expected=f"|Δ| <= {float(frame):.6f} s",
            actual=f"video {float(delivered_seconds):.6f} s / audio {float(used_audio):.6f} s",
        )
    return delivered_frames, trimmed, delivered_seconds, audio_samples


def _run_mux(
    argv: list[str], limits: MediaLimits, cancel: Any, marks: dict[str, str]
) -> None:
    result = run_tool(
        argv,
        timeout=limits.process_timeout_seconds,
        cancel=cancel,
        max_stdout_bytes=1 << 20,
        max_stderr_bytes=limits.max_stderr_bytes,
        what="FFmpeg mux",
    )
    if result.returncode != 0:
        detail = summarize_stderr(redact(result.stderr, marks), 800)
        raise MediaError(
            "MEDIA_TOOL_FAILED",
            "FFmpeg 封裝失敗" + (f"：{detail}" if detail else ""),
        )


def _mux_files(
    video_track: str | os.PathLike[str],
    pcm: str | os.PathLike[str],
    output: str | os.PathLike[str],
    container: str,
    limits: MediaLimits,
) -> tuple[LocalFile, LocalFile, WavHeader, Path]:
    suffixes = CONTAINERS[container][2]
    video_local = check_local_file(
        video_track, limits=limits, field_path="inputs.video_track"
    )
    pcm_local = check_local_file(pcm, limits=limits, field_path="inputs.pcm")
    header = read_wav_header(pcm_local.path, limits=limits)
    final = check_output_path(output, inputs=[video_local.path, pcm_local.path])
    if final.suffix.lower() not in suffixes:
        raise MediaError(
            "INVALID_ARGUMENT", f"{container} 輸出副檔名必須是 {'/'.join(suffixes)}"
        )
    return video_local, pcm_local, header, final
