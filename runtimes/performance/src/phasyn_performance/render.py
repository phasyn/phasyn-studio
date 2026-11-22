"""Decode a bounded CFR performance and publish a control sequence or animated portrait."""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, BinaryIO

import numpy as np
from phasyn_captioner.upscale.video import (
    FrameReader,
    SourceVideo,
    attach_audio,
    inspect_source,
)
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import RunContext
from phasyn_media.encode import StreamingVideoEncoder
from phasyn_media.files import file_sha256
from phasyn_media.limits import DEFAULT_LIMITS

from .capture import WEIGHTS, Capture
from .mesh import CharacterMesh, Frame, skeleton


LIMITS = replace(
    DEFAULT_LIMITS,
    max_width=2048,
    max_height=2048,
    max_pixels=2048 * 1080,
    max_frames=900,
)
MIN_IMAGE_SIDE = 32


def _character(path: Path, detector: Capture) -> CharacterMesh:
    image_module = import_module("PIL.Image")
    with image_module.open(path, formats=["PNG", "JPEG", "WEBP"]) as im:
        width, height = im.size
        if (
            min(width, height) < MIN_IMAGE_SIDE
            or width * height > LIMITS.max_pixels
            or max(width, height) > LIMITS.max_width
            or width % 2
            or height % 2
        ):
            raise ComponentError(
                "UNSUPPORTED_COMBINATION",
                "Portrait dimensions must be even and within the declared limits.",
            )
        if im.getexif().get(274, 1) != 1:
            raise ComponentError(
                "UNSUPPORTED_COMBINATION",
                "Apply the image orientation before using this portrait.",
            )
        rgb = np.asarray(im.convert("RGB"))
    points = detector.detect(rgb, -1)["points"]
    if not points:
        raise ComponentError(
            "INVALID_ARGUMENT", "No subject detected in the reference portrait."
        )
    return CharacterMesh(rgb, points, detector.edges, body=detector.kind == "pose")


def _bytes(obj: Any) -> bytes:
    return json.dumps(
        obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode()


@dataclass(frozen=True)
class _CaptureOutputs:
    track: Path
    record: BinaryIO


def _frames(
    ctx: RunContext,
    detector: Capture,
    subject: CharacterMesh | None,
    source: SourceVideo,
    outputs: _CaptureOutputs,
) -> int:
    width, height = (
        (subject.width, subject.height) if subject else (source.width, source.height)
    )
    detected = 0
    with (
        StreamingVideoEncoder(
            outputs.track,
            width=width,
            height=height,
            fps_num=source.fps.numerator,
            fps_den=source.fps.denominator,
            expected_frames=source.frames,
            max_queue_chunks=2,
            cancel=ctx.cancel_token,
            limits=LIMITS,
        ) as encoder,
        FrameReader(source, cancel=ctx.cancel_token, limits=LIMITS) as reader,
    ):
        for i, frame in enumerate(reader.frames()):
            ctx.check_cancelled()
            data = detector.detect(frame, i)
            points = data["points"]
            detected += bool(points)
            if subject and not points:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "Subject lost in the driving video.",
                    details={"frame": i},
                )
            if i:
                outputs.record.write(b",")
            outputs.record.write(_bytes(data))
            rendered: Frame = (
                subject.animate(
                    points,
                    (source.width, source.height),
                    ctx.parameters.get("strength", 1.0),
                )
                if subject
                else skeleton(frame, points, detector.edges)
            )
            encoder.write_chunk(rendered[None, ...])
        if detected == 0:
            raise ComponentError(
                "INVALID_ARGUMENT", "No subject was detected in the driving video."
            )
        encoder.finish()
    return detected


def render(ctx: RunContext, detector: Capture, *, animate: bool) -> None:
    """Publish the measured JSON and video outputs of the same decoded sequence."""
    video = ctx.input("video_file")
    source = inspect_source(
        video.require_path("video_file"), cancel=ctx.cancel_token, limits=LIMITS
    )
    if source.frames > LIMITS.max_frames:
        raise ComponentError(
            "INVALID_ARGUMENT", "The driving video exceeds the frame limit."
        )
    ref = ctx.input("character") if animate else None
    subject = _character(ref.require_path("character"), detector) if ref else None
    width, height = (
        (subject.width, subject.height) if subject else (source.width, source.height)
    )
    metadata = {
        "kind": detector.kind,
        "method": "relative_2d_mesh" if subject else "landmark_edges",
        "model_sha256": WEIGHTS[detector.kind][2],
        "mediapipe": detector.mp.__version__,
        "driving": video.file,
        "character": ref.file if ref else None,
        "fps": {"num": source.fps.numerator, "den": source.fps.denominator},
        "frames": source.frames,
        "width": width,
        "height": height,
        "driving_width": source.width,
        "driving_height": source.height,
        "connections": detector.edges,
        "copy_audio": bool(
            subject and source.audio and ctx.parameters.get("copy_audio", True)
        ),
        "strength": ctx.parameters.get("strength", 1.0) if subject else None,
    }
    ctx.work_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=ctx.work_dir) as temp:
        folder = Path(temp)
        track = folder / "capture.mp4"
        report = folder / "points.json"
        with report.open("wb") as record:
            record.write(
                b'{"schema":"media.landmarks.v1","metadata":'
                + _bytes(metadata)
                + b',"frames":['
            )
            count = _frames(
                ctx, detector, subject, source, _CaptureOutputs(track, record)
            )
            record.write(b'],"detected_frames":' + _bytes(count) + b"}")
        video_out = track
        if metadata["copy_audio"]:
            video_out = folder / "with-audio.mp4"
            attach_audio(
                track,
                source,
                video_out,
                frames=source.frames,
                cancel=ctx.cancel_token,
                limits=LIMITS,
            )
        ctx.check_cancelled()
        result = ctx.new_file(
            None,
            "video/mp4",
            {"model_sha256": WEIGHTS[detector.kind][2], "method": metadata["method"]},
            type_id="media.video.v1",
        )
        digest, size = file_sha256(video_out, cancel=ctx.cancel_token)
        result.adopt_file(video_out, sha256=digest, size=size)
        report_out = ctx.new_file(
            None,
            "application/json",
            {"model_sha256": WEIGHTS[detector.kind][2]},
            type_id="media.landmarks.v1",
        )
        digest, size = file_sha256(report, cancel=ctx.cancel_token)
        report_out.adopt_file(report, sha256=digest, size=size)
    actual = {
        **metadata,
        "detected_frames": count,
        "landmarks": ctx.file_ref(report_out),
    }
    asset = {
        "asset_id": new_id(),
        "kind": "final",
        "file": ctx.file_ref(result),
        "source_latent": None,
        "complete": True,
        "frame_count": source.frames,
        "fps": metadata["fps"],
        "width": width,
        "height": height,
        "actual_settings": {"performance": actual},
    }
    contracts.validate("Asset", asset, code="RUNTIME_ERROR", what="Performance asset")
    ctx.set_output("asset", asset)
    ctx.set_file_output("video_file", result)
    ctx.set_file_output("landmarks", report_out)
