"""Make a reusable, time-aligned Canny edge video for compatible conditioning pipelines."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.provider import BaseProvider, Description, Port, RunContext

from ..errors import MediaError
from ..limits import DEFAULT_LIMITS
from ..probe import probe
from ..tools import input_url
from . import _analysis_video as video
from ._failure import media_failure


PARAMS = {"low": video.number(20 / 255, 0, 1), "high": video.number(50 / 255, 0, 1)}


def _geometry(source: video.Source) -> tuple[int, int]:
    """Map display orientation to the output raster without a spatial crop or rescale."""
    rotation = (source.info.rotation_degrees or 0) % 360
    if rotation not in (0, 90, 180, 270):
        raise MediaError(
            "UNSUPPORTED_COMBINATION",
            "An edge sequence requires an orthogonal display rotation.",
        )
    width, height = int(source.info.width or 0), int(source.info.height or 0)
    return (height, width) if rotation in (90, 270) else (width, height)


def _render(
    ctx: RunContext, source: video.Source, path: Path, settings: dict[str, float]
) -> dict[str, Any]:
    width, height = _geometry(source)
    pixel_format = "yuv444p" if width % 2 or height % 2 else "yuv420p"
    clock = source.clock
    graph = f"setpts=PTS-STARTPTS,format=gray,edgedetect=mode=wires:low={settings['low']}:high={settings['high']}"
    video.transform(
        ctx,
        source,
        graph,
        [
            "-fps_mode",
            "passthrough",
            "-enc_time_base:v",
            str(clock.time_base),
            "-video_track_timescale",
            str(clock.time_base.denominator),
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-preset",
            "veryfast",
            "-crf",
            "0",
            "-pix_fmt",
            pixel_format,
            "-map_metadata",
            "-1",
            "-fs",
            str(DEFAULT_LIMITS.max_file_bytes),
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            "-n",
            input_url(path),
        ],
    )
    delivered = probe(path, cancel=ctx.cancel_token)
    if (
        (delivered.width, delivered.height) != (width, height)
        or delivered.has_audio
        or delivered.video_codec != "h264"
    ):
        raise MediaError(
            "MEDIA_INCOMPLETE", "Edge video failed geometry or stream verification."
        )
    actual = video.read_clock(path, ctx)
    if actual.count != clock.count or any(
        x * actual.time_base != y * clock.time_base
        for x, y in zip(actual.ticks, clock.ticks, strict=True)
    ):
        raise MediaError(
            "MEDIA_INCOMPLETE",
            "The edge sequence does not match every source frame timestamp and the exclusive end.",
        )
    return {
        **source.metadata,
        "control_type": "edge",
        "algorithm": "ffmpeg.edgedetect.wires",
        "ffmpeg_version": video.tool_version(ctx),
        "settings": settings,
        "frame_count": actual.count,
        "width": width,
        "height": height,
        "pixel_format": pixel_format,
        "fps": {"num": delivered.fps_num, "den": delivered.fps_den},
        "time_mapping": "one_to_one_source_pts",
        "audio": "none",
    }


class EdgeControlProvider(BaseProvider):
    """CPU control-asset generation, independent of model conditioning."""

    provider_id = "media.edge_control"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Advertise the input and derived white-on-black Canny sequence."""
        del settings
        return video.describe(
            cls.provider_id,
            "Canny edge control sequence",
            PARAMS,
            [
                Port(
                    "control",
                    "media.video.v1",
                    transport="file",
                    description="Frame-aligned Canny edge sequence (MP4)",
                )
            ],
        )

    def invoke(self, ctx: RunContext) -> None:
        """Encode and verify the control asset before exposing it to other graph steps."""
        options = video.values(ctx, PARAMS)
        if options["low"] > options["high"]:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "The low edge threshold must not exceed the high threshold.",
            )
        try:
            with ctx.recorder.phase("input"):
                source = video.inspect(ctx)
            with video.workspace(ctx) as root:
                path = Path(root) / "edge.mp4"
                with ctx.recorder.phase("edge"):
                    metadata = _render(ctx, source, path, options)
                video.publish(ctx, "control", "video/mp4", path, metadata)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="Edge sequence") from exc
