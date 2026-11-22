"""Infer depth or a person matte on a fixed grid and preserve source frame timing."""

from __future__ import annotations

import shutil
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol

import numpy as np
from numpy.lib.format import open_memmap
from numpy.typing import NDArray
from phasyn_captioner.upscale.video import FrameReader, SourceVideo, inspect_source
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.outputs import OutputFile
from phasyn_components.provider import RunContext
from phasyn_media.encode import StreamingVideoEncoder
from phasyn_media.files import file_sha256

from .capture import WEIGHTS
from .mesh import Frame
from .render import LIMITS


GRID = 256
Field = NDArray[np.float32]


class MapModel(Protocol):
    """Per-frame floating-point estimate and the identity of its inference library."""

    kind: str
    library: str

    def measure(self, frame: Frame) -> Field:
        """Measure one RGB frame on the output grid."""
        ...

    def close(self) -> None:
        """Release native model resources."""
        ...


class Depth:
    """MiDaS v2.1 Small ONNX expects RGB in [0,1] and normalizes channels in the graph."""

    kind = "depth"

    def __init__(self, weights: bytes) -> None:
        """Load the verified model bytes into a CPU inference engine."""
        self.cv = import_module("cv2")
        self.library = "opencv-" + self.cv.__version__
        self.net = self.cv.dnn.readNetFromONNX(np.frombuffer(weights, np.uint8))
        self.net.setPreferableBackend(self.cv.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(self.cv.dnn.DNN_TARGET_CPU)

    def measure(self, frame: Frame) -> Field:
        """Return relative inverse depth, nearer values increasing."""
        rgb = self.cv.resize(
            frame.astype(np.float32) / 255,
            (GRID, GRID),
            interpolation=self.cv.INTER_CUBIC,
        )
        self.net.setInput(np.ascontiguousarray(rgb.transpose(2, 0, 1)[None]))
        return np.asarray(self.net.forward(), dtype=np.float32).reshape(GRID, GRID)

    def close(self) -> None:
        """Release the detector owned by this component."""
        self.net = None


class PersonMask:
    """Use the pose model's foreground probability field for a single person."""

    kind = "person_mask"

    def __init__(self, weights: bytes) -> None:
        """Load the verified model bytes into a CPU inference engine."""
        self.cv = import_module("cv2")
        self.mp = import_module("mediapipe")
        self.library = "mediapipe-" + self.mp.__version__
        vision = self.mp.tasks.vision
        base = self.mp.tasks.BaseOptions(
            model_asset_buffer=weights, delegate=self.mp.tasks.BaseOptions.Delegate.CPU
        )
        self.detector = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(
                base_options=base, num_poses=2, output_segmentation_masks=True
            )
        )

    def measure(self, frame: Frame) -> Field:
        """Return a probability field and a black frame when no person is visible."""
        masks = self.detector.detect(
            self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=frame)
        ).segmentation_masks
        if not masks:
            return np.zeros((GRID, GRID), np.float32)
        if len(masks) > 1:
            raise ComponentError(
                "INVALID_ARGUMENT", "Person matte requires one visible subject."
            )
        mask = self.cv.resize(
            masks[0].numpy_view(), (GRID, GRID), interpolation=self.cv.INTER_LINEAR
        )
        return np.asarray(mask, dtype=np.float32).reshape(GRID, GRID)

    def close(self) -> None:
        """Release the native model and worker threads."""
        self.detector.close()


def _measure(
    ctx: RunContext, source: SourceVideo, model: MapModel, path: Path
) -> tuple[float, float]:
    needed = source.frames * GRID * GRID * np.dtype(np.float32).itemsize
    if shutil.disk_usage(path.parent).free <= needed + 4096:
        raise ComponentError(
            "DISK_FULL",
            "Insufficient workspace for the control sequence.",
            details={"field_bytes": needed},
        )
    fields = open_memmap(
        path, mode="w+", version=(1, 0), dtype="<f4", shape=(source.frames, GRID, GRID)
    )
    low, high = float("inf"), float("-inf")
    with FrameReader(source, cancel=ctx.cancel_token, limits=LIMITS) as reader:
        for index, frame in enumerate(reader.frames()):
            ctx.check_cancelled()
            field = model.measure(frame)
            if field.shape != (GRID, GRID) or not np.isfinite(field).all():
                raise ComponentError(
                    "RUNTIME_ERROR",
                    "Invalid control field returned by the inference runtime.",
                )
            fields[index] = field
            low, high = min(low, float(field.min())), max(high, float(field.max()))
    fields.flush()
    if model.kind == "person_mask" and high <= 0:
        raise ComponentError(
            "INVALID_ARGUMENT", "No subject was detected in the driving video."
        )
    return (0.0, 1.0) if model.kind == "person_mask" else (low, high)


def _grayscale(
    field: Field, source: SourceVideo, bounds: tuple[float, float]
) -> NDArray[np.uint8]:
    cv = import_module("cv2")
    low, high = bounds
    mapped = np.clip(
        (field - low) / max(high - low, float(np.finfo(np.float32).eps)), 0, 1
    )
    scaled = cv.resize(
        mapped, (source.width, source.height), interpolation=cv.INTER_LINEAR
    )
    return np.asarray(np.rint(255 * scaled), dtype=np.uint8)


def _control_png(
    ctx: RunContext,
    field: Path,
    source: SourceVideo,
    bounds: tuple[float, float],
    index: int,
) -> OutputFile:
    cv = import_module("cv2")
    stack = np.load(field, mmap_mode="r", allow_pickle=False)
    encoded, data = cv.imencode(".png", _grayscale(stack[index], source, bounds))
    if not encoded:
        raise ComponentError(
            "RUNTIME_ERROR", "Failed to encode the selected control frame."
        )
    image = ctx.new_file("control_image", "image/png", {"frame_index": index})
    image.write(data.tobytes())
    image.finish()
    return image


def _encode(
    ctx: RunContext,
    source: SourceVideo,
    path: Path,
    video: Path,
    bounds: tuple[float, float],
) -> None:
    cv = import_module("cv2")
    fields = np.load(path, mmap_mode="r", allow_pickle=False)
    with StreamingVideoEncoder(
        video,
        width=source.width,
        height=source.height,
        fps_num=source.fps.numerator,
        fps_den=source.fps.denominator,
        expected_frames=source.frames,
        max_queue_chunks=2,
        cancel=ctx.cancel_token,
        limits=LIMITS,
    ) as encoder:
        for field in fields:
            ctx.check_cancelled()
            mono = _grayscale(field, source, bounds)
            encoder.write_chunk(cv.cvtColor(mono, cv.COLOR_GRAY2RGB)[None])
        encoder.finish()


def _publish(ctx: RunContext, path: Path, *, type_id: str, mime: str) -> OutputFile:
    written = ctx.new_file(None, mime, {}, type_id=type_id)
    digest, size = file_sha256(path, cancel=ctx.cancel_token)
    written.adopt_file(path, sha256=digest, size=size)
    return written


def control(ctx: RunContext, model: MapModel) -> None:
    """Publish a preview video and an unclipped float32 field stack in the same frame order."""
    original = ctx.input("video_file")
    source = inspect_source(
        original.require_path("video_file"), cancel=ctx.cancel_token, limits=LIMITS
    )
    if not 0 < source.frames <= LIMITS.max_frames:
        raise ComponentError(
            "INVALID_ARGUMENT", "The control input exceeds the frame limit."
        )
    index = ctx.parameters.get("frame_index", 0)
    if type(index) is not int or not 0 <= index < source.frames:
        raise ComponentError(
            "INVALID_ARGUMENT", "Selected control frame is outside the source clip."
        )
    ctx.work_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=ctx.work_dir) as tmp:
        field, video = Path(tmp) / "control.npy", Path(tmp) / "control.mp4"
        bounds = _measure(ctx, source, model, field)
        _encode(ctx, source, field, video, bounds)
        still = _control_png(ctx, field, source, bounds, index)
        ctx.check_cancelled()
        raw = _publish(
            ctx, field, type_id="media.control-field.v1", mime="application/x-npy"
        )
        preview = _publish(ctx, video, type_id="media.video.v1", mime="video/mp4")
    fps = {"num": source.fps.numerator, "den": source.fps.denominator}
    metadata = {
        "kind": model.kind,
        "format": "numpy-npy-v1",
        "dtype": "<f4",
        "shape": [source.frames, GRID, GRID],
        "normalization": {"low": bounds[0], "high": bounds[1], "scope": "whole_clip"},
        "source": original.file,
        "field_file": ctx.file_ref(raw),
        "selected_frame": {"index": index, "file": ctx.file_ref(still)},
        "model_sha256": WEIGHTS["depth" if model.kind == "depth" else "pose"][2],
        "inference_engine": model.library,
        "crop": "full_frame",
        "fps": fps,
    }
    asset = {
        "asset_id": new_id(),
        "kind": "final",
        "file": ctx.file_ref(preview),
        "source_latent": None,
        "complete": True,
        "frame_count": source.frames,
        "fps": fps,
        "width": source.width,
        "height": source.height,
        "actual_settings": {"control": metadata},
    }
    contracts.validate("Asset", asset, code="RUNTIME_ERROR")
    ctx.set_output("asset", asset)
    ctx.set_file_output("video_file", preview)
    ctx.set_file_output("field", raw)
    ctx.set_file_output("control_image", still)
