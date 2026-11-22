"""Static clip properties that can be transferred to a native retake in source time."""

from __future__ import annotations

from copy import deepcopy

from .model import Doc, clip_end, default_motion
from .rejection import reject


def compatible_visuals(clip: Doc) -> bool:
    """Allow stationary scale and color plus audio properties which live on the retained audio track."""
    motion = {**default_motion(), **clip["motion"]}
    defaults = default_motion()
    fx = clip.get("effects", {})
    neutral = {
        "speed_percent": 100,
        "frame_step": 1,
        "hold": {"start": 0, "end": 0},
        "fade": {"video_in": 0, "video_out": 0},
        "transition_out": {"kind": "cut"},
        "color": {"brightness": 0, "contrast": 1, "saturation": 1, "invert": False},
        "camera": {"zoom_percent": 100, "shake_px": 0, "shake_frames": 0},
    }
    active = (
        any(motion[k] != defaults[k] for k in ("x", "y", "rotation", "opacity"))
        or any(
            keys
            for name, keys in motion["keyframes"].items()
            if name not in {"gain_db", "pan"}
        )
        or any(e.get("enabled", True) for e in clip.get("effect_stack", []))
        or bool(clip.get("mask"))
        or clip.get("blend_mode", "normal") != "normal"
    )
    for name, value in fx.items():
        if name in {"volume_db", "mute", "color"}:
            continue
        default = neutral.get(name)
        if isinstance(default, dict) and isinstance(value, dict):
            active |= any(
                v != default.get(k)
                for k, v in value.items()
                if not (name == "fade" and k in {"audio_in", "audio_out"})
            )
        else:
            active |= default != value
    return not active


def retained_visuals(timeline: Doc, track: str, start: int, end: int) -> Doc:
    """Capture only supported picture properties of a single unretimed source clip."""
    overlaps = [
        clip
        for clip in timeline["clips"]
        if clip["track_id"] == track
        and clip["start_frame"] < end
        and clip_end(clip) > start
    ]
    if (
        len(overlaps) != 1
        or overlaps[0]["start_frame"] > start
        or clip_end(overlaps[0]) < end
        or not compatible_visuals(overlaps[0])
    ):
        reject(
            "invalid_command",
            "保留縮放與調色需要單一原速、沒有轉場、保持格或其他畫面特效的片段",
        )
    clip = overlaps[0]
    color = clip.get("effects", {}).get("color")
    return {"scale": clip["motion"]["scale"], "color": deepcopy(color)}
