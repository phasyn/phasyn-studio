"""Encode a lossless silent mask with the original frame timestamps and publish provenance."""

from __future__ import annotations

import hashlib
import json
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING, Any

import av
import numpy as np
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_media.providers._analysis_video import publish, read_clock
from PIL import Image

from .model import ENGINE, FILE, REPO, REVISION


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext
    from phasyn_media.providers._analysis_video import Source

    from .annotations import Annotations


def _encode(
    ctx: RunContext, path: Path, folder: Path, source: Source, coverage: range
) -> None:
    clock = source.clock
    width, height = source.metadata["source_width"], source.metadata["source_height"]
    # MOV stores integer track ticks. Select a timescale that represents every native
    # timestamp, including a nonzero starting PTS and the last sample's duration.
    scale = clock.time_base.denominator
    base = Fraction(1, scale)
    pts = [
        (clock.first_pts + offset) * clock.time_base.numerator for offset in clock.ticks
    ]
    durations = {p: q - p for p, q in pairwise(pts)}
    rate = Fraction(
        source.metadata["source_fps"]["num"], source.metadata["source_fps"]["den"]
    )
    options = {
        "video_track_timescale": str(scale),
        "movie_timescale": str(scale),
        "use_editlist": "1",
        "avoid_negative_ts": "disabled",
    }
    # PNG in MOV is lossless and supports odd native dimensions. One input sample
    # yields one intra packet: set the duration explicitly, including the last sample.
    with av.open(str(path), "w", format="mov", options=options) as mux:
        stream = mux.add_stream("png", rate=rate)
        stream.width, stream.height = width, height
        stream.pix_fmt = "gray"
        stream.time_base = base
        stream.codec_context.time_base = base
        stream.codec_context.thread_count = 1
        blank = Image.new("L", (width, height))

        def packet_out(packet: Any) -> None:
            if packet.pts not in durations or packet.time_base != base:
                raise ComponentError(
                    "MEDIA_INCOMPLETE", "Mask encoder changed a source timestamp."
                )
            packet.duration = durations[packet.pts]
            mux.mux(packet)

        for index in range(clock.count):
            ctx.check_cancelled()
            if index in coverage:
                with Image.open(folder / f"{index}.png", formats=["PNG"]) as image:
                    frame = av.VideoFrame.from_ndarray(np.asarray(image), format="gray")
            else:
                frame = av.VideoFrame.from_ndarray(np.asarray(blank), format="gray")
            frame.pts, frame.time_base = pts[index], base
            for packet in stream.encode(frame):
                packet_out(packet)
        for packet in stream.encode():
            packet_out(packet)
    output = read_clock(path, ctx)
    if output.count != clock.count or any(
        (output.first_pts + right) * output.time_base
        != (clock.first_pts + left) * clock.time_base
        for left, right in zip(clock.ticks, output.ticks, strict=True)
    ):
        raise ComponentError(
            "MEDIA_INCOMPLETE",
            "Delivered mask does not preserve the source presentation clock.",
        )


def deliver(
    ctx: RunContext, path: Path, masks: Path, source: Source, hints: Annotations
) -> None:
    """Publish a typed binary video and an independently reusable edit document."""
    coverage = hints.active_range(source.clock.count)
    _encode(ctx, path, masks, source, coverage)
    document = hints.document
    digest = hashlib.sha256(
        json.dumps(
            document, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    ).hexdigest()
    metadata = {
        "method": "sam2_video_segmentation",
        "source_sha256": source.metadata["source_sha256"],
        "annotations_sha256": digest,
        "model_sha256": FILE.sha256,
        "object_id": hints.object_id,
    }
    result = publish(ctx, "mask_video", "video/quicktime", path, metadata)
    result_ref = ctx.file_ref(result)
    clock = source.clock
    mapping = {
        "version": 1,
        "source": source.metadata,
        "mask": result_ref,
        "annotations": document,
        "annotations_sha256": digest,
        "resolved_mark_frames": [mark.frame for mark in hints.marks],
        "frame_pts": [clock.first_pts + t for t in clock.ticks[:-1]],
        "end_pts_exclusive": clock.first_pts + clock.ticks[-1],
        "tracked_range": [coverage.start, coverage.stop],
        "outside_tracked_range": "black",
        "mask_values": {"background": 0, "object": 255},
        "threshold": "logit > 0",
        "model": {
            "repo": REPO,
            "revision": REVISION,
            "sha256": FILE.sha256,
            "sam2_commit": ENGINE,
        },
        "input_encoding": "jpeg_q2",
        "output_encoding": "png_gray_in_mov",
        "has_audio": False,
    }
    report = ctx.new_file("mapping", "application/json", metadata)
    report.write(
        json.dumps(mapping, ensure_ascii=False, allow_nan=False).encode("utf-8")
    )
    ctx.set_file_output("mapping", report)
    asset = {
        "asset_id": new_id(),
        "kind": "final",
        "file": result_ref,
        "complete": True,
        "source_latent": None,
        "frame_count": clock.count,
        "fps": source.metadata["source_fps"],
        "width": source.info.width,
        "height": source.info.height,
        "has_audio": False,
        "actual_settings": {
            "segmentation": {**metadata, "mapping": ctx.file_ref(report)}
        },
    }
    contracts.validate("Asset", asset, code="RUNTIME_ERROR", what="SAM 2 object mask")
    ctx.set_output("asset", asset)
