"""Numeric bounds of the timeline document (generated; do not edit).

Source: ``contracts/component.schema.json``. Regenerate with
``python3 -I tools/contracts/timeline_limits.py``; ``--check`` reports drift.
"""

from typing import Final

MAX_SEQUENCE_FRAMES: Final[int] = 100000
MAX_SEQUENCE_SECONDS: Final[int] = 3600
MIN_FPS: Final[int] = 1
MAX_FPS: Final[int] = 240
MAX_SOURCE_FRAMES: Final[int] = 20736000
MAX_SOURCE_SECONDS: Final[int] = 86400
MAX_SOURCE_SIDE: Final[int] = 16384
MAX_TRACKS: Final[int] = 16
MAX_CLIPS: Final[int] = 1000
MAX_SOURCES: Final[int] = 500
MAX_CAPTIONS: Final[int] = 500
MAX_MARKERS: Final[int] = 500
MAX_PLACED_SHOTS: Final[int] = 500
MAX_MIGRATION_NOTES: Final[int] = 64
MAX_MIGRATION_NOTE_CHARS: Final[int] = 400
MAX_KEYFRAMES: Final[int] = 128
MAX_EFFECTS: Final[int] = 8
MAX_NAME_CHARS: Final[int] = 200
MAX_TEXT_CHARS: Final[int] = 200
MIN_GAIN_DB: Final[float] = -60.0
MAX_GAIN_DB: Final[float] = 12.0
MIN_SPEED_PERCENT: Final[int] = 50
MAX_SPEED_PERCENT: Final[int] = 200
MIN_VOLUME_DB: Final[float] = -60.0
MAX_VOLUME_DB: Final[float] = 12.0
MAX_HOLD_FRAMES: Final[int] = 240
MAX_FADE_FRAMES: Final[int] = 1000
MAX_FRAME_STEP: Final[int] = 4
MAX_IMPACT_FRAMES: Final[int] = 12
MAX_TRANSITION_FRAMES: Final[int] = 240
MAX_COMMANDS: Final[int] = 64
MAX_SRT_CHARS: Final[int] = 1000000
MOTION_BOUNDS: Final[dict[str, tuple[float, float]]] = {
    "x": (-2.0, 2.0),
    "y": (-2.0, 2.0),
    "scale": (0.05, 4.0),
    "rotation": (-360.0, 360.0),
    "opacity": (0.0, 1.0),
    "gain_db": (-60.0, 12.0),
    "pan": (-1.0, 1.0),
}
EFFECT_BOUNDS: Final[dict[str, dict[str, tuple[float, float]]]] = {
    "color": {
        "brightness": (-1.0, 1.0),
        "contrast": (0.0, 4.0),
        "saturation": (0.0, 4.0),
    },
    "blur": {
        "radius": (0.0, 64.0),
    },
    "chroma_key": {
        "similarity": (0.01, 1.0),
        "blend": (0.0, 1.0),
    },
    "glow": {
        "intensity": (0.0, 4.0),
        "radius": (0.0, 64.0),
        "threshold": (0.0, 1.0),
    },
    "rgb_split": {
        "offset": (0.0, 64.0),
        "angle": (-180.0, 180.0),
    },
    "vignette": {
        "amount": (0.0, 1.0),
        "softness": (0.0, 1.0),
    },
    "grain": {
        "amount": (0.0, 1.0),
    },
    "directional_blur": {
        "length": (0.0, 128.0),
        "angle": (-180.0, 180.0),
    },
    "sharpen": {
        "amount": (0.0, 3.0),
    },
}
MASK_BOUNDS: Final[dict[str, tuple[float, float]]] = {
    "x": (0.0, 1.0),
    "y": (0.0, 1.0),
    "width": (0.01, 1.0),
    "height": (0.01, 1.0),
    "feather": (0.0, 0.5),
}

__all__ = [
    "EFFECT_BOUNDS",
    "MASK_BOUNDS",
    "MAX_CAPTIONS",
    "MAX_CLIPS",
    "MAX_COMMANDS",
    "MAX_EFFECTS",
    "MAX_FADE_FRAMES",
    "MAX_FPS",
    "MAX_FRAME_STEP",
    "MAX_GAIN_DB",
    "MAX_HOLD_FRAMES",
    "MAX_IMPACT_FRAMES",
    "MAX_KEYFRAMES",
    "MAX_MARKERS",
    "MAX_MIGRATION_NOTES",
    "MAX_MIGRATION_NOTE_CHARS",
    "MAX_NAME_CHARS",
    "MAX_PLACED_SHOTS",
    "MAX_SEQUENCE_FRAMES",
    "MAX_SEQUENCE_SECONDS",
    "MAX_SOURCES",
    "MAX_SOURCE_FRAMES",
    "MAX_SOURCE_SECONDS",
    "MAX_SOURCE_SIDE",
    "MAX_SPEED_PERCENT",
    "MAX_SRT_CHARS",
    "MAX_TEXT_CHARS",
    "MAX_TRACKS",
    "MAX_TRANSITION_FRAMES",
    "MAX_VOLUME_DB",
    "MIN_FPS",
    "MIN_GAIN_DB",
    "MIN_SPEED_PERCENT",
    "MIN_VOLUME_DB",
    "MOTION_BOUNDS",
]
