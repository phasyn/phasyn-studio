"""Report black and stationary spans at decoded source frame indices, with PNG evidence."""

from __future__ import annotations

import json
from collections.abc import Mapping
from fractions import Fraction
from pathlib import Path
from typing import Any

from phasyn_components.provider import BaseProvider, Description, Port, RunContext

from ..errors import MediaError
from ..probe import probe
from ..tools import input_url
from . import _analysis_video as video
from ._failure import media_failure


PARAMS = {
    "min_seconds": video.number(0.5, 0.04, 60),
    "black_ratio": video.number(0.98, 0.5, 1),
    "black_luma": video.number(0.10, 0, 1),
    "freeze_noise": video.number(0.001, 0, 0.2),
}
_TAGS = {
    "lavfi.black_start": ("black", True),
    "lavfi.black_end": ("black", False),
    "lavfi.freezedetect.freeze_start": ("freeze", True),
    "lavfi.freezedetect.freeze_end": ("freeze", False),
}
_MAX_TILES = 12
_COLUMNS = 4
_TILE_WIDTH = 256
_TILE_HEIGHT = 144


def _intervals(data: bytes, count: int) -> list[tuple[int, int, str]]:
    """Read detector event values on a synthetic one-second-per-frame clock, including EOF."""
    opening: dict[str, int] = {}
    spans: list[tuple[int, int, str]] = []
    for line in data.decode("ascii", "replace").splitlines():
        tag, _, value = line.partition("=")
        event = _TAGS.get(tag)
        if event is None:
            continue
        kind, start = event
        point = Fraction(value)
        if point.denominator != 1 or not 0 <= point < count:
            raise MediaError(
                "MEDIA_INCOMPLETE",
                "The signal detector reported an unknown source frame.",
            )
        index = int(point)
        if start and kind not in opening:
            opening[kind] = index
        elif not start and kind in opening:
            spans.append((opening.pop(kind), index, kind))
        else:
            raise MediaError(
                "MEDIA_INCOMPLETE",
                "The signal detector emitted inconsistent interval boundaries.",
            )
    spans.extend((start, count, kind) for kind, start in opening.items())
    return sorted(spans)


def _scan(
    ctx: RunContext, source: video.Source, settings: dict[str, float]
) -> list[dict[str, Any]]:
    # The detector returns timestamp strings with limited decimal precision. Give it exact integral
    # frame indices; the true decoded PTS clock below determines duration, including for VFR.
    graph = (
        f"metadata=mode=delete,settb=1/1,setpts=N,blackdetect=d=0:pic_th={settings['black_ratio']}:pix_th={settings['black_luma']},"
        f"freezedetect=n={settings['freeze_noise']}:d=1,metadata=mode=print:file=-"
    )
    data = video.transform(
        ctx, source, graph, ["-fps_mode", "passthrough", "-f", "null", "-"]
    )
    clock = source.clock
    minimum = Fraction(str(settings["min_seconds"]))
    return [
        {
            "kind": kind,
            "start_frame": start,
            "end_frame": end,
            "start_seconds": float(clock.seconds(start)),
            "end_seconds": float(clock.seconds(end)),
            "start_tick": clock.ticks[start],
            "end_tick": clock.ticks[end],
            "evidence_frame": (start + end - 1) // 2,
        }
        for start, end, kind in _intervals(data, clock.count)
        if clock.seconds(end) - clock.seconds(start) >= minimum
    ]


def _tiles(findings: list[dict[str, Any]]) -> list[int]:
    """Limit thumbnails while retaining a source frame index for every event."""
    frames = sorted({int(item["evidence_frame"]) for item in findings}) or [0]
    if len(frames) > _MAX_TILES:
        frames = [
            frames[i * (len(frames) - 1) // (_MAX_TILES - 1)] for i in range(_MAX_TILES)
        ]
    indices = {frame: i for i, frame in enumerate(frames)}
    for item in findings:
        item["evidence_tile"] = indices.get(item["evidence_frame"])
    return frames


def _sheet(
    ctx: RunContext, source: video.Source, frames: list[int], path: Path
) -> dict[str, Any]:
    columns = min(_COLUMNS, len(frames))
    rows = (len(frames) + columns - 1) // columns
    select = "+".join(f"eq(n\\,{n})" for n in frames)
    graph = (
        f"select={select},scale={_TILE_WIDTH}:{_TILE_HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={_TILE_WIDTH}:{_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,tile={columns}x{rows}:nb_frames={len(frames)}"
    )
    video.transform(
        ctx,
        source,
        graph,
        [
            "-frames:v",
            "1",
            "-c:v",
            "png",
            "-threads",
            "1",
            "-pix_fmt",
            "rgb24",
            "-update",
            "1",
            "-f",
            "image2",
            "-n",
            input_url(path),
        ],
    )
    image = probe(path, cancel=ctx.cancel_token)
    if image.kind != "image" or (image.width, image.height) != (
        columns * _TILE_WIDTH,
        rows * _TILE_HEIGHT,
    ):
        raise MediaError(
            "MEDIA_INCOMPLETE",
            "The evidence image did not match the expected tile geometry.",
        )
    return {
        "frames": frames,
        "columns": columns,
        "rows": rows,
        "tile_width": _TILE_WIDTH,
        "tile_height": _TILE_HEIGHT,
        "width": image.width,
        "height": image.height,
    }


class TakeAnalysisProvider(BaseProvider):
    """Technical checks for human review; intentional holds and black frames remain valid."""

    provider_id = "media.take_analysis"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Advertise a structured review document and a contact sheet of decoded evidence."""
        del settings
        return video.describe(
            cls.provider_id,
            "Black and stationary frame review",
            PARAMS,
            [
                Port(
                    "report",
                    "media.take_analysis.v1",
                    transport="file",
                    description="JSON findings with source frame/time ranges",
                ),
                Port(
                    "evidence",
                    "media.image.v1",
                    transport="file",
                    description="PNG contact sheet of source frames",
                ),
            ],
        )

    def invoke(self, ctx: RunContext) -> None:
        """Create both files through the Node's atomic output transaction."""
        settings = video.values(ctx, PARAMS)
        try:
            with ctx.recorder.phase("input"):
                source = video.inspect(ctx)
                version = video.tool_version(ctx)
            with ctx.recorder.phase("analyze"):
                findings = _scan(ctx, source, settings)
                frames = _tiles(findings)
            with video.workspace(ctx) as root:
                path = Path(root) / "evidence.png"
                with ctx.recorder.phase("evidence"):
                    sheet = _sheet(ctx, source, frames, path)
                common = {
                    **source.metadata,
                    "ffmpeg_version": version,
                    "settings": settings,
                }
                image = video.publish(
                    ctx,
                    "evidence",
                    "image/png",
                    path,
                    {**common, **sheet, "role": "take_review_evidence"},
                )
                report = ctx.new_file(
                    "report",
                    "application/json",
                    {**common, "finding_count": len(findings)},
                )
                document = {
                    **common,
                    "schema": "media.take_analysis.v1",
                    "findings": findings,
                    "evidence_frames": frames,
                    "evidence": {
                        **sheet,
                        "port": "evidence",
                        "file_id": image.file_id,
                        "sha256": image.sha256,
                        "size_bytes": image.size,
                    },
                    "frame_range": "half_open",
                    "disposition": "review",
                }
                report.write(
                    json.dumps(document, ensure_ascii=False, allow_nan=False).encode(
                        "utf-8"
                    )
                )
                ctx.set_file_output("report", report)
        except MediaError as exc:
            raise media_failure(ctx, exc, what="Take review") from exc
