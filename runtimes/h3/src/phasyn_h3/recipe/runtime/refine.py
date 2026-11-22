"""Low-noise refinement from an existing latent (SDEdit / hires-fix style second pass), torch-free.

Opt-in on ``h3.dit``: the ``init_latent`` input (another run's ``video.final-latent.v1`` bundle) and the
``start_step`` parameter.  The plan, its sigma artifact and the seeded noise draw stay exactly as without
refinement; the stage then

* starts the loop at grid index ``start_step`` (``video[start_step:]`` / ``audio[start_step:]``, so the loop runs
  ``len(grid) - 1 - start_step`` updates over the plan's own sigma values, never recomputed);
* builds the initial target rows as the rectified-flow interpolation ``x_s = s * noise + (1 - s) * x0`` with
  ``x0`` the init latent in the noise's row order (video patchified ``[1,2,2]``, audio ``[2*T, 32]``) and ``s``
  the grid value at ``start_step`` of that modality.

Without the option nothing here runs and the stage is the stage of today.  Only an online AdaLN DiT without a
LoRA takes it: a fixed AdaLN sidecar and a LoRA's sampling contract are tied to the full grid.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .errors import InvalidStageInput, UnsupportedCombination


STAGE_OPTION = "refine"
INPUT_ROLE = "init_latents"
LATENT_MISMATCH = "LATENT_MISMATCH"


@dataclass(frozen=True)
class Refine:
    """Where the refinement pass enters the plan's grid."""

    start_step: int

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {"start_step": self.start_step, "formula": "sigma*noise+(1-sigma)*x0"}


def parse(
    stage: Mapping[str, Any], *, planned_updates: int, adaln_mode: str, has_lora: bool
) -> Refine | None:
    """The stage's ``refine`` option (None: the option is off and nothing changes)."""
    raw = stage.get(STAGE_OPTION)
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise InvalidStageInput(
            "REFINE_OPTION_INVALID", "refine 必須是 object", field_path="refine"
        )
    start = raw.get("start_step")
    if isinstance(start, bool) or not isinstance(start, int):
        raise InvalidStageInput(
            "REFINE_START_STEP_INVALID", f"start_step 必須是整數，收到 {start!r}"
        )
    if not 1 <= start < planned_updates:
        raise InvalidStageInput(
            "REFINE_START_STEP_RANGE",
            f"start_step={start} 必須落在 1..{planned_updates - 1}（steps={planned_updates}）",
            field_path="start_step",
        )
    if adaln_mode != "online":
        raise UnsupportedCombination(
            "REFINE_ADALN_MODE",
            f"從既有 latent 精修只支援 online AdaLN；此元件是 adaln.mode={adaln_mode}（固定 sidecar 綁定完整 sigma 網格）",
            field_path="adaln.mode",
        )
    if has_lora:
        raise UnsupportedCombination(
            "REFINE_LORA",
            "從既有 latent 精修不支援綁定 LoRA 的 DiT（LoRA 的採樣合約綁定完整 sigma 網格）",
        )
    return Refine(start_step=start)


def truncate(
    video: Sequence[float], audio: Sequence[float], refine: Refine | None
) -> tuple[list[float], list[float]]:
    """The sigma lists the loop runs: the plan's grids, from ``start_step`` on when refining."""
    if refine is None:
        return list(video), list(audio)
    if len(video) != len(audio) or not 1 <= refine.start_step < len(video) - 1:
        raise InvalidStageInput(
            "REFINE_START_STEP_RANGE",
            f"start_step={refine.start_step} 不在 sigma 網格（{len(video)} 點）之內",
        )
    return list(video[refine.start_step :]), list(audio[refine.start_step :])


def check_shapes(
    video_shape: Sequence[int],
    audio_shape: Sequence[int],
    geometry: Mapping[str, Any],
) -> None:
    """The init latent must have exactly the plan's latent shapes (never reshaped or resized)."""
    for name, have, want in (
        (
            "video_latent",
            list(video_shape),
            list(geometry.get("video_latent_shape") or []),
        ),
        (
            "audio_latent",
            list(audio_shape),
            list(geometry.get("audio_latent_shape") or []),
        ),
    ):
        if [int(d) for d in have] != [int(d) for d in want]:
            raise InvalidStageInput(
                "INIT_LATENT_SHAPE",
                f"init_latent 的 {name} 形狀 {have} 與此 plan 的幾何 {want} 不符（不 reshape、不縮放）",
                error_code=LATENT_MISMATCH,
                field_path=f"init_latent.{name}",
                expected=want,
                actual=have,
            )


def check_dtype(name: str, dtype: str) -> None:
    """Check whether the latent dtype can be used for refinement."""
    if dtype != "F32":
        raise InvalidStageInput(
            "INIT_LATENT_DTYPE",
            f"init_latent 的 {name} 必須是 F32（normalized），收到 {dtype}",
            error_code=LATENT_MISMATCH,
            field_path=f"init_latent.{name}",
        )


def noised_rows[T](noise: T, init: Any, sigma: float) -> T:
    """``sigma * noise + (1 - sigma) * init`` (rectified flow), in the rows' own dtype (FP32)."""
    if tuple(getattr(noise, "shape", ())) != tuple(getattr(init, "shape", ())):
        raise InvalidStageInput(
            "INIT_LATENT_ROWS",
            f"init_latent rows {tuple(getattr(init, 'shape', ()))} 與 noise rows {tuple(getattr(noise, 'shape', ()))} 不同",
            error_code=LATENT_MISMATCH,
        )
    out: T = sigma * noise + (1.0 - sigma) * init  # type: ignore[operator]
    return out


__all__ = [
    "INPUT_ROLE",
    "STAGE_OPTION",
    "Refine",
    "check_dtype",
    "check_shapes",
    "noised_rows",
    "parse",
    "truncate",
]
