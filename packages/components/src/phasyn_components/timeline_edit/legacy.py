"""Shot-level trims and effects (the edit state before the timeline) moved into timeline clips.

The twin of the editor's ``shotSequence.ts`` and of the clip-building half of its ``sources.ts``, with two decided
differences. A value the timeline cannot hold (a fade longer than the clip, a transition without a following clip,
a range that does not survive a frame-rate conversion) is brought to the nearest valid value and written down as a
note instead of refusing the whole project. And each clip gets the effects that act on it: picture effects go to
the video clip, sound effects to the audio clip, timing and the transition to both, and ``volume_db`` becomes the
audio clip's ``motion.gain_db`` (the composition adds the two, so the level is the same).
"""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from ..timeline_limits import (
    MAX_FADE_FRAMES,
    MAX_FRAME_STEP,
    MAX_HOLD_FRAMES,
    MAX_IMPACT_FRAMES,
    MAX_MIGRATION_NOTE_CHARS,
    MAX_MIGRATION_NOTES,
    MAX_NAME_CHARS,
    MAX_SEQUENCE_FRAMES,
    MAX_SEQUENCE_SECONDS,
    MAX_SPEED_PERCENT,
    MAX_TEXT_CHARS,
    MAX_TRANSITION_FRAMES,
    MAX_VOLUME_DB,
    MIN_SPEED_PERCENT,
    MIN_VOLUME_DB,
)
from .model import (
    WIPE_SOFTNESS_MAX,
    Doc,
    active_transition,
    clip_duration,
    clip_end,
    default_motion,
    retimed_frames,
    transition_value,
)
from .shots import (
    H3_FPS,
    active_take,
    library_source,
    rate,
    shot_name,
    shot_source,
    unique_id,
)
from .text import round_half_up


FADE_KEYS = ("video_in", "video_out", "audio_in", "audio_out")
IMPACT_STYLES = ("negative", "white", "black")
VIDEO_EFFECTS = ("color", "frame_step", "camera", "impact", "title")
TIMING_EFFECTS = ("speed_percent", "hold")
ZOOM_RANGE = (100, 200)
MAX_SHAKE_PX = 64
MAX_SHAKE_FRAMES = 1000
ORIGINAL_AUDIO_UNUSABLE = "原影片音軌資料不完整，時間軸改用各鏡頭自己的聲音。"


_NORMAL_PERCENT = 100


def _clamp_int(value: Any, low: int, high: int) -> int:
    if (
        not isinstance(value, int | float)
        or isinstance(value, bool)
        or not math.isfinite(value)
    ):
        return low
    return min(high, max(low, round_half_up(value)))


def _round_to(value: float, digits: int) -> float:
    scale = 10**digits
    rounded = round_half_up(value * scale) / scale
    return int(rounded) if rounded == int(rounded) else rounded


def _normalized_color(color: Mapping[str, Any]) -> Doc | None:
    value: Doc = {
        "brightness": _round_to(min(1, max(-1, color.get("brightness", 0))), 3),
        "contrast": _round_to(min(3, max(0, color.get("contrast", 1))), 3),
        "saturation": _round_to(min(3, max(0, color.get("saturation", 1))), 3),
    }
    if color.get("invert"):
        value["invert"] = True
    plain = (
        value["brightness"] == 0 and value["contrast"] == 1 and value["saturation"] == 1
    )
    return None if plain and "invert" not in value else value


def _normalized_camera(camera: Mapping[str, Any]) -> Doc:
    value: Doc = {}
    zoom = _clamp_int(camera.get("zoom_percent", ZOOM_RANGE[0]), *ZOOM_RANGE)
    shake = _clamp_int(camera.get("shake_px", 0), 0, MAX_SHAKE_PX)
    frames = _clamp_int(camera.get("shake_frames", 0), 0, MAX_SHAKE_FRAMES)
    if zoom != ZOOM_RANGE[0]:
        value["zoom_percent"] = zoom
    if shake > 0 and frames > 0:
        value["shake_px"] = shake
        value["shake_frames"] = frames
    return value


def _normalized_title(title: Mapping[str, Any]) -> Doc:
    start = _clamp_int(title["start_frame"], 0, MAX_SEQUENCE_FRAMES)
    end = title["end_frame"]
    if end is not None:
        end = max(start + 1, _clamp_int(end, 1, MAX_SEQUENCE_FRAMES))
    return {
        **title,
        "text": title["text"][:MAX_TEXT_CHARS],
        "start_frame": start,
        "end_frame": end,
    }


def normalize_effects(effects: Mapping[str, Any] | None) -> Doc | None:
    """Clip effects without members that are at their default; None when nothing is left."""
    if not effects:
        return None
    out: Doc = {}
    speed = _clamp_int(
        effects.get("speed_percent", 100), MIN_SPEED_PERCENT, MAX_SPEED_PERCENT
    )
    if speed != _NORMAL_PERCENT:
        out["speed_percent"] = speed
    volume = _round_to(
        min(MAX_VOLUME_DB, max(MIN_VOLUME_DB, effects.get("volume_db", 0))), 2
    )
    if volume != 0:
        out["volume_db"] = volume
    if effects.get("mute"):
        out["mute"] = True
    given = effects.get("fade") or {}
    fade = {key: _clamp_int(given.get(key, 0), 0, MAX_FADE_FRAMES) for key in FADE_KEYS}
    if any(fade.values()):
        out["fade"] = {key: value for key, value in fade.items() if value > 0}
    color = _normalized_color(effects.get("color") or {})
    if color is not None:
        out["color"] = color
    _finish_clip_effects(out, effects)
    return out or None


def _finish_clip_effects(out: Doc, effects: Mapping[str, Any]) -> None:
    held = effects.get("hold") or {}
    hold = {
        edge: _clamp_int(held.get(edge, 0), 0, MAX_HOLD_FRAMES)
        for edge in ("start", "end")
    }
    if any(hold.values()):
        out["hold"] = {edge: value for edge, value in hold.items() if value > 0}
    step = _clamp_int(effects.get("frame_step", 1), 1, MAX_FRAME_STEP)
    if step != 1:
        out["frame_step"] = step
    camera = _normalized_camera(effects.get("camera") or {})
    if camera:
        out["camera"] = camera
    impact = effects.get("impact")
    if impact and impact.get("style") in IMPACT_STYLES:
        out["impact"] = {
            "frames": _clamp_int(impact.get("frames"), 1, MAX_IMPACT_FRAMES),
            "style": impact["style"],
        }
    title = effects.get("title")
    if title and title["text"].strip():
        out["title"] = _normalized_title(title)
    transition = effects.get("transition_out")
    if transition and transition.get("kind") != "cut":
        frames = _clamp_int(transition.get("frames"), 1, MAX_TRANSITION_FRAMES)
        hints = dict(transition)
        softness = hints.get("softness")
        if (
            isinstance(softness, int | float)
            and not isinstance(softness, bool)
            and math.isfinite(softness)
        ):
            hints["softness"] = min(WIPE_SOFTNESS_MAX, max(0, softness))
        out["transition_out"] = transition_value(str(transition["kind"]), frames, hints)


def has_legacy_edit(shot: Mapping[str, Any]) -> bool:
    """The shot still carries a trim or effects of its own."""
    return bool(
        shot.get("in_frame") or shot.get("out_frame") is not None or shot.get("effects")
    )


def legacy_range(
    shot: Mapping[str, Any], take: Mapping[str, Any] | None
) -> tuple[int, int]:
    """A shot's trim on its take, in the take's own frames: in (inclusive) and out (exclusive)."""
    usable = (
        take
        if take is not None and take["state"] == "succeeded" and take.get("asset")
        else None
    )
    total = max(
        1,
        (usable["asset"]["frame_count"] or usable["frames"])
        if usable
        else shot["frames"],
    )
    first = min(max(0, shot["in_frame"]), total - 1)
    out = shot["out_frame"] if shot["out_frame"] is not None else total
    return first, min(max(first + 1, out), total)


def too_long(frames: int, fps: Mapping[str, Any]) -> bool:
    """More frames than a sequence may have (the frame and the duration limit)."""
    seconds = Fraction(frames * int(fps["den"]), int(fps["num"]))
    return frames > MAX_SEQUENCE_FRAMES or seconds > MAX_SEQUENCE_SECONDS


def bounded_notes(notes: Sequence[str]) -> list[str]:
    """Notes as the document stores them: no repeats, short, and a last line that counts what did not fit."""
    unique = list(
        dict.fromkeys(note[:MAX_MIGRATION_NOTE_CHARS] for note in notes if note)
    )
    if len(unique) <= MAX_MIGRATION_NOTES:
        return unique
    kept = unique[: MAX_MIGRATION_NOTES - 1]
    return [*kept, f"另有 {len(unique) - len(kept)} 項調整未列出。"]


@dataclass
class PlacedShot:
    """A shot as the clips that show it, before they have a place on the sequence."""

    shot_id: str
    name: str
    source: Doc
    video: Doc
    audio: Doc | None
    transition: Doc | None

    @property
    def clips(self) -> list[Doc]:
        """List the clips in this legacy timeline."""
        return [self.video] if self.audio is None else [self.video, self.audio]

    @property
    def frames(self) -> int:
        """Return the range length in frames."""
        return clip_duration(self.video)

    def move_to(self, start: int) -> None:
        """Move the clip to its new position."""
        for clip in self.clips:
            clip["start_frame"] = start

    def set_transition(self, transition: Mapping[str, Any], frames: int) -> None:
        """The shot's outgoing transition (direction, easing and softness kept) with an overlap of ``frames``."""
        for clip in self.clips:
            clip["effects"] = {
                **(clip.get("effects") or {}),
                "transition_out": {**transition, "frames": frames},
            }


def _source_range(
    shot: Mapping[str, Any],
    fps: Mapping[str, Any],
    source: Mapping[str, Any],
    notes: list[str],
) -> tuple[int, int]:
    """The shot's trim as a range of its source, in frames of the timeline's rate."""
    take = active_take(shot)
    asset_fps = (take.get("asset") or {}).get("fps") if take else None
    if asset_fps:
        ratio = (int(fps["num"]) * int(asset_fps["den"])) / (
            int(fps["den"]) * int(asset_fps["num"])
        )
    else:
        ratio = rate(fps) / H3_FPS
    first, out = legacy_range(shot, take)
    start, end = round_half_up(first * ratio), round_half_up(out * ratio)
    length = int(source["duration_frames"])
    fitted_end = max(1, min(end, length))
    fitted_start = max(0, min(start, fitted_end - 1))
    if (fitted_start, fitted_end) != (start, end):
        notes.append(
            f"「{shot_name(shot)}」的裁切範圍超出素材長度，已調整為素材範圍內。"
        )
    return fitted_start, fitted_end


def fitted_fades(
    name: str, fade: Mapping[str, int], frames: int, notes: list[str]
) -> Doc:
    """Fades that fit a clip of ``frames``: each pair is scaled down together, and the picture never ends black."""
    fitted = dict(fade)
    for kind, label in (("video", "影像"), ("audio", "聲音")):
        fade_in, fade_out = fade.get(f"{kind}_in", 0), fade.get(f"{kind}_out", 0)
        new_in, new_out = fade_in, fade_out
        if fade_in + fade_out > frames:
            new_in = fade_in * frames // (fade_in + fade_out)
            new_out = frames - new_in
        if kind == "video" and new_out >= frames:
            new_out = frames - 1
        if (new_in, new_out) == (fade_in, fade_out):
            continue
        notes.append(
            f"「{name}」的{label}淡入淡出超過片段長度（{frames} 影格），已縮短為淡入 {new_in}、淡出 {new_out} 影格。"
        )
        for edge, value in ((f"{kind}_in", new_in), (f"{kind}_out", new_out)):
            if value > 0:
                fitted[edge] = value
            else:
                fitted.pop(edge, None)
    return fitted


def _fitted_title(
    name: str, title: Mapping[str, Any], frames: int, notes: list[str]
) -> Doc:
    """A title inside a clip of ``frames``; one that ran past the clip ended with it, which the timeline calls None."""
    fitted = dict(title)
    if fitted["start_frame"] >= frames:
        fitted["start_frame"] = frames - 1
        fitted["end_frame"] = None
        notes.append(f"「{name}」的文字起點超過片段長度，已移到片段的最後一格。")
    elif fitted["end_frame"] is not None and fitted["end_frame"] > frames:
        fitted["end_frame"] = None
    return fitted


def _clip_effects(
    name: str, effects: Mapping[str, Any], frames: int, notes: list[str]
) -> tuple[Doc, Doc]:
    """(video clip effects, audio clip effects) of normalized shot effects, fitted to a clip of ``frames``."""
    video: Doc = {
        key: copy.deepcopy(effects[key]) for key in TIMING_EFFECTS if key in effects
    }
    audio: Doc = copy.deepcopy(video)
    if effects.get("mute"):
        audio["mute"] = True
    fade = fitted_fades(name, effects.get("fade") or {}, frames, notes)
    for target, kind in ((video, "video"), (audio, "audio")):
        edges = {key: value for key, value in fade.items() if key.startswith(kind)}
        if edges:
            target["fade"] = edges
    for key in VIDEO_EFFECTS:
        if key in effects:
            video[key] = copy.deepcopy(effects[key])
    impact = video.get("impact")
    if impact and impact["frames"] > frames:
        video["impact"] = {**impact, "frames": frames}
        notes.append(f"「{name}」的衝擊格超過片段長度，已縮短為 {frames} 影格。")
    if "title" in video:
        video["title"] = _fitted_title(name, video["title"], frames, notes)
    return video, audio


def shot_clips(  # noqa: PLR0913, PLR0917 - Keep the published positional and keyword API.
    project: Mapping[str, Any],
    shot: Mapping[str, Any],
    fps: Mapping[str, Any],
    tracks: tuple[str, str | None],
    taken: set[str],
    notes: list[str],
    known: Mapping[str, Any] | None = None,
) -> PlacedShot:
    """A shot as a source, a video clip and (with an audio track) its linked audio clip, both at frame 0.

    The shot's own trim and effects are carried into the clips. ``known`` is the source the timeline already has
    for the shot (a new one is made without it). ``taken`` holds the ids in use and receives the new ones.
    """
    name = shot_name(shot)
    video_track, audio_track = tracks
    if known is not None:
        source = dict(known)
        identity = str(source["source_id"])
    else:
        source = shot_source(project, shot, fps)
        identity = str(source["source_id"])
        source["source_id"] = unique_id(identity, taken)
    first, out = _source_range(shot, fps, source, notes)
    effects = normalize_effects(shot.get("effects")) or {}
    hold = effects.get("hold") or {}
    speed = effects.get("speed_percent", 100)
    frames = (
        retimed_frames(out - first, speed) + hold.get("start", 0) + hold.get("end", 0)
    )
    legacy_first, legacy_out = legacy_range(shot, active_take(shot))
    planned = (
        retimed_frames(legacy_out - legacy_first, speed)
        + hold.get("start", 0)
        + hold.get("end", 0)
    )
    if planned != frames:
        notes.append(
            f"「{name}」的素材影格率與序列不同，片段長度由 {planned} 影格換算為 {frames} 影格。"
        )
    video_effects, audio_effects = _clip_effects(name, effects, frames, notes)
    base: Doc = {
        "clip_id": unique_id(f"v-{identity}", taken),
        "source_id": source["source_id"],
        "track_id": video_track,
        "name": source["name"],
        "start_frame": 0,
        "in_frame": first,
        "out_frame": out,
    }
    audio: Doc | None = None
    if audio_track is not None:
        base["linked_id"] = unique_id(f"link-{identity}", taken)
        gain = effects.get("volume_db", 0)
        audio = {
            **base,
            "clip_id": unique_id(f"a-{identity}", taken),
            "track_id": audio_track,
            "motion": {**default_motion(), "gain_db": gain},
        }
        if audio_effects:
            audio["effects"] = audio_effects
    elif (
        effects.get("volume_db")
        or effects.get("mute")
        or any(key.startswith("audio") for key in effects.get("fade") or {})
    ):
        notes.append(
            f"這個專案使用原影片音軌，「{name}」的音量、靜音與聲音淡入淡出沒有作用，未帶入時間軸。"
        )
    video: Doc = {**base, "motion": default_motion()}
    if video_effects:
        video["effects"] = video_effects
    return PlacedShot(
        str(shot["shot_id"]), name, source, video, audio, active_transition(effects)
    )


def _overlap(
    previous: PlacedShot | None, incoming: int, item: PlacedShot
) -> tuple[int, str | None]:
    """The frames ``item`` overlaps ``previous`` by for its outgoing transition, and a note when that was changed."""
    transition = previous.transition if previous is not None else None
    if previous is None or transition is None:
        return 0, None
    wanted = int(transition["frames"])
    allowed = min(wanted, previous.frames - incoming, item.frames)
    if allowed < 1:
        return (
            0,
            f"「{previous.name}」的出場轉場無法保留（相鄰片段太短），已改為直接切換。",
        )
    if allowed != wanted:
        note = f"「{previous.name}」的出場轉場超過相鄰片段可重疊的長度，已由 {wanted} 影格縮短為 {allowed} 影格。"
        return allowed, note
    return allowed, None


def lay_out(
    items: Sequence[PlacedShot], fps: Mapping[str, Any], start: int, notes: list[str]
) -> list[PlacedShot]:
    """Give the shots their places back to back from ``start``, a transition as an overlap with the next shot.

    Shots that would run past the sequence limit are left out; the ones that got a place are returned.
    """
    placed: list[PlacedShot] = []
    cursor, incoming = start, 0
    for item in items:
        previous = placed[-1] if placed else None
        overlap, note = _overlap(previous, incoming, item)
        if too_long(cursor - overlap + item.frames, fps):
            notes.append(f"序列超過長度上限，「{item.name}」未放入時間軸。")
            continue
        if note:
            notes.append(note)
        if previous is not None and previous.transition is not None and overlap:
            previous.set_transition(previous.transition, overlap)
        item.move_to(cursor - overlap)
        cursor, incoming = cursor - overlap + item.frames, overlap
        placed.append(item)
    if placed and placed[-1].transition is not None:
        notes.append(f"「{placed[-1].name}」是最後一個片段，出場轉場已移除。")
    return placed


def original_audio_clip(
    job: Mapping[str, Any],
    item: Mapping[str, Any],
    timeline: Mapping[str, Any],
    track_id: str,
    notes: list[str],
) -> tuple[Doc, Doc] | None:
    """(source, clip) playing a character-swap project's source video sound under the whole sequence."""
    fps = timeline["fps"]
    source = library_source(item, fps)
    duration = max((clip_end(clip) for clip in timeline["clips"]), default=0)
    if source is None or duration <= 0:
        return None
    exact = (int(job["start_frame"]) * int(fps["num"])) / (
        int(job["fps"]) * int(fps["den"])
    )
    start = round_half_up(exact)
    if start != exact:
        notes.append(f"原影片音訊起點無法對齊序列影格率，已取最接近的第 {start} 影格。")
    end = min(start + duration, int(source["duration_frames"]))
    if end <= start:
        notes.append("原影片音軌比序列的起點還短，沒有放入時間軸。")
        return None
    if end < start + duration:
        notes.append(f"原影片音軌不足以涵蓋整個序列，只鋪到第 {end - start} 影格。")
    clip: Doc = {
        "clip_id": f"original-{source['source_id']}",
        "source_id": source["source_id"],
        "track_id": track_id,
        "name": f"原影片音軌（{source['name']}）"[:MAX_NAME_CHARS],
        "start_frame": 0,
        "in_frame": start,
        "out_frame": end,
        "motion": default_motion(),
    }
    return source, clip


__all__ = [
    "ORIGINAL_AUDIO_UNUSABLE",
    "PlacedShot",
    "bounded_notes",
    "fitted_fades",
    "has_legacy_edit",
    "lay_out",
    "legacy_range",
    "normalize_effects",
    "original_audio_clip",
    "shot_clips",
    "too_long",
]
