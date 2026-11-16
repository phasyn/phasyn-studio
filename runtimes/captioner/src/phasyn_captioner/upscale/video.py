"""FFmpeg side of ``media.upscale``: check the source, stream its frames as RGB, and copy its audio onto the result.

* ``inspect_source`` accepts exactly one constant-frame-rate video stream that starts at 0 (checked on the packet
  timeline, not on header values), no rotation, and at most one audio stream whose codec can be stream-copied into
  MP4. The frame count is the number of video packets.
* ``FrameReader`` decodes the video once to ``rgb24`` with the source's own YUV matrix and range (an untagged source
  is read as BT.709 limited range, which is what the H3 decoder writes, and the metadata says so); it yields exactly
  the counted number of frames or fails, and a watcher thread kills FFmpeg on cancel or deadline.
* ``attach_audio`` stream-copies the source's audio next to the new video track and verifies that the result has the
  expected frames and the same audio packets, codec and start/end times as the source.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
from phasyn_components.errors import ComponentError
from phasyn_media.errors import MediaError, cancel_requested
from phasyn_media.files import file_sha256, partial_path, publish, remove_quietly
from phasyn_media.limits import DEFAULT_LIMITS, MediaLimits
from phasyn_media.probe import probe
from phasyn_media.timeline import StreamTimeline, check_video_stream, scan_timeline
from phasyn_media.tools import ManagedProcess, find_ffmpeg, input_url, redact, run_tool, summarize_stderr, tool_env

# Audio codecs that MP4 carries as a plain stream copy (the Studio takes and exports are AAC).
COPY_AUDIO_CODECS = ("aac", "mp3", "alac")
# FFmpeg colour-space tag -> swscale matrix name
MATRICES = {
    "bt709": "bt709",
    "smpte170m": "smpte170m",
    "bt470bg": "bt470bg",
    "bt2020nc": "bt2020",
    "smpte240m": "smpte240m",
    "fcc": "fcc",
}
RANGES = {"tv": "tv", "pc": "pc"}
_WATCH_INTERVAL_S = 0.05


@dataclass(frozen=True)
class AudioTrack:
    codec: str
    packets: int
    start_seconds: float
    end_seconds: float
    tick_seconds: float
    sample_rate: int | None
    channels: int | None


@dataclass(frozen=True)
class SourceVideo:
    path: Path
    width: int
    height: int
    fps: Fraction
    frames: int
    pixel_format: str | None
    matrix: str
    color_range: str
    color_assumed: bool
    color: dict[str, str | None]
    audio: AudioTrack | None
    dropped_streams: int


def _unsupported(message: str, **details: Any) -> ComponentError:
    return ComponentError("UNSUPPORTED_SETTING", message, details=details or None)


def _audio(stream: StreamTimeline) -> AudioTrack:
    codec = str(stream.codec_name or "")
    if codec not in COPY_AUDIO_CODECS:
        raise _unsupported(
            f"來源音訊 {codec or '未知'} 不能原樣複製進 MP4（支援 {'、'.join(COPY_AUDIO_CODECS)}）", audio_codec=codec
        )
    if not stream.timestamps_monotonic or stream.packets <= 0:
        raise ComponentError("MEDIA_INCOMPLETE", "來源音訊的時間戳非單調或缺漏")
    return AudioTrack(
        codec=codec,
        packets=stream.packets,
        start_seconds=stream.start_seconds,
        end_seconds=stream.end_seconds,
        tick_seconds=stream.tick_seconds,
        sample_rate=stream.sample_rate,
        channels=stream.channels,
    )


def inspect_source(path: Path, *, cancel: Any, limits: MediaLimits = DEFAULT_LIMITS) -> SourceVideo:
    """Probe and packet-scan the source; raises ``MediaError`` for tool failures and ``ComponentError`` for refusals."""
    info = probe(path, limits=limits, count_frames=True, cancel=cancel)
    if info.kind != "video":
        raise ComponentError("INVALID_ARGUMENT", f"來源不是影片（{info.kind}）")
    if info.video_streams != 1:
        raise _unsupported(f"來源有 {info.video_streams} 個影片串流（只接受一個）", video_streams=info.video_streams)
    if info.audio_streams > 1:
        raise _unsupported(
            f"來源有 {info.audio_streams} 個音訊串流（只能原樣複製一個）", audio_streams=info.audio_streams
        )
    if info.rotation_degrees not in (None, 0):
        raise _unsupported(f"來源帶有 {info.rotation_degrees}° 旋轉標記（不在超分時旋轉）")
    if not info.fps_num or not info.fps_den or not info.width or not info.height:
        raise ComponentError("MEDIA_INCOMPLETE", "無法取得來源的 fps 或尺寸")
    fps = Fraction(info.fps_num, info.fps_den)
    if fps.denominator > 1001 or fps.numerator > 240_000:
        raise _unsupported(f"來源 fps {fps} 無法以固定 fps 重新編碼")
    timeline = scan_timeline(path, limits=limits, cancel=cancel, expected_fps=fps)
    videos, audios = timeline.of_type("video"), timeline.of_type("audio")
    if len(videos) != 1:
        raise _unsupported("來源的影片串流數與 probe 不一致")
    try:
        check = check_video_stream(videos[0], fps=fps, width=info.width, height=info.height)
    except MediaError as exc:
        raise _unsupported(f"來源不是固定 fps 的影片，重新編碼會改變時間：{exc.message}") from exc
    if abs(check.start_seconds) > videos[0].tick_seconds + 1e-9:
        raise _unsupported(f"來源影片軌起始時間是 {check.start_seconds:.6f} 秒（不是 0），音畫相對位置無法保持")
    if info.frame_count is not None and info.frame_count != check.frames:
        raise ComponentError(
            "MEDIA_INCOMPLETE",
            f"來源標頭記錄 {info.frame_count} 幀，實際有 {check.frames} 個影片 packet",
            details={"header_frames": info.frame_count, "packets": check.frames},
        )
    space, value_range = info.color_space, info.color_range
    assumed = space is None or value_range is None
    matrix = MATRICES.get(space or "bt709")
    if matrix is None or (value_range is not None and value_range not in RANGES):
        raise _unsupported(f"不支援的來源色彩標記（color_space={space}, color_range={value_range}）")
    return SourceVideo(
        path=path,
        width=int(info.width),
        height=int(info.height),
        fps=fps,
        frames=check.frames,
        pixel_format=info.pixel_format,
        matrix=matrix,
        color_range=RANGES.get(value_range or "tv", "tv"),
        color_assumed=assumed,
        color={
            "primaries": info.color_primaries,
            "transfer": info.color_transfer,
            "space": space,
            "range": value_range,
        },
        audio=_audio(audios[0]) if audios else None,
        dropped_streams=max(0, len(timeline.streams) - len(videos) - len(audios)),
    )


class FrameReader:
    """``with FrameReader(source, cancel=…) as reader: for frame in reader.frames(): …`` (``uint8 [H, W, 3]``)."""

    def __init__(self, source: SourceVideo, *, cancel: Any, limits: MediaLimits = DEFAULT_LIMITS) -> None:
        self.source = source
        self._cancel = cancel
        self._limits = limits
        self._proc: ManagedProcess | None = None
        self._stop = threading.Event()
        self._watcher: threading.Thread | None = None
        self._marks = {str(source.path): "<video>", input_url(source.path): "<video>"}

    def _argv(self) -> list[str]:
        s = self.source
        scale = (
            f"scale=in_color_matrix={s.matrix}:in_range={s.color_range}:flags=bicubic+accurate_rnd+full_chroma_int,"
            "format=rgb24"
        )
        return [
            find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
            "-protocol_whitelist", "file", "-format_whitelist", self._limits.format_whitelist,
            *self._limits.decoder_flags,
            "-i", input_url(s.path),
            "-map", "0:V:0", "-an", "-sn", "-dn", "-vf", scale, "-fps_mode", "passthrough",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]  # fmt: skip

    def __enter__(self) -> FrameReader:
        import subprocess

        self._proc = ManagedProcess(
            self._argv(), stdout=subprocess.PIPE, env=tool_env(), max_stderr_bytes=self._limits.max_stderr_bytes
        )
        self._watcher = threading.Thread(target=self._watch, name="upscale-decode-watcher", daemon=True)
        self._watcher.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._proc is not None:
            self._proc.kill_tree()
            self._proc.close()
        if self._watcher is not None:
            self._watcher.join(2.0)

    def _watch(self) -> None:
        while not self._stop.wait(_WATCH_INTERVAL_S):
            if cancel_requested(self._cancel) and self._proc is not None:
                self._proc.kill_tree()
                return

    def _failure(self, message: str) -> MediaError:
        if cancel_requested(self._cancel):
            return MediaError("CANCELLED", "已要求取消")
        stderr = summarize_stderr(redact(self._proc.stderr_text() if self._proc else "", self._marks), 600)
        return MediaError("MEDIA_TOOL_FAILED", message + (f"：{stderr}" if stderr else ""))

    def frames(self) -> Iterator[np.ndarray]:
        if self._proc is None or self._proc.stdout is None:
            raise RuntimeError("FrameReader.frames() needs the with block")
        stream = self._proc.stdout
        height, width = self.source.height, self.source.width
        size = width * height * 3
        for index in range(self.source.frames):
            buffer = bytearray(size)
            view = memoryview(buffer)
            got = 0
            while got < size:
                n = stream.readinto(view[got:])
                if not n:
                    break
                got += n
            if got != size:
                raise self._failure(f"FFmpeg 解碼只得到 {index} 幀（預期 {self.source.frames} 幀）")
            yield np.frombuffer(buffer, dtype=np.uint8).reshape(height, width, 3)
        if stream.read(1):
            raise MediaError("INTEGRITY_MISMATCH", f"FFmpeg 解碼出的影格比計數的 {self.source.frames} 幀多")
        if self._proc.wait(self._limits.process_timeout_seconds) != 0:
            raise self._failure("FFmpeg 解碼失敗")


def attach_audio(
    track: Path, source: SourceVideo, output: Path, *, frames: int, cancel: Any, limits: MediaLimits = DEFAULT_LIMITS
) -> tuple[str, int]:
    """Stream-copy ``source``'s audio next to ``track`` into ``output``; verified, hashed, then published → (sha, size)."""
    audio = source.audio
    if audio is None:
        raise ValueError("attach_audio needs a source with audio")
    temp = partial_path(output)
    argv = [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
        "-protocol_whitelist", "file", "-format_whitelist", "mov", "-i", input_url(track),
        "-protocol_whitelist", "file", "-format_whitelist", limits.format_whitelist, *limits.decoder_flags,
        "-i", input_url(source.path),
        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1",
        "-movflags", "+faststart", "-f", "mp4", "-n", input_url(temp),
    ]  # fmt: skip
    marks = {str(p): f"<{n}>" for n, p in (("track", track), ("video", source.path), ("output", temp))}
    marks |= {input_url(Path(k)): v for k, v in list(marks.items())}
    try:
        result = run_tool(
            argv,
            timeout=limits.process_timeout_seconds,
            cancel=cancel,
            max_stdout_bytes=1 << 20,
            max_stderr_bytes=limits.max_stderr_bytes,
            what="FFmpeg 複製音訊",
        )
        if result.returncode != 0:
            detail = summarize_stderr(redact(result.stderr, marks), 800)
            raise MediaError("MEDIA_TOOL_FAILED", "FFmpeg 複製音訊失敗" + (f"：{detail}" if detail else ""))
        _verify(temp, source, audio, frames=frames, cancel=cancel, limits=limits)
        sha256, size = file_sha256(temp, cancel=cancel)
        if cancel_requested(cancel):
            raise MediaError("CANCELLED", "已要求取消")
        publish(temp, output)
    except BaseException:
        remove_quietly(temp)
        raise
    return sha256, size


def _verify(
    path: Path, source: SourceVideo, audio: AudioTrack, *, frames: int, cancel: Any, limits: MediaLimits
) -> None:
    timeline = scan_timeline(path, limits=limits, cancel=cancel, expected_fps=source.fps)
    videos, audios = timeline.of_type("video"), timeline.of_type("audio")
    if len(videos) != 1 or len(audios) != 1 or len(timeline.streams) != 2:
        raise MediaError("INTEGRITY_MISMATCH", "結果必須恰有一個 video 與一個 audio stream")
    check_video_stream(videos[0], fps=source.fps, expected_frames=frames, codec="h264", pixel_format="yuv420p")
    out = audios[0]
    tolerance = max(out.tick_seconds, audio.tick_seconds) + 1e-9
    problems = []
    if out.codec_name != audio.codec:
        problems.append(f"audio codec {out.codec_name} ≠ 來源 {audio.codec}")
    if out.packets != audio.packets:
        problems.append(f"audio packet 數 {out.packets} ≠ 來源 {audio.packets}")
    if abs(out.start_seconds - audio.start_seconds) > tolerance or abs(out.end_seconds - audio.end_seconds) > tolerance:
        problems.append(
            f"audio 時間 {out.start_seconds:.6f}–{out.end_seconds:.6f} ≠ 來源 {audio.start_seconds:.6f}–{audio.end_seconds:.6f}"
        )
    if problems:
        raise MediaError("INTEGRITY_MISMATCH", "複製音訊後驗證失敗：" + "；".join(problems))


__all__ = ["COPY_AUDIO_CODECS", "AudioTrack", "FrameReader", "SourceVideo", "attach_audio", "inspect_source"]
