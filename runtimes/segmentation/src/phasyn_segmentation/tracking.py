"""Run one bounded native predictor state and retain full-resolution object masks."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import torch
from phasyn_components.errors import ComponentError
from PIL import Image

from .annotations import Annotations


if TYPE_CHECKING:
    from phasyn_components.provider import RunContext
    from phasyn_media.providers._analysis_video import Source


def _save(
    folder: Path, source: Source, token: int, result: tuple[Any, Any, Any]
) -> int:
    index, object_ids, logits = result
    if object_ids != [token] or not 0 <= index < source.clock.count:
        raise ComponentError(
            "INTEGRITY_MISMATCH", "SAM returned an unexpected object or source frame."
        )
    expected = (1, 1, source.info.height, source.info.width)
    if tuple(logits.shape) != expected:
        raise ComponentError(
            "INTEGRITY_MISMATCH", "SAM mask geometry differs from the annotated source."
        )
    mask = (logits[0, 0] > 0).to(torch.uint8).mul_(255).cpu().numpy()
    Image.fromarray(mask).save(folder / f"{index}.png", format="PNG")
    return int(index)


def track(
    ctx: RunContext, predictor: Any, workspace: Path, source: Source, hints: Annotations
) -> None:
    """Apply final corrections, propagate over the requested range and check coverage."""
    masks = workspace / "masks"
    with torch.inference_mode():
        state = predictor.init_state(
            video_path=str(workspace / "frames"),
            offload_video_to_cpu=True,
            offload_state_to_cpu=True,
            async_loading_frames=False,
        )
        try:
            if (state["num_frames"], state["video_width"], state["video_height"]) != (
                source.clock.count,
                source.info.width,
                source.info.height,
            ):
                raise ComponentError(
                    "INTEGRITY_MISMATCH", "The model input frame layout changed."
                )
            produced: set[int] = set()
            for mark in hints.marks:
                ctx.check_cancelled()
                result = predictor.add_new_points_or_box(
                    inference_state=state,
                    frame_idx=mark.frame,
                    obj_id=hints.object_id,
                    points=np.asarray(mark.points, dtype=np.float32)
                    if mark.points
                    else None,
                    labels=np.asarray(mark.labels, dtype=np.int32)
                    if mark.points
                    else None,
                    box=np.asarray(mark.box, dtype=np.float32)
                    if mark.box is not None
                    else None,
                )
                produced.add(_save(masks, source, hints.object_id, result))
            earliest, latest = hints.marks[0].frame, hints.marks[-1].frame
            passes = []
            if hints.direction != "backward":
                passes.append((earliest, False))
            if hints.direction != "forward":
                passes.append((earliest if hints.direction == "both" else latest, True))
            for start, reverse in passes:
                for result in predictor.propagate_in_video(
                    state, start_frame_idx=start, reverse=reverse
                ):
                    ctx.check_cancelled()
                    produced.add(_save(masks, source, hints.object_id, result))
            if produced != set(hints.active_range(source.clock.count)):
                raise ComponentError(
                    "MEDIA_INCOMPLETE",
                    "SAM did not return the full requested propagation interval.",
                )
        finally:
            predictor.reset_state(state)
