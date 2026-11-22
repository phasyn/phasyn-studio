"""``actual_settings`` of a ``media.upscale`` output: method, source identity, sizes, durations and processing notes.

The source is identified by its node, file id and SHA-256 (as the restore and interpolation reports do) and its asset
id, never by a local path. The record must not have the shape of a FileRef (node_id, file_id, sha256 and size_bytes):
adopting the output as a take walks the asset for FileRefs and refuses one without a media type. The timing and memory
blocks are added by the provider after the call.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import plan
from .shader import MethodSpec


def actual_settings(
    provider_id: str,
    method: MethodSpec,
    dtype_name: str,
    tile_pixels: int,
    *,
    ref: Mapping[str, Any],
    asset: Mapping[str, Any] | None,
    source: Any,
    geometry: plan.Geometry,
    params: plan.UpscaleParams,
    track: Any,
    size: int,
    sha256: str,
) -> dict[str, Any]:
    notes = []
    if source.color_assumed:
        notes.append("來源沒有完整的色彩標記：以 BT.709 limited range 解碼")
    if source.pixel_format and any(d in source.pixel_format for d in ("10", "12", "16")):
        notes.append(f"來源像素格式 {source.pixel_format} 以 8-bit RGB 處理")
    if source.dropped_streams:
        notes.append(f"來源另有 {source.dropped_streams} 個非影音串流，沒有帶到輸出")
    return {
        "provider_id": provider_id,
        "upscale": {
            "method": method.method_id,
            "method_label": method.label,
            "license": "MIT",
            "shader_sha256": method.upscale.sha256,
            "shaders": [{"file": f, "sha256": s} for f, s in method.shaders],
            "compute_dtype": dtype_name,
            "tile_pixels": tile_pixels,
            "halo_pixels": method.halo,
            "scale": params.scale,
            "target": params.target,
            "resize": "bicubic+antialias" if geometry.resized else None,
            "source": {
                "asset_id": (asset or {}).get("asset_id"),
                "node_id": ref.get("node_id"),
                "file_id": ref.get("file_id"),
                "sha256": ref.get("sha256"),
                "width": source.width,
                "height": source.height,
                "frames": source.frames,
                "fps": {"num": source.fps.numerator, "den": source.fps.denominator},
                "duration_seconds": float(source.frames / source.fps),
                "pixel_format": source.pixel_format,
                "color": source.color,
                "audio_codec": source.audio.codec if source.audio else None,
            },
            "output": {
                "width": geometry.output_width,
                "height": geometry.output_height,
                "model_width": geometry.model_width,
                "model_height": geometry.model_height,
                "frames": track.frames,
                "duration_seconds": track.duration_seconds,
                "video_codec": "h264",
                "encoder": track.encoder_name,
                "pixel_format": "yuv420p",
                "crf": params.crf,
                "color": "bt709 limited range",
                "audio": "copied unchanged" if source.audio else None,
                "size_bytes": size,
                "sha256": sha256,
            },
            "notes": notes,
        },
    }


__all__ = ["actual_settings"]
