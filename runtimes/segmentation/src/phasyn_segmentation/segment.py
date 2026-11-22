"""Project media into SAM's numbered JPEG frame view and deliver the tracked object."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError
from phasyn_media.files import file_sha256, unchanged_since
from phasyn_media.providers._analysis_video import inspect, transform, workspace

from .annotations import MAX_FRAMES, MAX_PIXELS, Annotations
from .export import deliver
from .tracking import track


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext
    from phasyn_media.providers._analysis_video import Source


def _extract(ctx: RunContext, source: Source, frames: Path) -> None:
    # Number exactly one image per decoded presentation frame. No fps conversion,
    # pixel resize, rotation, crop or media-supplied output name participates.
    transform(
        ctx,
        source,
        "null",
        [
            "-fps_mode",
            "passthrough",
            "-frames:v",
            str(source.clock.count),
            "-c:v",
            "mjpeg",
            "-threads",
            "1",
            "-q:v",
            "2",
            "-start_number",
            "0",
            "-f",
            "image2",
            str(frames / "%08d.jpg"),
        ],
    )
    expected = {f"{n:08d}.jpg" for n in range(source.clock.count)}
    if {p.name for p in frames.iterdir()} != expected:
        raise ComponentError(
            "MEDIA_INCOMPLETE",
            "Frame extraction differs from the measured source clock.",
        )


def segment(ctx: RunContext, predictor: Any) -> None:
    """Validate source and hints before decoding; publish only a completely verified result."""
    with ctx.recorder.phase("inspect"):
        source = inspect(ctx)
        if source.info.video_streams != 1 or source.info.rotation_degrees not in (
            None,
            0,
        ):
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "Select one source stream with baked-in orientation.",
            )
        if (
            source.clock.count > MAX_FRAMES
            or source.metadata["source_width"] * source.metadata["source_height"]
            > MAX_PIXELS
        ):
            raise ComponentError(
                "RESOURCE_EXHAUSTED",
                "SAM 2 accepts at most 240 frames and 2,211,840 pixels per frame.",
            )
        if source.clock.time_base.denominator > 2**31 - 1 or source.clock.first_pts < 0:
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "The source presentation clock cannot be stored in this mask track.",
            )
        hints = Annotations.parse(ctx.input("annotations").value, source)
        digest, size = file_sha256(source.file.path, cancel=ctx.cancel_token)
        if (
            digest != source.metadata["source_sha256"]
            or size != source.metadata["source_size_bytes"]
            or not unchanged_since(source.file)
        ):
            raise ComponentError(
                "INTEGRITY_MISMATCH",
                "Source bytes differ from the annotated file revision.",
            )
    with workspace(ctx) as tmp:
        folder = Path(tmp)
        frames, masks = folder / "frames", folder / "masks"
        frames.mkdir()
        masks.mkdir()
        with ctx.recorder.phase("decode"):
            _extract(ctx, source, frames)
        with ctx.recorder.phase("segment"):
            track(ctx, predictor, folder, source, hints)
        with ctx.recorder.phase("publish"):
            ctx.check_cancelled()
            deliver(ctx, folder / "object.mov", masks, source, hints)
