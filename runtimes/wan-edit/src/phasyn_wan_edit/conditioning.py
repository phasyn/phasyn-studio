"""Translate a requested edit into VACE control frames, spatial and temporal masks, and a delivery slice."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError
from PIL import Image

from .media import Source, decode, inspect, rate
from .schema import GENERATE
from .spatial_mask import SpatialMask, read_mask


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext

MAX_FRAMES = 129
_ALIGN = 16
_MIN_SIDE = 128
_MAX_SIDE = 1280
_MAX_PIXELS = 1280 * 720
_STRIDE = 4
_DEFAULT_SIZE = (832, 480)
_DEFAULT_FRAMES = 49
_MAX_RATE = 120
_MAX_FPS_NUM = 240_000
_MAX_FPS_DEN = 1001
_INPUTS = {
    "generate": (set(), {"first_frame", "reference"}),
    "retake": ({"source"}, {"reference", "mask_video", "mask_image"}),
    "extend_before": ({"source"}, {"reference"}),
    "extend_after": ({"source"}, {"reference"}),
    "gap": ({"first_frame", "last_frame"}, {"reference"}),
    "layout": ({"layout"}, {"reference"}),
    "control": ({"control"}, {"reference"}),
}
_OPERATION_FIELDS = {
    "start_frame",
    "end_frame",
    "context_frames",
    "frames",
    "fps_num",
    "fps_den",
    "mask_required",
    "composite_unmasked",
}
_OPTIONS = {
    "generate": {"frames", "fps_num", "fps_den"},
    "retake": {
        "start_frame",
        "end_frame",
        "context_frames",
        "mask_required",
        "composite_unmasked",
    },
    "extend_before": {"frames", "context_frames"},
    "extend_after": {"frames", "context_frames"},
    "gap": {"frames", "fps_num", "fps_den"},
    "layout": {"frames", "fps_num", "fps_den"},
    "control": {"frames", "start_frame"},
}


def invalid(message: str) -> ComponentError:
    """Describe an edit the runtime cannot interpret without changing its meaning."""
    return ComponentError("INVALID_ARGUMENT", message)


@dataclass
class Conditioning:
    """Bounded model input and exact mapping from model output back to the Studio clip."""

    operation: str
    canvas: tuple[int, int]
    fps: Fraction
    source_records: dict[str, dict[str, Any]]
    frames: list[Image.Image]
    masks: list[Image.Image]
    output: range
    placement: range
    source_window: range | None
    reference: Image.Image | None
    first_anchor: Image.Image | None
    spatial_mask: SpatialMask | None = None

    def record(self) -> dict[str, Any]:
        """Record the exact fit, padded clock, extracted frame interval and edit placement."""
        return {
            "operation": self.operation,
            "sources": self.source_records,
            "fps": rate(self.fps),
            "canvas": list(self.canvas),
            "image_fit": "contain_center_black_pad",
            "model_frames": len(self.frames),
            "model_output_range": [self.output.start, self.output.stop],
            "timeline_range": [self.placement.start, self.placement.stop],
            "source_window": [self.source_window.start, self.source_window.stop]
            if self.source_window is not None
            else None,
            "audio": "silent_patch_keep_original_timeline_audio",
            "interval": "half_open",
            **(
                {"spatial_mask": self.spatial_mask.record()}
                if self.spatial_mask is not None
                else {}
            ),
        }


@dataclass(frozen=True)
class Window:
    """Source frames consumed, generated interval, unpadded length and its timeline placement."""

    read: range | None
    output: range
    total: int
    placement: range


def _video_window(operation: str, source: Source, params: dict[str, Any]) -> Window:
    count = source.count
    context = min(count, int(params.get("context_frames", 8)))
    start = int(params.get("start_frame", 0))
    if operation == "retake":
        if "start_frame" not in params or "end_frame" not in params:
            raise invalid(
                "retake needs both start_frame and end_frame in source presentation frames"
            )
        end = int(params["end_frame"])
        if not 0 <= start < end <= count:
            raise invalid(
                "retake requires 0 <= start_frame < end_frame <= source frame count"
            )
        read = range(max(0, start - context), min(count, end + context))
        return Window(
            read,
            range(start - read.start, end - read.start),
            len(read),
            range(start, end),
        )
    if operation == "control":
        length = int(params.get("frames", count - start))
        if length < 1 or start < 0 or start + length > count:
            raise invalid("control guide is shorter than the requested interval")
        return Window(
            range(start, start + length),
            range(length),
            length,
            range(start, start + length),
        )
    length = int(params.get("frames", _DEFAULT_FRAMES))
    if operation == "extend_before":
        return Window(
            range(context), range(length), length + context, range(-length, 0)
        )
    return Window(
        range(count - context, count),
        range(context, context + length),
        context + length,
        range(count, count + length),
    )


def _canvas(
    params: dict[str, Any], video: Source | None, anchor: Source | None
) -> tuple[int, int]:
    basis = video or anchor
    original = (basis.width, basis.height) if basis is not None else _DEFAULT_SIZE
    width, height = (
        int(params.get("width", original[0])),
        int(params.get("height", original[1])),
    )
    if video is not None and original != (width, height):
        raise invalid(
            "A source or control video must match the requested canvas exactly"
        )
    if (
        any(
            not _MIN_SIDE <= side <= _MAX_SIDE or side % _ALIGN
            for side in (width, height)
        )
        or width * height > _MAX_PIXELS
    ):
        raise invalid(
            "VACE needs multiples of 16, sides 128..1280, and at most 1280 x 720 pixels"
        )
    return width, height


def _window(params: dict[str, Any], op: str, video: Source | None) -> Window:
    if video is not None:
        return _video_window(op, video, params)
    length = int(params.get("frames", _DEFAULT_FRAMES))
    if op == "gap":
        return Window(None, range(1, length + 1), length + 2, range(1, length + 1))
    return Window(None, range(length), length, range(length))


def _operation(ctx: RunContext, provider: str) -> str:
    op = (
        "generate" if provider == GENERATE else str(ctx.parameters.get("operation", ""))
    )
    if op not in _INPUTS or (provider != GENERATE and op == "generate"):
        raise invalid("Unsupported Wan VACE operation")
    required, optional = _INPUTS[op]
    provided = ctx.inputs.keys() - {"prompt"}
    if not required <= provided or provided - required - optional:
        raise invalid(
            f"{op} requires {sorted(required)} and optionally accepts {sorted(optional)}"
        )
    unused = ctx.parameters.keys() & (_OPERATION_FIELDS - _OPTIONS[op])
    if unused:
        raise invalid(f"{op} does not consume {sorted(unused)}")
    return op


def _fill_source(
    ctx: RunContext, job: Conditioning, source: Source, window: Window
) -> None:
    if window.read is None:
        raise invalid("Missing source interval")
    images = decode(ctx, source, window.read, job.canvas)
    if job.operation == "control":
        job.frames[: len(images)] = images
        return
    black = Image.new("L", job.canvas, 0)
    offset = len(window.output) if job.operation == "extend_before" else 0
    for i, image in enumerate(images, start=offset):
        if i not in window.output:
            job.frames[i] = image
            job.masks[i] = black
        elif job.spatial_mask is not None:
            job.frames[i], job.masks[i] = job.spatial_mask.conditioning_frame(
                i - window.output.start, image, job.frames[i]
            )


def _still(
    ctx: RunContext, job: Conditioning, name: str, inspected: Source | None = None
) -> Image.Image:
    source = inspected or inspect(ctx, name)
    job.source_records[name] = source.record()
    return decode(ctx, source, range(1), job.canvas)[0]


def _anchors(
    ctx: RunContext, job: Conditioning, last: int, first_source: Source | None
) -> None:
    if "first_frame" in ctx.inputs:
        first = _still(ctx, job, "first_frame", first_source)
        job.frames[0], job.masks[0] = first, Image.new("L", job.canvas, 0)
        if job.operation == "generate":
            job.first_anchor = first
    if "last_frame" in ctx.inputs:
        job.frames[last], job.masks[last] = (
            _still(ctx, job, "last_frame"),
            Image.new("L", job.canvas, 0),
        )
    if "layout" in ctx.inputs:
        job.frames[:] = [_still(ctx, job, "layout")] * len(job.frames)
    if "reference" in ctx.inputs:
        job.reference = _still(ctx, job, "reference")


def prepare(ctx: RunContext, provider: str) -> Conditioning:
    """Check the entire bounded request before allocating model inputs or entering the GPU."""
    op = _operation(ctx, provider)
    video_name = next((k for k in ("source", "control") if k in ctx.inputs), None)
    video = inspect(ctx, video_name) if video_name is not None else None
    first_source = inspect(ctx, "first_frame") if op == "gap" else None
    size = _canvas(ctx.parameters, video, first_source)
    window = _window(ctx.parameters, op, video)
    padded = 1 + ((window.total - 1 + _STRIDE - 1) // _STRIDE) * _STRIDE
    if not 1 <= window.total <= padded <= MAX_FRAMES:
        raise invalid(
            f"Input context, anchors, requested frames and padding exceed {MAX_FRAMES} model frames"
        )
    fps = (
        video.fps
        if video is not None
        else Fraction(
            int(ctx.parameters.get("fps_num", 24)),
            int(ctx.parameters.get("fps_den", 1)),
        )
    )
    if (
        fps is None
        or not 0 < fps <= _MAX_RATE
        or fps.numerator > _MAX_FPS_NUM
        or fps.denominator > _MAX_FPS_DEN
    ):
        raise invalid(
            "VACE supports CFR rates up to 120 fps, numerator <= 240000 and denominator <= 1001"
        )
    job = Conditioning(
        op,
        size,
        fps,
        {},
        [Image.new("RGB", size, (128, 128, 128))] * padded,
        [Image.new("L", size, 255)] * padded,
        window.output,
        window.placement,
        window.read,
        None,
        None,
    )
    if video is not None and video_name is not None:
        job.source_records[video_name] = video.record()
        if op == "retake":
            job.spatial_mask = read_mask(ctx, video, window.placement)
        _fill_source(ctx, job, video, window)
    _anchors(ctx, job, window.total - 1, first_source)
    # No repeat of an unknown future image: pad both the control and its mask with the last real condition.
    for index in range(window.total, padded):
        job.frames[index], job.masks[index] = (
            job.frames[window.total - 1],
            job.masks[window.total - 1],
        )
    return job
