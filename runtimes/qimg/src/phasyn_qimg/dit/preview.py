"""Intermediate denoise previews (best effort: never changes sampling, never fails a successful generation).

Both modes work on the x0 estimate ``x0 = x_t − σ·v`` in the normalized latent space:
- ``vae_thumbnail``: a CPU FP32 VAE (loaded once with the component) decodes a *downscaled* x0 (area-resized
  to max_side/16 latent cells). This is not the final image.
- ``linear_fit``: a 64→3 linear projection plus bias, bilinearly upscaled to max_side. Coefficients come only
  from our own outputs (fitted by tools/fit_preview_coefficients.py; no third-party coefficients). A missing
  coefficients file is a 422 at the caller.

The background thread keeps at most one running render plus one replaceable pending request (older ones are
dropped and counted) and never queues GPU tensors. Publishing goes through the platform API
``ctx.publish_preview`` (the caller feature-detects it and disables previews with a note when absent).
Preview images are composited on white when they have alpha (as image_white), JPEG quality 85, real pixel size.
"""

from __future__ import annotations

import io
import json
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from phasyn_components.model_identity import display_path, location

from .. import VAE_SCALE_FACTOR
from ..latents import unpack_latents

PACKAGED_COEFFICIENTS = Path(__file__).with_name("preview_coefficients.json")
COEFFICIENTS_SCHEMA = "phasyn_qimg.preview_linear_fit.v1"
COEFFICIENTS_SOURCE = "phasyn_qimg.fit_preview_coefficients"
LATENT_SPACE = "qwen-image-2.1.vae-normalized"
JPEG_QUALITY = 85
PREVIEW_NOTE = "預覽（非最終結果）"


class PreviewUnavailable(ValueError):
    """要求的預覽模式在這個元件／環境不可用（呼叫端轉成 422）。"""


def preview_due(step: int, every: int, total: int) -> bool:
    """``step`` counts completed steps from 1; previews at the first step, the last step and every ``every`` steps."""
    return every > 0 and (step in (1, total) or step % every == 0)


@dataclass(frozen=True)
class LinearCoefficients:
    matrix: tuple[tuple[float, float, float], ...]
    bias: tuple[float, float, float]
    synthetic: bool
    location: dict[str, str]  # relative to load.model_path, or the basename (never an absolute path)
    sha256: str
    fit: dict[str, Any]

    @property
    def channels(self) -> int:
        return len(self.matrix)

    def identity(self) -> dict[str, Any]:
        return {**self.location, "sha256": self.sha256, "synthetic": self.synthetic, "fit": self.fit}


def validate_coefficients(doc: Any, *, channels: int) -> list[str]:
    problems: list[str] = []
    if not isinstance(doc, dict):
        return ["係數檔不是 JSON object"]
    if doc.get("schema") != COEFFICIENTS_SCHEMA:
        problems.append(f"schema 必須是 {COEFFICIENTS_SCHEMA}")
    if doc.get("latent_space") != LATENT_SPACE:
        problems.append(f"latent_space 必須是 {LATENT_SPACE}")
    provenance = doc.get("provenance")
    if not isinstance(provenance, dict) or provenance.get("source") != COEFFICIENTS_SOURCE:
        problems.append(f"provenance.source 必須是 {COEFFICIENTS_SOURCE}（只接受我們自己擬合的係數）")
    matrix = doc.get("matrix")
    if not isinstance(matrix, list) or len(matrix) != channels:
        problems.append(f"matrix 必須是 {channels}×3")
    else:
        for row in matrix:
            if not isinstance(row, list) or len(row) != 3 or not all(_finite(v) for v in row):
                problems.append(f"matrix 必須是 {channels}×3 的有限數值")
                break
    bias = doc.get("bias")
    if not isinstance(bias, list) or len(bias) != 3 or not all(_finite(v) for v in bias):
        problems.append("bias 必須是 3 個有限數值")
    return problems


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def load_coefficients(path: Path, *, channels: int, root: Path | None = None) -> LinearCoefficients:
    """Validated linear_fit coefficients; ``root`` (``load.model_path``) only shapes the recorded location."""
    import hashlib

    if not path.is_file():
        raise PreviewUnavailable(
            f"linear_fit 尚無係數檔（{display_path(path, root)}）；"
            "請先用 runtimes/qimg/tools/fit_preview_coefficients.py 以我們自己的輸出擬合"
        )
    data = path.read_bytes()
    try:
        doc = json.loads(data)
    except ValueError as exc:
        raise PreviewUnavailable(f"linear_fit 係數檔不是有效 JSON：{exc}") from exc
    problems = validate_coefficients(doc, channels=channels)
    if problems:
        raise PreviewUnavailable("linear_fit 係數檔不合格：" + "；".join(problems))
    return LinearCoefficients(
        matrix=tuple(tuple(float(v) for v in row) for row in doc["matrix"]),  # type: ignore[misc]
        bias=tuple(float(v) for v in doc["bias"]),  # type: ignore[arg-type]
        synthetic=bool(doc["provenance"].get("synthetic", False)),
        location=location(path, root),
        sha256=hashlib.sha256(data).hexdigest(),
        fit=dict(doc.get("fit") or {}),
    )


def render_vae_thumbnail(vae: Any, packed: Any, *, width: int, height: int, max_side: int) -> Any:
    """Decode a downscaled x0 with the CPU FP32 VAE; returns a PIL image (RGBA when the VAE emits alpha)."""
    import torch
    from PIL import Image
    from torch.nn import functional

    with torch.inference_mode():
        latents = unpack_latents(packed, width=width, height=height)
        latent_h, latent_w = latents.shape[-2:]
        max_latent = max(1, max_side // VAE_SCALE_FACTOR)
        ratio = min(1.0, max_latent / max(latent_h, latent_w))
        if ratio < 1.0:
            target = (max(1, round(latent_h * ratio)), max(1, round(latent_w * ratio)))
            latents = functional.interpolate(latents[:, :, 0], size=target, mode="area").unsqueeze(2)
        mean = torch.tensor(vae.config.latents_mean, dtype=latents.dtype).view(1, -1, 1, 1, 1)
        std = torch.tensor(vae.config.latents_std, dtype=latents.dtype).view(1, -1, 1, 1, 1)
        decoded = vae.decode(latents * std + mean, return_dict=False)[0][0, :, 0]
        pixels = ((decoded.float().clamp(-1, 1) + 1) / 2 * 255).round().byte()
        array = pixels.permute(1, 2, 0).cpu().numpy()
    return Image.fromarray(array)


def render_linear(coefficients: LinearCoefficients, packed: Any, *, width: int, height: int, max_side: int) -> Any:
    """x0 (H,W,64) @ M + b → [0,1] RGB → 雙線性放大到最長邊 max_side。"""
    import torch
    from PIL import Image

    if packed.shape[-1] != coefficients.channels:
        raise PreviewUnavailable("linear_fit 係數的 channel 數與 latent 不符")
    with torch.inference_mode():
        latents = unpack_latents(packed, width=width, height=height)[0, :, 0]  # (C, H, W)
        matrix = torch.tensor(coefficients.matrix, dtype=torch.float32)
        bias = torch.tensor(coefficients.bias, dtype=torch.float32)
        rgb = latents.float().movedim(0, -1) @ matrix + bias
        rgb = torch.nan_to_num(rgb, nan=0.0, posinf=1.0, neginf=0.0)
        pixels = (rgb.clamp(0, 1) * 255).round().to(torch.uint8).numpy()
    image = Image.fromarray(pixels)
    ratio = max_side / max(image.size)
    target = max(1, round(image.size[0] * ratio)), max(1, round(image.size[1] * ratio))
    return image.resize(target, Image.Resampling.BILINEAR)


def encode_preview(image: Any) -> tuple[bytes, int, int]:
    """alpha 合成在白底 → JPEG（預覽與最終的白底版一致；透明區不會變黑）。"""
    from PIL import Image

    if image.mode in ("RGBA", "LA"):
        white = Image.new("RGB", image.size, (255, 255, 255))
        white.paste(image, mask=image.getchannel("A"))
        image = white
    elif image.mode != "RGB":
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue(), int(image.size[0]), int(image.size[1])


def load_preview_vae(vae_dir: Path) -> Any:
    """CPU FP32 VAE loaded once per component for ``vae_thumbnail`` previews."""
    import torch
    from diffusers import AutoencoderKLQwenImage21

    vae = AutoencoderKLQwenImage21.from_pretrained(
        str(vae_dir), local_files_only=True, torch_dtype=torch.float32, use_safetensors=True
    ).eval()
    vae.enable_tiling()
    return vae


class PreviewWorker:
    """一張執行中＋一張可被取代的待辦；只處理 CPU tensor 副本。錯誤只停用預覽，留給主執行緒報告。"""

    def __init__(
        self,
        *,
        render: Callable[[Any], Any],
        publish: Callable[..., bool],
        total: int,
        note: str = PREVIEW_NOTE,
        lock: threading.Lock | None = None,
    ) -> None:
        self._render = render
        self._publish = publish
        self._total = total
        self._note = note
        self._decode_lock = lock or threading.Lock()
        self._cv = threading.Condition()
        self._pending: tuple[Any, int] | None = None
        self._closing = False
        self._discard = False
        self._disabled = False
        self.error: str | None = None
        self.submitted = 0
        self.replaced = 0
        self.rendered = 0
        self.published = 0
        self.dropped_by_platform = 0
        self.copy_ms = 0.0
        self.render_ms = 0.0
        self.encode_ms = 0.0
        self.bytes_published = 0
        self._thread = threading.Thread(target=self._run, name="qimg-dit-preview", daemon=True)
        self._thread.start()

    @property
    def active(self) -> bool:
        with self._cv:
            return not (self._disabled or self._closing)

    def submit(self, x0: Any, step: int) -> None:
        """x0：裝置上的 (1,HW,C) float32；這裡複製成獨立的 CPU tensor（同步點，只在預覽步發生）。"""
        if not self.active:
            return
        import torch

        t0 = time.perf_counter()
        owned = x0.detach().to(device="cpu", dtype=torch.float32, copy=True)
        with self._cv:
            if self._disabled or self._closing:
                return
            self.copy_ms += (time.perf_counter() - t0) * 1000
            self.submitted += 1
            self.replaced += int(self._pending is not None)
            self._pending = (owned, step)
            self._cv.notify()

    def _run(self) -> None:
        try:
            while True:
                with self._cv:
                    self._cv.wait_for(lambda: self._pending is not None or self._closing)
                    if self._discard or self._pending is None:
                        self._pending = None
                        return
                    packed, step = self._pending
                    self._pending = None
                t0 = time.perf_counter()
                with self._decode_lock:  # CPU VAE 有內部 feature cache，不能並行解碼
                    image = self._render(packed)
                t1 = time.perf_counter()
                data, width, height = encode_preview(image)
                t2 = time.perf_counter()
                with self._cv:
                    self.rendered += 1
                    self.render_ms += (t1 - t0) * 1000
                    self.encode_ms += (t2 - t1) * 1000
                # 執行中的一張做完就發布（即使 close 已要求丟棄待辦）；close 只丟棄尚未開始的待辦
                ok = bool(
                    self._publish(
                        step=step,
                        total=self._total,
                        data=data,
                        media_type="image/jpeg",
                        width=width,
                        height=height,
                        note=self._note,
                    )
                )
                with self._cv:
                    if ok:
                        self.published += 1
                        self.bytes_published += len(data)
                    else:
                        self.dropped_by_platform += 1
        except Exception as exc:  # 預覽失敗不影響生成
            with self._cv:
                self.error = f"{type(exc).__name__}: {exc}"[:500]
                self._disabled = True
                self._pending = None

    def close(self, *, discard: bool = True) -> None:
        """結束：預設丟棄尚未開始的待辦（呼叫結束時 Node 會刪掉預覽）；等執行中的一張做完並發布。"""
        with self._cv:
            self._closing = True
            self._discard = discard
            if discard:
                self._pending = None
            self._cv.notify_all()
        self._thread.join()

    def statistics(self) -> dict[str, Any]:
        with self._cv:
            return {
                "submitted": self.submitted,
                "replaced": self.replaced,
                "rendered": self.rendered,
                "published": self.published,
                "dropped_by_platform": self.dropped_by_platform,
                "bytes_published": self.bytes_published,
                "copy_ms": round(self.copy_ms, 3),
                "render_ms": round(self.render_ms, 3),
                "encode_ms": round(self.encode_ms, 3),
                "error": self.error,
            }


__all__ = [
    "COEFFICIENTS_SCHEMA",
    "COEFFICIENTS_SOURCE",
    "LATENT_SPACE",
    "PACKAGED_COEFFICIENTS",
    "PREVIEW_NOTE",
    "LinearCoefficients",
    "PreviewUnavailable",
    "PreviewWorker",
    "encode_preview",
    "load_coefficients",
    "load_preview_vae",
    "preview_due",
    "render_linear",
    "render_vae_thumbnail",
    "validate_coefficients",
]
