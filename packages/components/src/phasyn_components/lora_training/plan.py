"""Training defaults, the step budget for a dataset size, chunking and the registered LoRA manifest (pure).

The defaults are a conservative style/motion LoRA on the plain (not distilled) H3 Ref2VA weights: rank 16,
alpha 16, learning rate 1e-4, the inference shift-12 timestep grid and a few hundred steps that grow with the
number of training clips. Training runs in chunks; every chunk ends with a resumable checkpoint and a LoRA
file, so an early comparison can stop a run that does not help.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

from ..errors import ComponentError


DEFAULTS: dict[str, Any] = {
    "rank": 16,
    "alpha": 16.0,
    "learning_rate": 1e-4,
    "warmup_steps": 20,
    "window_latent_frames": 3,
    "timestep_bins": 16,
    "sigma_min": 0.0,
    "seed": 20261121,
    "checkpoint_seconds": 600,
    "chunk_steps": 150,
}
STEP_ROUND = 50
MAX_RANK = 128
STEPS_PER_CLIP = 2.5
MIN_STEPS, MAX_STEPS = 300, 1200
DEFAULT_STRENGTHS = (0.0, 0.25, 0.5, 0.75, 1.0)
MAX_STRENGTHS = 7
MAX_STRENGTH = 2.0
# Step counts a flow-matching LoRA trained on the continuous shift-12 grid may be sampled with.
SAMPLING_STEPS = (4, 6, 8, 12, 16, 18, 20, 24, 25, 30, 40, 50)
H3_LICENSE_URL = "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE"
PEFT_TARGETS = ("to_q", "to_k", "to_v", "to_out.0", "ff.net.0.proj", "ff.net.2")
_SLUG = re.compile(r"[^a-z0-9]+")


def default_steps(train_clips: int) -> int:
    """A few hundred steps, growing with the dataset and rounded to whole checkpoints."""
    raw = STEPS_PER_CLIP * max(train_clips, 1)
    rounded = int(math.ceil(raw / STEP_ROUND) * STEP_ROUND)
    return max(MIN_STEPS, min(MAX_STEPS, rounded))


def chunk_ends(total_steps: int, chunk_steps: int) -> list[int]:
    """The step at which every training chunk ends (the last one is the total)."""
    if total_steps <= 0 or chunk_steps <= 0:
        raise ComponentError("INVALID_ARGUMENT", "訓練步數與分段步數必須大於 0")
    ends = list(range(chunk_steps, total_steps, chunk_steps))
    return [*ends, total_steps]


def check_strengths(values: Sequence[float]) -> list[float]:
    """Strengths of the comparison grid: distinct, 0 included, within bounds, ascending."""
    out = sorted({round(float(v), 4) for v in values})
    if not out or len(out) > MAX_STRENGTHS:
        raise ComponentError(
            "INVALID_ARGUMENT", f"LoRA 強度需要 1 到 {MAX_STRENGTHS} 個值"
        )
    if out[0] < 0 or out[-1] > MAX_STRENGTH:
        raise ComponentError(
            "INVALID_ARGUMENT", f"LoRA 強度必須介於 0 與 {MAX_STRENGTH} 之間"
        )
    if out[0] != 0.0:
        out.insert(0, 0.0)
    return out


def early_strengths(strengths: Sequence[float]) -> list[float]:
    """The early round's subset of a checked grid: 0, the strength nearest half the top one, and the top one."""
    grid = check_strengths(strengths)
    top = grid[-1]
    middle = min(grid[1:-1], key=lambda s: abs(s - top / 2), default=None)
    return sorted({0.0, top} | ({middle} if middle is not None else set()))


def lora_slug(name: str, job_id: str) -> str:
    """A filesystem-safe LoRA id: ASCII words of the name plus the job's short id."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = _SLUG.sub("-", ascii_name.lower()).strip("-")[:40]
    short = job_id.replace("-", "")[:8]
    return f"trained-{slug}-{short}" if slug else f"trained-{short}"


def manifest(  # noqa: PLR0913 - the manifest's independent facts
    *,
    lora_id: str,
    label: str,
    relative_path: str,
    sha256: str,
    size_bytes: int,
    rank: int,
    alpha: float,
    revision: str,
    notes: Sequence[str],
    status: str = "registered",
) -> dict[str, Any]:
    """A LoRA manifest in the schema the H3 DiT loads (``peft_diffusers``, Ref2VA, no AdaLN)."""
    return {
        "schema_version": "1.0",
        "lora_id": lora_id,
        "family": "minimax_h3",
        "label": label,
        "source_repo": f"local:phasyn-training/{lora_id}",
        "source_revision": revision,
        "license_url": H3_LICENSE_URL,
        "base_model_license_url": H3_LICENSE_URL,
        "file": {
            "relative_path": relative_path,
            "sha256": sha256,
            "size_bytes": int(size_bytes),
        },
        "format": "peft_diffusers",
        "variants": ["ref2va"],
        "rank": int(rank),
        "alpha": float(alpha),
        "alpha_source": "file_metadata",
        "alpha_note": "trained here; alpha written into the file metadata",
        "touches_adaln": False,
        "targets": list(PEFT_TARGETS),
        "pdd": None,
        "sampling_contract": {
            "steps": list(SAMPLING_STEPS),
            "video_shift": 12.0,
            "audio_shift": 3.0,
            "scheduler": "h3_euler",
        },
        "fixed_scale": None,
        "notes_zh": list(notes),
        "status": status,
        "is_fixture": False,
    }


def training_parameters(
    options: Mapping[str, Any], *, train_clips: int
) -> dict[str, Any]:
    """Resolved hyperparameters of one job: the defaults overlaid with the user's choices."""
    out = dict(DEFAULTS)
    out.update({k: v for k, v in options.items() if k in DEFAULTS and v is not None})
    steps = options.get("steps")
    out["steps"] = int(steps) if steps else default_steps(train_clips)
    if not 1 <= out["rank"] <= MAX_RANK:
        raise ComponentError("INVALID_ARGUMENT", "rank 必須介於 1 與 128")
    if not 0 <= float(out["sigma_min"]) < 1:
        raise ComponentError("INVALID_ARGUMENT", "sigma_min 必須介於 0 與 1")
    return out


__all__ = [
    "DEFAULTS",
    "DEFAULT_STRENGTHS",
    "PEFT_TARGETS",
    "SAMPLING_STEPS",
    "check_strengths",
    "chunk_ends",
    "default_steps",
    "early_strengths",
    "lora_slug",
    "manifest",
    "training_parameters",
]
