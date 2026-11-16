"""Environment variables shared by the Node and the component processes it starts.

A component process does not inherit the Node's environment: the Node passes only
:data:`PASSTHROUGH_ENV` (when set), the runtime entry's own ``env`` map from the Node config, and
the variables below that it sets itself. Keeping the names here lets the Node, ``phasyn_media`` and
the component runtime agree without depending on one another.
"""

from __future__ import annotations

ENV_FFMPEG = "PHASYN_FFMPEG"  # absolute path (or PATH name) of the ffmpeg binary to use
ENV_FFPROBE = "PHASYN_FFPROBE"  # same for ffprobe
RUNTIME_ID_ENV = "PHASYN_RUNTIME_ID"  # set by the Node: the runtime entry that started the process
SOURCE_REVISION_ENV = "PHASYN_SOURCE_REVISION"  # set by the Node: the code revision it runs
PREVIEW_FD_ENV = "PHASYN_PREVIEW_FD"  # set by the Node: write end of the intermediate-preview pipe

# Copied from the Node's own environment into every component process (when present).
PASSTHROUGH_ENV: tuple[str, ...] = ("PATH", "HOME", "LANG", "TZ", ENV_FFMPEG, ENV_FFPROBE)

# Set by the Node for every component process: model libraries read local files only and report nothing.
# Weights are fetched only by the Node's explicit download, never by a component.
OFFLINE_ENV: dict[str, str] = {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "DO_NOT_TRACK": "1",
}

__all__ = [
    "ENV_FFMPEG",
    "ENV_FFPROBE",
    "OFFLINE_ENV",
    "PASSTHROUGH_ENV",
    "PREVIEW_FD_ENV",
    "RUNTIME_ID_ENV",
    "SOURCE_REVISION_ENV",
]
