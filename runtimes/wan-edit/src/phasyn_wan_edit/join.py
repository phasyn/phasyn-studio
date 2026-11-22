"""Deliver an extension as one new take: the original clip and the generated frames joined (``deliver = joined``).

The source keeps its own pixels (decoded at its exact size, which is the edit canvas) and its own audio. The new part
is silent: after the clip for ``extend_after``, before it for ``extend_before`` (the original audio is delayed by the
new part's length). A source without audio gives a silent take. The result has ``source + new`` frames.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import TYPE_CHECKING, Any

import numpy as np
from phasyn_components.errors import ComponentError
from phasyn_media.audio_conform import conform_audio
from phasyn_media.encode import EncodedTrack, StreamingVideoEncoder
from phasyn_media.files import file_sha256
from phasyn_media.mux import mux

from .media import Source, decode


if TYPE_CHECKING:
    from pathlib import Path

    from phasyn_components.provider import RunContext
    from PIL import Image

DELIVERIES = ("patch", "joined")
EXTENDS = ("extend_before", "extend_after")
_CHUNK = 24  # source frames decoded per FFmpeg pass (bounded memory)


@dataclass(frozen=True)
class Joined:
    """The joined file and its exact composition."""

    path: Path
    frames: int
    width: int
    height: int
    sha256: str
    size_bytes: int
    has_audio: bool
    record: dict[str, Any]


def delivery(operation: str, parameters: dict[str, Any]) -> str:
    """The requested delivery; ``joined`` only exists for the two extend operations."""
    value = parameters.get("deliver", "patch")
    if value not in DELIVERIES:
        raise ComponentError("INVALID_ARGUMENT", "deliver must be patch or joined")
    if value == "joined" and operation not in EXTENDS:
        raise ComponentError(
            "INVALID_ARGUMENT", "deliver=joined is only defined for extend operations"
        )
    return str(value)


def _source_chunks(source: Source) -> list[range]:
    return [
        range(start, min(start + _CHUNK, source.count))
        for start in range(0, source.count, _CHUNK)
    ]


def _encode(
    ctx: RunContext,
    path: Path,
    source: Source,
    new: list[Image.Image],
    *,
    before: bool,
) -> EncodedTrack:
    canvas = (source.width, source.height)
    if any(frame.size != canvas for frame in new):
        raise ComponentError(
            "INTEGRITY_MISMATCH", "Generated frames differ from the source size"
        )
    fps = source.fps
    if fps is None:
        raise ComponentError(
            "INVALID_ARGUMENT", "The source has no verified frame rate"
        )
    with StreamingVideoEncoder(
        path,
        width=source.width,
        height=source.height,
        fps_num=fps.numerator,
        fps_den=fps.denominator,
        expected_frames=source.count + len(new),
        cancel=ctx.cancel_token,
    ) as writer:

        def write(frames: list[Image.Image]) -> None:
            for frame in frames:
                ctx.check_cancelled()
                writer.write_chunk(np.asarray(frame.convert("RGB"))[None, ...])

        if before:
            write(new)
        for span in _source_chunks(source):
            write(decode(ctx, source, span, canvas))
        if not before:
            write(new)
        return writer.finish()


def join(
    ctx: RunContext,
    work: Path,
    source: Source,
    new: list[Image.Image],
    *,
    operation: str,
) -> Joined:
    """Encode ``source + new`` (or ``new + source``) and carry the source audio with silence for the new part."""
    before = operation == "extend_before"
    fps = source.fps
    if fps is None:
        raise ComponentError(
            "INVALID_ARGUMENT", "The source has no verified frame rate"
        )
    video = _encode(ctx, work / "joined-video.mp4", source, new, before=before)
    total = source.count + len(new)
    if video.frames != total:
        raise ComponentError(
            "INTEGRITY_MISMATCH", "The joined clip has a different frame count"
        )
    record: dict[str, Any] = {
        "deliver": "joined",
        "order": "new_then_source" if before else "source_then_new",
        "source_frames": source.count,
        "new_frames": len(new),
        "frames": total,
        "new_range": [0, len(new)] if before else [source.count, total],
    }
    if not source.has_audio:
        record["audio"] = "none (the source has no audio)"
        return Joined(
            video.path,
            total,
            video.width,
            video.height,
            video.sha256,
            video.size_bytes,
            has_audio=False,
            record=record,
        )
    lead = Fraction(len(new)) / fps if before else Fraction(0)
    track = conform_audio(
        source.local.path,
        work / "joined-audio.wav",
        frames=total,
        fps=fps,
        lead_seconds=lead,
        cancel=ctx.cancel_token,
    )
    out = work / "joined.mp4"
    muxed = mux(
        video_track=video.path,
        pcm=track.path,
        output=out,
        fps_num=fps.numerator,
        fps_den=fps.denominator,
        cancel=ctx.cancel_token,
        expected_source_frames=total,
    )
    video.path.unlink(missing_ok=True)
    track.path.unlink(missing_ok=True)
    sha, size = file_sha256(out, cancel=ctx.cancel_token)
    record["audio"] = "source audio kept, silence for the new frames"
    record["audio_fit"] = track.as_dict()
    return Joined(
        out,
        muxed.delivered_frames,
        source.width,
        source.height,
        sha,
        size,
        has_audio=True,
        record=record,
    )
