"""Multi-track branch of media.concat: original files, bounded processes, verified publication.

The export is planned completely before anything is encoded (``phasyn_media.composition``), then:

1. every source the plan uses is identified by its header only (kind, clocks, colour tags) and by
   bounded packet windows around the frames the clips need: a source may be far longer than the
   sequence, the export never decodes or scans what it does not show;
2. titles, text layers and captions are drawn by ``phasyn_media.text`` (no browser);
3. the sound is mixed chunk by chunk into one 48 kHz float file with an exact sample count;
4. the picture is rendered segment by segment: one short-lived FFmpeg per segment seeks its
   clips, composites the frames and writes raw 4:2:0 frames into the pipe of ONE encoder process,
   which encodes H.264 and AAC and muxes the MP4. Renderers have the per-process bound; the
   encoder only waits for frames and is bounded by the call's deadline;
5. the file is verified (frames, size, rate, audio packets, declared presentation length) and only
   then published. The run's record (``actual_settings.concat``) states what was exported: frames and
   audio samples as verified, the clips that gave no picture and no sound and why, the silence played
   where a source's sound ends early, and for text which engine drew what, with which fonts, and every
   character no font on the Node has (drawn as ``.notdef``, as a browser does).

Every temporary file lives in one directory this call creates exclusively and removes on success,
failure, timeout and cancel. Error text never carries a local path.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import time
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from fractions import Fraction
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import RunContext

from ..composition import (
    CompositionPlan,
    Segment,
    chunk_samples,
    invalid,
    plan_composition,
    refusal,
    title_in_slice,
)
from ..composition_audio import AudioInput, chunk_graph, first_sample
from ..composition_video import (
    MediaInput,
    RasterInput,
    SegmentInputs,
    direct_segment,
    segment_graph,
    source_range,
)
from ..effects import AUDIO_RATE, samples_for
from ..errors import MediaError
from ..limits import DEFAULT_LIMITS, TIMELINE_SOURCE_LIMITS, MediaLimits
from ..probe import MediaInfo, probe, run_ffprobe_json
from ..seek import (
    SourceTiming,
    StreamClock,
    audio_cut,
    frame_tick,
    lacks_start,
    near,
    parse_packets,
    seek_text,
    source_timing,
    tick_seconds,
    video_seek,
)
from ..text import (
    CaptionEvent,
    CaptionTrackJob,
    MissingGlyphs,
    TextRenderError,
    TextRequest,
    TextResult,
    TitleJob,
    render_texts,
)
from ..timeline import scan_timeline
from ..tools import (
    ManagedProcess,
    ToolResult,
    find_ffmpeg,
    find_ffprobe,
    graph_script_args,
    input_url,
    redact,
    run_tool,
    summarize_stderr,
)
from ._failure import media_failure

# What the multitrack branch understands, as the provider's descriptor states it (``facts.timeline_export``):
# ``version`` is the highest ``StudioTimeline.version`` it plans (2: disabled clips), ``text`` says that
# titles, text layers and captions are drawn here, so no browser-made image has to come with the document, and
# ``adjustment`` that adjustment layers are composited (their chain on the composite of the tracks below them).
TIMELINE_EXPORT_FACTS: Mapping[str, Any] = {"version": 2, "text": True, "adjustment": True}
# BT.709 limited range: what every segment renderer writes and what the published file states.
COLOUR_TAGS = ("-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv")
# How many clip and caption ids the record names for characters drawn as .notdef (the counts are exact).
MISSING_GLYPH_ITEMS = 100

TIMING_ENTRIES = (
    "format=start_time:stream=index,codec_type,time_base,start_pts,sample_rate:stream_disposition=attached_pic"
)
# How far before a frame the packet window starts; a longer gap between frames widens it once, then the
# clip is read from the start of its file.
PACKET_LEADS = (Fraction(4), Fraction(120))
# Around the end of an audio clip: sound that stops up to a second before it is seen, and the read goes on
# long enough after it that sound stored behind the picture in the file is not mistaken for missing.
SOUND_WINDOW = (Fraction(1), Fraction(2))
PACKET_WINDOWS_PER_PROBE = 48
# Packets read from the start of a file whose header states no stream start (WAV, Wave64, raw AAC).
FIRST_PACKETS = 64
PACKET_PROBE_BYTES = 64 * 1024 * 1024
# A decoder of one clip input and the slice threads of a renderer: enough for one layer at export
# speed, small enough that 64 open clips stay a few hundred megabytes.
DECODER_THREADS = 2
FILTER_THREADS = 8
# No machine composites and encodes this many pixels per second: a plan that needs more than the
# call has left is refused before any process starts.
BEST_CASE_PIXELS_PER_SECOND = 2_000_000_000


@dataclass(frozen=True)
class Material:
    """One source file as its header describes it. ``timing`` is ``None`` for a still image."""

    path: Path
    info: MediaInfo
    timing: SourceTiming | None
    declare: str = ""


@dataclass
class _Packets:
    """Packets read in bounded windows of one source: enough to place seeks and to prove extents."""

    video: list[tuple[int, int]] = field(default_factory=list)  # (pts, duration), sorted
    audio_end: int | None = None  # largest pts + duration seen on the audio stream


@dataclass(frozen=True)
class _Run:
    """One planned FFmpeg process and what it must deliver (frames or samples)."""

    argv: list[str]
    marks: Mapping[str, str]
    expected: int


@dataclass
class _Job:
    directory: Path
    marks: dict[str, str] = field(default_factory=dict)
    audio: list[_Run] = field(default_factory=list)
    video: list[_Run] = field(default_factory=list)
    text: TextResult | None = None
    sources: list[dict[str, Any]] = field(default_factory=list)
    text_facts: dict[str, Any] | None = None


def _limits(ctx: RunContext, base: MediaLimits = DEFAULT_LIMITS) -> MediaLimits:
    ctx.check_cancelled()
    remaining = ctx.remaining_seconds()
    if remaining <= 0:
        raise ComponentError("CALL_TIMEOUT", "多軌匯出超過時間限制")
    return replace(
        base,
        probe_timeout_seconds=min(base.probe_timeout_seconds, remaining),
        process_timeout_seconds=min(base.process_timeout_seconds, remaining),
    )


def _input(path: Path, limits: MediaLimits, before: Sequence[str] = ()) -> list[str]:
    """One whitelisted ``file:`` input; ``before`` are its seek and decoder options."""
    return [
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        limits.format_whitelist,
        *limits.decoder_flags,
        *before,
        "-i",
        input_url(path),
    ]


def _incomplete(reason: str, message: str, **details: Any) -> ComponentError:
    return refusal("MEDIA_INCOMPLETE", reason, message, **details)


# --------------------------------------------------------------------------- sources


def _declare(info: MediaInfo) -> str:
    """Colour properties a YUV video does not state: BT.709 for HD, BT.601 below, limited range (as players assume)."""
    if info.kind != "video" or not (info.pixel_format or "").startswith(("yuv", "nv")):
        return ""
    declared: list[str] = []
    if info.color_space is None:
        high = (info.width or 0) >= 1280 or (info.height or 0) > 576
        declared.append("colorspace=bt709" if high else "colorspace=smpte170m")
    if info.color_range is None:
        declared.append("range=tv")
    return ":".join(declared)


def _opaque_cover(info: MediaInfo, plan: CompositionPlan) -> bool:
    """True when a video's own picture is opaque, upright and fills the canvas under the sequence fit."""
    pixel_format = info.pixel_format or ""
    opaque = pixel_format.startswith(("yuv4", "yuvj", "nv")) and not pixel_format.startswith("yuva")
    if (
        info.kind != "video"
        or not opaque
        or info.rotation_degrees not in (None, 0)
        or not info.width
        or not info.height
    ):
        return False
    return plan.fit == "cover" or info.width * plan.height == info.height * plan.width


def _timing(ctx: RunContext, path: Path, limits: MediaLimits) -> SourceTiming:
    """Clocks of a file from its header; a stream the header gives no start for starts at its first packet."""
    header = run_ffprobe_json(
        path, ["-show_entries", TIMING_ENTRIES], limits=limits, cancel=ctx.cancel_token, max_output_bytes=65536
    )
    if not lacks_start(header):
        return source_timing(header)
    first = run_ffprobe_json(
        path,
        ["-read_intervals", f"%+#{FIRST_PACKETS}", "-show_entries", "packet=stream_index,pts"],
        limits=limits,
        cancel=ctx.cancel_token,
        max_output_bytes=65536,
    )
    starts: dict[int, int] = {}
    for packet in first.get("packets") or []:
        index, pts = packet.get("stream_index"), packet.get("pts")
        if isinstance(index, int) and isinstance(pts, int):
            starts[index] = min(pts, starts.get(index, pts))
    return source_timing(header, starts)


def _material(ctx: RunContext, source: Mapping[str, Any]) -> Material:
    source_id = source["source_id"]
    file = source["file"]  # Deliberately never source.proxy.file.
    if file is None:  # the plan refuses this first, by clip
        raise invalid("placeholder_clip", "原始素材尚未完成", source_id=source_id)
    path = ctx.resolve_file(file)
    limits = _limits(ctx, TIMELINE_SOURCE_LIMITS)
    try:
        info = probe(path, count_frames=False, limits=limits, cancel=ctx.cancel_token)
        timing = None if info.kind == "image" else _timing(ctx, path, limits)
    except MediaError as exc:
        failure = media_failure(ctx, exc, what="原始素材無法讀取")  # a cancel raises here
        details = {**failure.details, "reason": "source_unreadable", "source_id": source_id}
        raise ComponentError(failure.code, failure.message, details=details) from exc
    if info.kind != source["kind"]:
        raise invalid("source_kind_mismatch", "原始素材實際種類與時間軸不同", source_id=source_id)
    return Material(path, info, timing, _declare(info))


def _materials(ctx: RunContext, plan: CompositionPlan) -> dict[str, Material]:
    """Header facts of every source an exported clip reads, with the kind each clip needs."""
    materials: dict[str, Material] = {}
    for clip in plan.clips:
        if not clip.enabled or not clip.media_file:
            continue
        source_id = str(clip.source["source_id"])
        if source_id not in materials:
            materials[source_id] = _material(ctx, clip.source)
        material, number = materials[source_id], clip.index + 1
        if clip.is_video and material.info.kind not in ("video", "image"):
            raise invalid("source_without_picture", f"片段 {number} 的來源沒有畫面", clip_id=clip.document["clip_id"])
        if not clip.is_video and (material.timing is None or material.timing.audio is None):
            raise invalid("source_without_sound", f"片段 {number} 的來源沒有音訊", clip_id=clip.document["clip_id"])
    return materials


def _intervals(spans: Sequence[tuple[Fraction, Fraction]]) -> list[str]:
    """ffprobe read intervals of the given spans (container seconds), overlapping ones merged."""
    merged: list[tuple[Fraction, Fraction]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return [f"{seek_text(start)}%{seek_text(end + Fraction(1, 1000))}" for start, end in merged]


def _frame_windows(clock: StreamClock, fps: Fraction, ticks: Sequence[int], lead: Fraction) -> list[str]:
    """Read intervals around source frames: ``lead`` seconds before each one, four frames after."""
    times = [tick_seconds(tick, clock, fps) for tick in ticks]
    return _intervals([(at - lead, at + 4 / fps) for at in times])


def _sound_windows(timing: SourceTiming, ends: Sequence[int]) -> list[str]:
    """Read intervals around the ends of audio clips (48 kHz samples from the clip origin)."""
    times = [timing.origin_seconds + Fraction(sample, AUDIO_RATE) for sample in ends]
    return _intervals([(at - SOUND_WINDOW[0], at + SOUND_WINDOW[1]) for at in times])


def _read_packets(
    ctx: RunContext,
    material: Material,
    intervals: Sequence[str],
    into: _Packets,
    *,
    stream: int | None = None,
    whole_clip: bool = False,
) -> None:
    """Demux (never decode) the given intervals of one source and remember its packets.

    ffprobe ends an interval at the first packet it shows that lies past it. With ``stream`` only that
    stream is shown, so a window around a frame ends on a frame however the file interleaves its sound;
    without it every stream is shown, so the read stays bounded when one of them has already ended.
    A window is a probe; ``whole_clip`` reads the range of one clip and gets a process's time.
    """
    timing = material.timing
    if timing is None or not intervals:
        return
    url = input_url(material.path)
    limits = _limits(ctx, TIMELINE_SOURCE_LIMITS)
    timeout = limits.process_timeout_seconds if whole_clip else limits.probe_timeout_seconds
    selected = ["-select_streams", str(stream)] if stream is not None else []
    for offset in range(0, len(intervals), PACKET_WINDOWS_PER_PROBE):
        batch = ",".join(intervals[offset : offset + PACKET_WINDOWS_PER_PROBE])
        argv = [
            find_ffprobe(), "-hide_banner", "-v", "error", "-protocol_whitelist", "file",
            "-format_whitelist", limits.format_whitelist, *limits.decoder_flags, *selected,
            "-read_intervals", batch, "-show_entries", "packet=stream_index,pts,duration",
            "-of", "compact=p=0:nk=0", url,
        ]  # fmt: skip
        result = run_tool(
            argv,
            timeout=timeout,
            cancel=ctx.cancel_token,
            max_stdout_bytes=PACKET_PROBE_BYTES,
            max_stderr_bytes=limits.max_stderr_bytes,
            what="ffprobe packet window",
        )
        if result.returncode != 0:
            marks = {str(material.path): "<source>", url: "<source>"}
            raise _failure("來源片段範圍讀取失敗", result.stderr, marks, "source_window_unreadable")
        packets = parse_packets(result.stdout.decode("ascii", errors="replace"), limit=limits.max_scan_packets)
        if timing.video is not None:
            into.video = sorted({*into.video, *packets.get(timing.video.index, [])})
        if timing.audio is not None:
            ends = [pts + max(duration, 0) for pts, duration in packets.get(timing.audio.index, [])]
            into.audio_end = max([*ends, *([into.audio_end] if into.audio_end is not None else [])], default=None)


def _frame_before(packets: _Packets, clock: StreamClock, fps: Fraction, tick: int, lead: Fraction) -> int | None:
    """PTS of the frame shown at ``tick`` when it lies inside the window that was read for it."""
    ticks = [frame_tick(pts, clock, fps) for pts, _duration in packets.video]
    position = bisect_right(ticks, tick) - 1
    if position < 0:
        return None
    pts = packets.video[position][0]
    window_start = tick_seconds(tick, clock, fps) - lead
    return pts if pts * clock.time_base >= window_start or window_start <= clock.start_seconds else None


def _has_frame(packets: _Packets, clock: StreamClock, fps: Fraction, tick: int) -> bool:
    """True when the source has real picture for ``tick`` (a later frame, or the last one lasting into it)."""
    if not packets.video:
        return False
    pts, duration = packets.video[-1]
    return frame_tick(pts, clock, fps) >= tick or frame_tick(pts + max(duration, 0), clock, fps) > tick


class _Sources:
    """Seek points and extents of the sources, answered from bounded packet windows."""

    def __init__(self, ctx: RunContext, plan: CompositionPlan, materials: Mapping[str, Material]) -> None:
        self._ctx, self._plan, self.materials = ctx, plan, materials
        self._packets: dict[str, _Packets] = {source_id: _Packets() for source_id in materials}
        self._lead: dict[str, Fraction] = {}

    def read(self, ticks: Mapping[str, Sequence[int]], ends: Mapping[str, Sequence[int]]) -> None:
        """Read the windows of every source once; frames that sit in a longer gap get one wider window."""
        fps = self._plan.fps
        for source_id, material in self.materials.items():
            timing, packets = material.timing, self._packets[source_id]
            if timing is None:
                continue
            if timing.audio is not None:
                sound = _sound_windows(timing, sorted(set(ends.get(source_id, ()))))
                _read_packets(self._ctx, material, sound, packets)
            clock = timing.video
            wanted = sorted(set(ticks.get(source_id, ()))) if clock is not None else []
            for lead in PACKET_LEADS:
                if clock is None or not wanted:
                    break
                windows = _frame_windows(clock, fps, wanted, lead)
                _read_packets(self._ctx, material, windows, packets, stream=clock.index)
                self._lead[source_id] = lead
                wanted = [tick for tick in wanted if _frame_before(packets, clock, fps, tick, lead) is None]

    def seek(self, source_id: str, tick: int) -> Fraction | None:
        """``-ss`` seconds for a slice that starts at source frame ``tick``; ``None`` reads from the start."""
        material = self.materials[source_id]
        timing = material.timing
        if timing is None or timing.video is None:
            return None
        lead = self._lead.get(source_id, PACKET_LEADS[0])
        pts = _frame_before(self._packets[source_id], timing.video, self._plan.fps, tick, lead)
        return None if pts is None else video_seek(pts, timing.video, timing)

    def has_picture(self, source_id: str) -> bool:
        """True for a still image and for a file with a video stream (cover art is not a picture)."""
        timing = self.materials[source_id].timing
        return timing is None or timing.video is not None

    def has_frame(self, source_id: str, tick: int) -> bool:
        """True when the source has real picture for ``tick``; a still image has every frame."""
        timing = self.materials[source_id].timing
        if timing is None:
            return True
        return timing.video is not None and _has_frame(self._packets[source_id], timing.video, self._plan.fps, tick)

    def _sound(self, source_id: str) -> int | None:
        timing = self.materials[source_id].timing
        end = self._packets[source_id].audio_end
        if timing is None or timing.audio is None or end is None:
            return None
        return near((end * timing.audio.time_base - timing.origin_seconds) * AUDIO_RATE)

    def sound_end(self, source_id: str, start: int, end: int) -> int | None:
        """Where the source's sound stops as a clip ``[start, end)`` sees it (48 kHz samples from the clip origin).

        The window read around the clip's end shows sound that reaches the end or stops less than a second
        before it. When it shows neither, the clip's own range is read once, packets only, to find where the
        sound stopped: the cost stays that of the clip, however long the source is. ``None``: no sound at all.
        """
        reached = self._sound(source_id)
        material = self.materials[source_id]
        timing = material.timing
        if timing is not None and (reached is None or reached < end - AUDIO_RATE) and end - start > AUDIO_RATE:
            origin = timing.origin_seconds
            first, last = origin + Fraction(start, AUDIO_RATE), origin + Fraction(end, AUDIO_RATE) - 1
            interval = f"{seek_text(first)}%{seek_text(last)}"
            _read_packets(self._ctx, material, [interval], self._packets[source_id], whole_clip=True)
            reached = self._sound(source_id)
        return reached


def _needs(plan: CompositionPlan) -> tuple[dict[str, list[int]], dict[str, list[int]]]:
    """Source frames whose packets must be read (first and last of every slice) and audio ends, per source."""
    ticks: dict[str, list[int]] = {}
    ends: dict[str, list[int]] = {}
    for segment in plan.segments:
        for item in segment.slices:
            clip = plan.clips[item.clip]
            if clip.enabled and clip.media_file and not clip.still:
                ticks.setdefault(str(clip.source["source_id"]), []).extend(source_range(clip, item))
    for clip in plan.clips:
        if not clip.enabled or not clip.media_file or clip.still:
            continue
        source_id, last = str(clip.source["source_id"]), int(clip.document["out_frame"])
        ticks.setdefault(source_id, []).append(last - 1)  # a window must not hide a short source
        if not clip.is_video:
            ends.setdefault(source_id, []).append(samples_for(last, plan.fps))
    return ticks, ends


def _check_extents(plan: CompositionPlan, sources: _Sources) -> dict[str, int]:
    """Refuse before rendering when a clip's range is not backed by real frames or samples of its source.

    A clip's range ends on a frame, while the sound of a file rarely does: it often stops inside the last
    frame, and before the end of the picture when the file has one (an H3 take's sound can be a third of a
    frame shorter). An audio clip may therefore run to the end of its source's picture, or less than one frame
    past sound that has no picture; the chunk graph plays silence for what is missing. A clip that starts at
    or after the end of the sound, or reaches further, asks for a range the source does not have.

    Returns the silence (48 kHz samples) played after the end of each source's sound: the largest shortfall
    among its audio clips.
    """
    silence: dict[str, int] = {}
    for clip in plan.clips:
        if not clip.enabled or not clip.media_file:
            continue
        source_id, number = str(clip.source["source_id"]), clip.index + 1
        last = int(clip.document["out_frame"])
        if sources.has_picture(source_id) and not sources.has_frame(source_id, last - 1):
            raise _incomplete(
                "source_missing_frames", f"片段 {number} 的出點超過來源實際影格數", clip_id=clip.document["clip_id"]
            )
        if clip.is_video:
            continue
        start, end = samples_for(int(clip.document["in_frame"]), plan.fps), samples_for(last, plan.fps)
        sound = sources.sound_end(source_id, start, end)
        within_last_frame = (sound or 0) + samples_for(1, plan.fps) - 1
        if sound is None or start >= sound or (end > within_last_frame and not sources.has_picture(source_id)):
            raise _incomplete(
                "source_missing_audio", f"片段 {number} 的範圍超過來源實際音訊長度", clip_id=clip.document["clip_id"]
            )
        silence[source_id] = max(silence.get(source_id, 0), end - sound)
    return silence


# --------------------------------------------------------------------------- text and uploaded rasters


def _image(ctx: RunContext, file: Mapping[str, Any]) -> Path:
    path = ctx.resolve_file(file)
    info = probe(path, limits=_limits(ctx), count_frames=False, cancel=ctx.cancel_token)
    if info.kind != "image" or info.format_name != "png_pipe":
        raise invalid("text_image_invalid", "文字圖層必須是 PNG 圖片", file_id=file["file_id"])
    if not info.width or not info.height:
        raise invalid("text_image_invalid", "文字圖層沒有有效尺寸", file_id=file["file_id"])
    return path


def _text_request(plan: CompositionPlan) -> tuple[TextRequest, dict[int, str], dict[int, str]]:
    """What the exporter draws: one raster per distinct title, one caption track per segment that shows captions."""
    keys: dict[str, str] = {}
    titles: list[TitleJob] = []
    by_clip: dict[int, str] = {}
    for index, clip in enumerate(plan.clips):
        spec = clip.title.spec if clip.enabled and clip.title else None
        if spec is None:
            continue
        key = spec.key(plan.width, plan.height)
        if key not in keys:
            keys[key] = f"title{len(titles)}"
            titles.append(TitleJob(keys[key], spec))
        by_clip[index] = keys[key]
    tracks: list[CaptionTrackJob] = []
    by_segment: dict[int, str] = {}
    for segment in plan.segments:
        events = tuple(
            CaptionEvent(
                max(caption.start, segment.start) - segment.start,
                min(caption.end, segment.end) - segment.start,
                caption.spec,
            )
            for caption in (plan.captions[index] for index in segment.captions)
            if caption.spec is not None
        )
        if events:
            by_segment[segment.index] = f"captions{segment.index}"
            tracks.append(CaptionTrackJob(by_segment[segment.index], segment.frames, events))
    request = TextRequest(plan.width, plan.height, plan.fps, tuple(titles), tuple(tracks))
    return request, by_clip, by_segment


def _text_owner(
    plan: CompositionPlan, by_clip: Mapping[int, str], by_segment: Mapping[int, str], error: TextRenderError
) -> tuple[str, dict[str, Any]]:
    """The clip or caption a text refusal belongs to: a message prefix and the details that name it."""
    for index, job_id in by_clip.items():
        if job_id == error.job_id:
            clip = plan.clips[index]
            return f"時間軸片段 {clip.index + 1} 的文字：", {"clip_id": clip.document["clip_id"]}
    for number, job_id in by_segment.items():
        if job_id == error.job_id and error.item is not None:
            index = _caption_of(plan, number, error.item)
            return f"字幕 {index + 1}：", {"caption_id": plan.document["captions"][index]["caption_id"]}
    return "", {}


def _caption_of(plan: CompositionPlan, segment: int, item: int) -> int:
    """Index (in the document) of the caption that is event ``item`` of a segment's caption track."""
    drawn = [index for index in plan.segments[segment].captions if plan.captions[index].spec is not None]
    return drawn[item]


def _missing_facts(
    plan: CompositionPlan, by_clip: Mapping[int, str], by_segment: Mapping[int, str], missing: MissingGlyphs
) -> dict[str, Any]:
    """Which characters were drawn as ``.notdef`` and in which clips and captions (ids, at most 100 of each)."""
    titles = {job_id for job_id, item in missing.items if item is None}
    clips = [str(plan.clips[index].document["clip_id"]) for index, job_id in by_clip.items() if job_id in titles]
    segments = {job_id: number for number, job_id in by_segment.items()}
    captions = dict.fromkeys(
        str(plan.document["captions"][_caption_of(plan, segments[job_id], item)]["caption_id"])
        for job_id, item in missing.items
        if item is not None
    )
    return {
        "code_points": list(missing.code_points),
        "count": missing.count,
        "clips": clips[:MISSING_GLYPH_ITEMS],
        "clip_count": len(clips),
        "captions": list(captions)[:MISSING_GLYPH_ITEMS],
        "caption_count": len(captions),
    }


def _text_facts(
    plan: CompositionPlan, by_clip: Mapping[int, str], by_segment: Mapping[int, str], text: TextResult | None
) -> dict[str, Any] | None:
    """Who drew the text of this export: this engine (and with which fonts) or an older document's uploaded image."""
    titled = [clip.title for clip in plan.clips if clip.enabled and clip.title is not None]
    if not titled and not plan.captions:
        return None
    facts: dict[str, Any] = {
        "drawn": {"titles": len(by_clip), "captions": sum(caption.spec is not None for caption in plan.captions)},
        "uploaded": {
            "titles": sum(title.image is not None for title in titled),
            "captions": sum(caption.image is not None for caption in plan.captions),
        },
    }
    if text is not None:
        facts.update(engine=dict(text.engine), fonts=[dict(font) for font in text.fonts])
        if text.skipped_fonts:
            facts["skipped_fonts"] = [dict(font) for font in text.skipped_fonts]
        if text.missing_glyphs is not None:
            facts["missing_glyphs"] = _missing_facts(plan, by_clip, by_segment, text.missing_glyphs)
    return facts


def _draw_text(
    ctx: RunContext,
    plan: CompositionPlan,
    jobs: tuple[TextRequest, Mapping[int, str], Mapping[int, str]],
    directory: Path,
) -> TextResult | None:
    """Draw every title and caption track in one bounded child process; a refusal names its clip or caption."""
    request, by_clip, by_segment = jobs
    if not request.titles and not request.caption_tracks:
        return None
    target = directory / "text"
    target.mkdir()
    items = len(request.titles) + sum(len(track.events) for track in request.caption_tracks)
    timeout = min(_limits(ctx).process_timeout_seconds, 60.0 + items)
    try:
        return render_texts(request, target, timeout=timeout, cancel=ctx.cancel_token)
    except TextRenderError as exc:
        prefix, details = _text_owner(plan, by_clip, by_segment, exc)
        if exc.detail:
            details["actual"] = exc.detail
        code = "INVALID_ARGUMENT" if exc.code == "INVALID_ARGUMENT" else "MEDIA_TOOL_FAILED"
        raise refusal(code, exc.reason, prefix + exc.message, **details) from exc


# --------------------------------------------------------------------------- processes


class _Inputs:
    """Input arguments of one FFmpeg process and the redaction marks of its paths."""

    def __init__(self, limits: MediaLimits) -> None:
        self._limits = limits
        self.argv: list[str] = []
        self.marks: dict[str, str] = {}
        self.count = 0

    def add(self, path: Path, before: Sequence[str] = ()) -> int:
        self.argv += _input(path, self._limits, before)
        self.marks.update({str(path): f"<input {self.count + 1}>", input_url(path): f"<input {self.count + 1}>"})
        self.count += 1
        return self.count - 1


def _read_span(start: Fraction | None, end: Fraction) -> list[str]:
    """``-ss``/``-t`` of one input: seek to ``start`` and stop reading a little after ``end`` (container seconds)."""
    seek = start if start is not None else Fraction(0)
    options = ["-ss", seek_text(seek)] if start is not None else []
    return [*options, "-t", seek_text(end - seek + 1)]


def _video_before(
    material: Material, plan: CompositionPlan, sources: _Sources, source_id: str, span: tuple[int, int]
) -> list[str]:
    timing = material.timing
    if timing is None or timing.video is None:
        return []
    end = tick_seconds(span[1] + 2, timing.video, plan.fps) - timing.container_start
    return [*_read_span(sources.seek(source_id, span[0]), end), "-threads", str(DECODER_THREADS), "-an"]


def _segment_run(
    ctx: RunContext,
    plan: CompositionPlan,
    segment: Segment,
    sources: _Sources,
    rasters: Mapping[int, tuple[Path, RasterInput]],
    captions: tuple[Mapping[int, Path], tuple[Path, RasterInput] | None],
    job: _Job,
) -> _Run:
    """Inputs, graph and command line of one segment renderer (raw frames to standard output)."""
    files = _Inputs(_limits(ctx, TIMELINE_SOURCE_LIMITS))
    media: dict[int, MediaInput] = {}
    titles: dict[int, RasterInput] = {}
    for position, item in enumerate(segment.slices):
        clip = plan.clips[item.clip]
        if not clip.enabled:
            continue
        if clip.media_file:
            source_id = str(clip.source["source_id"])
            material = sources.materials[source_id]
            before = _video_before(material, plan, sources, source_id, source_range(clip, item))
            index = files.add(material.path, before)
            clock = material.timing.video if material.timing else None
            media[position] = MediaInput(
                index,
                clock.time_base if clock else None,
                clock.start_pts if clock else 0,
                material.declare,
                _opaque_cover(material.info, plan),
                (material.info.width, material.info.height) != (plan.width, plan.height),
            )
        if title_in_slice(clip, item.first, item.end):
            path, raster = rasters[item.clip]
            titles[position] = replace(raster, index=files.add(path))
    caption_images = {
        index: RasterInput(files.add(path), fitted=True)
        for index, path in captions[0].items()
        if index in segment.captions
    }
    track = replace(captions[1][1], index=files.add(captions[1][0])) if captions[1] else None
    direct = direct_segment(plan, segment, media)
    graph = segment_graph(plan, segment, SegmentInputs(media, titles, caption_images, track, direct))
    script = job.directory / f"video-{segment.index:05d}.ffgraph"
    script.write_text(graph, encoding="utf-8")
    argv = [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-y", "-copyts",
        "-filter_complex_threads", str(min(FILTER_THREADS, os.cpu_count() or 1)),
        *files.argv, *graph_script_args(script), "-map", "[v]", "-an",
        "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p",
        "-stats_period", "5", "-progress", "pipe:2", "pipe:1",
    ]  # fmt: skip
    return _Run(argv, {**files.marks, str(script): "<graph>"}, segment.frames)


def _audio_runs(ctx: RunContext, plan: CompositionPlan, sources: _Sources, job: _Job) -> list[_Run]:
    runs: list[_Run] = []
    for chunk in plan.audio_chunks:
        files = _Inputs(_limits(ctx, TIMELINE_SOURCE_LIMITS))
        inputs: dict[int, AudioInput] = {}
        for index in chunk.clips:
            clip = plan.clips[index]
            if not clip.enabled:
                continue
            material = sources.materials[str(clip.source["source_id"])]
            if material.timing is None:
                raise invalid(
                    "source_without_sound", f"片段 {clip.index + 1} 的來源沒有音訊", clip_id=clip.document["clip_id"]
                )
            cut = audio_cut(material.timing, first_sample(clip, plan.fps))
            before = [*(["-ss", seek_text(cut.seek)] if cut.seek is not None else []), "-vn"]
            inputs[index] = AudioInput(files.add(material.path, before), cut)
        script = job.directory / f"audio-{chunk.index:05d}.ffgraph"
        script.write_text(chunk_graph(plan, chunk, inputs), encoding="utf-8")
        first, last = chunk_samples(plan, chunk.start, chunk.end)
        argv = [
            find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-y", "-copyts", "-filter_complex_threads", "1",
            *files.argv, *graph_script_args(script), "-map", "[a]", "-vn",
            "-f", "f32le", "-ar", str(AUDIO_RATE), "-ac", "2", "pipe:1",
        ]  # fmt: skip
        runs.append(_Run(argv, {**files.marks, str(script): "<graph>"}, last - first))
    return runs


def _rasters(
    ctx: RunContext, plan: CompositionPlan, text: TextResult | None, by_clip: Mapping[int, str]
) -> dict[int, tuple[Path, RasterInput]]:
    """Title picture of every titled clip: drawn here, or the uploaded image of an older document."""
    uploaded: dict[str, Path] = {}
    rasters: dict[int, tuple[Path, RasterInput]] = {}
    for index, clip in enumerate(plan.clips):
        title = clip.title if clip.enabled else None
        if title is None:
            continue
        if title.image is not None:
            file_id = str(title.image["file_id"])
            if file_id not in uploaded:
                uploaded[file_id] = _image(ctx, title.image)
            rasters[index] = (uploaded[file_id], RasterInput(0, fitted=True))
        elif text is not None:
            drawn = text.titles[by_clip[index]]
            rasters[index] = (drawn.path, RasterInput(0, drawn.x, drawn.y))
    return rasters


def _caption_files(ctx: RunContext, plan: CompositionPlan) -> dict[int, Path]:
    uploaded: dict[str, Path] = {}
    files: dict[int, Path] = {}
    for caption in plan.captions:
        if caption.image is None:
            continue
        file_id = str(caption.image["file_id"])
        if file_id not in uploaded:
            uploaded[file_id] = _image(ctx, caption.image)
        files[caption.index] = uploaded[file_id]
    return files


def _prepare(ctx: RunContext, plan: CompositionPlan, directory: Path) -> _Job:
    """Everything that can refuse an export, and the command line of every process, before any encode."""
    job = _Job(directory)
    materials = _materials(ctx, plan)
    sources = _Sources(ctx, plan, materials)
    sources.read(*_needs(plan))
    silence = _check_extents(plan, sources)
    jobs = _text_request(plan)
    _request, by_clip, by_segment = jobs
    job.text = _draw_text(ctx, plan, jobs, directory)
    job.text_facts = _text_facts(plan, by_clip, by_segment, job.text)
    rasters = _rasters(ctx, plan, job.text, by_clip)
    caption_images = _caption_files(ctx, plan)
    for segment in plan.segments:
        drawn = job.text.caption_tracks.get(by_segment.get(segment.index, "")) if job.text else None
        track = (drawn.path, RasterInput(0, drawn.x, drawn.y)) if drawn is not None else None
        job.video.append(_segment_run(ctx, plan, segment, sources, rasters, (caption_images, track), job))
    job.audio = _audio_runs(ctx, plan, sources, job)
    files = {str(clip.source["source_id"]): clip.source["file"] for clip in plan.clips if clip.source["file"]}
    job.sources = [
        {
            "source_id": source_id,
            "file_id": files[source_id]["file_id"],
            "kind": material.info.kind,
            "duration_seconds": material.info.duration_seconds,
            "declared_colour": material.declare or None,
            # Silence (48 kHz samples) played after the end of this source's sound: see _check_extents
            "audio_silence_samples": silence.get(source_id, 0),
        }
        for source_id, material in materials.items()
    ]
    return job


def _failure(what: str, result_stderr: str, marks: Mapping[str, str], reason: str) -> ComponentError:
    detail = summarize_stderr(redact(result_stderr, marks), 600)
    return refusal("MEDIA_TOOL_FAILED", reason, what + (f"：{detail}" if detail else ""))


def _render_audio(ctx: RunContext, job: _Job, pcm: Path) -> None:
    """Mix every chunk into one float file; each chunk must deliver exactly its samples."""
    with pcm.open("xb") as handle:

        def sink(chunk: bytes) -> None:
            handle.write(chunk)

        for number, run in enumerate(job.audio):
            limits = _limits(ctx)
            before = handle.tell()
            result = run_tool(
                run.argv,
                timeout=limits.process_timeout_seconds,
                cancel=ctx.cancel_token,
                stdout_sink=sink,
                max_stderr_bytes=limits.max_stderr_bytes,
                what="FFmpeg timeline audio",
            )
            if result.returncode != 0:
                raise _failure("多軌音訊混音失敗", result.stderr, {**job.marks, **run.marks}, "audio_render_failed")
            if handle.tell() - before != run.expected * 8:
                raise _incomplete("audio_chunk_incomplete", "多軌音訊混音的取樣數與計畫不同", chunk=number)


def _encoder(
    plan: CompositionPlan, pcm: Path, output: Path, params: Mapping[str, Any], limits: MediaLimits
) -> list[str]:
    movie_timescale = math.lcm(AUDIO_RATE, plan.fps.numerator)
    if movie_timescale > 2**31 - 1:
        movie_timescale = AUDIO_RATE
    rate = f"{plan.fps.numerator}/{plan.fps.denominator}"
    return [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-nostats", "-y",
        "-protocol_whitelist", "pipe", "-f", "rawvideo", "-pixel_format", "yuv420p",
        "-video_size", f"{plan.width}x{plan.height}", "-framerate", rate,
        # The renderers deliver BT.709 limited range (OUTPUT_FORMAT). Said here, the frames reach the encoder
        # as they are; untagged, FFmpeg converts them to the output tags below and loses a code value of luma.
        *COLOUR_TAGS, "-i", "pipe:0",
        "-protocol_whitelist", "file", "-f", "f32le", "-ar", str(AUDIO_RATE), "-ac", "2", "-i", input_url(pcm),
        "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
        "-c:v", "libx264", "-preset", str(params["preset"]), "-crf", str(int(params["crf"])),
        "-pix_fmt", "yuv420p", "-r", rate, *COLOUR_TAGS,
        "-c:a", "aac", "-b:a", str(int(params["audio_bitrate"])), "-ar", str(AUDIO_RATE),
        "-fs", str(limits.max_file_bytes), "-movflags", "+faststart",
        # MP4 edit lists must represent every audio sample, including AAC priming.
        "-movie_timescale", str(movie_timescale),
        input_url(output),
    ]  # fmt: skip


def _progress_frames(result: ToolResult) -> int | None:
    """Frames a renderer reports having written (the last ``frame=`` of its ``-progress`` lines)."""
    counts = [
        int(line[6:]) for line in result.stderr.splitlines() if line.startswith("frame=") and line[6:].strip().isdigit()
    ]
    return counts[-1] if counts else None


def _finish(ctx: RunContext, encoder: ManagedProcess, marks: Mapping[str, str]) -> None:
    """Close the frame pipe and wait for the encoder, still honouring cancel and the deadline."""
    if encoder.stdin is not None:
        encoder.stdin.close()
    while encoder.poll() is None:
        ctx.check_cancelled()
        time.sleep(0.05)
    if encoder.returncode != 0:
        raise _failure("多軌匯出失敗", encoder.stderr_text(), marks, "encode_failed")


def _render_video(
    ctx: RunContext, plan: CompositionPlan, job: _Job, pcm: Path, output: Path, params: Mapping[str, Any]
) -> None:
    """Render the segments in order into the stdin pipe of one encoder; any short segment fails the export."""
    marks = {
        **job.marks,
        str(output): "<output>",
        input_url(output): "<output>",
        str(pcm): "<audio>",
        input_url(pcm): "<audio>",
    }
    encoder = ManagedProcess(
        _encoder(plan, pcm, output, params, _limits(ctx)),
        stdin=subprocess.PIPE,
        max_stderr_bytes=DEFAULT_LIMITS.max_stderr_bytes,
    )
    try:
        if encoder.stdin is None:
            raise refusal("MEDIA_TOOL_FAILED", "encode_failed", "多軌匯出無法建立編碼管線")
        for number, run in enumerate(job.video):
            limits = _limits(ctx)
            result = run_tool(
                run.argv,
                timeout=limits.process_timeout_seconds,
                cancel=ctx.cancel_token,
                stdout_fd=encoder.stdin.fileno(),
                max_stderr_bytes=limits.max_stderr_bytes,
                what="FFmpeg timeline segment",
            )
            if encoder.poll() is not None:
                raise _failure("多軌匯出失敗", encoder.stderr_text(), marks, "encode_failed")
            if result.returncode != 0:
                raise _failure("多軌畫面合成失敗", result.stderr, {**marks, **run.marks}, "segment_render_failed")
            if _progress_frames(result) != run.expected:
                raise _incomplete("segment_incomplete", "多軌匯出的片段影格數與計畫不同", segment=number)
        _finish(ctx, encoder, marks)
    finally:
        encoder.kill_tree()
        encoder.close()


def _audio_mismatch() -> ComponentError:
    return _incomplete("output_mismatch", "多軌匯出的音訊長度與計畫不同", check="audio")


def _verify(ctx: RunContext, plan: CompositionPlan, output: Path) -> tuple[int, int]:
    info = probe(output, count_frames=True, limits=_limits(ctx), cancel=ctx.cancel_token)
    if info.frame_count != plan.output_frames or (info.width, info.height) != (plan.width, plan.height):
        raise _incomplete("output_mismatch", "多軌匯出的實際影格數或尺寸與計畫不同", check="frames")
    if not info.fps_num or not info.fps_den or Fraction(info.fps_num, info.fps_den) != plan.fps:
        raise _incomplete("output_mismatch", "多軌匯出的影格率與計畫不同", check="rate")
    scanned = scan_timeline(output, limits=_limits(ctx), cancel=ctx.cancel_token)
    audio = scanned.of_type("audio")
    measured = (
        round((audio[0].end_seconds - audio[0].start_seconds) * AUDIO_RATE) if audio and audio[0].packets > 0 else None
    )
    if measured is None or abs(measured - plan.output_samples) > 1:
        raise _audio_mismatch()
    header = run_ffprobe_json(
        output,
        ["-select_streams", "a:0", "-show_entries", "stream=sample_rate,start_pts,duration_ts,time_base"],
        limits=_limits(ctx),
        cancel=ctx.cancel_token,
        max_output_bytes=16384,
    )
    streams = header.get("streams")
    if not isinstance(streams, list) or len(streams) != 1 or not isinstance(streams[0], Mapping):
        raise _audio_mismatch()
    stream = streams[0]
    try:
        rate = int(stream["sample_rate"])
        start = int(stream["start_pts"])
        duration = int(stream["duration_ts"])
        time_base = Fraction(str(stream["time_base"]))
        declared = duration * time_base * AUDIO_RATE
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise _audio_mismatch() from exc
    if rate != AUDIO_RATE or start != 0 or duration < 0 or time_base <= 0 or declared != plan.output_samples:
        raise _audio_mismatch()
    return int(info.frame_count or 0), int(declared)


def _check_time(ctx: RunContext, plan: CompositionPlan) -> None:
    needed = plan.output_frames * plan.width * plan.height / BEST_CASE_PIXELS_PER_SECOND
    if needed > ctx.remaining_seconds():
        raise refusal(
            "INPUT_TOO_LARGE",
            "export_time_budget",
            "這次匯出在呼叫期限內無法完成，請提高步驟的時間上限或縮短匯出範圍",
            needed_seconds=math.ceil(needed),
        )


def _record(plan: CompositionPlan, job: _Job, params: Mapping[str, Any], verified: tuple[int, int]) -> dict[str, Any]:
    """What this export is: ``frames`` and ``audio_samples`` as the published file was verified to hold."""
    frames, samples = verified
    record: dict[str, Any] = {
        "timeline": True,
        "timeline_version": int(plan.document["version"]),
        "frames": frames,
        "audio_samples": samples,
        "expected_frames": plan.output_frames,
        "range": {"start_frame": plan.range_start, "end_frame": plan.range_end},
        "skipped_clips": [{"clip_id": clip.clip_id, "reason": clip.reason} for clip in plan.skipped],
        "sources": job.sources,
        "segments": len(plan.segments),
        "audio_chunks": len(plan.audio_chunks),
        "colour": {"matrix": "bt709", "range": "tv"},
        "notes": ["獨立音軌混音，不自動正規化；音量過高可能削波"],
        "encoder": {
            "video": "libx264",
            "audio": "aac",
            "crf": int(params["crf"]),
            "preset": params["preset"],
            "audio_bitrate": int(params["audio_bitrate"]),
        },
    }
    if job.text_facts is not None:
        record["text"] = job.text_facts
    return record


def export_timeline(ctx: RunContext, sequence: Mapping[str, Any], params: Mapping[str, Any]) -> None:
    started = time.perf_counter_ns()
    try:
        plan = plan_composition(sequence)
        _check_time(ctx, plan)
        directory = Path(ctx.work_dir) / f"{new_id()}.timeline.d"
        owned: list[Path] = []
        try:
            directory.mkdir()  # exclusive: an existing path is never adopted or cleaned
            owned.append(directory)
            with ctx.recorder.phase("input"):
                job = _prepare(ctx, plan, directory)
            job.marks.update({str(directory): "<work>", str(Path(ctx.work_dir)): "<work>"})
            out = ctx.new_file(
                None, "video/mp4", {"kind": "final", "sequence": True, "timeline": True}, type_id="media.video.v1"
            )
            tmp = Path(ctx.work_dir) / f"{out.file_id}.timeline.mp4"
            with tmp.open("xb"):
                owned.append(tmp)
            with ctx.recorder.phase("audio"):
                _render_audio(ctx, job, directory / "mix.f32")
            with ctx.recorder.phase("encode"):
                _render_video(ctx, plan, job, directory / "mix.f32", tmp, params)
            with ctx.recorder.phase("verify"):
                verified = _verify(ctx, plan, tmp)
            ctx.check_cancelled()
            shutil.move(tmp, out.path)
            out.adopt_written()
        finally:
            for path in owned:
                if path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
    except MediaError as exc:
        raise media_failure(ctx, exc, what="多軌媒體處理失敗") from exc
    elapsed = (time.perf_counter_ns() - started) / 1e6
    ctx.recorder.record_cost(
        "concat",
        work=verified[0] * plan.width * plan.height,
        unit="pixel_frame",
        compute_ms=elapsed,
        clips=len(plan.clips),
        timeline=True,
    )
    ctx.set_output(
        "asset",
        {
            "asset_id": new_id(),
            "kind": "final",
            "file": {
                "node_id": str(ctx.recorder.node_id),
                "file_id": out.file_id,
                "size_bytes": out.size,
                "sha256": out.sha256,
                "media_type": "video/mp4",
                "metadata": out.metadata,
            },
            "source_latent": None,
            "frame_count": verified[0],
            "fps": {"num": plan.fps.numerator, "den": plan.fps.denominator},
            "width": plan.width,
            "height": plan.height,
            "complete": True,
            "actual_settings": {"concat": _record(plan, job, params, verified)},
        },
    )


__all__ = ["TIMELINE_EXPORT_FACTS", "Material", "export_timeline"]
