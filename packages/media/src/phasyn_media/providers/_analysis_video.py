"""Bounded decoding and evidence publication shared by the CPU take and control providers."""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise
from math import ceil
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    Description,
    OutputFile,
    Port,
    RunContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording

from ..errors import MediaError
from ..files import LocalFile, check_local_file, unchanged_since
from ..limits import DEFAULT_LIMITS
from ..probe import MediaInfo, probe, run_ffprobe_json
from ..tools import find_ffmpeg, input_url, redact, run_tool, summarize_stderr


def describe(
    provider: str, label: str, parameters: dict[str, Any], outputs: list[Port]
) -> Description:
    """Declare CPU ports and settings without starting FFmpeg or reading media."""
    return Description(
        provider_id=provider,
        kind="media.prepare",
        label=label,
        inputs=[
            Port(
                "video", "media.video.v1", transport="file", description="Source video"
            )
        ],
        outputs=outputs,
        parameters_schema={
            "type": "object",
            "properties": parameters,
            "additionalProperties": False,
        },
        settings_schema=settings_schema(
            invoke_properties=parameters, device_kinds=("cpu",)
        ),
        default_settings={
            "load": {
                "device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-media"}
            },
            "invoke": {},
            "recording": normalize_recording({"mode": "detailed"}),
        },
    )


def values(ctx: RunContext, schema: dict[str, Any]) -> dict[str, float]:
    """Read bounded numeric options; reject booleans, NaN and unknown parameters."""
    if set(ctx.parameters) - schema.keys():
        raise ComponentError("INVALID_ARGUMENT", "Unknown media analysis parameters.")
    parsed = {}
    for key, definition in schema.items():
        value = ctx.parameters.get(key, definition["default"])
        if (
            type(value) not in (int, float)
            or not definition["minimum"] <= value <= definition["maximum"]
        ):
            raise ComponentError("INVALID_ARGUMENT", f"Invalid value for {key}.")
        parsed[key] = float(value)
    return parsed


def number(default: float, minimum: float, maximum: float) -> dict[str, Any]:
    """Describe a bounded numeric setting."""
    return {
        "type": "number",
        "default": default,
        "minimum": minimum,
        "maximum": maximum,
    }


@dataclass(frozen=True)
class Clock:
    """Exact source-relative presentation times of every decoded frame plus the exclusive end."""

    ticks: list[int]
    time_base: Fraction
    first_pts: int

    @property
    def count(self) -> int:
        return len(self.ticks) - 1

    def seconds(self, frame: int) -> Fraction:
        return self.ticks[frame] * self.time_base

    def frame_at_us(self, timestamp: int) -> int:
        """Resolve a source-relative SAM mark, including its one-microsecond boundary tolerance."""
        at = Fraction(timestamp, 1_000_000) / self.time_base
        if timestamp < 0 or at >= self.ticks[-1]:
            raise ValueError("time_us is outside the source video.")
        index = bisect_right(self.ticks, at) - 1
        if index + 1 < self.count and timestamp >= self.mark_boundary_us(index + 1):
            index += 1
        return index

    def mark_boundary_us(self, frame: int) -> int:
        """First integer microsecond mapping to a frame, or the exclusive source end."""
        start = self.seconds(frame) * 1_000_000
        if 0 < frame < self.count:
            start = max(self.seconds(frame - 1) * 1_000_000, start - 1)
        return ceil(start)


def read_clock(path: Path, ctx: RunContext) -> Clock:
    """Measure decoded presentation timestamps and last frame duration for CFR or VFR video."""
    ctx.check_cancelled()
    limits = DEFAULT_LIMITS
    data = run_ffprobe_json(
        path,
        [
            "-select_streams",
            "V:0",
            "-show_frames",
            "-show_entries",
            "stream=time_base,start_pts,duration_ts:frame=best_effort_timestamp,duration,pkt_duration,width,height",
        ],
        limits=limits,
        cancel=ctx.cancel_token,
        timeout=min(ctx.remaining_seconds(), limits.process_timeout_seconds),
        max_output_bytes=limits.max_tool_output_bytes,
    )
    records = data.get("frames") or []
    if not 0 < len(records) <= limits.max_frames:
        raise MediaError(
            "INVALID_ARGUMENT", "A bounded, nonempty decoded video is required."
        )
    try:
        stream = data["streams"][0]
        base = Fraction(stream["time_base"])
        first = int(records[0]["best_effort_timestamp"])
        ticks = [int(frame["best_effort_timestamp"]) - first for frame in records]
        if any(
            (frame.get("width"), frame.get("height"))
            != (records[0].get("width"), records[0].get("height"))
            for frame in records
        ):
            raise MediaError(
                "UNSUPPORTED_COMBINATION",
                "Video frame dimensions change within the stream.",
            )
        last = records[-1]
        duration = int(last.get("duration") or last.get("pkt_duration") or 0)
        if duration > 0:
            ticks.append(ticks[-1] + duration)
        else:
            ticks.append(int(stream["start_pts"]) + int(stream["duration_ts"]) - first)
    except (IndexError, KeyError, ValueError, ZeroDivisionError, TypeError) as exc:
        raise MediaError(
            "UNSUPPORTED_COMBINATION",
            "Cannot establish a complete presentation clock for this video.",
        ) from exc
    if (
        base <= 0
        or any(b <= a for a, b in pairwise(ticks))
        or ticks[-1] * base > limits.max_duration_seconds
    ):
        raise MediaError(
            "UNSUPPORTED_COMBINATION",
            "Video does not have a supported, strictly increasing presentation clock.",
        )
    return Clock(ticks, base, first)


@dataclass(frozen=True)
class Source:
    """Verified video file and its frame clock."""

    file: LocalFile
    metadata: dict[str, Any]
    clock: Clock
    info: MediaInfo


def inspect(ctx: RunContext) -> Source:
    """Probe the resolved file and capture its identity and actual geometry."""
    item = ctx.input("video")
    if item.file is None:
        raise ComponentError("INVALID_ARGUMENT", "A video FileRef is required.")
    ref = item.file
    local = check_local_file(ctx.resolve_file(ref), limits=DEFAULT_LIMITS)
    info = probe(local.path, count_frames=False, cancel=ctx.cancel_token)
    if info.kind != "video" or not all(
        (info.width, info.height, info.fps_num, info.fps_den)
    ):
        raise MediaError(
            "INVALID_ARGUMENT",
            "A video with known frame rate and dimensions is required.",
        )
    clock = read_clock(local.path, ctx)
    meta = {
        "source_node_id": ref["node_id"],
        "source_file_id": ref["file_id"],
        "source_sha256": ref["sha256"],
        "source_size_bytes": ref["size_bytes"],
        "source_width": info.width,
        "source_height": info.height,
        "source_rotation_degrees": info.rotation_degrees or 0,
        "source_frame_count": clock.count,
        "source_fps": {"num": info.fps_num, "den": info.fps_den},
        "source_time_base": {
            "num": clock.time_base.numerator,
            "den": clock.time_base.denominator,
        },
        "source_first_pts": clock.first_pts,
        "source_duration_ticks": clock.ticks[-1],
    }
    return Source(local, meta, clock, info)


def ffmpeg(ctx: RunContext, arguments: list[str], marks: Mapping[str, str]) -> bytes:
    """Run FFmpeg with the remaining call deadline, cancellation and bounded captured bytes."""
    ctx.check_cancelled()
    limits = DEFAULT_LIMITS
    run = run_tool(
        [find_ffmpeg(), *arguments],
        timeout=min(ctx.remaining_seconds(), limits.process_timeout_seconds),
        cancel=ctx.cancel_token,
        max_stdout_bytes=limits.max_tool_output_bytes,
        max_stderr_bytes=limits.max_stderr_bytes,
        what="FFmpeg media analysis",
    )
    if run.returncode:
        raise MediaError(
            "MEDIA_TOOL_FAILED", summarize_stderr(redact(run.stderr, marks), 800)
        )
    return run.stdout


def tool_version(ctx: RunContext) -> str:
    """Identify the actual executable used for this call."""
    return (
        ffmpeg(ctx, ["-version"], {}).decode("utf-8", "replace").splitlines()[0][:200]
    )


def transform(ctx: RunContext, source: Source, graph: str, output: list[str]) -> bytes:
    """Decode the selected video only, with file demuxer/decoder limits and one filter thread."""
    url = input_url(source.file.path)
    args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-xerror",
        "-filter_threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        DEFAULT_LIMITS.format_whitelist,
        *DEFAULT_LIMITS.decoder_flags,
        "-i",
        url,
        "-map",
        "0:V:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        graph,
        *output,
    ]
    marks = {url: "<input>", str(source.file.path): "<input>"}
    if output[-1] != "-":
        marks[output[-1]] = "<output>"
    result = ffmpeg(ctx, args, marks)
    if not unchanged_since(source.file):
        raise MediaError(
            "INTEGRITY_MISMATCH", "Video file changed while it was being analyzed."
        )
    return result


def workspace(ctx: RunContext) -> TemporaryDirectory[str]:
    """Use a private directory so FFmpeg can publish only a verified, complete artifact."""
    root = Path(ctx.work_dir)
    root.mkdir(parents=True, exist_ok=True)
    return TemporaryDirectory(dir=root)


def publish(
    ctx: RunContext, name: str, media_type: str, path: Path, metadata: dict[str, Any]
) -> OutputFile:
    """Transfer validated media into the provider's atomic output transaction."""
    with path.open("rb") as handle:
        output = ctx.new_file(name, media_type, metadata)
        while block := handle.read(1 << 20):
            ctx.check_cancelled()
            output.write(block)
        ctx.set_file_output(name, output)
        return output
