# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/resolved_plan.py (minimax_h3_resolve_spatial_shape), time_request.py and reference_encoding.py (frame/latent and reference-image shape formulas)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: pure-Python port with the same arithmetic.
"""H3 temporal/spatial geometry, exactly following the pinned SGLang resolver.

* frames:  SG:time_request.py:5-29 and SG:resolved_plan.py:208-217
* canvas:  SG:resolved_plan.py:96-182 (``adapt_shape_v1``)
* bounds:  SG:constants.py:30-31, SG:request_validation.py:117-126

The geometry document validates against ``contracts/geometry.schema.json``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from . import constants
from ._diag import INVALID, UNSUPPORTED, err, warn


# Opt-in reference-image short edges besides the pinned 2048. Each is a whole number of DiT tokens
# (REFERENCE_IMAGE_MULTIPLE = TOKEN_STRIDE = 32 px), so the resolved canvas stays on the same 32 px grid:
# 736 is the short side of a 1280x736 take, 768 the official reference-video short edge.
EXPERIMENTAL_IMAGE_SHORT_EDGES = (736, 768, 1024)


def requested_frame_count(seconds: float, fps: int = constants.FPS) -> int:
    """``int(round(seconds * fps))`` with Python (banker's) rounding.

    SG:resolved_plan.py:208-210, SG:request_validation.py:296-301.
    """
    return round(float(seconds) * fps)


def align_frame_count(frame_count: int) -> int:
    """Snap up to the 17n+5 grid (SG:time_request.py:5-10, incl. its <=0 -> 1 quirk)."""
    if frame_count <= 0:
        return 1
    current = int(frame_count)
    return current + (constants.FRAME_OFFSET - current) % constants.FRAME_GROUP


def video_latent_t(frame_count: int) -> int:
    """SG:time_request.py:13-16."""
    if frame_count <= constants.FRAME_OFFSET:
        return 2
    return (
        (int(frame_count) - constants.FRAME_OFFSET) // constants.FRAME_GROUP
    ) * constants.LATENT_T_GROUP + 2


def audio_latent_t(duration_seconds: float) -> int:
    """Per-channel 40 Hz audio latent length (SG:time_request.py:27-29)."""
    return round(float(duration_seconds) * float(constants.AUDIO_LATENT_HZ))


def align_up(value: int, alignment: int = constants.PACKED_ALIGNMENT) -> int:
    """Packed-sequence padding (SG:packed_sequence.py:165-169, alignment SGR:configs/models/dits/minimax_h3.py:9)."""
    return (int(value) + alignment - 1) // alignment * alignment


def latent_frame_rows(width: int, height: int) -> int:
    """DiT rows per latent frame: VAE /16 then patch [1,2,2] (SG:packed_sequence.py:149-151)."""
    return (int(height) // constants.TOKEN_STRIDE) * (
        int(width) // constants.TOKEN_STRIDE
    )


# ---------------------------------------------------------------------------
# canvas (adapt_shape_v1)
# ---------------------------------------------------------------------------


def _nearest_multiple(value: float, multiple: int) -> int:
    """SG:resolved_plan.py:96-97."""
    return max(multiple, round(float(value) / multiple) * multiple)


def resolve_spatial_shape(
    width: float, height: float, base_short_edge: int = constants.BASE_SHORT_EDGE
) -> dict[str, Any]:
    """Pure-Python port of ``minimax_h3_resolve_spatial_shape`` (SG:resolved_plan.py:114-182)."""
    if (
        isinstance(base_short_edge, bool)
        or int(base_short_edge) != base_short_edge
        or base_short_edge <= 0
    ):
        raise ValueError("base_short_edge must be a positive integer")
    source_width = float(width)
    source_height = float(height)
    if (
        not (math.isfinite(source_width) and math.isfinite(source_height))
        or source_width <= 0
        or source_height <= 0
    ):
        raise ValueError("shape width and height must be positive finite numbers")
    ratio = source_width / source_height
    if not constants.MIN_ASPECT_RATIO <= ratio <= constants.MAX_ASPECT_RATIO:
        raise ValueError("adapt_shape_v1 ratio must be within 1:4 .. 4:1")
    if ratio >= 1.0:
        nominal_width = float(base_short_edge) * ratio
        nominal_height = float(base_short_edge)
    else:
        nominal_width = float(base_short_edge)
        nominal_height = float(base_short_edge) / ratio
    nominal_area = nominal_width * nominal_height
    if nominal_area > constants.MAX_PIXELS:
        size_mode = "area"
        scale = math.sqrt(float(constants.MAX_PIXELS) / nominal_area)
        nominal_width *= scale
        nominal_height *= scale
    else:
        size_mode = "short_edge"
    resolved_width = _nearest_multiple(nominal_width, constants.CANVAS_MULTIPLE)
    resolved_height = _nearest_multiple(nominal_height, constants.CANVAS_MULTIPLE)
    return {
        "geometry": "resolved_v2",
        "shape_policy_version": constants.SHAPE_POLICY_VERSION,
        "base_short_edge": int(base_short_edge),
        "effective_short_edge": min(resolved_width, resolved_height),
        "size_mode": size_mode,
        "max_pixels": constants.MAX_PIXELS,
        "multiple": constants.CANVAS_MULTIPLE,
        "rounding": "nearest",
        "width": resolved_width,
        "height": resolved_height,
    }


def reference_image_short_edge(value: Any) -> int | None:
    """Normalize the opt-in image experiment; None keeps the pinned 2048 path."""
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value
        not in (*EXPERIMENTAL_IMAGE_SHORT_EDGES, constants.REFERENCE_IMAGE_SHORT_EDGE)
    ):
        allowed = ", ".join(str(edge) for edge in EXPERIMENTAL_IMAGE_SHORT_EDGES)
        raise ValueError(
            f"reference_image_short_edge must be {allowed}, "
            f"{constants.REFERENCE_IMAGE_SHORT_EDGE} or null"
        )
    return int(value) if value in EXPERIMENTAL_IMAGE_SHORT_EDGES else None


def resolve_reference_image_shape(
    width: float, height: float, *, short_edge: int | None = None
) -> dict[str, int]:
    """Reference-image canvas: 2048 px short edge, nearest 32, no area cap (SG:reference_encoding.py:125-178)."""
    w, h = float(width), float(height)
    if not (math.isfinite(w) and math.isfinite(h)) or w <= 0 or h <= 0:
        raise ValueError(
            "reference image width and height must be positive finite numbers"
        )
    if w > 4.0 * h or h > 4.0 * w:
        raise ValueError("reference image ratio must be within 1:4 .. 4:1")
    edge = (
        reference_image_short_edge(short_edge) or constants.REFERENCE_IMAGE_SHORT_EDGE
    )
    scale = edge / min(w, h)
    return {
        "width": _nearest_multiple(w * scale, constants.REFERENCE_IMAGE_MULTIPLE),
        "height": _nearest_multiple(h * scale, constants.REFERENCE_IMAGE_MULTIPLE),
    }


def canvas_diagnostics(width: Any, height: Any) -> list[dict[str, Any]]:
    """Canvas checks with job-request field paths (errors + warnings)."""
    out: list[dict[str, Any]] = []
    for path, value in (("output.width", width), ("output.height", height)):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            out.append(err(INVALID, "畫布尺寸必須是正整數", path, actual=value))
        elif value % constants.CANVAS_MULTIPLE:
            out.append(
                err(
                    INVALID,
                    f"H3 畫布必須是 {constants.CANVAS_MULTIPLE} 的倍數（VAE /16 再加 DiT 2×2 patch）",
                    path,
                    expected=f"{constants.CANVAS_MULTIPLE} 的倍數",
                    actual=value,
                )
            )
    if out:
        return out
    ratio = width / height
    if not constants.MIN_ASPECT_RATIO <= ratio <= constants.MAX_ASPECT_RATIO:
        return [
            err(
                INVALID,
                "H3 畫布比例必須介於 1:4 與 4:1（含）",
                "output.width",
                "output.height",
                expected="1:4 .. 4:1",
                actual=f"{width}×{height}",
            )
        ]
    resolved = resolve_spatial_shape(width, height, base_short_edge=min(width, height))
    if (resolved["width"], resolved["height"]) != (width, height):
        return [
            err(
                INVALID,
                "畫布超出 H3 面積上限：釘版 adapt_shape_v1 resolver 會把此比例與短邊解析成另一個畫布；"
                f"本產品不默默改尺寸，請改用 {resolved['width']}×{resolved['height']}",
                "output.width",
                "output.height",
                expected=f"{resolved['width']}×{resolved['height']}（面積上限 {constants.MAX_PIXELS:,} 像素）",
                actual=f"{width}×{height}",
            )
        ]
    if min(width, height) != constants.BASE_SHORT_EDGE:
        out.append(
            warn(
                "UNVERIFIED_SHORT_EDGE",
                f"短邊 {min(width, height)} 不是官方唯一驗證的 768；可生成但品質未經 MiniMax／SGLang 量測，"
                "低於 768 的 preview 不等於原生 768 品質",
                "output.width",
                "output.height",
            )
        )
    return out


# ---------------------------------------------------------------------------
# runtime-specific bounds after snapping
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RuntimeBounds:
    """Define the geometry limits supported by this runtime."""

    runtime_provider: str
    requested_seconds: tuple[int | float, int | float]
    generated_frames: tuple[int, int]
    generated_seconds: tuple[float, float]
    source: str


def _sglang_bounds() -> RuntimeBounds:
    lo_frames = align_frame_count(1)  # 5 = smallest point of the 17n+5 grid
    hi_frames = align_frame_count(
        requested_frame_count(constants.MAX_DURATION_SECONDS)
    )  # 362
    return RuntimeBounds(
        runtime_provider=constants.RUNTIME_SGLANG,
        requested_seconds=(
            constants.MIN_DURATION_SECONDS,
            constants.MAX_DURATION_SECONDS,
        ),
        generated_frames=(lo_frames, hi_frames),
        generated_seconds=(lo_frames / constants.FPS, hi_frames / constants.FPS),
        source="SG:constants.py:30-31; SG:request_validation.py:117-126; SG:time_request.py:5-10",
    )


RUNTIME_BOUNDS: dict[str, RuntimeBounds] = {
    constants.RUNTIME_SGLANG: _sglang_bounds(),
    # The Diffusers MiniMax-H3 pipeline documentation states 5-15 s; the limit is applied to the snapped
    # generated duration as well: a backend that disallows >15 s must reject 362 frames.
    constants.RUNTIME_DIFFUSERS: RuntimeBounds(
        runtime_provider=constants.RUNTIME_DIFFUSERS,
        requested_seconds=(5, 15),
        generated_frames=(5 * constants.FPS, 15 * constants.FPS),
        generated_seconds=(5.0, 15.0),
        source="Diffusers MiniMax-H3 pipeline documentation (5-15 s); ",
    ),
}


def effective_requested_bounds(
    bounds: RuntimeBounds,
) -> tuple[int | float, int | float]:
    """Intersection of the official guide range [4, 15] and the runtime's requested range."""
    return (
        max(constants.MIN_DURATION_SECONDS, bounds.requested_seconds[0]),
        min(constants.MAX_DURATION_SECONDS, bounds.requested_seconds[1]),
    )


# ---------------------------------------------------------------------------
# geometry document
# ---------------------------------------------------------------------------


def build_geometry(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    *,
    requested_seconds: Any,
    width: Any,
    height: Any,
    duration_policy: str,
    runtime_provider: str | None,
    fps: Any = constants.FPS,
    latent_dtype: str = constants.LATENT_WIRE_DTYPE,
    batch: int = 1,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Return ``(geometry_doc | None, diagnostics)`` (job-request field paths).

    Errors are returned, never raised; the doc is ``None`` whenever an error exists.
    ``runtime_provider=None`` applies only the official rules and reports the pinned
    SGLang bounds (the adapter's reference resolver) in the document.
    """
    diags: list[dict[str, Any]] = []
    if isinstance(fps, bool) or fps != constants.FPS:
        diags.append(
            err(
                INVALID,
                "H3 只支援原生 24 fps",
                "output.fps",
                expected=constants.FPS,
                actual=fps,
            )
        )
    if isinstance(requested_seconds, bool) or not isinstance(
        requested_seconds, (int, float)
    ):
        diags.append(
            err(INVALID, "requested_seconds 必須是數字", "output.requested_seconds")
        )
        return None, diags
    if not math.isfinite(float(requested_seconds)) or not (
        constants.MIN_DURATION_SECONDS
        <= float(requested_seconds)
        <= constants.MAX_DURATION_SECONDS
    ):
        diags.append(
            err(
                INVALID,
                f"H3 官方要求時長為 {constants.MIN_DURATION_SECONDS}\N{EN DASH}{constants.MAX_DURATION_SECONDS} 秒",
                "output.requested_seconds",
                expected=f"[{constants.MIN_DURATION_SECONDS}, {constants.MAX_DURATION_SECONDS}]",
                actual=requested_seconds,
            )
        )
    diags.extend(canvas_diagnostics(width, height))
    bounds = (
        RUNTIME_BOUNDS[constants.RUNTIME_SGLANG]
        if runtime_provider is None
        else RUNTIME_BOUNDS.get(str(runtime_provider))
    )
    if bounds is None:
        diags.append(
            err(
                UNSUPPORTED,
                f"H3 adapter 沒有 runtime「{runtime_provider}」的時長／幀數界線；不猜測，請選 "
                + "、".join(sorted(RUNTIME_BOUNDS)),
                "profile.runtime_provider",
                actual=runtime_provider,
            )
        )
    if duration_policy not in ("preserve_generated", "trim_to_requested"):
        diags.append(
            err(
                INVALID,
                "未知的 duration_policy",
                "output.duration_policy",
                actual=duration_policy,
            )
        )
    if any(d["severity"] == "error" for d in diags):
        return None, diags

    frames = requested_frame_count(requested_seconds)
    generated = align_frame_count(frames)
    latent_t = video_latent_t(generated)
    generated_seconds = generated / constants.FPS
    audio_t = audio_latent_t(generated_seconds)

    if not (bounds is not None):
        raise AssertionError
    req_lo, req_hi = effective_requested_bounds(bounds)
    snapped_ok = (
        req_lo <= float(requested_seconds) <= req_hi
        and bounds.generated_frames[0] <= generated <= bounds.generated_frames[1]
        and bounds.generated_seconds[0]
        <= generated_seconds
        <= bounds.generated_seconds[1]
    )
    if not snapped_ok:
        diags.append(
            err(
                UNSUPPORTED,
                f"要求 {requested_seconds} 秒對齊 17n+5 後生成 {generated} 幀（{generated_seconds:.4f} 秒），"
                f"超出 runtime {bounds.runtime_provider} 的界線（要求 {req_lo}\N{EN DASH}{req_hi} 秒、"
                f"生成 {bounds.generated_frames[0]}\N{EN DASH}{bounds.generated_frames[1]} 幀）；"
                "不會默默縮短，請調整要求時長或改用其他 runtime",
                "output.requested_seconds",
                "profile.runtime_provider",
                expected=f"generated_frames ∈ [{bounds.generated_frames[0]}, {bounds.generated_frames[1]}]",
                actual=str(generated),
            )
        )
        return None, diags

    delivered_frames = frames if duration_policy == "trim_to_requested" else generated
    doc: dict[str, Any] = {
        "requested_seconds": requested_seconds,
        "requested_frames": frames,
        "generated_frames": generated,
        "generated_seconds": generated_seconds,
        "delivered_frames": delivered_frames,
        "delivered_seconds": delivered_frames / constants.FPS,
        "fps_numerator": constants.FPS,
        "fps_denominator": 1,
        "width": int(width),
        "height": int(height),
        "video_latent_shape": [
            int(batch),
            constants.VIDEO_LATENT_CHANNELS,
            latent_t,
            int(height) // constants.VAE_SPATIAL_FACTOR,
            int(width) // constants.VAE_SPATIAL_FACTOR,
        ],
        "audio_latent_shape": [
            int(batch),
            constants.AUDIO_CHANNELS,
            audio_t,
            constants.AUDIO_LATENT_CHANNELS,
        ],
        "video_latent_dtype": latent_dtype,
        "audio_latent_dtype": latent_dtype,
        "requested_duration_bounds": [req_lo, req_hi],
        "generated_frame_bounds": list(bounds.generated_frames),
        "generated_duration_bounds": list(bounds.generated_seconds),
        "frame_alignment_rule": constants.FRAME_ALIGNMENT_RULE,
    }
    return doc, diags


def token_counts(geometry: Mapping[str, Any]) -> dict[str, int]:
    """N_video / N_audio rows of the target (SG:packed_sequence.py:149-156)."""
    _, _, latent_t, lat_h, lat_w = geometry["video_latent_shape"]
    rows = (lat_h // 2) * (lat_w // 2)
    audio_t = geometry["audio_latent_shape"][2]
    return {
        "latent_frame_rows": rows,
        "N_video": latent_t * rows,
        "N_audio": audio_t * constants.AUDIO_CHANNELS,
    }


def packed_length(
    *,
    n_text: int,
    n_video: int,
    n_audio: int,
    n_keyframe_rows: int = 0,
    n_reference_rows: int = 0,
) -> int:
    """``align_up(N_text + N_cond + N_refs + N_audio + N_video, 64)`` (SG:packed_sequence.py:161-169,385-392)."""
    return align_up(n_text + n_keyframe_rows + n_reference_rows + n_audio + n_video)
