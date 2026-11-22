"""Pure rules of the H3 LoRA trainer (no GPU library): timestep grid, windows, loss masks, stop and thermal rules.

Objective (rectified flow, the inference convention of the pinned denoise loop): with ``t = 1 - sigma`` the
target rows are ``z_t = t * x0 + sigma * eps`` and the model predicts the velocity ``v``; the clean estimate is
``z_t + sigma * v``, so the regression target is ``x0 - eps``. Video and audio use their own shifted sigma of
one base value ``u`` (video shift 12, audio shift 3, as at inference). The grid is the midpoint grid of ``u``;
``sigma_min`` drops the low-noise end (for an adapter meant for a distilled route that never samples there).
"""

from __future__ import annotations

import hashlib
import json
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


VIDEO_SHIFT, AUDIO_SHIFT = 12.0, 3.0
TARGET_KEYS = {
    "qkv": "attn.qkv_proj",
    "out": "attn.out_proj",
    "fc1": "mlp.fc1",
    "fc2": "mlp.fc2",
}
LATENT_PIXELS = 16
TOKEN_LATENTS = 2
DRIFT_LIMIT = 1.5
CKPT_SCHEMA = "phasyn.h3.lora_train.ckpt.v1"


def shift_sigma(u: float, shift: float) -> float:
    """The scheduler's shifted sigma of a base value ``u`` in (0, 1)."""
    return shift * u / (1.0 + (shift - 1.0) * u)


def timestep_grid(bins: int, *, sigma_min: float = 0.0) -> list[dict[str, float]]:
    """Midpoint base values -> (sigma_video, sigma_audio) with the inference shifts; ``sigma_min`` trims."""
    if bins < 1:
        raise ValueError("timestep bins must be positive")
    out = []
    for i in range(bins):
        u = (i + 0.5) / bins
        sv = shift_sigma(u, VIDEO_SHIFT)
        if sv >= sigma_min:
            out.append({"u": u, "sigma_v": sv, "sigma_a": shift_sigma(u, AUDIO_SHIFT)})
    if not out:
        raise ValueError("sigma_min leaves no timestep")
    return out


def draw_window(rng: random.Random, latent_t: int, k: int) -> int:
    """A window start keeping ``k`` whole latent frames inside the clip, uniformly."""
    if not 0 < k < latent_t:
        raise ValueError(f"window k={k} must be in 1..{latent_t - 1}")
    return rng.randrange(latent_t - k + 1)


def audio_window(w0: int, k: int, latent_t: int, audio_t: int) -> tuple[int, int]:
    """(a0, ak): the target-audio rows covering the time of video latent frames ``w0 .. w0+k-1``."""
    ak = round(audio_t * k / latent_t)
    a0 = min(round(audio_t * w0 / latent_t), audio_t - ak)
    return a0, ak


def draw_source(rng: random.Random, by_source: Mapping[str, Sequence[int]]) -> int:
    """A source uniformly, then one of its samples (a large source does not outweigh a small one)."""
    source = sorted(by_source)[rng.randrange(len(by_source))]
    items = by_source[source]
    return items[rng.randrange(len(items))]


def token_mask(
    regions: Sequence[Mapping[str, Any]], *, latent_t: int, latent_h: int, latent_w: int
) -> list[list[list[float]]] | None:
    """Loss weight per video token [T][H/2][W/2] (0 = masked) for pixel regions; None without regions.

    A region ``[x0, y0, x1, y1]`` in clip pixels covers the tokens it touches plus one token of margin, on
    every latent frame (the overlays it comes from are static).
    """
    if not regions:
        return None
    th, tw = latent_h // TOKEN_LATENTS, latent_w // TOKEN_LATENTS
    size = LATENT_PIXELS * TOKEN_LATENTS
    grid = [[1.0] * tw for _ in range(th)]
    for region in regions:
        x0, y0, x1, y1 = (int(v) for v in region["region"])
        c0, c1 = max(0, x0 // size - 1), min(tw - 1, (x1 - 1) // size + 1)
        r0, r1 = max(0, y0 // size - 1), min(th - 1, (y1 - 1) // size + 1)
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                grid[r][c] = 0.0
    return [[list(row) for row in grid] for _ in range(latent_t)]


def drift_report(history: Sequence[Mapping[str, Any]], window: int) -> dict[str, Any]:
    """Mean loss of the last ``window`` steps over the first, per timestep bin present in both."""
    window = max(1, window)
    first, last = history[:window], history[-window:]
    ratios: dict[int, float] = {}
    for gi in sorted({int(h["gi"]) for h in first} & {int(h["gi"]) for h in last}):
        f = [float(h["loss"]) for h in first if int(h["gi"]) == gi]
        lt = [float(h["loss"]) for h in last if int(h["gi"]) == gi]
        ratios[gi] = (sum(lt) / len(lt)) / max(sum(f) / len(f), 1e-12)
    mean = sum(ratios.values()) / len(ratios) if ratios else None
    return {
        "per_bin_ratio": {str(k): round(v, 4) for k, v in ratios.items()},
        "mean_ratio": None if mean is None else round(mean, 4),
        "diverging": bool(mean is not None and mean > DRIFT_LIMIT),
    }


@dataclass(frozen=True)
class Thermal:
    """Thermal gate between steps: start only below ``start_soc``; after a pause wait for both resume values."""

    start_soc: float = 85.0
    resume_soc: float = 70.0
    resume_gpu: float = 68.0
    poll_seconds: float = 2.0
    max_pause_seconds: float = 3600.0
    save_every_seconds: float = 600.0

    def hot(self, soc: float | None) -> bool:
        """Whether the next step may not start."""
        return soc is not None and soc > self.start_soc

    def cool(self, soc: float | None, gpu: float | None) -> bool:
        """Whether a paused run may continue."""
        return (soc is None or soc <= self.resume_soc) and (
            gpu is None or gpu <= self.resume_gpu
        )


def args_digest(params: Mapping[str, Any], *, samples_digest: str) -> str:
    """The training identity a checkpoint must match before a resume (hyperparameters and data)."""
    keys = (
        "rank",
        "alpha",
        "learning_rate",
        "warmup_steps",
        "window_latent_frames",
        "timestep_bins",
        "sigma_min",
        "seed",
        "steps",
        "targets",
        "w8_group",
    )
    doc = {k: params.get(k) for k in keys} | {"samples": samples_digest}
    return hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest()[:16]


def lr_scale(step: int, warmup: int) -> float:
    """Linear warmup factor of the learning rate."""
    return min(1.0, (step + 1) / warmup) if warmup > 0 else 1.0


__all__ = [
    "AUDIO_SHIFT",
    "CKPT_SCHEMA",
    "TARGET_KEYS",
    "VIDEO_SHIFT",
    "Thermal",
    "args_digest",
    "audio_window",
    "draw_source",
    "draw_window",
    "drift_report",
    "lr_scale",
    "shift_sigma",
    "timestep_grid",
    "token_mask",
]
