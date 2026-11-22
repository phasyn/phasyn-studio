"""Semantic integrity of the persisted multitrack edit, independent of media tools and UI.

JSON Schema owns shape and scalar bounds. This module checks references, source handles,
non-overlap, timebase and automation limits before a document is saved or exported. Every refusal
is ``INVALID_ARGUMENT`` with a stable ``details.reason`` (one of ``StudioTimelineRejection.reason``),
so callers that edit on behalf of an agent can report why without parsing the message.
"""

from __future__ import annotations

import math
from collections.abc import Collection, Mapping, Sequence
from fractions import Fraction
from itertools import pairwise
from typing import Any, NoReturn

from . import contracts
from .errors import ComponentError
from .timeline_limits import (
    EFFECT_BOUNDS,
    MASK_BOUNDS,
    MAX_FPS,
    MAX_SEQUENCE_FRAMES,
    MAX_SEQUENCE_SECONDS,
    MAX_SOURCE_SECONDS,
    MIN_FPS,
    MOTION_BOUNDS,
)


CHANNEL_BOUNDS = MOTION_BOUNDS
EFFECT_CHANNEL_BOUNDS = EFFECT_BOUNDS
MASK_CHANNEL_BOUNDS = MASK_BOUNDS
TIMED_SOURCE_KINDS = frozenset({"video", "audio"})
# Sources the composition makes itself: no file to render or to wait for (a text layer's title, an adjustment layer).
GENERATED_SOURCE_KINDS = frozenset({"text", "adjustment"})
PROXY_FIELDS = ("proxy", "proxy_source_sha256", "proxy_run_id", "proxy_error")
# An adjustment layer changes the composite of the tracks below it: it has no picture, clock or sound of its own, so
# its motion stays at rest but for its opacity.
ADJUSTMENT_REST = {"x": 0, "y": 0, "scale": 1, "rotation": 0, "gain_db": 0, "pan": 0}
ADJUSTMENT_TRANSITION = "調整圖層不能有轉場；請用淡化或不透明度讓效果漸入漸出"


_NORMAL_PERCENT = 100


def bezier_value(progress: float, controls: Sequence[float]) -> float:
    """Bounded cubic easing; the browser and export use the same 32 bisections."""
    if progress <= 0:
        return 0.0
    if progress >= 1:
        return 1.0
    x1, y1, x2, y2 = controls
    low, high = 0.0, 1.0
    for _ in range(32):
        at = (low + high) / 2
        x = 3 * (1 - at) ** 2 * at * x1 + 3 * (1 - at) * at**2 * x2 + at**3
        if x < progress:
            low = at
        else:
            high = at
    at = (low + high) / 2
    return 3 * (1 - at) ** 2 * at * y1 + 3 * (1 - at) * at**2 * y2 + at**3


def curve_progress(key: Mapping[str, Any], progress: float) -> float:
    """Evaluate a segment's original easing domain after an exact timeline slice."""
    progress = min(1.0, max(0.0, progress))
    kind = key["interpolation"]
    if kind == "hold":
        return 0.0 if progress < 1 else 1.0
    bounds: Sequence[float] = key.get("curve_range", [0.0, 1.0])
    low, high = bounds
    span = high - low
    if kind == "ease_in":
        bend = span / (low + high)
        return progress * (1 - bend + bend * progress)
    if kind == "ease_out":
        bend = span / ((1 - low) + (1 - high))
        return progress * (1 + bend - bend * progress)
    if kind == "ease_in_out":
        first = low * (1 - low)
        middle = (low * (1 - high) + high * (1 - low)) / 2
        last = high * (1 - high)
        weight = first + middle + last
        c1, c2 = first / weight, (first + middle) / weight
        return progress * (
            3 * c1 + progress * (3 * c2 - 6 * c1 + progress * (1 + 3 * c1 - 3 * c2))
        )
    if kind == "bezier":
        return _bezier_progress(progress, low, high, key["bezier"])
    return progress


def _bezier_progress(
    progress: float, low: float, high: float, controls: Sequence[float]
) -> float:
    span = high - low
    if progress in {0, 1}:
        return progress
    start, end = bezier_value(low, controls), bezier_value(high, controls)
    if end <= start:
        # A domain smaller than solver precision has no resolvable curvature.
        return progress
    return min(
        1.0,
        max(
            0.0,
            (bezier_value(low + span * progress, controls) - start) / (end - start),
        ),
    )


def curve_value(
    keys: Sequence[Mapping[str, Any]], frame: float, fallback: float
) -> float:
    """Evaluate validated keys at a clip-local output frame, holding both endpoints."""
    if not keys:
        return fallback
    if frame <= keys[0]["frame"]:
        return float(keys[0]["value"])
    for left, right in pairwise(keys):
        if frame < right["frame"]:
            progress = (frame - left["frame"]) / (right["frame"] - left["frame"])
            return float(
                left["value"]
                + (right["value"] - left["value"]) * curve_progress(left, progress)
            )
    return float(keys[-1]["value"])


def _invalid(reason: str, message: str, **details: Any) -> NoReturn:
    raise ComponentError(
        "INVALID_ARGUMENT", message, details={"reason": reason, **details}
    )


def processed_clip_duration(clip: Mapping[str, Any]) -> int:
    """Full effect clock before an optional output window; never shortened by a slice."""
    effects = clip.get("effects") or {}
    hold = effects.get("hold") or {}
    count = int(clip["out_frame"]) - int(clip["in_frame"])
    speed = int(effects.get("speed_percent", 100))
    return (
        max(1, count * 100 // speed)
        + int(hold.get("start", 0))
        + int(hold.get("end", 0))
    )


def clip_output_window(clip: Mapping[str, Any]) -> tuple[int, int]:
    """Read a validated half-open window in the complete processed timebase."""
    window = clip.get("output_window")
    if window is None:
        return 0, processed_clip_duration(clip)
    return int(window["start_frame"]), int(window["end_frame"])


def clip_duration(clip: Mapping[str, Any]) -> int:
    """Visible timeline duration; automation and fixed effects use the processed duration."""
    start, end = clip_output_window(clip)
    return end - start


def clip_enabled(clip: Mapping[str, Any]) -> bool:
    """A clip without the flag is enabled; a disabled clip keeps its place but is not rendered."""
    return clip.get("enabled", True) is not False


def _unique(items: list[dict[str, Any]], field: str) -> dict[str, dict[str, Any]]:
    result = {item[field]: item for item in items}
    if len(result) != len(items):
        _invalid("duplicate_id", f"剪輯文件含有重複的 {field}", field=field)
    return result


def _keyframes(
    container: Mapping[str, Any],
    bounds: Mapping[str, tuple[float, float]],
    duration: int,
) -> None:
    for channel, keys in container.get("keyframes", {}).items():
        low, high = bounds[channel]
        previous = -1
        for key in keys:
            frame = key["frame"]
            if not previous < frame <= duration:
                _invalid("keyframes", "關鍵影格必須依時間遞增且位於片段範圍內")
            if not math.isfinite(key["value"]) or not low <= key["value"] <= high:
                _invalid("keyframes", "關鍵影格數值超出屬性的允許範圍")
            curve = key.get("curve_range")
            if curve is not None and not (
                all(math.isfinite(value) for value in curve)
                and 0 <= curve[0] < curve[1] <= 1
            ):
                _invalid("keyframes", "緩動曲線區間的起點必須小於終點")
            controls = key.get("bezier")
            if key["interpolation"] == "bezier" and controls is None:
                _invalid("keyframes", "貝茲插值必須指定四個控制值")
            if controls is not None and not all(
                math.isfinite(value) and 0 <= value <= 1 for value in controls
            ):
                _invalid("keyframes", "貝茲控制值必須介於 0\N{EN DASH}1")
            previous = frame


def _automation(clip: Mapping[str, Any], duration: int) -> None:
    _keyframes(clip["motion"], MOTION_BOUNDS, duration)
    for effect in clip.get("effect_stack", []):
        bounds = EFFECT_BOUNDS[effect["kind"]]
        for channel, (low, high) in bounds.items():
            if not math.isfinite(effect[channel]) or not low <= effect[channel] <= high:
                _invalid("compositing", "效果參數超出允許範圍")
        _keyframes(effect, bounds, duration)
    mask = clip.get("mask")
    if mask is not None:
        _keyframes(mask, MASK_BOUNDS, duration)


def _effects(clip: Mapping[str, Any], duration: int) -> None:
    effects = clip.get("effects") or {}
    fade = effects.get("fade") or {}
    if (
        fade.get("video_in", 0) + fade.get("video_out", 0) > duration
        or fade.get("video_out", 0) >= duration
    ):
        _invalid("effect_range", "影像淡入淡出範圍超過片段長度")
    if fade.get("audio_in", 0) + fade.get("audio_out", 0) > duration:
        _invalid("effect_range", "音訊淡入淡出範圍超過片段長度")
    impact = effects.get("impact")
    if impact and impact["frames"] > duration:
        _invalid("effect_range", "衝擊格範圍超過片段長度")
    title = effects.get("title")
    if title:
        if not title["text"].strip():
            _invalid("text_invalid", "文字內容不能是空白")
        style = title.get("style")
        if style and any(
            not math.isfinite(style[name]) for name in ("font_size", "x", "y")
        ):
            _invalid("text_invalid", "文字樣式數值必須有限")
        end = title["end_frame"] if title["end_frame"] is not None else duration
        if not 0 <= title["start_frame"] < end <= duration:
            _invalid("effect_range", "文字範圍超過片段長度")


def _compositing(clip: Mapping[str, Any], track: Mapping[str, Any]) -> None:
    stack = clip.get("effect_stack", [])
    if len({effect["effect_id"] for effect in stack}) != len(stack):
        _invalid("compositing", "同一片段的效果識別碼不能重複")
    mask = clip.get("mask")
    if mask is not None and any(not math.isfinite(mask[name]) for name in MASK_BOUNDS):
        _invalid("compositing", "遮罩參數必須有限")
    if mask is not None and (
        mask["x"] + mask["width"] > 1 + 1e-12 or mask["y"] + mask["height"] > 1 + 1e-12
    ):
        _invalid("compositing", "遮罩範圍必須位於畫面內")
    if track["kind"] == "audio" and (
        any(effect["enabled"] for effect in stack)
        or mask is not None
        or clip.get("blend_mode", "normal") != "normal"
    ):
        _invalid("compositing", "影像效果、遮罩與混合模式只能套用於影像軌片段")


def _transition_frames(clip: Mapping[str, Any]) -> int:
    transition = (clip.get("effects") or {}).get("transition_out") or {}
    return (
        int(transition.get("frames", 0))
        if transition.get("kind", "cut") != "cut"
        else 0
    )


def _adjustment(clip: Mapping[str, Any]) -> None:
    """An adjustment clip has no picture, clock or sound of its own: what would need one is refused, with why.

    Neutral values (speed 100, no hold, frame step 1, a camera at rest, volume 0) change nothing and are kept.
    """
    motion = clip["motion"]
    keys = motion.get("keyframes", {})
    if any(
        motion[name] != rest or keys.get(name) for name, rest in ADJUSTMENT_REST.items()
    ):
        _invalid(
            "adjustment_layer",
            "調整圖層沒有自己的畫面與聲音：不能移動、縮放、旋轉或調整音量與聲像",
        )
    effects = clip.get("effects") or {}
    hold = effects.get("hold") or {}
    if (
        effects.get("speed_percent", 100) != _NORMAL_PERCENT
        or hold.get("start", 0)
        or hold.get("end", 0)
    ):
        _invalid("adjustment_layer", "調整圖層沒有自己的時間：不能變速或停格")
    camera = effects.get("camera") or {}
    still = (
        camera.get("zoom_percent", 100) == _NORMAL_PERCENT
        and not camera.get("shake_px", 0)
        and not camera.get("shake_frames", 0)
    )
    if (
        effects.get("frame_step", 1) != 1
        or not still
        or effects.get("impact")
        or effects.get("title")
    ):
        _invalid(
            "adjustment_layer",
            "調整圖層沒有自己的畫面：不能改變拍數，也不能使用鏡頭運動、衝擊格或文字",
        )
    fade = effects.get("fade") or {}
    if (
        effects.get("volume_db", 0) != 0
        or effects.get("mute")
        or fade.get("audio_in", 0)
        or fade.get("audio_out", 0)
    ):
        _invalid("adjustment_layer", "調整圖層沒有聲音：不能設定音量、靜音或聲音淡化")
    if _transition_frames(clip):
        _invalid("adjustment_layer", ADJUSTMENT_TRANSITION)


def _track_intervals(clips: list[dict[str, Any]], adjustments: Collection[str]) -> None:
    # Stable sort preserves document order for full-length transitions with equal starts.
    ordered = sorted(clips, key=lambda clip: clip["start_frame"])
    for index, clip in enumerate(ordered):
        end = clip["start_frame"] + clip_duration(clip)
        following = ordered[index + 1] if index + 1 < len(ordered) else None
        overlap = _transition_frames(clip)
        if overlap:
            _check_transition(clip, following, overlap, end, adjustments)
            # The cut a transition records lies inside its overlap: the frames on its two sides make up the overlap.
            cut = ((clip.get("effects") or {}).get("transition_out") or {}).get("cut")
            if (
                cut is not None
                and cut["outgoing"]["frames"] + cut["incoming"]["frames"] != overlap
            ):
                _invalid("transition_mismatch", "轉場的切點與重疊長度不一致")
            if index > 0 and _transition_frames(
                ordered[index - 1]
            ) + overlap > clip_duration(clip):
                _invalid("transition_too_long", "片段兩端的轉場超過片段長度")
        elif following is not None and following["start_frame"] < end:
            _invalid("overlap", "同一軌道的片段不能重疊；請使用另一軌或明確設定轉場")


def _check_transition(
    clip: Mapping[str, Any],
    following: Mapping[str, Any] | None,
    overlap: int,
    end: int,
    adjustments: Collection[str],
) -> None:
    if following is None:
        _invalid("transition_mismatch", "轉場需要同軌相鄰片段及足夠的重疊長度")
    if following["clip_id"] in adjustments:
        _invalid("adjustment_layer", ADJUSTMENT_TRANSITION)
    if overlap > min(clip_duration(clip), clip_duration(following)):
        _invalid("transition_too_long", "轉場需要同軌相鄰片段及足夠的重疊長度")
    if following["start_frame"] != end - overlap:
        _invalid("transition_mismatch", "轉場的片段重疊與指定影格數不一致")
    if clip.get("blend_mode", "normal") != following.get("blend_mode", "normal"):
        _invalid("transition_mismatch", "轉場相鄰片段必須使用相同的混合模式")


def _too_long(frames: int, fps: Fraction) -> bool:
    return (
        frames > MAX_SEQUENCE_FRAMES or Fraction(frames, 1) / fps > MAX_SEQUENCE_SECONDS
    )


def _clip(
    clip: Mapping[str, Any],
    source: Mapping[str, Any],
    track: Mapping[str, Any],
    fps: Fraction,
    *,
    for_export: bool,
) -> int:
    """Check one clip against its source and track; returns its visible end on the sequence."""
    _check_source_range(clip, source, track)
    processed = processed_clip_duration(clip)
    window_start, window_end = clip_output_window(clip)
    if not 0 <= window_start < window_end <= processed:
        _invalid("output_window", "片段輸出窗口超出完整處理範圍")
    # A short visible window must not bypass bounds on the work needed before the cut.
    if _too_long(processed, fps):
        _invalid(
            "limit_exceeded", "剪輯長度超過序列上限", max_frames=MAX_SEQUENCE_FRAMES
        )
    if source["kind"] == "text":
        title = (clip.get("effects") or {}).get("title")
        if (
            not title
            or title["start_frame"] != 0
            or title["end_frame"] not in (None, processed)
        ):
            _invalid("text_layer", "獨立文字圖層必須保留完整片段文字")
    if source["kind"] == "adjustment":
        _adjustment(clip)
    _automation(clip, processed)
    _effects(clip, processed)
    _compositing(clip, track)
    if (
        for_export
        and clip_enabled(clip)
        and source["kind"] not in GENERATED_SOURCE_KINDS
        and source["file"] is None
    ):
        _invalid(
            "not_rendered",
            "時間軸仍有尚未渲染的素材，請完成渲染後再匯出",
            source_id=source["source_id"],
        )
    return int(clip["start_frame"]) + window_end - window_start


def _check_source_range(
    clip: Mapping[str, Any], source: Mapping[str, Any], track: Mapping[str, Any]
) -> None:
    if not 0 <= clip["in_frame"] < clip["out_frame"] <= source["duration_frames"]:
        _invalid("source_range", "片段入出點超出原始素材範圍")
    if source["kind"] == "adjustment" and track["kind"] != "video":
        _invalid("track_kind", "調整圖層只能放在影像軌")
    if track["kind"] == "video" and source["kind"] == "audio":
        _invalid("track_kind", "純音訊素材不能放入影像軌")
    if track["kind"] == "audio" and not source["has_audio"]:
        _invalid("track_kind", "素材沒有音訊，不能放入音軌")


def _source(source: Mapping[str, Any], doc: Mapping[str, Any], fps: Fraction) -> None:
    if (
        source["kind"] in TIMED_SOURCE_KINDS
        and Fraction(source["duration_frames"], 1) / fps > MAX_SOURCE_SECONDS
    ):
        _invalid(
            "limit_exceeded", "素材長度超過 24 小時上限", source_id=source["source_id"]
        )
    if source["kind"] in GENERATED_SOURCE_KINDS and (
        source["file"] is not None
        or source["has_audio"]
        or any(
            source.get(name) is not None
            for name in ("shot_id", "take_id", "library_id", *PROXY_FIELDS)
        )
    ):
        if source["kind"] == "adjustment":
            _invalid(
                "adjustment_layer", "調整圖層素材不能引用媒體檔案、代理、鏡頭或音訊"
            )
        _invalid("text_layer", "獨立文字素材不能引用媒體檔案、代理、鏡頭或音訊")
    proxy = source.get("proxy")
    if proxy is not None:
        if source.get("proxy_source_sha256") != (source.get("file") or {}).get(
            "sha256"
        ):
            _invalid("proxy", "代理媒體的原始來源已變更")
        if not source["file"] or not proxy["complete"] or proxy["fps"] != doc["fps"]:
            _invalid("proxy", "代理媒體必須完整且與原始素材使用同一時間基準")
        if proxy["frame_count"] != source["duration_frames"]:
            _invalid("proxy", "代理媒體影格數與原始素材不一致")


def validate_timeline(value: Any, *, for_export: bool = False) -> None:
    """Reject invalid edits atomically; never clamp values or silently drop a clip.

    ``for_export`` also requires media for every enabled clip and a non-empty sequence. Whether text
    layers are ready is the exporter's question, not the document's.
    """
    contracts.validate("StudioTimeline", value, what="多軌剪輯文件")
    doc: dict[str, Any] = value
    fps = Fraction(doc["fps"]["num"], doc["fps"]["den"])
    if not MIN_FPS <= fps <= MAX_FPS:
        _invalid("fps", "剪輯影格率必須介於 1\N{EN DASH}240 fps")
    sources = _unique(doc["sources"], "source_id")
    tracks = _unique(doc["tracks"], "track_id")
    _unique(doc["clips"], "clip_id")
    _unique(doc["captions"], "caption_id")
    _unique(doc["markers"], "marker_id")
    area = doc.get("work_area")
    if area is not None and area["start_frame"] >= area["end_frame"]:
        _invalid("work_area", "序列出點必須晚於入點")
    total = 0
    for clip in doc["clips"]:
        source = sources.get(clip["source_id"])
        track = tracks.get(clip["track_id"])
        if source is None or track is None:
            _invalid(
                "reference_missing",
                "片段引用的素材或軌道不存在",
                clip_id=clip["clip_id"],
            )
        total = max(total, _clip(clip, source, track, fps, for_export=for_export))
    _check_tracks(doc, tracks, sources)
    total = _caption_end(doc["captions"], total)
    if _too_long(total, fps):
        _invalid(
            "limit_exceeded", "剪輯長度超過序列上限", max_frames=MAX_SEQUENCE_FRAMES
        )
    if for_export and total <= 0:
        _invalid("empty_timeline", "時間軸沒有可匯出的內容")
    for source in sources.values():
        _source(source, doc, fps)


def _caption_end(captions: Sequence[Mapping[str, Any]], total: int) -> int:
    for caption in captions:
        if caption["end_frame"] <= caption["start_frame"]:
            _invalid("caption_range", "字幕出點必須晚於入點")
        if not caption["text"].strip():
            _invalid("text_invalid", "字幕內容不能是空白")
        total = max(total, caption["end_frame"])
    return total


def _check_tracks(
    doc: dict[str, Any], tracks: Mapping[str, Any], sources: Mapping[str, Any]
) -> None:
    adjustments = {
        clip["clip_id"]
        for clip in doc["clips"]
        if sources[clip["source_id"]]["kind"] == "adjustment"
    }
    for track_id in tracks:
        _track_intervals(
            [clip for clip in doc["clips"] if clip["track_id"] == track_id], adjustments
        )
