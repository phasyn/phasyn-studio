"""Single-subject capture with pinned MediaPipe model bytes and explicit landmark coverage."""

from __future__ import annotations

import hashlib
import os
import stat
from importlib import import_module
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError


WEIGHTS = {
    "depth": (
        "midas-v2.1-small-256.onnx",
        66764249,
        "2d8c6cb8f415229daf1eb041024208e2608c9f98e17c81cc7c6ecb449c56fd58",
    ),
    "pose": (
        "pose_landmarker_full.task",
        9398198,
        "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
    ),
    "face": (
        "face_landmarker.task",
        3758596,
        "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    ),
}


def model_bytes(path: Path, kind: str) -> bytes:
    """Read a regular local weights file and verify its fixed size and SHA-256."""
    _, size, digest = WEIGHTS[kind]
    absolute = path.absolute()
    if ".." in absolute.parts:
        raise ComponentError("INVALID_ARGUMENT", "Parent traversal in the model path.")
    directories = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(absolute.anchor, directories)
    try:
        for part in absolute.parts[1:-1]:
            child = os.open(part, directories, dir_fd=parent)
            os.close(parent)
            parent = child
        fd = os.open(
            absolute.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent
        )
    finally:
        os.close(parent)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != size:
            raise ComponentError(
                "INTEGRITY_MISMATCH", "Unexpected landmark model file type or size."
            )
        payload = source.read(size + 1)
    if hashlib.sha256(payload).hexdigest() != digest:
        raise ComponentError("INTEGRITY_MISMATCH", "Unexpected landmark model SHA-256.")
    return payload


class Capture:
    """Run a CPU detector statelessly for each source frame."""

    def __init__(self, kind: str, model: bytes) -> None:
        """Initialize one detector with verified weights."""
        self.mp = import_module("mediapipe")
        self.kind = kind
        vision = self.mp.tasks.vision
        base = self.mp.tasks.BaseOptions(
            model_asset_buffer=model, delegate=self.mp.tasks.BaseOptions.Delegate.CPU
        )
        if kind == "face":
            opts = vision.FaceLandmarkerOptions(
                base_options=base, num_faces=2, output_face_blendshapes=True
            )
            self.detector = vision.FaceLandmarker.create_from_options(opts)
            edges = vision.FaceLandmarksConnections.FACE_LANDMARKS_CONTOURS
        else:
            opts = vision.PoseLandmarkerOptions(base_options=base, num_poses=2)
            self.detector = vision.PoseLandmarker.create_from_options(opts)
            edges = vision.PoseLandmarksConnections.POSE_LANDMARKS
        self.edges = [(e.start, e.end) for e in edges]

    def detect(self, rgb: Any, frame: int) -> dict[str, Any]:
        """Return normalized coordinates and measured channels for one frame."""
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
        measurement = self.detector.detect(image)
        subjects = getattr(measurement, self.kind + "_landmarks")
        if len(subjects) > 1:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "Multiple subjects in a single-subject capture.",
                details={"frame": frame},
            )
        if not subjects:
            return {"frame": frame, "points": [], "blendshapes": {}}
        points = [
            [v.x, v.y, v.z, 1.0 if v.visibility is None else v.visibility]
            for v in subjects[0]
        ]
        expressions = getattr(measurement, "face_blendshapes", ())
        blendshapes = (
            {v.category_name: v.score for v in expressions[0]} if expressions else {}
        )
        return {"frame": frame, "points": points, "blendshapes": blendshapes}

    def close(self) -> None:
        """Release the native detector and its worker threads."""
        self.detector.close()
