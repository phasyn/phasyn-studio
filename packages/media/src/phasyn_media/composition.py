"""Bounded, deterministic planning of a multitrack export (pure: no process, no file access).

Coordinates use sequence frames. Sources are normalized to the sequence rate before trim. A clip
keeps its complete processed clock (speed, holds, fades, keys); its output window, a render range
and the segments of an export only select frames of that clock, they never restart it.

What the plan decides before anything is read or encoded:

- whether the document can be exported at all: the timeline validator of ``phasyn_components``
  (the one the Controller saves and exports with) checks references, ranges, effect lengths, the
  sequence and source bounds and that every enabled clip has its media, with its stable reasons;
- which clips are exported: a disabled clip, a muted track and a track hidden by solo give no
  picture and no sound but keep their place and the sequence length (``skipped`` names them);
- which text the exporter draws itself (titles, text layers, captions) and which uploaded image of
  an older document is still used;
- which clips are adjustment layers: they read no file, their picture is the composite of the
  tracks below them (``composition_video``);
- the segments: an export is rendered as consecutive frame ranges, each by one bounded process
  that opens only the clips it shows, so the number of clips and the length of a sequence are not
  limited by one process. A segment never holds more than ``SEGMENT_MAX_INPUTS`` inputs;
- every refusal, with a stable ``details.reason``.

Tracks composite bottom-to-top. Solo is evaluated independently for video and audio.
"""

from __future__ import annotations

import json
from bisect import bisect_right
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from fractions import Fraction
from functools import partial
from typing import Any, override

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.timeline import (
    clip_enabled,
    clip_output_window,
    validate_timeline,
)

from .effects import ClipEffects, PlannedClip, clip_frames, parse_effects, samples_for
from .limits import DEFAULT_LIMITS
from .text import TextSpec, text_direction_problem


_MAX_FPS = 240


MAX_GRAPH_BYTES = 1024 * 1024
# One renderer process opens at most this many files (clips, title images, uploaded caption images
# and one caption track). 16 tracks with a transition on each need 32 clips at one frame.
SEGMENT_MAX_INPUTS = 64
# An open clip keeps decoded and converted frames in memory: a renderer is planned to stay near this
# much for its inputs (measured: about 45 bytes per canvas pixel and input), so a large canvas gets
# segments with fewer clips. What one frame shows at once is always allowed up to SEGMENT_MAX_INPUTS.
SEGMENT_INPUT_BYTES = 2 * 1024**3
SEGMENT_INPUT_BYTES_PER_PIXEL = 45
# Frames of one segment: about 25 s of 1920x1080 at 24 fps, fewer for larger pictures.
SEGMENT_PIXEL_FRAMES = 1920 * 1080 * 600
SEGMENT_MAX_FRAMES = 1200
# Audio is cheap per frame: a chunk is bounded by the files it opens only.
AUDIO_CHUNK_MAX_INPUTS = 64


def refusal(code: str, reason: str, message: str, **details: Any) -> ComponentError:
    """An export refusal: ``details.reason`` is the stable identifier, the message is for people."""
    return ComponentError(code, message, details={"reason": reason, **details})


def invalid(reason: str, message: str, **details: Any) -> ComponentError:
    """Build a media validation error for the specified field."""
    return refusal("INVALID_ARGUMENT", reason, message, **details)


class BoundedGraph(list[str]):
    """Filter statements of one process; growth is refused while compiling, before strings accumulate."""

    def __init__(self) -> None:
        """Set the maximum size and line count of the filter graph."""
        super().__init__()
        self._size = 0

    @override
    def append(self, item: str) -> None:
        """Append one graph statement within the configured bounds."""
        self._size += len(item.encode()) + 1
        if self._size > MAX_GRAPH_BYTES:
            raise refusal(
                "INPUT_TOO_LARGE", "graph_too_large", "時間軸效果運算式超過大小限制"
            )
        super().append(item)


@dataclass(frozen=True)
class TitlePlan:
    """A clip title: drawn by the exporter (``spec``) or the uploaded raster of an older document (``image``)."""

    start_frame: int
    end_frame: int  # exclusive, in the complete processed clip
    spec: TextSpec | None
    image: Mapping[str, Any] | None


@dataclass(frozen=True)
class CaptionPlan:
    """Caption placement and timing in the output composition."""

    index: int
    start: int
    end: int
    spec: TextSpec | None
    image: Mapping[str, Any] | None


@dataclass(frozen=True)
class CompositionClip:
    """A source-backed clip positioned on the composition timeline."""

    index: int  # position in timeline.clips; messages count from 1
    document: Mapping[str, Any]
    source: Mapping[str, Any]
    track: Mapping[str, Any]
    plan: PlannedClip  # complete processed duration; its start is the visible placement
    window_start: int
    window_end: int
    enabled: bool = True  # False: a disabled clip kept only as the silent, transparent end of a transition
    title: TitlePlan | None = None

    @property
    def visible_frames(self) -> int:
        """Return the number of frames presented by this clip."""
        return self.window_end - self.window_start

    @property
    def start(self) -> int:
        """Return the first frame on the timeline."""
        return self.plan.start_frame

    @property
    def end(self) -> int:
        """Return the exclusive end frame on the timeline."""
        return self.plan.start_frame + self.visible_frames

    @property
    def is_video(self) -> bool:
        """Return whether the input contains moving video."""
        return bool(self.track["kind"] == "video")

    @property
    def generated(self) -> bool:
        """A text layer: its picture is the title on a transparent frame, it has no media file."""
        return bool(self.source["kind"] == "text")

    @property
    def adjustment(self) -> bool:
        """An adjustment layer: no media file and no picture of its own; its chain runs on the composite below it."""
        return bool(self.source["kind"] == "adjustment")

    @property
    def media_file(self) -> bool:
        """The clip reads a file (not a text layer, not an adjustment layer)."""
        return not (self.generated or self.adjustment)

    @property
    def still(self) -> bool:
        """Return whether the source is a still image."""
        return bool(self.source["kind"] in ("image", "text"))


@dataclass(frozen=True)
class ClipSlice:
    """The part of one video clip a segment shows: processed frames ``[first, end)``, shown from ``at``."""

    clip: int  # index into CompositionPlan.clips
    first: int
    end: int
    at: int  # segment-local frame of ``first``

    @property
    def frames(self) -> int:
        """Return the length of the interval in frames."""
        return self.end - self.first


@dataclass(frozen=True)
class Segment:
    """A contiguous timeline interval with its participating clips."""

    index: int
    start: int
    end: int
    slices: tuple[ClipSlice, ...]  # compositing order
    captions: tuple[int, ...]  # indices into CompositionPlan.captions

    @property
    def frames(self) -> int:
        """Return the length of the interval in frames."""
        return self.end - self.start


@dataclass(frozen=True)
class AudioChunk:
    """Audio inputs and sample boundaries for one interval."""

    index: int
    start: int  # sequence frames
    end: int
    clips: tuple[int, ...]  # indices into CompositionPlan.clips


@dataclass(frozen=True)
class SkippedClip:
    """A clip of the document that gives no picture and no sound: ``disabled``, ``track_muted`` or ``not_solo``."""

    clip_id: str
    reason: str


@dataclass(frozen=True)
class CompositionPlan:
    """Resolved video segments, audio chunks, and output timing."""

    document: Mapping[str, Any]
    clips: tuple[CompositionClip, ...]
    captions: tuple[CaptionPlan, ...]
    groups: tuple[tuple[int, ...], ...]  # clips joined by transitions, in time order
    width: int
    height: int
    fps: Fraction
    frames: int
    samples: int
    fit: str | None
    range_start: int
    range_end: int
    segments: tuple[Segment, ...] = ()
    audio_chunks: tuple[AudioChunk, ...] = ()
    skipped: tuple[SkippedClip, ...] = ()  # in document order

    @property
    def output_frames(self) -> int:
        """Return the total number of output video frames."""
        return self.range_end - self.range_start

    @property
    def output_samples(self) -> int:
        """Return the total number of output audio samples."""
        return samples_for(self.output_frames, self.fps)


# --------------------------------------------------------------------------- text and uploaded rasters


def _json_value(value: Any) -> Any:
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _browser_key(values: Sequence[Any]) -> str:
    """``JSON.stringify`` of the editor's layout key (numbers without a trailing ``.0``)."""
    return json.dumps(
        [_json_value(item) for item in values],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def title_image_key(title: Mapping[str, Any], width: int, height: int) -> str:
    style = title.get("style")
    head = [title["text"], title["position"], title["size"], width, height]
    if not style:
        return _browser_key(["title.v1", *head])
    names = ("font_family", "font_size", "font_weight", "color", "align", "x", "y")
    return _browser_key(["title.v2", *head, *(style[name] for name in names)])


def caption_image_key(caption: Mapping[str, Any], width: int, height: int) -> str:
    return _browser_key(
        [caption["text"], caption["position"], caption["size"], width, height]
    )


def _uploaded(document: Mapping[str, Any], key: str) -> Mapping[str, Any] | None:
    """The uploaded raster when it still belongs to this text and size; a stale one is drawn again instead."""
    image = document.get("image")
    if not isinstance(image, Mapping):
        return None
    recorded = document.get("image_key")
    return image if recorded is None or recorded == key else None


def _text_spec(document: Mapping[str, Any], what: str) -> TextSpec:
    if text_direction_problem(document["text"]):
        raise invalid(
            "text_direction_unsupported",
            f"{what}含有由右至左書寫的文字，匯出目前無法排版",
        )
    return TextSpec.from_document(document)


def _title(
    item: Mapping[str, Any], number: int, length: int, width: int, height: int
) -> TitlePlan | None:
    """The title of a clip; its range was checked by the validator against the complete processed clip."""
    title = (item.get("effects") or {}).get("title")
    if not title:
        return None
    end = title["end_frame"] if title.get("end_frame") is not None else length
    image = _uploaded(title, title_image_key(title, width, height))
    media_type = (
        str((image or {}).get("media_type") or "").split(";")[0].strip().lower()
    )
    if image is not None and media_type != "image/png":
        raise invalid(
            "text_image_invalid", f"時間軸片段 {number} 的文字圖層必須是 PNG 圖片"
        )
    spec = (
        None if image is not None else _text_spec(title, f"時間軸片段 {number} 的文字")
    )
    return TitlePlan(int(title["start_frame"]), int(end), spec, image)


def _caption(
    index: int, caption: Mapping[str, Any], width: int, height: int
) -> CaptionPlan:
    image = _uploaded(caption, caption_image_key(caption, width, height))
    spec = None if image is not None else _text_spec(caption, f"字幕 {index + 1} ")
    return CaptionPlan(
        index, int(caption["start_frame"]), int(caption["end_frame"]), spec, image
    )


# --------------------------------------------------------------------------- clips


def _effects_without_title(item: Mapping[str, Any], index: int) -> ClipEffects | None:
    """Legacy effect parsing owns everything but the title: a timeline title needs no uploaded image."""
    effects = {
        key: value
        for key, value in (item.get("effects") or {}).items()
        if key != "title"
    }
    return parse_effects(effects or None, path=f"timeline.clips[{index}].effects")


def _clip(
    index: int,
    item: Mapping[str, Any],
    source: Mapping[str, Any],
    track: Mapping[str, Any],
    geometry: tuple[int, int, Fraction],
) -> CompositionClip:
    width, height, fps = geometry
    effects = _effects_without_title(item, index)
    length = clip_frames(item["out_frame"] - item["in_frame"], effects)
    window_start, window_end = clip_output_window(item)
    enabled = clip_enabled(item)
    # A text layer always has its title (the validator refuses one without); only enabled clips draw.
    title = (
        _title(item, index + 1, length, width, height)
        if enabled and track["kind"] == "video"
        else None
    )
    planned = PlannedClip(
        index,
        item["out_frame"] - item["in_frame"],
        length,
        item["start_frame"],
        samples_for(length, fps),
        effects,
        None,
    )
    return CompositionClip(
        index, item, source, track, planned, window_start, window_end, enabled, title
    )


def _transition(clip: CompositionClip) -> int:
    effects = clip.plan.effects
    return effects.transition_out.frames if effects and effects.transition_out else 0


def _groups(clips: Sequence[CompositionClip]) -> list[list[int]]:
    """Chains of clips joined by transitions. ``clips`` are sorted by track, then time."""
    groups: list[list[int]] = []
    for index, item in enumerate(clips):
        previous = clips[index - 1] if index else None
        overlap = _transition(previous) if previous else 0
        if previous is None or overlap == 0:
            groups.append([index])
            continue
        if previous.document["track_id"] != item.document["track_id"]:
            raise invalid("transition_invalid", "轉場需要同軌相鄰片段")
        if item.start != previous.end - overlap:
            raise invalid("transition_invalid", "轉場的片段位置與重疊長度不同")
        groups[-1].append(index)
    if clips and _transition(clips[-1]):
        raise invalid("transition_invalid", "最後一個片段不能設定出場轉場")
    return groups


def _exported(
    clips: list[CompositionClip],
) -> tuple[tuple[CompositionClip, ...], tuple[tuple[int, ...], ...]]:
    """Drop disabled clips, except where one is the other end of an exported clip's transition."""
    kept: list[CompositionClip] = []
    groups: list[tuple[int, ...]] = []
    for group in _groups(clips):
        if not any(clips[index].enabled for index in group):
            continue
        groups.append(tuple(range(len(kept), len(kept) + len(group))))
        kept.extend(clips[index] for index in group)
    return tuple(kept), tuple(groups)


def _validate(sequence: Mapping[str, Any]) -> Mapping[str, Any]:
    """The request's shape, then the timeline as the Controller exports it (media for every enabled clip)."""
    try:
        contracts.validate("MediaSequence", sequence, what="sequence")
        document: Mapping[str, Any] = sequence["timeline"]
        validate_timeline(document, for_export=True)
    except ComponentError as exc:
        # The validator's own reason, when it gives one, is the more precise identifier.
        details = {"reason": "timeline_invalid", **exc.details}
        raise ComponentError(exc.code, exc.message, details=details) from exc
    return document


def _geometry(
    sequence: Mapping[str, Any], document: Mapping[str, Any]
) -> tuple[int, int, Fraction]:
    fps = Fraction(document["fps"]["num"], document["fps"]["den"])
    if fps != Fraction(sequence["fps"]["num"], sequence["fps"]["den"]):
        raise invalid("fps_mismatch", "時間軸與匯出影格率不同")
    width, height = int(sequence["width"]), int(sequence["height"])
    limits = DEFAULT_LIMITS
    if not 1 <= fps <= _MAX_FPS or width % 2 or height % 2:
        raise invalid(
            "output_size_invalid", "匯出尺寸需為正偶數，影格率需介於 1\u2013240"
        )
    if (
        width * height > limits.max_pixels
        or width > limits.max_width
        or height > limits.max_height
    ):
        raise refusal("INPUT_TOO_LARGE", "output_too_large", "多軌匯出尺寸超過媒體限制")
    return width, height, fps


def _render_range(sequence: Mapping[str, Any], total: int) -> tuple[int, int]:
    render_range = sequence.get("render_range")
    start = int(render_range["start_frame"]) if render_range else 0
    end = int(render_range["end_frame"]) if render_range else total
    if not 0 <= start < end <= total:
        raise invalid("render_range_invalid", "匯出範圍必須位於序列內且出點晚於入點")
    return start, end


def _skipped_reason(
    item: Mapping[str, Any], track: Mapping[str, Any], solo: Mapping[str, bool]
) -> str | None:
    """Why a clip gives no picture and no sound, or ``None`` when it is exported."""
    if track["muted"]:
        return "track_muted"
    if solo[track["kind"]] and not track["solo"]:
        return "not_solo"
    return None if clip_enabled(item) else "disabled"


def plan_composition(sequence: Mapping[str, Any]) -> CompositionPlan:
    """Validate a ``media.sequence.v1`` timeline value and plan its export; every refusal happens here."""
    document = _validate(sequence)
    geometry = _geometry(sequence, document)
    width, height, fps = geometry
    sources = {source["source_id"]: source for source in document["sources"]}
    tracks = {track["track_id"]: track for track in document["tracks"]}
    order = {
        track["track_id"]: position for position, track in enumerate(document["tracks"])
    }
    solo = {
        kind: any(t["solo"] for t in document["tracks"] if t["kind"] == kind)
        for kind in ("video", "audio")
    }
    clips: list[CompositionClip] = []
    skipped: list[SkippedClip] = []
    total = 0
    for index, item in enumerate(document["clips"]):
        track = tracks[item["track_id"]]
        clip = _clip(index, item, sources[item["source_id"]], track, geometry)
        total = max(total, clip.end)
        reason = _skipped_reason(item, track, solo)
        if reason is not None:
            skipped.append(SkippedClip(str(item["clip_id"]), reason))
        if reason in (None, "disabled"):
            clips.append(
                clip
            )  # a disabled clip may still be the silent, transparent end of a transition
    captions = tuple(
        _caption(index, caption, width, height)
        for index, caption in enumerate(document["captions"])
    )
    # The validator refused an empty sequence and one longer than the sequence bounds.
    total = max([total, *(caption.end for caption in captions)])
    range_start, range_end = _render_range(sequence, total)
    clips.sort(key=lambda c: (order[c.document["track_id"]], c.start, c.index))
    exported, groups = _exported(clips)
    plan = CompositionPlan(
        document,
        exported,
        captions,
        groups,
        width,
        height,
        fps,
        total,
        samples_for(total, fps),
        sequence.get("fit"),
        range_start,
        range_end,
        skipped=tuple(skipped),
    )
    return replace(
        plan, segments=plan_segments(plan), audio_chunks=plan_audio_chunks(plan)
    )


# --------------------------------------------------------------------------- frame arithmetic of a clip


def retimed_frames(clip: CompositionClip) -> int:
    """Frames of the clip between its holds (the source after speed)."""
    effects = clip.plan.effects
    return clip.plan.frames - (effects.hold.start + effects.hold.end if effects else 0)


def retimed_index(clip: CompositionClip, frame: int) -> int:
    """The retimed frame a processed frame shows: holds repeat the first and the last one."""
    effects = clip.plan.effects
    head = effects.hold.start if effects else 0
    return min(max(frame - head, 0), retimed_frames(clip) - 1)


def stepped_index(clip: CompositionClip, retimed: int) -> int:
    """Limited animation: every ``frame_step`` retimed frames show the first of them."""
    effects = clip.plan.effects
    step = effects.frame_step if effects else 1
    return retimed - retimed % step


def source_index(clip: CompositionClip, frame: int) -> int:
    """The source frame (sequence rate, counted from the first source frame) a processed frame shows."""
    effects = clip.plan.effects
    speed = effects.speed_percent if effects else 100
    return (
        int(clip.document["in_frame"])
        + stepped_index(clip, retimed_index(clip, frame)) * speed // 100
    )


# --------------------------------------------------------------------------- segments


def _still_motion(motion: Mapping[str, Any]) -> bool:
    """True when the clip is neither moved, scaled, rotated nor made transparent at any frame."""
    rest = {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1}
    keys = motion.get("keyframes", {})
    return all(
        motion[name] == value and all(k["value"] == value for k in keys.get(name, []))
        for name, value in rest.items()
    )


def plain_clip(plan: CompositionPlan, index: int) -> bool:
    """True when nothing is drawn on or done to the picture of a video clip except timing.

    Such a clip can stay in the pixel format of its source: when its picture is opaque and fills the
    canvas (which only the file can tell), a segment of plain clips is composed without any RGB conversion.
    """
    clip = plan.clips[index]
    effects = clip.plan.effects
    untouched = effects is None or (
        effects.fade.video_in == 0
        and effects.fade.video_out == 0
        and effects.color.is_identity
        and effects.camera.is_identity
        and effects.impact is None
    )
    document = clip.document
    return (
        clip.enabled
        and clip.source["kind"] == "video"
        and clip.title is None
        and untouched
        and document.get("mask") is None
        and not any(effect["enabled"] for effect in document.get("effect_stack", []))
        and document.get("blend_mode", "normal") == "normal"
        and _still_motion(document["motion"])
        and all(len(group) == 1 for group in plan.groups if index in group)
    )


def title_in_slice(clip: CompositionClip, first: int, end: int) -> bool:
    """True when processed frames ``[first, end)`` show the clip's title (a text layer always does)."""
    title = clip.title
    return title is not None and (
        clip.generated or (title.start_frame < end and title.end_frame > first)
    )


def _clip_inputs(clip: CompositionClip) -> int:
    """Files one exported clip adds to a process: its media, and its title raster on a video clip."""
    if not clip.enabled:
        return 0
    return (1 if clip.media_file else 0) + (1 if clip.title is not None else 0)


def _segment_inputs(
    plan: CompositionPlan, videos: Sequence[CompositionClip], start: int, end: int
) -> int:
    count = sum(
        _clip_inputs(clip) for clip in videos if clip.start < end and clip.end > start
    )
    shown = [
        caption
        for caption in plan.captions
        if caption.start < end and caption.end > start
    ]
    return (
        count
        + sum(caption.image is not None for caption in shown)
        + any(c.spec is not None for c in shown)
    )


def _longest(
    start: int, limit: int, cap: int, inputs: Callable[[int, int], int]
) -> int | None:
    """The largest end in ``(start, limit]`` whose span opens at most ``cap`` inputs (a longer span opens more)."""
    if inputs(start, start + 1) > cap:
        return None
    low, high = start + 1, limit
    while low < high:
        middle = (low + high + 1) // 2
        low, high = (
            (middle, high) if inputs(start, middle) <= cap else (low, middle - 1)
        )
    return low


def _snap(start: int, end: int, limit: int, edges: Sequence[int]) -> int:
    """Prefer a cut between clips in the later half of the span: fewer clips are opened twice."""
    if end >= limit:
        return end
    position = bisect_right(edges, end)
    edge = edges[position - 1] if position else start
    return edge if edge > start + (end - start) // 2 else end


def _slices(plan: CompositionPlan, start: int, end: int) -> tuple[ClipSlice, ...]:
    slices: list[ClipSlice] = []
    for index, clip in enumerate(plan.clips):
        if not clip.is_video or clip.start >= end or clip.end <= start:
            continue
        shown_from, shown_to = max(clip.start, start), min(clip.end, end)
        first = clip.window_start + shown_from - clip.start
        slices.append(
            ClipSlice(index, first, first + shown_to - shown_from, shown_from - start)
        )
    return tuple(slices)


def segment_frames(width: int, height: int) -> int:
    """Return the number of frames allocated to a segment."""
    return max(1, min(SEGMENT_MAX_FRAMES, SEGMENT_PIXEL_FRAMES // (width * height)))


def segment_inputs(width: int, height: int) -> int:
    """Inputs a renderer may open beyond what a single frame needs: the memory plan of one process."""
    return max(
        1,
        min(
            SEGMENT_MAX_INPUTS,
            SEGMENT_INPUT_BYTES // (SEGMENT_INPUT_BYTES_PER_PIXEL * width * height),
        ),
    )


def plan_segments(plan: CompositionPlan) -> tuple[Segment, ...]:
    """Cut the render range into consecutive frame ranges that each stay inside the input bound."""
    videos = [clip for clip in plan.clips if clip.is_video]
    edges = sorted({edge for clip in videos for edge in (clip.start, clip.end)})
    budget = segment_frames(plan.width, plan.height)
    preferred = segment_inputs(plan.width, plan.height)
    segments: list[Segment] = []
    position = plan.range_start
    while position < plan.range_end:
        limit = min(plan.range_end, position + budget)
        # What this frame shows at once must be opened together; beyond that the memory plan decides.
        allowed = min(
            SEGMENT_MAX_INPUTS,
            max(preferred, _segment_inputs(plan, videos, position, position + 1)),
        )
        end = _longest(position, limit, allowed, partial(_segment_inputs, plan, videos))
        if end is None:
            raise refusal(
                "INPUT_TOO_LARGE",
                "too_many_layers",
                f"時間軸第 {position} 影格同時顯示的片段、標題與字幕圖層超過 {SEGMENT_MAX_INPUTS} 個",
                frame=position,
                limit=SEGMENT_MAX_INPUTS,
            )
        end = _snap(position, end, plan.range_end, edges)
        captions = tuple(
            c.index for c in plan.captions if c.start < end and c.end > position
        )
        segments.append(
            Segment(
                len(segments), position, end, _slices(plan, position, end), captions
            )
        )
        position = end
    return tuple(segments)


def plan_audio_chunks(plan: CompositionPlan) -> tuple[AudioChunk, ...]:
    """Cut the render range so that no audio process opens more than ``AUDIO_CHUNK_MAX_INPUTS`` files."""
    audios = [
        (index, clip) for index, clip in enumerate(plan.clips) if not clip.is_video
    ]

    def members(start: int, end: int) -> tuple[int, ...]:
        return tuple(
            index for index, clip in audios if clip.start < end and clip.end > start
        )

    def inputs(start: int, end: int) -> int:
        return sum(plan.clips[index].enabled for index in members(start, end))

    chunks: list[AudioChunk] = []
    position = plan.range_start
    while position < plan.range_end:
        end = _longest(position, plan.range_end, AUDIO_CHUNK_MAX_INPUTS, inputs)
        if end is None:
            raise refusal(
                "INPUT_TOO_LARGE",
                "too_many_layers",
                f"時間軸第 {position} 影格同時播放的音訊片段超過 {AUDIO_CHUNK_MAX_INPUTS} 個",
                frame=position,
                limit=AUDIO_CHUNK_MAX_INPUTS,
            )
        chunks.append(AudioChunk(len(chunks), position, end, members(position, end)))
        position = end
    return tuple(chunks)


def chunk_samples(plan: CompositionPlan, start: int, end: int) -> tuple[int, int]:
    """48 kHz sample range of a frame range, measured from the render range so that chunks join exactly."""
    origin = samples_for(plan.range_start, plan.fps)
    last = origin + plan.output_samples
    first = samples_for(start, plan.fps)
    return first, (last if end >= plan.range_end else samples_for(end, plan.fps))


__all__ = [
    "AUDIO_CHUNK_MAX_INPUTS",
    "MAX_GRAPH_BYTES",
    "SEGMENT_MAX_INPUTS",
    "AudioChunk",
    "BoundedGraph",
    "CaptionPlan",
    "ClipSlice",
    "CompositionClip",
    "CompositionPlan",
    "Segment",
    "SkippedClip",
    "TitlePlan",
    "chunk_samples",
    "invalid",
    "plain_clip",
    "plan_audio_chunks",
    "plan_composition",
    "plan_segments",
    "refusal",
    "retimed_frames",
    "retimed_index",
    "segment_frames",
    "segment_inputs",
    "source_index",
    "stepped_index",
    "title_in_slice",
]
