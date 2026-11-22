"""Bounded source inspection, RGB decoding and transactional silent clip delivery."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
from phasyn_components.errors import ComponentError
from phasyn_media.encode import EncodedTrack, StreamingVideoEncoder
from phasyn_media.errors import MediaError
from phasyn_media.files import LocalFile, check_local_file, unchanged_since
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.probe import probe
from phasyn_media.timeline import check_video_stream, scan_timeline
from phasyn_media.tools import find_ffmpeg, input_url, run_tool
from PIL import Image


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext


@dataclass(frozen=True)
class Source:
    """A resolved media port and its verified frame geometry and display clock."""

    local: LocalFile
    identity: dict[str, Any]
    width: int
    height: int
    count: int
    fps: Fraction | None
    has_audio: bool
    start_seconds: float

    def record(self) -> dict[str, Any]:
        """Serialize the original clock and content identity for the edit decision."""
        return {
            **self.identity,
            "width": self.width,
            "height": self.height,
            "frames": self.count,
            "has_audio": self.has_audio,
            "start_seconds": self.start_seconds,
            "fps": rate(self.fps) if self.fps is not None else None,
        }


def rate(fps: Fraction) -> dict[str, int]:
    """Serialize an exact playback rate."""
    return {"num": fps.numerator, "den": fps.denominator}


def inspect(ctx: RunContext, name: str) -> Source:
    """Resolve a real file and require one non-rotated image or a provable CFR video stream."""
    value = ctx.input(name)
    if value.file is None:
        raise ComponentError("INVALID_ARGUMENT", f"{name} needs a FileRef")
    local = check_local_file(value.require_path(name))
    info = probe(local.path, count_frames=False, cancel=ctx.cancel_token)
    kind = "video" if name in {"source", "control", "mask_video"} else "image"
    if (
        info.kind != kind
        or not info.width
        or not info.height
        or info.video_streams != 1
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", f"{name} requires exactly one {kind} stream"
        )
    if info.rotation_degrees not in (None, 0):
        raise ComponentError(
            "UNSUPPORTED_SETTING", "Flatten rotation metadata before using a VACE input"
        )
    identity = {key: value.file[key] for key in ("node_id", "file_id", "sha256")}
    if kind == "image":
        return Source(
            local,
            identity,
            info.width,
            info.height,
            1,
            None,
            has_audio=False,
            start_seconds=0.0,
        )
    if not info.fps_num or not info.fps_den:
        raise ComponentError(
            "INVALID_ARGUMENT", "The source has no verified frame rate"
        )
    fps = Fraction(info.fps_num, info.fps_den)
    timeline = scan_timeline(local.path, expected_fps=fps, cancel=ctx.cancel_token)
    streams = timeline.of_type("video")
    if len(streams) != 1:
        raise ComponentError(
            "INVALID_ARGUMENT", "A single source video stream is required"
        )
    checked = check_video_stream(
        streams[0], fps=fps, width=info.width, height=info.height
    )
    return Source(
        local,
        identity,
        info.width,
        info.height,
        checked.frames,
        fps,
        info.has_audio,
        checked.start_seconds,
    )


def decode(
    ctx: RunContext,
    source: Source,
    span: range,
    canvas: tuple[int, int],
    *,
    matte: bool = False,
) -> list[Image.Image]:
    """Decode a bounded set of RGB pictures or nearest-neighbor single-channel masks."""
    if span.step != 1 or span.start < 0 or span.stop > source.count or not span:
        raise ComponentError(
            "INVALID_ARGUMENT", "Requested frames fall outside the source"
        )
    width, height = canvas
    mode, pixel_format, channels = ("L", "gray", 1) if matte else ("RGB", "rgb24", 3)
    frame_bytes = width * height * channels
    # The output sink holds at most one partial frame. The job's bounded model window owns the PIL images.
    buffer = bytearray()
    images: list[Image.Image] = []

    def accept(chunk: bytes) -> None:
        if len(images) * frame_bytes + len(buffer) + len(chunk) > frame_bytes * len(
            span
        ):
            raise MediaError(
                "RESOURCE_EXHAUSTED", "Decoded frames exceed the VACE window"
            )
        buffer.extend(chunk)
        while len(buffer) >= frame_bytes:
            images.append(Image.frombytes(mode, canvas, bytes(buffer[:frame_bytes])))
            del buffer[:frame_bytes]

    limits = DEFAULT_LIMITS
    resize = (
        f"scale={width}:{height}:flags=neighbor"
        if matte
        else f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    )
    filters = f"trim=start_frame={span.start}:end_frame={span.stop},{resize},setsar=1"
    result = run_tool(
        [
            find_ffmpeg(),
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            limits.format_whitelist,
            *limits.decoder_flags,
            "-noautorotate",
            "-i",
            input_url(source.local.path),
            "-map",
            "0:V:0",
            "-an",
            "-vf",
            filters,
            "-frames:v",
            str(len(span)),
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            pixel_format,
            "-f",
            "rawvideo",
            "pipe:1",
        ],
        cancel=ctx.cancel_token,
        timeout=min(ctx.remaining_seconds(), limits.process_timeout_seconds),
        max_stdout_bytes=frame_bytes * len(span),
        max_stderr_bytes=limits.max_stderr_bytes,
        stdout_sink=accept,
    )
    if (
        result.returncode
        or buffer
        or len(images) != len(span)
        or not unchanged_since(source.local)
    ):
        raise MediaError(
            "MEDIA_INCOMPLETE", "Source changed or did not decode the requested frames"
        )
    return images


def encode(
    ctx: RunContext, path: Path, frames: list[Image.Image], fps: Fraction
) -> EncodedTrack:
    """Encode one new, verified silent MP4 through the shared media owner."""
    width, height = frames[0].size
    with StreamingVideoEncoder(
        path,
        width=width,
        height=height,
        fps_num=fps.numerator,
        fps_den=fps.denominator,
        expected_frames=len(frames),
        cancel=ctx.cancel_token,
    ) as writer:
        for frame in frames:
            ctx.check_cancelled()
            if frame.size != (width, height):
                raise ComponentError(
                    "INTEGRITY_MISMATCH", "VACE returned varying frame sizes"
                )
            writer.write_chunk(np.asarray(frame.convert("RGB"))[None, ...])
        return writer.finish()
