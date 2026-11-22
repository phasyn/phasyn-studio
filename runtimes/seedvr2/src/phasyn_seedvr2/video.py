"""Bounded SeedVR2 video restoration, selection and verified audio delivery."""

from __future__ import annotations

import os
import stat
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from phasyn_captioner.upscale.video import SourceVideo, attach_audio, inspect_source
from phasyn_components.errors import ComponentError
from phasyn_media.errors import MediaError, raise_if_canceled
from phasyn_media.files import (
    check_local_file,
    check_output_path,
    file_sha256,
    fsync_dir,
    unchanged_since,
)
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.timeline import check_video_stream, scan_timeline
from phasyn_media.tools import (
    find_ffmpeg,
    input_url,
    redact,
    run_tool,
    summarize_stderr,
)


LIMITS = replace(
    DEFAULT_LIMITS,
    max_pixels=4096 * 2160,
    max_width=8192,
    max_height=8192,
    max_frames=7200,
)
LONG_EDGE_TOLERANCE = 2
AV_STREAM_COUNT = 2


@dataclass(frozen=True)
class Selection:
    """Validated half-open source frame range and model parameters."""

    start: int
    end: int
    short_side: int
    seed: int
    strength: float

    @property
    def frames(self) -> int:
        """Return the number of source frames selected for delivery."""
        return self.end - self.start


@dataclass(frozen=True)
class _RenderPlan:
    """Frozen input, source selection and delivery geometry."""

    source: SourceVideo
    selection: Selection
    geometry: tuple[int, int]


def _integer(
    params: Mapping[str, Any], key: str, default: int, lo: int, hi: int
) -> int:
    value = params.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
        raise ComponentError("INVALID_ARGUMENT", f"{key} 必須是 {lo} 到 {hi} 的整數")
    return value


def _selection(source: SourceVideo, params: Mapping[str, Any]) -> Selection:
    unknown = params.keys() - {
        "start_frame",
        "end_frame",
        "short_side",
        "seed",
        "strength",
    }
    if unknown:
        raise ComponentError("INVALID_ARGUMENT", f"不支援的影片修復參數 {min(unknown)}")
    start = _integer(params, "start_frame", 0, 0, source.frames - 1)
    end = (
        source.frames
        if params.get("end_frame") is None
        else _integer(params, "end_frame", source.frames, start + 1, source.frames)
    )
    short_side = _integer(params, "short_side", 512, 128, 1536)
    if short_side % 2:
        raise ComponentError("INVALID_ARGUMENT", "short_side 必須是偶數")
    seed = _integer(params, "seed", 42, 0, 2**31 - 1)
    strength = params.get("strength", 1.0)
    if (
        isinstance(strength, bool)
        or not isinstance(strength, int | float)
        or not 0 <= strength <= 1
    ):
        raise ComponentError("INVALID_ARGUMENT", "strength 必須介於 0 到 1")
    return Selection(start, end, short_side, seed, float(strength))


def _geometry(source: SourceVideo, short_side: int) -> tuple[int, int]:
    # 4:2:0 delivery needs even dimensions. Keep the exact chosen geometry in the report.
    scale = Fraction(short_side, min(source.width, source.height))
    width, height = (
        max(2, 2 * round(scale * side / 2)) for side in (source.width, source.height)
    )
    if (
        width > LIMITS.max_width
        or height > LIMITS.max_height
        or width * height > LIMITS.max_pixels
    ):
        raise ComponentError(
            "INPUT_TOO_LARGE", "指定解析度與長寬比會超出影片修復尺寸上限"
        )
    return width, height


def _ffmpeg(
    inputs: Sequence[Path], options: Sequence[str], out: Path, *, cancel: Any
) -> None:
    argv = [
        find_ffmpeg(),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-filter_complex_threads",
        "1",
        "-copyts",
    ]
    for path in inputs:
        argv.extend(
            (
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                LIMITS.format_whitelist,
                *LIMITS.decoder_flags,
            )
        )
        argv.extend(("-i", input_url(path)))
    argv.extend(
        (
            *options,
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-fs",
            str(LIMITS.max_file_bytes),
        )
    )
    argv.extend(("-movflags", "+faststart", "-f", "mp4", "-n", input_url(out)))
    result = run_tool(
        argv,
        timeout=LIMITS.process_timeout_seconds,
        cancel=cancel,
        max_stderr_bytes=LIMITS.max_stderr_bytes,
    )
    if result.returncode != 0:
        paths = [*inputs, out]
        marks = {
            value: "<media>" for path in paths for value in (input_url(path), str(path))
        }
        detail = summarize_stderr(redact(result.stderr, marks), 480)
        raise MediaError("MEDIA_TOOL_FAILED", f"FFmpeg 影片修復處理失敗：{detail}")


def _track_options(fps: Fraction, *, lossless: bool = False) -> list[str]:
    return [
        "-an",
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        f"{fps.denominator}:{fps.numerator}",
        "-video_track_timescale",
        str(fps.numerator),
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-crf",
        "0" if lossless else "16",
        "-pix_fmt",
        "yuv420p",
    ]


def _validate_track(
    path: Path, fps: Fraction, count: int, geometry: tuple[int, int], cancel: Any
) -> None:
    timeline = scan_timeline(path, limits=LIMITS, expected_fps=fps, cancel=cancel)
    videos = timeline.of_type("video")
    if len(videos) != 1:
        raise MediaError("INTEGRITY_MISMATCH", "修復結果須有一個影片串流")
    width, height = geometry
    check = check_video_stream(
        videos[0], fps=fps, expected_frames=count, width=width, height=height
    )
    if abs(check.start_seconds) > videos[0].tick_seconds + 1e-9 or videos[0].fps != fps:
        raise MediaError("INTEGRITY_MISMATCH", "修復影片的起點或幀率與選區不同")


def _segment(source: SourceVideo, selected: Selection, work: Path, cancel: Any) -> Path:
    if selected.start == 0 and selected.end == source.frames:
        return source.path
    clip = work / "clip.mp4"
    trim = f"trim=start_frame={selected.start}:end_frame={selected.end},setpts=PTS-STARTPTS"
    _ffmpeg(
        [source.path],
        ["-map", "0:V:0", "-vf", trim, *_track_options(source.fps, lossless=True)],
        clip,
        cancel=cancel,
    )
    _validate_track(
        clip, source.fps, selected.frames, (source.width, source.height), cancel
    )
    return clip


def _native_result(path: Path, plan: _RenderPlan, cancel: Any) -> SourceVideo:
    try:
        leaf = path.lstat()
    except FileNotFoundError:
        raise MediaError("MEDIA_INCOMPLETE", "修復元件沒有輸出影片") from None
    if not stat.S_ISREG(leaf.st_mode) or leaf.st_nlink != 1:
        raise MediaError("MEDIA_INCOMPLETE", "修復元件輸出檔案類型不合法")
    restored = inspect_source(path, limits=LIMITS, cancel=cancel)
    if restored.frames != plan.selection.frames or restored.fps != plan.source.fps:
        raise MediaError("INTEGRITY_MISMATCH", "模型輸出幀數或幀率與選區不同")
    # Backends round the aspect-scaled long edge to the nearest encodable size.
    sizes = (restored.width, restored.height)
    if min(sizes) != min(plan.geometry) or any(
        abs(actual - wanted) > LONG_EDGE_TOLERANCE
        for actual, wanted in zip(sizes, plan.geometry, strict=True)
    ):
        raise MediaError(
            "INTEGRITY_MISMATCH", "模型輸出尺寸與指定的短邊或來源長寬比不符"
        )
    return restored


def _scale(source: SourceVideo, width: int, height: int) -> str:
    return (
        f"setpts=PTS-STARTPTS,scale={width}:{height}:flags=bilinear:in_color_matrix={source.matrix}:"
        f"in_range={source.color_range}:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p"
    )


def _picture(
    segment: Path,
    plan: _RenderPlan,
    restored: SourceVideo | None,
    track: Path,
    cancel: Any,
) -> None:
    source, selected = plan.source, plan.selection
    width, height = plan.geometry
    paths = [segment]
    graph = f"[0:V:0]{_scale(source, width, height)}[pic]"
    if restored is not None:
        if selected.strength == 1:
            paths = [restored.path]
            graph = f"[0:V:0]{_scale(restored, width, height)}[pic]"
        else:
            paths.append(restored.path)
            graph = (
                f"[0:V:0]{_scale(source, width, height)}[original];"
                f"[1:V:0]{_scale(restored, width, height)}[restored];"
                f"[restored][original]blend=all_mode=normal:all_opacity={selected.strength}[pic]"
            )
    _ffmpeg(
        paths,
        [
            "-filter_complex",
            graph,
            "-map",
            "[pic]",
            *_track_options(source.fps),
            "-colorspace",
            "bt709",
            "-color_range",
            "tv",
        ],
        track,
        cancel=cancel,
    )
    _validate_track(track, source.fps, selected.frames, plan.geometry, cancel)


def _clip_audio(
    track: Path, source: SourceVideo, selected: Selection, result: Path, cancel: Any
) -> None:
    if source.audio is None or not source.audio.sample_rate:
        raise MediaError("MEDIA_INCOMPLETE", "無法取得選區音軌的取樣率")
    rate = source.audio.sample_rate
    first, last = (
        round(frame * rate / source.fps) for frame in (selected.start, selected.end)
    )
    # Anchor the decoded sample clock to video time zero. Fill initial/internal gaps, trim on the
    # source sample grid and pad a short audio tail with silence, keeping the preview aligned.
    graph = (
        f"[1:a:0]aresample={rate}:async=1:min_comp={0.5 / rate}:min_hard_comp={0.5 / rate}:first_pts=0,"
        f"apad=whole_len={last},atrim=start_sample={first}:end_sample={last},asetpts=N/SR/TB[a]"
    )
    _ffmpeg(
        [track, source.path],
        [
            "-filter_complex",
            graph,
            "-map",
            "0:v:0",
            "-map",
            "[a]",
            "-c:v",
            "copy",
            "-c:a",
            "alac",
        ],
        result,
        cancel=cancel,
    )
    timeline = scan_timeline(
        result, limits=LIMITS, expected_fps=source.fps, cancel=cancel
    )
    audios = timeline.of_type("audio")
    if len(audios) != 1 or len(timeline.streams) != AV_STREAM_COUNT:
        raise MediaError("INTEGRITY_MISMATCH", "選區結果缺少預期音軌")
    audio = audios[0]
    if (
        audio.codec_name != "alac"
        or audio.sample_rate != rate
        or audio.channels != source.audio.channels
        or not audio.timestamps_monotonic
        or abs(audio.start_seconds * rate) > 1
        or abs(audio.end_seconds * rate - (last - first)) > 1
    ):
        raise MediaError("INTEGRITY_MISMATCH", "選區結果的音軌與來源取樣位置不同")


def _finish_audio(
    track: Path, plan: _RenderPlan, output: Path, cancel: Any
) -> tuple[Path, str]:
    src, selected = plan.source, plan.selection
    if src.audio is None:
        return track, "none"
    if selected.start == 0 and selected.end == src.frames:
        attach_audio(
            track, src, output, frames=src.frames, limits=LIMITS, cancel=cancel
        )
        policy = "stream_copy"
    else:
        _clip_audio(track, src, selected, output, cancel)
        policy = "sample_trim_alac"
    _validate_track(output, src.fps, selected.frames, plan.geometry, cancel)
    return output, policy


def render(
    source: Path,
    target: Path,
    *,
    parameters: Mapping[str, Any],
    restore: Callable[[Path, Path, int, int], None],
    cancel: Any,
) -> dict[str, Any]:
    """Publish a new video only after the selected frames and original audio have been verified."""
    local = check_local_file(source, limits=LIMITS)
    final = check_output_path(target, inputs=(local.path,))
    if final.suffix.lower() != ".mp4" or os.path.lexists(final):
        raise ComponentError("INVALID_ARGUMENT", "修復輸出必須是未使用的 MP4 檔名")
    src = inspect_source(local.path, limits=LIMITS, cancel=cancel)
    selected = _selection(src, parameters)
    geometry = _geometry(src, selected.short_side)
    if src.height % 2 or src.width % 2:
        raise ComponentError("UNSUPPORTED_SETTING", "影片修復需要偶數寬高的來源影格")
    digest, _ = file_sha256(local.path, cancel=cancel)
    plan = _RenderPlan(src, selected, geometry)
    with TemporaryDirectory(dir=final.parent, prefix=".seedvr2-") as directory:
        work = Path(directory)
        clip = _segment(src, selected, work, cancel)
        restored = None
        if selected.strength > 0:
            raise_if_canceled(cancel)
            model_output = work / "restored.mp4"
            restore(clip, model_output, min(geometry), selected.seed)
            raise_if_canceled(cancel)
            restored = _native_result(model_output, plan, cancel)
        track = work / "picture.mp4"
        _picture(clip, plan, restored, track, cancel)
        output, sound = _finish_audio(track, plan, work / "final.mp4", cancel)
        if not unchanged_since(local):
            raise MediaError("INTEGRITY_MISMATCH", "修復期間來源影片被修改")
        raise_if_canceled(cancel)
        os.link(output, final)
        fsync_dir(final.parent)
    fps = {"num": src.fps.numerator, "den": src.fps.denominator}
    return {
        "frames": selected.frames,
        "fps": fps,
        "width": geometry[0],
        "height": geometry[1],
        "source_sha256": digest,
        "source_frames": src.frames,
        "source_fps": fps,
        "source_width": src.width,
        "source_height": src.height,
        "source_color": src.color,
        "source_color_assumed": src.color_assumed,
        "start_frame": selected.start,
        "end_frame": selected.end,
        "short_side": selected.short_side,
        "effective_short_side": min(geometry),
        "seed": selected.seed,
        "strength": selected.strength,
        "model_applied": restored is not None,
        "audio_policy": sound,
        "has_audio": src.audio is not None,
    }
