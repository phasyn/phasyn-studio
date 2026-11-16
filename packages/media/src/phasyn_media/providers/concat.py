"""``media.concat``: trim and join complete video Assets into one video (Studio timeline export).

- Trims are frame-exact (``in_frame`` inclusive, ``out_frame`` exclusive, null = to the end). Cut
  points need not be keyframes, so the output is always re-encoded (libx264 + aac); never a stream copy.
- Every clip is fitted to the sequence resolution and FPS: aspect-preserving scale plus black bars
  (the default, ``fit`` absent or ``contain``), or with ``fit: cover`` scaled to fill and centre-cropped
  (for example a 1280x736 render exported as 1280x720). An explicit ``fit`` scales with lanczos. Audio is ``atrim``-ed to the same range and resampled to 48 kHz stereo; a clip
  without audio gets silence of the same length, recorded in the notes.
- The result's frames are counted with ffprobe and compared with the planned count; a mismatch
  fails the call and nothing half-done is published.
- Clips may carry ``effects`` (contract ``MediaClipEffects``: transitions, fades, speed, volume,
  colour, title layers). A sequence without any effect keeps the plain concat graph (byte-for-byte
  the output from before effects existed); with effects the ``phasyn_media.effects`` filtergraph
  pins every segment to its planned frame count and the total must match exactly.
- A sequence may carry ``audio_track`` (contract ``MediaSequenceAudioTrack``): the export's sound is
  then that file's first audio stream from ``start_seconds`` for exactly the sequence length
  (planned frames / FPS, 48 kHz sample-exact; padded with silence and noted when short); clip audio
  and audio effects are not used. A source without audio, or a start beyond its end, is
  ``INVALID_ARGUMENT`` (never silent output pretending to succeed). The exported audio length is
  verified by a packet scan.
- FFmpeg only reads ``file:`` inputs behind the protocol and demuxer whitelists, so a clip that is
  really an HLS playlist or concat list cannot reach other files or URLs; failures never echo
  local paths.
"""

from __future__ import annotations

import shutil
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import BaseProvider, Description, Port, RunContext, settings_schema
from phasyn_components.settings import normalize_recording

from ..effects import FITS, ClipSource, PlannedClip, SequencePlan, filter_graph, fit_chain, parse_effects, plan_sequence
from ..errors import MediaError
from ..limits import DEFAULT_LIMITS, MediaLimits
from ..probe import probe
from ..soundtrack import AudioSource, AudioTrack, SoundtrackPlan, audio_source, parse_audio_track, soundtrack_chain
from ..soundtrack import plan_soundtrack as _plan_soundtrack
from ..timeline import scan_timeline
from ..tools import find_ffmpeg, input_url, redact, run_tool, summarize_stderr
from ._failure import media_failure
from .timeline_export import TIMELINE_EXPORT_FACTS, export_timeline

MAX_CLIPS = 200
MIN_FPS = Fraction(1)
MAX_FPS = Fraction(240)
AUDIO_RATE = 48000
PARAMS: dict[str, dict[str, Any]] = {
    "crf": {"type": "integer", "minimum": 0, "maximum": 51, "default": 18},
    "preset": {"enum": ["ultrafast", "veryfast", "faster", "fast", "medium", "slow"], "default": "medium"},
    "audio_bitrate": {"type": "integer", "minimum": 32000, "maximum": 512000, "default": 192000},
}


def _fps_of(value: Any) -> Fraction | None:
    if isinstance(value, Mapping) and value.get("num") and value.get("den"):
        return Fraction(int(value["num"]), int(value["den"]))
    return None


def plan_clips(sequence: Any) -> tuple[list[dict[str, Any]], Mapping[str, Any]]:
    """驗證 ``media.sequence.v1`` 並展開成 [{asset, in_frame, out_frame, frames}]（純函式，方便測試）。"""
    if not isinstance(sequence, Mapping):
        raise ComponentError("INVALID_ARGUMENT", "sequence 必須是 object（media.sequence.v1）")
    clips = sequence.get("clips")
    if not isinstance(clips, list) or not clips:
        raise ComponentError("INVALID_ARGUMENT", "sequence.clips 必須是非空陣列")
    if len(clips) > MAX_CLIPS:
        raise ComponentError("INVALID_ARGUMENT", f"片段數超過上限 {MAX_CLIPS}")
    planned: list[dict[str, Any]] = []
    for index, clip in enumerate(clips):
        asset = clip.get("asset") if isinstance(clip, Mapping) else None
        if not isinstance(asset, Mapping) or not isinstance(asset.get("file"), Mapping):
            raise ComponentError("INVALID_ARGUMENT", f"clips[{index}] 需要 asset（media.asset.v1，含 file）")
        if not asset.get("complete"):
            raise ComponentError("MEDIA_INCOMPLETE", f"clips[{index}] 的 Asset 尚未完整（complete=false）")
        total = int(asset.get("frame_count") or 0)
        if total <= 0:
            raise ComponentError("INVALID_ARGUMENT", f"clips[{index}] 的 Asset 沒有 frame_count")
        start = int(clip.get("in_frame") or 0)
        raw_end = clip.get("out_frame")
        end = total if raw_end is None else int(raw_end)
        if not 0 <= start < end <= total:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"clips[{index}] 的裁切範圍不合法：in_frame={start}、out_frame={raw_end}（片段共 {total} 幀）",
                details={"index": index, "in_frame": start, "out_frame": raw_end, "frame_count": total},
            )
        effects = clip.get("effects")
        if effects is not None:
            contracts.validate("MediaClipEffects", effects, what=f"clips[{index}].effects")
        planned.append(
            {"asset": dict(asset), "in_frame": start, "out_frame": end, "frames": end - start, "effects": effects}
        )
    return planned, sequence


def plan_audio_track(sequence: Mapping[str, Any]) -> AudioTrack | None:
    """驗證 ``sequence.audio_track``（契約 MediaSequenceAudioTrack＋範圍；純函式）；沒有時回傳 None（＝原本的行為）。"""
    value = sequence.get("audio_track")
    if value is None:
        return None
    contracts.validate("MediaSequenceAudioTrack", value, what="sequence.audio_track")

    try:
        return parse_audio_track(value, path="sequence.audio_track")
    except MediaError as exc:
        raise ComponentError("INVALID_ARGUMENT", exc.message, details={"field_paths": list(exc.field_paths)}) from exc


def plan_fit(sequence: Mapping[str, Any]) -> str | None:
    """``sequence.fit``（contain／cover）；缺少時回傳 None（＝原本的等比縮小＋黑邊，縮放演算法也不變）。"""
    value = sequence.get("fit")
    if value is None:
        return None
    if value not in FITS:
        raise ComponentError("INVALID_ARGUMENT", f"sequence.fit 必須是 {' 或 '.join(FITS)}（目前 {value!r}）")
    return str(value)


def plan_soundtrack(track: AudioTrack, source: AudioSource, *, total_frames: int, fps: Fraction) -> SoundtrackPlan:
    """序列總長（計畫幀數）的外部音軌計畫；起點超過來源音軌 → INVALID_ARGUMENT（純函式）。"""

    try:
        return _plan_soundtrack(track, source, total_frames=total_frames, fps=fps)
    except MediaError as exc:
        raise ComponentError("INVALID_ARGUMENT", exc.message, details={"field_paths": list(exc.field_paths)}) from exc


def _ignored_audio_effects(plan: SequencePlan | None) -> list[str]:
    """使用 audio_track 時，片段上的聲音效果不套用：逐一寫進 notes（不默默忽略）。"""
    notes: list[str] = []
    for clip in plan.clips if plan is not None else ():
        fx = clip.effects
        if fx is None:
            continue
        ignored: list[str] = []
        if fx.mute:
            ignored.append("靜音")
        if fx.volume_db:
            ignored.append(f"音量 {fx.volume_db:g} dB")
        if fx.fade.audio_in or fx.fade.audio_out:
            ignored.append("聲音淡入淡出")
        if ignored:
            notes.append(f"片段 {clip.index + 1} 的{'、'.join(ignored)}未套用（聲音改用 audio_track）")
    return notes


def _frames_at(clip: Mapping[str, Any], fps: Fraction) -> int:
    """片段裁切後的幀數換算成序列影格率（四捨五入；同影格率時就是原幀數）。"""
    clip_fps = _fps_of(clip["asset"].get("fps")) or fps
    return int(Fraction(clip["frames"]) * fps / clip_fps + Fraction(1, 2))


def plan_effects(clips: list[dict[str, Any]], fps: Fraction) -> SequencePlan | None:
    """有效果的序列：回傳 ``phasyn_media.effects.SequencePlan``（每段輸出幀數、總長、轉場分組）；全部沒有效果時回傳 None。

    效果與片段長度不相容（轉場比片段長、淡入淡出超過片段、文字超出範圍、最後一段設轉場）→ INVALID_ARGUMENT。
    """

    try:
        parsed = [parse_effects(c.get("effects"), path=f"sequence.clips[{i}].effects") for i, c in enumerate(clips)]
        if all(fx is None for fx in parsed):
            return None
        return plan_sequence([_frames_at(c, fps) for c in clips], parsed, fps)
    except MediaError as exc:
        raise ComponentError("INVALID_ARGUMENT", exc.message, details={"field_paths": list(exc.field_paths)}) from exc


def _filter_graph(
    clips: list[dict[str, Any]],
    *,
    width: int,
    height: int,
    fps: Fraction,
    has_audio: list[bool],
    audio: bool = True,
    fit: str | None = None,
) -> tuple[str, list[str]]:
    """沒有效果的接合圖；audio=False 時只接影片（輸出只有 ``[v]``，聲音由 audio_track 提供）。"""
    parts: list[str] = []
    notes: list[str] = []
    rate = f"{fps.numerator}/{fps.denominator}"
    for i, clip in enumerate(clips):
        clip_fps = _fps_of(clip["asset"].get("fps")) or fps
        start_s = Fraction(clip["in_frame"]) / clip_fps
        dur_s = Fraction(clip["frames"]) / clip_fps
        parts.append(
            f"[{i}:V:0]trim=start_frame={clip['in_frame']}:end_frame={clip['out_frame']},setpts=PTS-STARTPTS,"
            f"fps={rate},{','.join(fit_chain(width, height, fit))},setsar=1,format=yuv420p[v{i}]"
        )
        if not audio:
            continue
        if has_audio[i]:
            parts.append(
                f"[{i}:a:0]atrim=start={float(start_s):.6f}:duration={float(dur_s):.6f},asetpts=PTS-STARTPTS,"
                f"aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"
            )
        else:
            parts.append(
                f"anullsrc=r={AUDIO_RATE}:cl=stereo,atrim=duration={float(dur_s):.6f},"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"
            )
            notes.append(f"片段 {i + 1} 沒有音軌：以 {float(dur_s):.3f} 秒靜音補齊")
    if audio:
        joined = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
        parts.append(f"{joined}concat=n={len(clips)}:v=1:a=1[v][a]")
    else:
        joined = "".join(f"[v{i}]" for i in range(len(clips)))
        parts.append(f"{joined}concat=n={len(clips)}:v=1:a=0[v]")
    return ";".join(parts), notes


def _clip_record(clip: Mapping[str, Any], planned: PlannedClip | None) -> dict[str, Any]:
    """actual_settings.concat.clips 的一筆；有效果的序列另外記錄套用速度後的幀數與正規化後的效果。"""
    record: dict[str, Any] = {
        "asset_id": clip["asset"].get("asset_id"),
        "file_id": clip["asset"]["file"].get("file_id"),
        "sha256": clip["asset"]["file"].get("sha256"),
        "in_frame": clip["in_frame"],
        "out_frame": clip["out_frame"],
    }
    if planned is not None:
        record["frames_out"] = planned.frames
        record["start_frame"] = planned.start_frame
        record["effects"] = planned.effects.as_dict() if planned.effects is not None else None
    return record


class ConcatProvider(BaseProvider):
    """``media.concat``. ETA work (``cost.stages``): ``concat`` in ``pixel_frame`` = output frames x width x height."""

    provider_id = "media.concat"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return Description(
            provider_id=cls.provider_id,
            kind="media.concat",
            label="序列匯出（多片段依序裁切、接合、重新編碼）",
            inputs=[
                Port(
                    "sequence",
                    "media.sequence.v1",
                    True,
                    "inline",
                    "{clips: [{asset: media.asset.v1, in_frame, out_frame|null, effects?}], width?, height?, fps?, "
                    "fit?: contain|cover, audio_track?: {file: FileRef, start_seconds, gain_db?}}（fit＝片段縮放方式；"
                    "audio_track＝聲音改用該檔音軌，長度固定為序列總長）",
                )
            ],
            outputs=[Port("asset", "media.asset.v1", True, "inline", "接合後的完整 MP4 Asset（h264＋aac）")],
            settings_schema=settings_schema(invoke_properties=PARAMS, device_kinds=("cpu",)),
            parameters_schema={"type": "object", "properties": PARAMS, "additionalProperties": False},
            default_settings={
                "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-concat"}},
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            facts={"timeline_export": TIMELINE_EXPORT_FACTS},
        )

    def invoke(self, ctx: RunContext) -> None:
        params: dict[str, Any] = {k: v.get("default") for k, v in PARAMS.items()} | dict(ctx.parameters)
        value = ctx.input("sequence").value
        if isinstance(value, Mapping) and "timeline" in value:
            export_timeline(ctx, value, params)
            return
        clips, sequence = plan_clips(value)
        track = plan_audio_track(sequence)  # None: the clips provide the sound, as before audio_track existed
        width, height, fps = _geometry(sequence, clips[0]["asset"])
        fit = plan_fit(sequence)  # None: aspect-preserving scale plus black bars, as before fit existed
        for index, clip in enumerate(clips):
            clip_fps = _fps_of(clip["asset"].get("fps"))
            if clip_fps is not None:
                _check_fps(clip_fps, f"片段 {index + 1} ")
        plan = plan_effects(clips, fps)  # None: no effects anywhere, keep the plain concat graph
        rec = ctx.recorder
        with rec.phase("input"):
            inputs = _probe_inputs(ctx, clips, plan, width=width, height=height)
            track_input = _resolve_audio_track(ctx, track) if track is not None else None
        graph, notes, expected, tolerance = _video_graph(
            clips, plan, inputs, width=width, height=height, fps=fps, audio=track is None, fit=fit
        )
        _check_output_size(expected, fps)
        soundtrack: SoundtrackPlan | None = None
        if track is not None and track_input is not None:
            # sound length = the planned sequence length (frames / fps); video frames are verified as usual
            soundtrack = plan_soundtrack(track, track_input[1], total_frames=expected, fps=fps)
            graph = f"{graph};{soundtrack_chain(inputs.count, soundtrack)}"
            notes = [*notes, *soundtrack.notes, *_ignored_audio_effects(plan)]
        out = ctx.new_file(None, "video/mp4", {"kind": "final", "sequence": True}, type_id="media.video.v1")
        tmp = Path(ctx.work_dir) / f"{out.file_id}.concat.mp4"
        t0 = time.perf_counter_ns()
        try:
            actual, measured = _encode_and_verify(
                ctx,
                inputs,
                audio_input=track_input[0] if track_input is not None else None,
                graph=graph,
                params=params,
                fps=fps,
                output=tmp,
                measure_audio=soundtrack is not None,
            )
            _check_lengths(
                actual=actual, expected=expected, tolerance=tolerance, effects=plan is not None,
                soundtrack=soundtrack, measured=measured,
            )  # fmt: skip
        except BaseException:
            tmp.unlink(missing_ok=True)  # never leave a half-written export in the work directory
            raise
        encode_ms = (time.perf_counter_ns() - t0) / 1e6
        rec.log("info", "序列接合完成", clips=len(clips), expected_frames=expected, actual_frames=actual)
        rec.part_value("concat", "encode_wall_ms", encode_ms, unit="ms", method="host_monotonic")
        rec.record_cost(
            "concat",
            work=actual * width * height,
            unit="pixel_frame",
            compute_ms=encode_ms,
            clips=len(clips),
            effects=plan is not None,
            audio_track=track is not None,
        )
        shutil.move(tmp, out.path)
        out.adopt_written()
        file_ref = {
            "node_id": str(rec.node_id),
            "file_id": out.file_id,
            "size_bytes": out.size,
            "sha256": out.sha256,
            "media_type": "video/mp4",
            "metadata": out.metadata,
        }
        record: dict[str, Any] = {
            "clips": [_clip_record(c, None if plan is None else plan.clips[i]) for i, c in enumerate(clips)],
            "expected_frames": expected,
            "encoder": {
                "video": "libx264",
                "crf": int(params["crf"]),
                "preset": params["preset"],
                "audio": "aac",
                "audio_bitrate": int(params["audio_bitrate"]),
            },
            "notes": notes,
        }
        if fit is not None:
            record["fit"] = fit
        if track is not None and track_input is not None and soundtrack is not None:
            record["audio_track"] = {
                "file_id": track.file.get("file_id"),
                "sha256": track.file.get("sha256"),
                "start_seconds": track.start_seconds,
                "gain_db": track.gain_db,
                **soundtrack.as_dict(),
                "measured_samples": measured,
                "source": track_input[1].as_dict(),
            }
        ctx.set_output(
            "asset",
            {
                "asset_id": new_id(),
                "kind": "final",
                "file": file_ref,
                "source_latent": None,
                "frame_count": actual,
                "fps": {"num": fps.numerator, "den": fps.denominator},
                "width": width,
                "height": height,
                "complete": True,
                "actual_settings": {"concat": record},
            },
        )


@dataclass
class _Inputs:
    """Probed, materialised FFmpeg inputs: clips first, then title images (ordered by clip index)."""

    clip_paths: list[Path] = field(default_factory=list)
    has_audio: list[bool] = field(default_factory=list)
    title_paths: dict[int, Path] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.clip_paths) + len(self.title_paths)

    def title_inputs(self) -> dict[int, int]:
        return {index: len(self.clip_paths) + k for k, index in enumerate(sorted(self.title_paths))}


def _geometry(sequence: Mapping[str, Any], first: Mapping[str, Any]) -> tuple[int, int, Fraction]:
    width = int(sequence.get("width") or first.get("width") or 0)
    height = int(sequence.get("height") or first.get("height") or 0)
    fps = _fps_of(sequence.get("fps")) or _fps_of(first.get("fps")) or Fraction(24, 1)
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise ComponentError("INVALID_ARGUMENT", f"序列解析度不合法：{width}×{height}（需為正偶數）")
    limits = DEFAULT_LIMITS
    if width > limits.max_width or height > limits.max_height or width * height > limits.max_pixels:
        raise ComponentError(
            "INPUT_TOO_LARGE",
            f"序列解析度 {width}×{height} 超過上限（{limits.max_width}×{limits.max_height}、{limits.max_pixels} 像素）",
            details={"width": width, "height": height, "limit_pixels": limits.max_pixels},
        )
    _check_fps(fps, "序列")
    return width, height, fps


def _check_fps(fps: Fraction, what: str) -> None:
    """A frame rate outside 1–240 fps would turn a few frames into hours of output (or the reverse)."""
    if not MIN_FPS <= fps <= MAX_FPS:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"{what}的 fps {fps.numerator}/{fps.denominator} 不在 {MIN_FPS}–{MAX_FPS} 之間",
            details={"fps": f"{fps.numerator}/{fps.denominator}"},
        )


def _check_output_size(expected: int, fps: Fraction) -> None:
    """The planned output stays inside the limits every other media step applies to a file."""
    limits = DEFAULT_LIMITS
    seconds = Fraction(expected) / fps
    if expected > limits.max_frames or seconds > limits.max_duration_seconds:
        raise ComponentError(
            "INPUT_TOO_LARGE",
            f"序列共 {expected} 幀（{float(seconds):.1f} 秒），超過上限 {limits.max_frames} 幀或 "
            f"{limits.max_duration_seconds:g} 秒",
            details={"frames": expected, "limit_frames": limits.max_frames},
        )


def _probe_inputs(
    ctx: RunContext, clips: list[dict[str, Any]], plan: SequencePlan | None, *, width: int, height: int
) -> _Inputs:

    inputs = _Inputs()
    for index, clip in enumerate(clips):
        ctx.check_cancelled()
        path = ctx.resolve_file(clip["asset"]["file"])
        try:
            info = probe(path, count_frames=False, cancel=ctx.cancel_token)
        except MediaError as exc:
            raise media_failure(ctx, exc, what=f"片段 {index + 1} 探測失敗") from exc
        if info.kind != "video":
            raise ComponentError("INVALID_ARGUMENT", f"片段 {index + 1} 不是影片（{info.kind}）")
        inputs.clip_paths.append(path)
        inputs.has_audio.append(bool(info.has_audio))
    for planned in plan.clips if plan is not None else ():
        title = planned.effects.title if planned.effects is not None else None
        if title is None:
            continue
        ctx.check_cancelled()
        path = ctx.resolve_file(title.image)
        try:
            info = probe(path, count_frames=False, cancel=ctx.cancel_token)
        except MediaError as exc:
            raise media_failure(ctx, exc, what=f"片段 {planned.index + 1} 的文字圖層探測失敗") from exc
        if info.kind != "image":
            raise ComponentError("INVALID_ARGUMENT", f"片段 {planned.index + 1} 的文字圖層不是圖片（{info.kind}）")
        if (info.width, info.height) != (width, height):
            inputs.notes.append(
                f"片段 {planned.index + 1} 的文字圖層 {info.width}×{info.height} 已縮放成 {width}×{height}"
            )
        inputs.title_paths[planned.index] = path
    return inputs


def _video_graph(
    clips: list[dict[str, Any]],
    plan: SequencePlan | None,
    inputs: _Inputs,
    *,
    width: int,
    height: int,
    fps: Fraction,
    audio: bool,
    fit: str | None = None,
) -> tuple[str, list[str], int, int]:
    """(filtergraph, notes, expected output frames, allowed frame difference)."""
    if plan is None:
        graph, notes = _filter_graph(
            clips, width=width, height=height, fps=fps, has_audio=inputs.has_audio, audio=audio, fit=fit
        )
        expected = sum(round(Fraction(c["frames"]) / (_fps_of(c["asset"].get("fps")) or fps) * fps) for c in clips)
        return graph, notes, expected, len(clips)

    sources = [
        ClipSource(
            input_index=i,
            in_frame=c["in_frame"],
            out_frame=c["out_frame"],
            fps=_fps_of(c["asset"].get("fps")) or fps,
            has_audio=inputs.has_audio[i],
        )
        for i, c in enumerate(clips)
    ]
    graph, notes = filter_graph(
        sources, plan, width=width, height=height, fps=fps, title_inputs=inputs.title_inputs(), audio=audio, fit=fit
    )
    # every segment is pinned to its planned frames and transition overlaps are whole frames: exact match
    return graph, inputs.notes + notes, plan.total_frames, 0


def _input_args(path: Path, limits: MediaLimits, *, demuxer: str | None = None) -> list[str]:
    """One whitelisted ``file:`` input: FFmpeg can never follow it to other files or URLs."""

    forced = ["-f", demuxer] if demuxer else []
    return [
        "-protocol_whitelist", "file", "-format_whitelist", limits.format_whitelist, *limits.decoder_flags,
        *forced, "-i", input_url(path),
    ]  # fmt: skip


def _encode_and_verify(
    ctx: RunContext,
    inputs: _Inputs,
    *,
    audio_input: Path | None,
    graph: str,
    params: Mapping[str, Any],
    fps: Fraction,
    output: Path,
    measure_audio: bool,
) -> tuple[int, int | None]:
    """Run the single FFmpeg encode, then count the output frames (and audio samples when asked)."""

    limits = DEFAULT_LIMITS
    argv: list[str] = [find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-y"]
    marks: dict[str, str] = {str(output): "<output>", input_url(output): "<output>"}
    for i, path in enumerate(inputs.clip_paths):
        argv += _input_args(path, limits)
        marks.update({str(path): f"<clip {i + 1}>", input_url(path): f"<clip {i + 1}>"})
    for index in sorted(inputs.title_paths):
        path = inputs.title_paths[index]
        argv += _input_args(path, limits, demuxer="png_pipe")
        marks.update({str(path): f"<title {index + 1}>", input_url(path): f"<title {index + 1}>"})
    if audio_input is not None:
        argv += _input_args(audio_input, limits)
        marks.update({str(audio_input): "<audio_track>", input_url(audio_input): "<audio_track>"})
    argv += [
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
        # the export carries no tags or chapters of its materials (a camera file's title, date or GPS position)
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-c:v", "libx264", "-preset", str(params["preset"]), "-crf", str(int(params["crf"])),
        "-pix_fmt", "yuv420p", "-r", f"{fps.numerator}/{fps.denominator}",
        "-c:a", "aac", "-b:a", str(int(params["audio_bitrate"])), "-ar", str(AUDIO_RATE),
        "-movflags", "+faststart", input_url(output),
    ]  # fmt: skip
    try:
        with ctx.recorder.phase("encode"):
            result = run_tool(
                argv,
                timeout=max(1.0, ctx.remaining_seconds()),
                cancel=ctx.cancel_token,
                max_stderr_bytes=limits.max_stderr_bytes,
                what="FFmpeg concat",
            )
        if result.returncode != 0:
            detail = summarize_stderr(redact(result.stderr, marks), 600)
            raise ComponentError("MEDIA_TOOL_FAILED", "FFmpeg 接合失敗" + (f"：{detail}" if detail else ""))
        with ctx.recorder.phase("verify"):
            info = probe(output, count_frames=True, cancel=ctx.cancel_token)
            measured = _audio_samples(output, ctx) if measure_audio else None
    except MediaError as exc:
        raise media_failure(ctx, exc, what="媒體處理失敗") from exc
    return int(info.frame_count or 0), measured


def _check_lengths(
    *,
    actual: int,
    expected: int,
    tolerance: int,
    effects: bool,
    soundtrack: SoundtrackPlan | None,
    measured: int | None,
) -> None:
    if abs(actual - expected) > tolerance:
        what = "計畫（含速度與轉場）的" if effects else "裁切後應有的"
        raise ComponentError(
            "MEDIA_INCOMPLETE",
            f"接合後實際 {actual} 幀，與{what} {expected} 幀不符",
            details={"expected_frames": expected, "actual_frames": actual},
        )
    if soundtrack is not None and (measured is None or abs(measured - soundtrack.samples) > 1):
        raise ComponentError(
            "MEDIA_INCOMPLETE",
            f"匯出的聲音長度 {measured} samples 與序列總長 {soundtrack.samples} samples（48 kHz）不符",
            details={"expected_samples": soundtrack.samples, "actual_samples": measured},
        )


def _resolve_audio_track(ctx: RunContext, track: AudioTrack) -> tuple[Path, AudioSource]:
    """Materialise the audio_track file and read its timeline.

    Not a video or audio file, or no audio stream -> ``INVALID_ARGUMENT`` (never replaced by silence).
    """

    fields = {"field_paths": ["sequence.audio_track.file"]}
    ctx.check_cancelled()
    path = ctx.resolve_file(track.file)
    try:
        info = probe(path, count_frames=False, cancel=ctx.cancel_token)
        if info.kind not in ("video", "audio"):
            raise ComponentError("INVALID_ARGUMENT", f"audio_track 的檔案不是影片或聲音（{info.kind}）", details=fields)
        if not info.has_audio:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "audio_track 的檔案沒有音軌，無法用它的聲音匯出；請改用片段本身的聲音或換一個有聲音的檔案",
                details=fields,
            )
        return path, audio_source(path, cancel=ctx.cancel_token)
    except MediaError as exc:
        failure = media_failure(ctx, exc, what="audio_track 的檔案探測失敗")
        raise ComponentError(failure.code, failure.message, details=fields) from exc


def _audio_samples(path: Path, ctx: RunContext) -> int | None:
    """Real length of the export's first audio stream in 48 kHz samples (packet scan: end minus start)."""

    timeline = scan_timeline(path, cancel=ctx.cancel_token)
    audio = timeline.of_type("audio")
    if not audio or audio[0].packets <= 0:
        return None
    stream = audio[0]
    return round((stream.end_seconds - stream.start_seconds) * AUDIO_RATE)


__all__ = ["ConcatProvider", "plan_audio_track", "plan_clips", "plan_effects", "plan_soundtrack"]
