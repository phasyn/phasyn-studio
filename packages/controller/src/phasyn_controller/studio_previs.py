"""Validate references and keyframe ordering in the shot's optional composition."""

from __future__ import annotations

from itertools import pairwise
from typing import Any

from phasyn_components.errors import ComponentError


def _crosses_target(keys: list[dict[str, Any]]) -> bool:
    """Find any sampled frame whose camera and target coincide, including between two keys."""
    positions = [
        (key["frame"], tuple(key[k] - key[f"target_{k}"] for k in ("x", "y", "z")))
        for key in keys
    ]
    threshold_sq = 1e-8
    if any(sum(x * x for x in start) < threshold_sq for _, start in positions):
        return True
    for (first, start), (last, end) in pairwise(positions):
        span = last - first
        delta = tuple(b - a for a, b in zip(start, end, strict=True))
        norm_sq = sum(x * x for x in delta)
        if span <= 0 or not norm_sq:
            continue
        closest = -sum(a * d for a, d in zip(start, delta, strict=True)) / norm_sq
        frame = round(min(1.0, max(0.0, closest)) * span)
        if (
            sum((a + d * frame / span) ** 2 for a, d in zip(start, delta, strict=True))
            < threshold_sq
        ):
            return True
    return False


def validate_previs(project: dict[str, Any]) -> None:
    """Reject malformed planes and dangling image references after JSON Schema validation."""
    images = {
        item["item_id"]
        for item in project.get("library", ())
        if item["kind"] == "image"
    }
    for shot in project["shots"]:
        scene = shot.get("previs")
        if scene is None:
            continue
        details = {"shot_id": shot["shot_id"]}
        if _crosses_target(scene.get("lens_keys", [])):
            raise ComponentError(
                "INVALID_ARGUMENT",
                "攝影機位置與瞄準點重合，請調整其中一項。",
                details=details,
            )
        ids: set[str] = set()
        tracks = [scene["camera"], scene.get("lens_keys", ())]
        for layer in scene["layers"]:
            item = layer["item_id"]
            if layer["id"] in ids or (layer["kind"] == "image") != (item is not None):
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "預演圖層的識別或素材設定無效。",
                    details=details,
                )
            if item is not None and item not in images:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "找不到預演使用的素材圖。",
                    details={**details, "item_id": item},
                )
            ids.add(layer["id"])
            tracks.extend((layer["keys"], layer.get("rig_keys", ())))
            if "rig_keys" in layer and layer["kind"] != "puppet":
                raise ComponentError(
                    "INVALID_ARGUMENT", "姿勢關鍵格只能用於立體人偶。", details=details
                )
        for track in tracks:
            if any(a["frame"] >= b["frame"] for a, b in pairwise(track)):
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "預演關鍵格必須依序排列，同一格只能有一個姿勢。",
                    details=details,
                )
