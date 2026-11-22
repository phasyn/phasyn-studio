"""``h3.dit`` refinement from an existing latent (``init_latent`` + ``start_step``), torch-free.

Off (neither given) must leave the plan, the sigma grid and the initial rows untouched; on, the loop enters the
plan's own grid at ``start_step`` with ``sigma * noise + (1 - sigma) * x0`` as its rows; a fixed AdaLN or LoRA
component and a latent of another shape are refused.
"""

from __future__ import annotations

from typing import Any

import jsonschema
import numpy as np
import pytest
from phasyn_components.errors import ComponentError

from phasyn_h3 import config
from phasyn_h3.providers import refine_request
from phasyn_h3.recipe.adapter.schedule import build_schedule, read_sigma_payload
from phasyn_h3.recipe.runtime import refine
from phasyn_h3.recipe.runtime.errors import InvalidStageInput, UnsupportedCombination


ONLINE = {"adaln": {"mode": "online"}, "lora": None}
FIXED = {"adaln": {"mode": "fixed", "cache_ref": "h3-ref2va-pdd8"}, "lora": None}
GEOMETRY = {
    "video_latent_shape": [1, 24, 8, 28, 48],
    "audio_latent_shape": [1, 2, 8, 32],
}


def _grid(steps: int = 50) -> tuple[list[float], list[float]]:
    _schedule, payload, _facts = build_schedule(
        steps=steps, video_shift=12.0, audio_shift=3.0
    )
    grids = read_sigma_payload(payload)
    return [float(x) for x in grids["video_sigmas"]], [
        float(x) for x in grids["audio_sigmas"]
    ]


def _patchify(latent: np.ndarray) -> np.ndarray:
    """numpy mirror of the pinned ``minimax_h3_patchify_video_latent`` with patch [1,2,2]."""
    b, c, t, h, w = latent.shape
    packed = latent.reshape(b, c, t, 1, h // 2, 2, w // 2, 2)
    packed = np.einsum("nctrhpwq->nthwcrpq", packed)
    return np.asarray(packed).reshape(b * t * (h // 2) * (w // 2), c * 4)


def test_off_changes_nothing() -> None:
    video, audio = _grid()
    assert (
        refine_request(None, has_init=False, planned_updates=50, options=FIXED) is None
    )
    assert (
        refine.parse(
            {"kind": "denoise_av"},
            planned_updates=50,
            adaln_mode="fixed",
            has_lora=True,
        )
        is None
    )
    assert refine.truncate(video, audio, None) == (video, audio)
    # the request without the new parameter still validates and the plan's schedule does not see it
    schema = config.parameters_schema("dit")
    jsonschema.validate(
        {"seed": 42, "steps": 50, "video_shift": 12.0, "audio_shift": 3.0}, schema
    )
    assert (
        build_schedule(steps=50, video_shift=12.0, audio_shift=3.0)[1]
        == build_schedule(steps=50, video_shift=12.0, audio_shift=3.0)[1]
    )


def test_grid_truncation_and_update_count() -> None:
    video, audio = _grid()
    on = refine.parse(
        {"refine": {"start_step": 30}},
        planned_updates=50,
        adaln_mode="online",
        has_lora=False,
    )
    assert on == refine.Refine(start_step=30)
    tv, ta = refine.truncate(video, audio, on)
    assert tv == video[30:] and ta == audio[30:]
    assert (
        tv[-1] == 0.0 and len(tv) - 1 == 50 - 30
    )  # the loop runs len(grid) - 1 - start_step updates


def test_initial_rows_follow_the_formula() -> None:
    rng = np.random.default_rng(0)
    noise_latent = rng.standard_normal((1, 24, 8, 28, 48), dtype=np.float32)
    x0_latent = rng.standard_normal((1, 24, 8, 28, 48), dtype=np.float32)
    audio_noise = rng.standard_normal((16, 32), dtype=np.float32)
    audio_x0 = rng.standard_normal((1, 2, 8, 32), dtype=np.float32)
    video, audio = _grid()
    sv, sa = refine.truncate(video, audio, refine.Refine(start_step=30))
    rows = refine.noised_rows(_patchify(noise_latent), _patchify(x0_latent), sv[0])
    arows = refine.noised_rows(audio_noise, audio_x0[0].reshape(-1, 32), sa[0])
    assert rows.dtype == np.float32 and arows.dtype == np.float32
    expected = sv[0] * noise_latent.astype(np.float64) + (
        1.0 - sv[0]
    ) * x0_latent.astype(np.float64)
    np.testing.assert_allclose(rows, _patchify(expected), rtol=1e-6, atol=1e-6)
    np.testing.assert_allclose(
        arows,
        sa[0] * audio_noise + (1.0 - sa[0]) * audio_x0[0].reshape(-1, 32),
        rtol=1e-6,
        atol=1e-6,
    )


@pytest.mark.parametrize(
    "options",
    [FIXED, {"adaln": {"mode": "off"}}, {**ONLINE, "lora": {"manifest_path": "x"}}],
)
def test_fixed_adaln_or_lora_is_refused(options: dict[str, Any]) -> None:
    with pytest.raises(ComponentError) as err:
        refine_request(30, has_init=True, planned_updates=50, options=options)
    assert err.value.code == "UNSUPPORTED_COMBINATION"
    with pytest.raises(UnsupportedCombination):
        refine.parse(
            {"refine": {"start_step": 30}},
            planned_updates=50,
            adaln_mode=str(options["adaln"]["mode"]),
            has_lora=bool(options.get("lora")),
        )


@pytest.mark.parametrize(
    ("start", "has_init"),
    [(30, False), (None, True), (0, True), (50, True), (True, True)],
)
def test_incomplete_or_out_of_range_request_is_refused(
    start: Any, *, has_init: bool
) -> None:
    with pytest.raises(ComponentError) as err:
        refine_request(start, has_init=has_init, planned_updates=50, options=ONLINE)
    assert err.value.code == "INVALID_ARGUMENT"
    assert refine_request(30, has_init=True, planned_updates=50, options=ONLINE) == {
        "start_step": 30
    }


def test_shape_mismatch_is_refused() -> None:
    refine.check_shapes([1, 24, 8, 28, 48], [1, 2, 8, 32], GEOMETRY)
    for video, audio in (
        ([1, 24, 8, 28, 40], [1, 2, 8, 32]),
        ([1, 24, 8, 28, 48], [1, 2, 9, 32]),
    ):
        with pytest.raises(InvalidStageInput) as err:
            refine.check_shapes(video, audio, GEOMETRY)
        assert err.value.error_code == "LATENT_MISMATCH"
    with pytest.raises(InvalidStageInput) as err:
        refine.noised_rows(
            np.zeros((4, 96), np.float32), np.zeros((5, 96), np.float32), 0.5
        )
    assert err.value.error_code == "LATENT_MISMATCH"
    with pytest.raises(InvalidStageInput) as err:
        refine.check_dtype("video_latent", "BF16")
    assert err.value.error_code == "LATENT_MISMATCH"
