"""Verify an edit matte against a source clock and bind it to VACE's actual denoising inputs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.probe import run_ffprobe_json
from phasyn_media.providers._analysis_video import Clock, read_clock
from PIL import Image

from .media import Source, decode, inspect, rate


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext

_THRESHOLD = 128
_BINARY = [0] * _THRESHOLD + [255] * (256 - _THRESHOLD)


def _clock_record(clock: Clock) -> dict[str, Any]:
    return {
        "time_base": rate(clock.time_base),
        "first_pts": clock.first_pts,
        "end_pts": clock.first_pts + clock.ticks[-1],
        "frames": clock.count,
    }


def _matching_clocks(ctx: RunContext, source: Source, mask: Source) -> dict[str, Any]:
    if source.count != mask.count or source.fps != mask.fps:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "Mask video and source need the same full frame count and exact FPS",
        )
    scene = read_clock(source.local.path, ctx)
    matte = read_clock(mask.local.path, ctx)
    if scene.count != source.count or matte.count != mask.count:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "Decoded mask or source frame count differs from its declared clock",
        )
    # Compare absolute presentation instants, including any edit-list offset and the exclusive last-frame end.
    # Equal frame rates alone cannot detect a one-frame origin shift or a small mid-clip timing change.
    left = scene.time_base.numerator * matte.time_base.denominator
    right = matte.time_base.numerator * scene.time_base.denominator
    ctx.check_cancelled()
    if any(
        (scene.first_pts + a) * left != (matte.first_pts + b) * right
        for a, b in zip(scene.ticks, matte.ticks, strict=True)
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            "Mask PTS must match every source frame and the exclusive end",
        )
    return {"source": _clock_record(scene), "mask": _clock_record(matte)}


def _single_still(ctx: RunContext, mask: Source) -> None:
    measured = run_ffprobe_json(
        mask.local.path,
        [
            "-select_streams",
            "V:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
        ],
        limits=DEFAULT_LIMITS,
        timeout=min(ctx.remaining_seconds(), DEFAULT_LIMITS.probe_timeout_seconds),
        cancel=ctx.cancel_token,
    )
    streams = measured.get("streams") or []
    if len(streams) != 1 or str(streams[0].get("nb_read_frames")) != "1":
        raise ComponentError(
            "INVALID_ARGUMENT", "The static mask must decode to exactly one picture"
        )


@dataclass
class SpatialMask:
    """One binary mask per delivered frame and the original pictures needed for optional compositing."""

    port: str
    source: Source
    shapes: list[Image.Image]
    clocks: dict[str, Any] | None
    composite_unmasked: bool
    originals: list[Image.Image] = field(default_factory=list)

    def record(self) -> dict[str, Any]:
        """Describe the exact mask source, verification and pre-encode composition."""
        return {
            "port": self.port,
            "source": self.source.record(),
            "clock_check": self.clocks,
            "white": "regenerate",
            "black": "preserve",
            "threshold": _THRESHOLD,
            "filter": "nearest",
            "channel": "decoded_luma",
            "composite_unmasked": self.composite_unmasked,
        }

    def conditioning_frame(
        self, index: int, original: Image.Image, neutral: Image.Image
    ) -> tuple[Image.Image, Image.Image]:
        """Keep the black source pixels for conditioning; leave the white region free for generation."""
        mask = self.shapes[index]
        if self.composite_unmasked:
            self.originals.append(original)
        return Image.composite(neutral, original, mask), mask

    def composite(self, ctx: RunContext, generated: list[Image.Image]) -> None:
        """Paste original decoded RGB into the preserved region before H.264 quantization."""
        if not self.composite_unmasked:
            return
        for i, (picture, original, mask) in enumerate(
            zip(generated, self.originals, self.shapes, strict=True)
        ):
            ctx.check_cancelled()
            generated[i] = Image.composite(picture.convert("RGB"), original, mask)


def read_mask(ctx: RunContext, source: Source, selected: range) -> SpatialMask | None:
    """Accept exactly one explicit static matte or one registered full-source video matte."""
    ports = [name for name in ("mask_image", "mask_video") if name in ctx.inputs]
    if not ports:
        if ctx.parameters.get("mask_required") is True:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "This masked retake requires one mask_image or mask_video input",
            )
        return None
    if len(ports) != 1:
        raise ComponentError(
            "INVALID_ARGUMENT", "Pass either mask_image or mask_video, not both"
        )
    name = ports[0]
    mask = inspect(ctx, name)
    canvas = source.width, source.height
    if (mask.width, mask.height) != canvas:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "Mask pixel dimensions must match the source without resizing",
        )
    if name == "mask_video":
        clocks = _matching_clocks(ctx, source, mask)
        shapes = [
            image.point(_BINARY)
            for image in decode(ctx, mask, selected, canvas, matte=True)
        ]
    else:
        clocks = None
        _single_still(ctx, mask)
        image = decode(ctx, mask, range(1), canvas, matte=True)[0].point(_BINARY)
        shapes = [image] * len(selected)
    return SpatialMask(
        name, mask, shapes, clocks, ctx.parameters.get("composite_unmasked", True)
    )
