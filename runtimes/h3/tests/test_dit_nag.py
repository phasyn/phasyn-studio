"""``h3.dit`` Normalized Attention Guidance (``nag_conditioning`` + ``nag_*``), torch-free.

Off (no input, no parameter) leaves the call, its stage options and the request schema of today; the formula is
checked on numpy rows against the paper's equations written out per row; the extended layout (negative rows,
positions, AdaLN sources, segments) is checked on a small layout; the unsupported combinations are refused.
The numerics on a tiny real DiT run in ``nag_cpu.py`` (a GPU runtime tuple's interpreter, CPU only);
``test_cpu_nag`` runs it when ``PHASYN_H3_RUNTIME_PYTHON`` names such an interpreter.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import jsonschema
import numpy as np
import pytest
from phasyn_components.errors import ComponentError

from phasyn_h3 import config
from phasyn_h3.providers import _denoise_options, nag_request
from phasyn_h3.recipe.runtime import nag_rules as rules
from phasyn_h3.recipe.runtime.errors import InvalidStageInput, UnsupportedCombination


# the product's PAI component (5080 pai8): approximate, auto_exact attention, fixed AdaLN sidecar, PDD LoRA
PAI8 = {
    "variant": "ref2va",
    "mode": "approximate",
    "attention": {"provider": "auto_exact", "reject_quadratic_materialization": True},
    "adaln": {
        "mode": "fixed",
        "host_cache_bytes": 8 << 30,
        "cache_ref": "h3-ref2va-pdd8",
    },
    "lora": {"manifest_path": "pai-h3-ref2va-acc8.json", "scale": 1.0},
}


# ---------------------------------------------------------------------------------------------- (a) off


def test_off_changes_nothing() -> None:
    params = {"seed": 42, "steps": 8, "video_shift": 12.0, "audio_shift": 3.0}
    assert (
        nag_request(params, has_negative=False, planned_updates=8, options=PAI8) is None
    )
    assert _denoise_options(None, None) is None  # the stage dict of today
    assert _denoise_options({"start_step": 3}, None) == {"refine": {"start_step": 3}}
    assert (
        rules.parse(
            {"kind": "denoise_av"},
            mode="exact",
            attention="subblock_sparse_attn",
            ref_kv_cache=True,
            ptd=True,
        )
        is None
    )
    jsonschema.validate(params, config.parameters_schema("dit"))


# ---------------------------------------------------------------------------------------------- (b) formula


def _paper(
    pos: np.ndarray, neg: np.ndarray, phi: float, tau: float, alpha: float
) -> np.ndarray:
    """Eq. 7-10 of arXiv 2505.21179, one row at a time in float64."""
    out = np.empty_like(pos, dtype=np.float64)
    for i in range(pos.shape[0]):
        zp, zn = pos[i].astype(np.float64).ravel(), neg[i].astype(np.float64).ravel()
        zt = zp + phi * (zp - zn)
        r = np.abs(zt).sum() / np.abs(zp).sum()
        zh = zt * min(r, tau) / r
        out[i] = (alpha * zh + (1 - alpha) * zp).reshape(pos.shape[1:])
    return out


def test_formula_matches_the_paper() -> None:
    rng = np.random.default_rng(0)
    pos = rng.standard_normal((16, 3, 8))
    neg = (
        pos
        + rng.standard_normal((16, 3, 8)) * np.linspace(0.01, 3.0, 16)[:, None, None]
    )
    got = rules.nag_combine(pos, neg, phi=4.0, tau=2.5, alpha=0.25)
    np.testing.assert_allclose(
        got, _paper(pos, neg, 4.0, 2.5, 0.25), rtol=1e-6, atol=1e-6
    )
    # some rows are clipped, some are not: the clipped Z^ has |Z^|_1 / |Z+|_1 == tau
    guided = pos * 5.0 - neg * 4.0
    ratio = np.abs(guided).reshape(16, -1).sum(-1) / np.abs(pos).reshape(16, -1).sum(-1)
    assert (ratio > 2.5).any() and (ratio <= 2.5).any()
    zhat = (got - 0.75 * pos) / 0.25
    clipped = np.abs(zhat).reshape(16, -1).sum(-1) / np.abs(pos).reshape(16, -1).sum(-1)
    np.testing.assert_allclose(clipped[ratio > 2.5], 2.5, rtol=1e-6)
    assert (clipped <= 2.5 + 1e-6).all()


def test_formula_edges() -> None:
    rng = np.random.default_rng(1)
    pos = rng.standard_normal((4, 2, 4)).astype(np.float32)
    neg = rng.standard_normal((4, 2, 4)).astype(np.float32)
    assert (
        rules.nag_combine(pos, neg, phi=0.0, tau=2.5, alpha=0.25) is pos
    )  # phi = 0: no arithmetic
    np.testing.assert_allclose(
        rules.nag_combine(pos, pos.copy(), phi=4.0, tau=2.5, alpha=0.25), pos, rtol=1e-6
    )
    np.testing.assert_allclose(
        rules.nag_combine(pos, neg, phi=4.0, tau=2.5, alpha=0.0), pos, rtol=1e-6
    )
    zero = np.zeros((1, 2, 4), np.float32)  # a zero row stays zero (no NaN)
    with np.errstate(
        divide="ignore", invalid="ignore"
    ):  # |Z+|_1 = 0: the ratio is inf, the row is clipped to 0
        assert np.isfinite(
            rules.nag_combine(zero, zero + 1, phi=4.0, tau=2.5, alpha=0.25)
        ).all()
    assert rules.nag_combine(pos, neg, phi=4.0, tau=2.5, alpha=0.25).dtype == np.float32


# ---------------------------------------------------------------------------------------------- (c) layout


def test_extended_layout() -> None:
    pos_tags = [
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        1,
    ]  # 12 text rows, Qwen vision rows 3..6
    rows = rules.row_plan(
        text_len=12,
        used=88,
        seq_len=128,
        positive_text_tags=pos_tags,
        negative_text_tags=[1] * 5,
    )
    assert (rows.ext_used, rows.ext_seq_len) == (93, 128)
    assert (
        rows.positive == (0, 88)
        and rows.negative == (12, 93)
        and rows.padding == (93, 128)
    )
    assert rows.negative_text == (88, 93)
    assert rows.position_src[:88] == tuple(range(88)) and rows.index_src[:88] == tuple(
        range(88)
    )
    assert rows.position_src[88:93] == (
        7,
        8,
        9,
        10,
        11,
    )  # right aligned on the last 5 text rows
    assert (
        rows.index_src[88:93] == (0,) * 5
    )  # a text row (tag 1): its AdaLN index and tag
    assert set(rows.position_src[93:]) == {88} and set(rows.index_src[93:]) == {
        88
    }  # an original padding row
    grown = rules.row_plan(
        text_len=12,
        used=126,
        seq_len=128,
        positive_text_tags=pos_tags,
        negative_text_tags=[1] * 5,
    )
    assert (grown.ext_used, grown.ext_seq_len, grown.padding) == (131, 192, (131, 192))
    exact = rules.row_plan(
        text_len=12,
        used=59,
        seq_len=64,
        positive_text_tags=pos_tags,
        negative_text_tags=[1] * 5,
    )
    assert exact.ext_seq_len == 64 and exact.padding == (64, 64)


def test_layout_refusals() -> None:
    tags = [1] * 12
    with pytest.raises(UnsupportedCombination) as err:
        rules.row_plan(
            text_len=12,
            used=88,
            seq_len=128,
            positive_text_tags=tags,
            negative_text_tags=[1, 0, 1],
        )
    assert err.value.reason_code == "NAG_NEGATIVE_VISION"
    with pytest.raises(InvalidStageInput) as err2:
        rules.row_plan(
            text_len=12,
            used=88,
            seq_len=128,
            positive_text_tags=tags,
            negative_text_tags=[1] * 13,
        )
    assert err2.value.reason_code == "NAG_NEGATIVE_TOO_LONG"
    with pytest.raises(InvalidStageInput):
        rules.row_plan(
            text_len=12,
            used=88,
            seq_len=128,
            positive_text_tags=tags,
            negative_text_tags=[],
        )


# ---------------------------------------------------------------------------------------------- (d) refusals


def test_parameters_and_defaults() -> None:
    on = nag_request({}, has_negative=True, planned_updates=8, options=PAI8)
    assert on == {
        "phi": 4.0,
        "tau": 2.5,
        "alpha": 0.25,
        "steps": None,
    }  # PAI fixed AdaLN + PDD LoRA: accepted
    given = {"nag_scale": 2, "nag_tau": 3.0, "nag_alpha": 0.5, "nag_steps": 4}
    assert nag_request(given, has_negative=True, planned_updates=8, options=PAI8) == {
        "phi": 2.0,
        "tau": 3.0,
        "alpha": 0.5,
        "steps": 4,
    }
    jsonschema.validate({"seed": 1, **given}, config.parameters_schema("dit"))
    staged = rules.parse(
        {"nag": on},
        mode="approximate",
        attention="pytorch_sdpa",
        ref_kv_cache=False,
        ptd=False,
    )
    assert staged == rules.Nag(phi=4.0, tau=2.5, alpha=0.25)
    assert (
        staged.on(7)
        and rules.Nag(4.0, 2.5, 0.25, steps=2).on(1)
        and not rules.Nag(4.0, 2.5, 0.25, steps=2).on(2)
    )


@pytest.mark.parametrize(
    "params",
    [
        {"nag_alpha": 1.5},
        {"nag_tau": 0.5},
        {"nag_scale": -1},
        {"nag_steps": 9},
        {"nag_steps": 0},
        {"nag_scale": True},
    ],
)
def test_out_of_range_is_refused(params: dict[str, Any]) -> None:
    with pytest.raises(ComponentError) as err:
        nag_request(params, has_negative=True, planned_updates=8, options=PAI8)
    assert err.value.code == "INVALID_ARGUMENT"


def test_parameters_without_the_negative_are_refused() -> None:
    with pytest.raises(ComponentError) as err:
        nag_request(
            {"nag_scale": 4}, has_negative=False, planned_updates=8, options=PAI8
        )
    assert err.value.code == "INVALID_ARGUMENT"


@pytest.mark.parametrize(
    "options",
    [
        {**PAI8, "mode": "exact"},
        {**PAI8, "attention": {"provider": "subblock_sparse_attn"}},
        {
            **PAI8,
            "ref_kv_cache": {
                "mode": "skip",
                "start_step": 1,
                "cache_dtype": "fp8",
                "refresh_steps": [],
            },
        },
    ],
)
def test_unsupported_components_are_refused(options: dict[str, Any]) -> None:
    with pytest.raises(ComponentError) as err:
        nag_request({}, has_negative=True, planned_updates=8, options=options)
    assert err.value.code == "UNSUPPORTED_COMBINATION"


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"mode": "exact"}, "NAG_EXACT_MODE"),
        ({"attention": "subblock_sparse_attn"}, "NAG_ATTENTION_UNSUPPORTED"),
        ({"ref_kv_cache": True}, "NAG_REF_KV_CACHE"),
        ({"ptd": True}, "NAG_LORA_PTD"),
    ],
)
def test_stage_refusals(kwargs: dict[str, Any], reason: str) -> None:
    base: dict[str, Any] = {
        "mode": "approximate",
        "attention": "pytorch_sdpa",
        "ref_kv_cache": False,
        "ptd": False,
    }
    with pytest.raises(UnsupportedCombination) as err:
        rules.parse({"nag": {}}, **{**base, **kwargs})
    assert err.value.reason_code == reason


def test_parallel_and_encoder_refusals() -> None:
    rules.check_parallel((1, 1, 1))
    for sizes in ((2, 1, 1), (1, 2, 1), (1, 1, 2)):
        with pytest.raises(UnsupportedCombination):
            rules.check_parallel(sizes)
    same = {
        "encoder_revision": "r",
        "tokenizer_digest": "t",
        "quant_profile_digest": "q",
        "geometry_digest": "a",
    }
    rules.check_same_encoder(
        same, {**same, "geometry_digest": "b"}
    )  # another geometry (t2va step) is fine
    with pytest.raises(InvalidStageInput):
        rules.check_same_encoder(same, {**same, "tokenizer_digest": "x"})


def test_cpu_nag(tmp_path: Path) -> None:
    """Runs ``nag_cpu.py`` under a runtime tuple's interpreter (CPU only, ``CUDA_VISIBLE_DEVICES=``)."""
    python = os.environ.get("PHASYN_H3_RUNTIME_PYTHON")
    if not python:
        pytest.skip(
            "PHASYN_H3_RUNTIME_PYTHON 未指向 runtime tuple 的 python（需要 torch\N{FULLWIDTH PLUS SIGN}釘版 SGLang）；未驗證，不算通過"
        )
    script = Path(__file__).resolve().parent / "nag_cpu.py"
    result = subprocess.run(  # noqa: S603 - Run the designated Python test worker using an argument vector.
        [python, "-I", "-B", str(script), "--work", str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=1800,
        env={**os.environ, "CUDA_VISIBLE_DEVICES": ""},
        check=False,
    )
    assert result.returncode == 0, result.stdout[-6000:] + result.stderr[-3000:]
