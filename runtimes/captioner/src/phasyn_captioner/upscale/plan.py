"""``media.upscale`` plan: parameters, bounds, output geometry and tiles (pure Python, no torch, no FFmpeg).

Every input is bounded before anything is decoded: a source may have at most ``MAX_INPUT_PIXELS`` per frame and
``load.provider_options.max_frames`` frames, the output at most ``MAX_OUTPUT_PIXELS``. The model always runs at 2×;
``target`` then resizes the 2× frames to an exact height (1440 or 2160) keeping the aspect ratio with an even width.
A target that is not larger than the source is refused instead of being turned into a downscale. Frame count and
frame rate are never changed: they are checked here and again on the encoded file.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError

METHOD_ID = "anime4k-v4-upscale-cnn-x2-vl"
METHOD_LABEL = "Anime4K v4 Upscale_CNN_x2_VL（bloc97/Anime4K，MIT）"
# Soft_VL is a choice; the current method stays the default
SOFT_VL_ID = "anime4k-v4-restore-soft-vl+upscale-x2-vl"
SOFT_VL_LABEL = "Anime4K v4 Restore_CNN_Soft_VL + Upscale_CNN_x2_VL（bloc97/Anime4K，MIT）"
METHODS: dict[str, str] = {METHOD_ID: METHOD_LABEL, SOFT_VL_ID: SOFT_VL_LABEL}
SCALES = (2,)
TARGET_HEIGHTS: dict[str, int | None] = {"2x": None, "1440p": 1440, "2160p": 2160}
# 2048×1088 input (covers 1920×1080 with the 16-pixel padding of H3 sizes) and its 2× output.
MAX_INPUT_PIXELS = 2048 * 1088
MAX_OUTPUT_PIXELS = 4096 * 2176
MAX_SIDE = 8192
CRF_RANGE = (10, 30)
DEFAULT_CRF = 16
TILE_PIXELS_RANGE = (128 * 128, 1024 * 1024)
DEFAULT_TILE_PIXELS = 512 * 512
MAX_FRAMES_CEILING = 21600
DEFAULT_MAX_FRAMES = 7200
CUDA_CAP_RANGE = (256 * 1024**2, 64 * 1024**3)

PARAMS: dict[str, dict[str, Any]] = {
    "method": {
        "enum": list(METHODS),
        "default": METHOD_ID,
        "description": "超分方法：anime4k-v4-upscale-cnn-x2-vl＝標準（Upscale_CNN_x2_VL，預設）；"
        "anime4k-v4-restore-soft-vl+upscale-x2-vl＝銳利（先 Clamp_Highlights 與 Restore_CNN_Soft_VL 修復再 2×，約慢 46%）",
    },
    "scale": {"enum": list(SCALES), "default": 2, "description": "模型倍率（目前只有 2×）"},
    "target": {
        "enum": list(TARGET_HEIGHTS),
        "default": "2x",
        "description": "2x＝模型輸出原樣；1440p／2160p＝2× 之後以 bicubic（縮小時含 antialias）縮放到正好這個高度，"
        "維持長寬比、寬度取偶數",
    },
    "crf": {
        "type": "integer",
        "minimum": CRF_RANGE[0],
        "maximum": CRF_RANGE[1],
        "default": DEFAULT_CRF,
        "description": "H.264（libx264、yuv420p、無 B-frame）的 CRF；越小越接近無損、檔案越大",
    },
}
PROVIDER_OPTIONS: dict[str, dict[str, Any]] = {
    "tile_pixels": {
        "type": "integer",
        "minimum": TILE_PIXELS_RANGE[0],
        "maximum": TILE_PIXELS_RANGE[1],
        "default": DEFAULT_TILE_PIXELS,
        "description": "每個分塊的輸入像素上限（不含邊界重疊）；越小顯存越省、呼叫次數越多。分塊結果與整張相同",
    },
    "max_frames": {
        "type": "integer",
        "minimum": 1,
        "maximum": MAX_FRAMES_CEILING,
        "default": DEFAULT_MAX_FRAMES,
        "description": "單次呼叫接受的影格數上限；超過時拒絕（不截斷）",
    },
    "cuda_memory_cap_bytes": {
        "type": ["integer", "null"],
        "minimum": CUDA_CAP_RANGE[0],
        "maximum": CUDA_CAP_RANGE[1],
        "default": None,
        "description": "PyTorch caching allocator 在此 GPU 的上限（set_per_process_memory_fraction）；null＝不設上限。"
        "CUDA context 不在此上限內",
    },
}


@dataclass(frozen=True)
class UpscaleParams:
    scale: int
    target: str
    crf: int
    method: str = METHOD_ID


@dataclass(frozen=True)
class LoadOptions:
    tile_pixels: int
    max_frames: int
    cuda_memory_cap_bytes: int | None


@dataclass(frozen=True)
class Geometry:
    source_width: int
    source_height: int
    model_width: int
    model_height: int
    output_width: int
    output_height: int

    @property
    def resized(self) -> bool:
        return (self.output_width, self.output_height) != (self.model_width, self.model_height)


def _int(raw: Mapping[str, Any], name: str, spec: Mapping[str, Any], where: str) -> int:
    value = raw.get(name, spec["default"])
    if isinstance(value, bool) or not isinstance(value, int) or not spec["minimum"] <= value <= spec["maximum"]:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"{name} 必須是 {spec['minimum']}–{spec['maximum']} 的整數",
            details={"field_paths": [f"{where}.{name}"]},
        )
    return value


def resolve_params(raw: Mapping[str, Any]) -> UpscaleParams:
    """Invoke parameters with defaults; unknown keys and out-of-range values are refused (never clamped)."""
    unknown = sorted(set(raw) - set(PARAMS))
    if unknown:
        raise ComponentError("INVALID_ARGUMENT", f"不支援的參數 {', '.join(unknown)}", details={"field_paths": unknown})
    scale = raw.get("scale", 2)
    if isinstance(scale, bool) or scale not in SCALES:
        raise ComponentError("UNSUPPORTED_SETTING", "scale 目前只支援 2", details={"field_paths": ["parameters.scale"]})
    target = raw.get("target", "2x")
    if target not in TARGET_HEIGHTS:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"target 必須是 {'、'.join(TARGET_HEIGHTS)}",
            details={"field_paths": ["parameters.target"]},
        )
    method = raw.get("method", METHOD_ID)
    if method not in METHODS:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"method 必須是 {'、'.join(METHODS)}",
            details={"field_paths": ["parameters.method"]},
        )
    return UpscaleParams(
        scale=int(scale), target=str(target), crf=_int(raw, "crf", PARAMS["crf"], "parameters"), method=str(method)
    )


def resolve_load_options(raw: Mapping[str, Any]) -> LoadOptions:
    unknown = sorted(set(raw) - set(PROVIDER_OPTIONS))
    if unknown:
        raise ComponentError(
            "INVALID_ARGUMENT", f"不支援的 provider_options {', '.join(unknown)}", details={"field_paths": unknown}
        )
    cap = raw.get("cuda_memory_cap_bytes")
    if cap is not None and (
        isinstance(cap, bool) or not isinstance(cap, int) or not CUDA_CAP_RANGE[0] <= cap <= CUDA_CAP_RANGE[1]
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"cuda_memory_cap_bytes 必須是 null 或 {CUDA_CAP_RANGE[0]}–{CUDA_CAP_RANGE[1]} 的整數",
            details={"field_paths": ["load.provider_options.cuda_memory_cap_bytes"]},
        )
    where = "load.provider_options"
    return LoadOptions(
        tile_pixels=_int(raw, "tile_pixels", PROVIDER_OPTIONS["tile_pixels"], where),
        max_frames=_int(raw, "max_frames", PROVIDER_OPTIONS["max_frames"], where),
        cuda_memory_cap_bytes=cap,
    )


def output_geometry(width: int, height: int, *, scale: int, target: str) -> Geometry:
    """Model and output sizes for one source size; refuses sizes beyond the bounds or a target that is not larger."""
    if width <= 0 or height <= 0 or width > MAX_SIDE or height > MAX_SIDE:
        raise ComponentError(
            "INVALID_ARGUMENT", f"來源尺寸 {width}×{height} 不合法", details={"width": width, "height": height}
        )
    if width * height > MAX_INPUT_PIXELS:
        raise ComponentError(
            "INPUT_TOO_LARGE",
            f"來源 {width}×{height} 超過每幀 {MAX_INPUT_PIXELS} 像素的上限",
            details={"width": width, "height": height, "max_pixels": MAX_INPUT_PIXELS},
        )
    model_w, model_h = width * scale, height * scale
    wanted = TARGET_HEIGHTS[target]
    if wanted is None:
        out_w, out_h = model_w, model_h
    else:
        if wanted <= height:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"target {target} 不比來源高度 {height} 大，這不是超分（不改成縮小）",
                details={"field_paths": ["parameters.target"], "height": height},
            )
        out_h = wanted
        out_w = max(2, round(width * wanted / height / 2) * 2)
    if out_w * out_h > MAX_OUTPUT_PIXELS or out_w > MAX_SIDE:
        raise ComponentError(
            "INPUT_TOO_LARGE",
            f"輸出 {out_w}×{out_h} 超過每幀 {MAX_OUTPUT_PIXELS} 像素的上限",
            details={"width": out_w, "height": out_h, "max_pixels": MAX_OUTPUT_PIXELS},
        )
    return Geometry(width, height, model_w, model_h, out_w, out_h)


def check_frames(frames: int, max_frames: int) -> None:
    if frames <= 0:
        raise ComponentError("MEDIA_INCOMPLETE", "來源影片沒有任何影格")
    if frames > max_frames:
        raise ComponentError(
            "INPUT_TOO_LARGE",
            f"來源有 {frames} 幀，超過此元件的上限 {max_frames} 幀（不截斷）",
            details={"frames": frames, "max_frames": max_frames},
        )


def tile_grid(height: int, width: int, tile_pixels: int) -> list[tuple[int, int, int, int]]:
    """Core tiles ``(y0, y1, x0, x1)`` covering the frame once, each at most ``tile_pixels`` input pixels."""
    side = max(1, math.isqrt(tile_pixels))
    rows, cols = math.ceil(height / side), math.ceil(width / side)
    ys = [round(i * height / rows) for i in range(rows + 1)]
    xs = [round(j * width / cols) for j in range(cols + 1)]
    return [(ys[i], ys[i + 1], xs[j], xs[j + 1]) for i in range(rows) for j in range(cols)]


def work_path(work_dir: Path, name: str) -> Path:
    """A file directly inside the call's work directory; any other name (separators, dot names) is refused."""
    if not name or name in (".", "..") or "/" in name or "\\" in name or "\x00" in name or name.startswith("."):
        raise ComponentError("RUNTIME_ERROR", "工作檔名不合法")
    root = work_dir.resolve()
    path = root / name
    if path.parent != root:
        raise ComponentError("RUNTIME_ERROR", "工作檔不在本次呼叫的工作目錄內")
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ComponentError("RUNTIME_ERROR", "工作檔路徑已被其他東西佔用")
    return path


__all__ = [
    "DEFAULT_CRF",
    "MAX_INPUT_PIXELS",
    "MAX_OUTPUT_PIXELS",
    "METHODS",
    "METHOD_ID",
    "METHOD_LABEL",
    "PARAMS",
    "PROVIDER_OPTIONS",
    "SOFT_VL_ID",
    "SOFT_VL_LABEL",
    "TARGET_HEIGHTS",
    "Geometry",
    "LoadOptions",
    "UpscaleParams",
    "check_frames",
    "output_geometry",
    "resolve_load_options",
    "resolve_params",
    "tile_grid",
    "work_path",
]
