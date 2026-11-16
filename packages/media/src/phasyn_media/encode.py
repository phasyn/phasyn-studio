"""Streaming video encode companion.

The producer (VideoVAE decode) hands RGB uint8 ``[F,H,W,3]`` chunks to
``write_chunk``; a bounded queue (<= 4 chunks) feeds a supervised FFmpeg child
through its stdin.  Backpressure: ``write_chunk`` blocks while the queue is
full, so frames are never accumulated in RAM beyond 4 chunks + 1 in flight.

Failure coupling (both directions):

- companion failure (non-zero exit, early exit, broken pipe) is recorded by
  the watcher/feeder threads; the producer's next ``write_chunk`` / ``finish``
  / ``raise_if_failed`` raises promptly, even while blocked on a full queue;
- producer failure: leaving the context manager with an exception (or without
  ``finish``) calls ``abort`` which kills the companion's process group and
  deletes the partial file, so no encoder is ever left waiting for EOF; a GC
  finalizer does the same for leaked encoders;
- cancel: the feeder polls the ``CancellationToken`` every 50 ms, kills the
  companion and removes the partial output even while the producer is busy.

``finish`` sends EOF, waits for a clean exit, then verifies with ffprobe the
frame count, codec, pixel format, dimensions and that every timestamp lies on
the CFR grid (monotonic, no drift), hashes the file and only then atomically
renames it to the final path: a partial track is never reported ready.

Tracks are encoded without B-frames (``-bf 0``): decode order equals
presentation order, timestamps start at 0 with no edit-list delay, and the
track can be cut losslessly at an exact frame for ``trim_to_requested``.
"""

from __future__ import annotations

import contextlib
import queue
import re
import subprocess
import threading
import time
import weakref
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np

from .errors import MediaCanceled, MediaError, cancel_requested
from .files import check_output_path, file_sha256, partial_path, publish, remove_quietly
from .limits import DEFAULT_LIMITS, MediaLimits
from .mux import container_for_suffix
from .timeline import check_video_stream, scan_timeline
from .tools import (
    ManagedProcess,
    find_ffmpeg,
    find_ffprobe,
    input_url,
    list_encoders,
    redact,
    summarize_stderr,
    tool_env,
)

CODECS = ("h264", "hevc", "av1")
PIXEL_FORMATS = ("yuv420p", "yuv420p10le")
PROVIDERS = ("cpu_ffmpeg", "nvenc")
MAX_QUEUE_CHUNKS = 4
CPU_ENCODERS: dict[str, tuple[str, ...]] = {
    "h264": ("libx264",),
    "hevc": ("libx265",),
    "av1": ("libsvtav1", "libaom-av1"),
}
NVENC_ENCODERS: dict[str, str] = {"h264": "h264_nvenc", "hevc": "hevc_nvenc", "av1": "av1_nvenc"}
TRACK_COLOR = {"color_primaries": "bt709", "color_transfer": "bt709", "color_space": "bt709", "color_range": "tv"}
_PRESET = re.compile(r"^[A-Za-z0-9_\-]{1,16}$")
_WRITE_SLICE = 4 * 1024 * 1024
_EOF = object()


def _positive_int(name: str, value: Any, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)) or int(value) <= 0:
        raise MediaError("INVALID_ARGUMENT", f"{name} 必須是正整數", actual=value)
    if maximum is not None and int(value) > maximum:
        raise MediaError("INVALID_ARGUMENT", f"{name} 超過上限", expected=f"<= {maximum}", actual=value)
    return int(value)


def resolve_encoder_name(codec: str, provider: str, *, ffmpeg: str | None = None) -> str:
    """Pick the FFmpeg encoder for codec/provider from the encoders actually built in."""
    available = list_encoders(ffmpeg)
    if provider == "nvenc":
        name = NVENC_ENCODERS[codec]
        if name not in available:
            raise MediaError("UNSUPPORTED_COMBINATION", f"此 FFmpeg 建置沒有 {name} 編碼器")
        return name
    for name in CPU_ENCODERS[codec]:
        if name in available:
            return name
    raise MediaError(
        "UNSUPPORTED_COMBINATION",
        f"此 FFmpeg 建置沒有 {codec} 的 CPU 編碼器（需要 {' 或 '.join(CPU_ENCODERS[codec])}）",
        field_paths=["output.video_codec", "output.encode_provider"],
    )


def video_filter(pixel_format: str, encoder_name: str) -> str:
    """RGB -> YUV with an explicit BT.709 limited-range matrix, tagged on the frames."""
    target = pixel_format
    if encoder_name.endswith("_nvenc"):
        target = "p010le" if pixel_format == "yuv420p10le" else "yuv420p"
    return (
        "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,"
        f"format={target},"
        "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
    )


def encoder_args(
    encoder_name: str, *, quality: int, pixel_format: str, preset: str | None = None, container: str = "mp4"
) -> list[str]:
    """Quality-mode (CRF/CQ) arguments without B-frames for one encoder."""
    if preset is not None and not _PRESET.match(preset):
        raise MediaError("INVALID_ARGUMENT", "preset 名稱不合法")
    q = str(int(quality))
    if encoder_name == "libx264":
        args = ["-c:v", "libx264", "-preset", preset or "medium", "-crf", q, "-bf", "0", "-pix_fmt", pixel_format]
    elif encoder_name == "libx265":
        args = [
            "-c:v", "libx265", "-preset", preset or "medium", "-crf", q,
            "-x265-params", "log-level=error:bframes=0", "-pix_fmt", pixel_format,
        ]  # fmt: skip
    elif encoder_name == "libsvtav1":
        args = ["-c:v", "libsvtav1", "-preset", preset or "8", "-crf", q, "-pix_fmt", pixel_format]
    elif encoder_name == "libaom-av1":
        args = [
            "-c:v", "libaom-av1", "-cpu-used", preset or "6", "-row-mt", "1",
            "-crf", q, "-b:v", "0", "-pix_fmt", pixel_format,
        ]  # fmt: skip
    elif encoder_name in NVENC_ENCODERS.values():
        nv_format = "p010le" if pixel_format == "yuv420p10le" else "yuv420p"
        args = [
            "-c:v", encoder_name, "-gpu", "0", "-preset", preset or "p5", "-tune", "hq",
            "-rc", "vbr", "-cq", q, "-b:v", "0", "-bf", "0", "-pix_fmt", nv_format,
        ]  # fmt: skip
        if encoder_name == "hevc_nvenc" and pixel_format == "yuv420p10le":
            args += ["-profile:v", "main10"]
    else:
        raise MediaError("UNSUPPORTED_COMBINATION", f"不支援的編碼器：{encoder_name}")
    if encoder_name in ("libx265", "hevc_nvenc") and container == "mp4":
        args += ["-tag:v", "hvc1"]
    return args


@dataclass(frozen=True)
class EncodedTrack:
    path: Path
    frames: int
    width: int
    height: int
    fps_num: int
    fps_den: int
    codec: str
    pixel_format: str
    duration_seconds: float
    sha256: str
    size_bytes: int
    provider: str
    encoder_name: str
    container: str = "mp4"
    media_type: str = "video/mp4"
    quality: int | None = None
    color_primaries: str = "bt709"
    color_transfer: str = "bt709"
    color_space: str = "bt709"
    color_range: str = "tv"
    reorder_free: bool = True
    gpu_uuid: str | None = None

    def as_dict(self) -> dict[str, Any]:
        doc = asdict(self)
        doc.pop("path")
        return doc


def _emergency_cleanup(proc: ManagedProcess | None, partial: Path) -> None:
    """GC finalizer for leaked encoders: never leave a companion or a partial file."""
    if proc is not None:
        with contextlib.suppress(Exception):
            proc.kill_tree(wait_seconds=2.0)
            proc.close(join_seconds=0.5)
    remove_quietly(partial)


class StreamingVideoEncoder:
    """FFmpeg companion fed by a bounded queue of RGB uint8 ``[F,H,W,3]`` chunks."""

    def __init__(
        self,
        output_path: str | Path,
        *,
        width: int,
        height: int,
        fps_num: int,
        fps_den: int,
        codec: str = "h264",
        pixel_format: str = "yuv420p",
        quality: int = 18,
        provider: str = "cpu_ffmpeg",
        gpu_index: int | None = None,
        max_queue_chunks: int = MAX_QUEUE_CHUNKS,
        cancel: Any = None,
        ffmpeg: str | None = None,
        gpu_uuid: str | None = None,
        expected_frames: int | None = None,
        preset: str | None = None,
        ffprobe: str | None = None,
        limits: MediaLimits = DEFAULT_LIMITS,
        idle_timeout_seconds: float | None = None,
        on_progress: Any = None,
    ) -> None:
        self._limits = limits
        self.width = _positive_int("width", width, limits.max_width)
        self.height = _positive_int("height", height, limits.max_height)
        if self.width % 2 or self.height % 2:
            raise MediaError("INVALID_ARGUMENT", "4:2:0 編碼要求寬高為偶數", actual=f"{self.width}x{self.height}")
        if self.width * self.height > limits.max_pixels:
            raise MediaError("INVALID_ARGUMENT", "畫面像素數超過上限")
        self.fps_num = _positive_int("fps_num", fps_num, 240_000)
        self.fps_den = _positive_int("fps_den", fps_den, 1001)
        if codec not in CODECS:
            raise MediaError(
                "INVALID_ARGUMENT", f"video codec 必須是 {', '.join(CODECS)}", field_paths=["output.video_codec"]
            )
        if pixel_format not in PIXEL_FORMATS:
            raise MediaError("INVALID_ARGUMENT", "pixel format 不支援", field_paths=["output.pixel_format"])
        if isinstance(quality, bool) or not isinstance(quality, int) or not 1 <= quality <= 51:
            raise MediaError("INVALID_ARGUMENT", "quality 必須是 1..51 的整數", field_paths=["output.quality"])
        if provider not in PROVIDERS:
            raise MediaError(
                "INVALID_ARGUMENT", "provider 必須是 cpu_ffmpeg 或 nvenc（auto_validated 須先經 route_codec 解析）"
            )
        if provider == "nvenc":
            if gpu_uuid is None and gpu_index is None:
                raise MediaError("INVALID_ARGUMENT", "nvenc 需要指定 gpu_uuid 或 gpu_index")
            if gpu_uuid is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}", gpu_uuid):
                raise MediaError("INVALID_ARGUMENT", "gpu_uuid 格式不合法")
            if gpu_uuid is None and (isinstance(gpu_index, bool) or not isinstance(gpu_index, int) or gpu_index < 0):
                raise MediaError("INVALID_ARGUMENT", "gpu_index 必須是非負整數")
        if isinstance(max_queue_chunks, bool) or not isinstance(max_queue_chunks, int):
            raise MediaError("INVALID_ARGUMENT", "max_queue_chunks 必須是整數")
        if not 1 <= max_queue_chunks <= MAX_QUEUE_CHUNKS:
            raise MediaError("INVALID_ARGUMENT", f"max_queue_chunks 必須介於 1..{MAX_QUEUE_CHUNKS}")
        if expected_frames is not None:
            expected_frames = _positive_int("expected_frames", expected_frames, limits.max_frames)
        self.codec = codec
        self.pixel_format = pixel_format
        self.quality = quality
        self.provider = provider
        self.gpu_index = gpu_index
        self.gpu_uuid = gpu_uuid
        self._preset = preset
        self._cancel = cancel
        self._ffmpeg = ffmpeg
        self._ffprobe = ffprobe
        self._expected_frames = expected_frames
        self._idle_timeout = idle_timeout_seconds or limits.process_timeout_seconds
        self._on_progress = on_progress
        self._final = check_output_path(output_path)
        container = container_for_suffix(self._final.suffix)
        if container is None:
            raise MediaError("INVALID_ARGUMENT", "影片軌輸出副檔名必須是 .mp4 或 .mkv")
        _name, self.container, self.media_type = container
        self._partial = partial_path(self._final)
        self._frame_bytes = self.width * self.height * 3
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=max_queue_chunks)
        self._lock = threading.Lock()
        self._error: MediaError | None = None
        self._started = False
        self._aborted = False
        self._finished = False
        self._track: EncodedTrack | None = None
        self._frames_queued = 0
        self._frames_fed = 0
        self._returncode: int | None = None
        self._eof_written = threading.Event()
        self._exited = threading.Event()
        self._abort_event = threading.Event()
        self._proc: ManagedProcess | None = None
        self._threads: list[threading.Thread] = []
        self._finalizer: Any = None
        self.encoder_name = ""

    # ------------------------------------------------------------------ properties

    @property
    def partial_path(self) -> Path:
        return self._partial

    # ------------------------------------------------------------------ lifecycle

    def __enter__(self) -> StreamingVideoEncoder:
        return self.start()

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if not self._finished:
            self.abort()

    def start(self) -> StreamingVideoEncoder:
        with self._lock:
            if self._started:
                return self
            if self._aborted:
                raise MediaError("INVALID_ARGUMENT", "編碼器已中止")
            self._started = True
        try:
            if cancel_requested(self._cancel):
                raise MediaCanceled("影片編碼已取消")
            ffmpeg = self._ffmpeg or find_ffmpeg()
            self._ffmpeg = ffmpeg
            self._ffprobe = self._ffprobe or find_ffprobe()
            self.encoder_name = resolve_encoder_name(self.codec, self.provider, ffmpeg=ffmpeg)
            argv = self._argv(ffmpeg)
            extra: dict[str, str] = {}
            if self.provider == "nvenc":
                extra["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
                extra["CUDA_VISIBLE_DEVICES"] = self.gpu_uuid or str(self.gpu_index)
            self._proc = ManagedProcess(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                env=tool_env(extra),
                max_stderr_bytes=self._limits.max_stderr_bytes,
            )
        except BaseException:
            with self._lock:
                self._aborted = True
            remove_quietly(self._partial)
            raise
        self._finalizer = weakref.finalize(self, _emergency_cleanup, self._proc, self._partial)
        for target, name in ((self._feed, "media-encode-feeder"), (self._watch, "media-encode-watcher")):
            thread = threading.Thread(target=target, name=name, daemon=True)
            self._threads.append(thread)
            thread.start()
        return self

    def _argv(self, ffmpeg: str) -> list[str]:
        muxer = self.container
        return [
            ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-nostats",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "pipe",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-video_size",
            f"{self.width}x{self.height}",
            "-framerate",
            f"{self.fps_num}/{self.fps_den}",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            video_filter(self.pixel_format, self.encoder_name),
            "-fps_mode",
            "passthrough",
            *encoder_args(
                self.encoder_name,
                quality=self.quality,
                pixel_format=self.pixel_format,
                preset=self._preset,
                container="mp4" if muxer == "mp4" else "mkv",
            ),
            "-map_metadata",
            "-1",
            "-f",
            muxer,
            "-n",
            input_url(self._partial),
        ]

    # ------------------------------------------------------------------ producer side

    def _to_bytes(self, frames: Any) -> tuple[bytes, int]:
        if isinstance(frames, np.ndarray):
            if (
                frames.dtype != np.uint8
                or frames.ndim != 4
                or frames.shape[0] < 1
                or tuple(frames.shape[1:]) != (self.height, self.width, 3)
            ):
                raise MediaError(
                    "INVALID_ARGUMENT",
                    "frames 必須是 uint8 RGB [F,H,W,3]",
                    expected=f"uint8 [F,{self.height},{self.width},3]",
                    actual=f"{frames.dtype} {list(frames.shape)}",
                )
            return frames.tobytes(order="C"), int(frames.shape[0])
        if isinstance(frames, (bytes, bytearray, memoryview)):
            data = bytes(frames)
            if not data or len(data) % self._frame_bytes:
                raise MediaError(
                    "INVALID_ARGUMENT", "raw frames 長度必須是 H×W×3 的整數倍", expected=f"k×{self._frame_bytes}"
                )
            return data, len(data) // self._frame_bytes
        raise MediaError("INVALID_ARGUMENT", "frames 必須是 numpy uint8 陣列或 raw bytes")

    def write_chunk(self, frames: Any) -> None:
        """Queue one chunk; blocks while 4 chunks are pending; raises promptly on failure/cancel."""
        data, count = self._to_bytes(frames)
        if not self._started:
            self.start()
        self.raise_if_failed()
        if self._frames_queued + count > self._limits.max_frames:
            self.abort()
            raise MediaError("INVALID_ARGUMENT", "frame 數超過上限", expected=f"<= {self._limits.max_frames}")
        if self._expected_frames is not None and self._frames_queued + count > self._expected_frames:
            self.abort()
            raise MediaError(
                "INTEGRITY_MISMATCH",
                "producer 送出的 frame 超過 plan 預期",
                expected=self._expected_frames,
                actual=self._frames_queued + count,
            )
        self._put((data, count))
        self._frames_queued += count

    def _put(self, item: Any) -> None:
        while True:
            self.raise_if_failed()
            try:
                self._queue.put(item, timeout=0.05)
                return
            except queue.Full:
                continue

    def raise_if_failed(self) -> None:
        """Raise (and clean up) if the companion failed, cancel was requested or the encoder was aborted."""
        if cancel_requested(self._cancel):
            reason = getattr(self._cancel, "reason", "") or ""
            self._fail(MediaCanceled("影片編碼已取消" + (f"：{reason}" if reason else "")))
        error = self._error
        if error is not None:
            self.abort()
            raise error
        if self._aborted:
            raise MediaError("INVALID_ARGUMENT", "編碼器已中止，不能再寫入")

    # ------------------------------------------------------------------ companion side

    def _fail(self, error: MediaError) -> None:
        with self._lock:
            if self._error is None:
                self._error = error

    def _stderr(self) -> str:
        if self._proc is None:
            return ""
        marks = {str(self._partial): "<track>", input_url(self._partial): "<track>"}
        return summarize_stderr(redact(self._proc.stderr_text(), marks), 800)

    def _terminate(self) -> None:
        if self._proc is not None:
            self._proc.kill_tree()
        remove_quietly(self._partial)

    def _feed(self) -> None:
        proc = self._proc
        assert proc is not None
        stdin = proc.stdin
        assert stdin is not None
        last_activity = time.monotonic()
        try:
            while not self._abort_event.is_set():
                if cancel_requested(self._cancel):
                    self._fail(MediaCanceled("影片編碼已取消"))
                    self._terminate()
                    return
                try:
                    item = self._queue.get(timeout=0.05)
                except queue.Empty:
                    if self._exited.is_set():
                        return
                    if time.monotonic() - last_activity > self._idle_timeout:
                        self._fail(
                            MediaError(
                                "RESOURCE_EXHAUSTED",
                                f"producer 超過 {self._idle_timeout:.0f} 秒未送出 frame，已終止編碼 companion",
                            )
                        )
                        self._terminate()
                        return
                    continue
                if item is _EOF:
                    # mark first: the watcher may observe the clean exit right after close()
                    self._eof_written.set()
                    stdin.close()
                    return
                data, count = item
                view = memoryview(data)
                for offset in range(0, len(view), _WRITE_SLICE):
                    if self._abort_event.is_set():
                        return
                    if cancel_requested(self._cancel):
                        self._fail(MediaCanceled("影片編碼已取消"))
                        self._terminate()
                        return
                    stdin.write(view[offset : offset + _WRITE_SLICE])
                stdin.flush()
                self._frames_fed += count
                last_activity = time.monotonic()
                if self._on_progress is not None:
                    with contextlib.suppress(Exception):  # telemetry must never break the companion
                        self._on_progress(self._frames_fed)
        except (OSError, ValueError):
            if not self._abort_event.is_set():
                proc.wait(1.0)
                rc = proc.poll()
                status = f"exit {rc}" if rc is not None else "管線中斷"
                detail = self._stderr()
                self._fail(
                    MediaError(
                        "MEDIA_TOOL_FAILED",
                        f"FFmpeg 編碼 companion 失敗（{status}）" + (f"：{detail}" if detail else ""),
                    )
                )
                self._terminate()
        finally:
            if not self._eof_written.is_set():
                try:
                    stdin.close()
                except (OSError, ValueError):
                    pass

    def _watch(self) -> None:
        proc = self._proc
        assert proc is not None
        while True:
            rc = proc.poll()
            if rc is not None:
                break
            time.sleep(0.02)
        self._returncode = rc
        if not self._abort_event.is_set():
            if rc != 0:
                detail = self._stderr()
                self._fail(
                    MediaError(
                        "MEDIA_TOOL_FAILED",
                        f"FFmpeg 編碼 companion 失敗（exit {rc}）" + (f"：{detail}" if detail else ""),
                    )
                )
            elif not self._eof_written.is_set():
                self._fail(MediaError("MEDIA_TOOL_FAILED", "FFmpeg 編碼 companion 在 EOF 前結束"))
        self._exited.set()

    # ------------------------------------------------------------------ completion

    def finish(self) -> EncodedTrack:
        """EOF, wait, verify frames/timestamps/codec via ffprobe, hash, then publish atomically."""
        if self._track is not None:
            return self._track
        if not self._started:
            self.abort()
            raise MediaError("INVALID_ARGUMENT", "沒有任何 frame 可編碼")
        self.raise_if_failed()
        if self._frames_queued == 0:
            self.abort()
            raise MediaError("INVALID_ARGUMENT", "沒有任何 frame 可編碼")
        if self._expected_frames is not None and self._frames_queued != self._expected_frames:
            self.abort()
            raise MediaError(
                "INTEGRITY_MISMATCH",
                "producer 送出的 frame 數與 plan 不符",
                expected=self._expected_frames,
                actual=self._frames_queued,
            )
        self._put(_EOF)
        deadline = time.monotonic() + self._limits.process_timeout_seconds
        while not self._exited.wait(0.05):
            self.raise_if_failed()
            if time.monotonic() > deadline:
                self.abort()
                raise MediaError("MEDIA_TOOL_FAILED", "等待 FFmpeg 編碼 companion 結束逾時")
        self.raise_if_failed()
        for thread in self._threads:
            thread.join(5.0)
        if self._returncode != 0 or self._frames_fed != self._frames_queued:
            self.abort()
            raise MediaError("MEDIA_TOOL_FAILED", "FFmpeg 編碼 companion 未完整消耗所有 frames")
        fps = Fraction(self.fps_num, self.fps_den)
        try:
            timeline = scan_timeline(
                self._partial, limits=self._limits, ffprobe=self._ffprobe, cancel=self._cancel, expected_fps=fps
            )
            videos = timeline.of_type("video")
            if len(videos) != 1 or len(timeline.streams) != 1:
                raise MediaError("INTEGRITY_MISMATCH", "影片軌必須恰有一個 video stream")
            check = check_video_stream(
                videos[0],
                fps=fps,
                expected_frames=self._frames_queued,
                width=self.width,
                height=self.height,
                codec=self.codec,
                pixel_format=self.pixel_format,
            )
            if abs(check.start_seconds) > videos[0].tick_seconds + 1e-9:
                raise MediaError("INTEGRITY_MISMATCH", "影片軌起始時間不是 0")
            sha256, size = file_sha256(self._partial, cancel=self._cancel)
            with self._lock:
                if self._aborted:
                    raise MediaCanceled("影片編碼已中止")
                publish(self._partial, self._final)
                self._finished = True
        except BaseException:
            self.abort()
            raise
        self._cleanup_process()
        self._track = EncodedTrack(
            path=self._final,
            frames=check.frames,
            width=self.width,
            height=self.height,
            fps_num=self.fps_num,
            fps_den=self.fps_den,
            codec=self.codec,
            pixel_format=self.pixel_format,
            duration_seconds=check.duration_seconds,
            sha256=sha256,
            size_bytes=size,
            provider=self.provider,
            encoder_name=self.encoder_name,
            container="mp4" if self.container == "mp4" else "mkv",
            media_type=self.media_type,
            quality=self.quality,
            reorder_free=check.reorder_free,
            gpu_uuid=self.gpu_uuid if self.provider == "nvenc" else None,
            **TRACK_COLOR,
        )
        return self._track

    def _cleanup_process(self) -> None:
        for thread in self._threads:
            if thread is not threading.current_thread():
                thread.join(5.0)
        if self._proc is not None:
            self._proc.close()
        if self._finalizer is not None:
            self._finalizer.detach()

    def abort(self) -> None:
        """Kill the companion's process tree and remove the partial output (idempotent)."""
        with self._lock:
            if self._finished or self._aborted:
                already = True
            else:
                already = False
                self._aborted = True
        if already:
            return
        self._abort_event.set()
        if self._proc is not None:
            self._proc.kill_tree()
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        self._cleanup_process()
        remove_quietly(self._partial)
