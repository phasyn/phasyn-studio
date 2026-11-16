"""``provider_options.ref_kv_cache`` (reference-row K/V cache across denoise steps), torch-free: the option rules,
the profile extension (absent when off), the plan diagnostics, the stage policy, the step plan and the sizes.

The numerics run on a tiny real DiT in ``ref_kv_cache_cpu.py`` (a GPU runtime tuple's interpreter, CPU only);
``test_cpu_equivalence`` runs it when ``PHASYN_H3_RUNTIME_PYTHON`` names such an interpreter.
"""

from __future__ import annotations

import copy
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import jsonschema
import pytest
from phasyn_components.errors import ComponentError
from phasyn_h3 import config
from phasyn_h3.plan import build_plan, make_job
from phasyn_h3.providers import LOAD_PLAN_PLACEHOLDER
from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.adapter import local_manifest
from phasyn_h3.recipe.adapter import ref_kv_rules as rules
from phasyn_h3.recipe.adapter.profile_rules import PROFILE_EXTENSION_SCHEMAS, validate_profile
from phasyn_h3.recipe.runtime.errors import UnsupportedCombination
from phasyn_h3.recipe.runtime.measure import dit_flop, dit_skip_step_flop, dit_step_flop
from phasyn_h3.recipe.runtime.policy import resolve_stage_policy
from phasyn_h3.recipe.runtime.stages import denoise_av

GIB = 1 << 30
SKIP = {"mode": "skip", "start_step": 1, "cache_dtype": "fp8", "refresh_steps": []}


def dit_settings(**options: Any) -> dict[str, Any]:
    """The resident Ref2VA INT8 component of a unified-memory GPU, LoRA off."""
    provider_options = {
        "variant": "ref2va",
        "shared_from": None,
        "mode": "approximate",
        "attention": {"provider": "auto_exact", "reject_quadratic_materialization": True},
        "adaln": {"mode": "fixed", "host_cache_bytes": 8 * GIB, "cache_ref": "h3-ref2va-pdd8"},
        "lora": None,
        "bounded_fp8_load": False,
    }
    provider_options.update(options)
    return {
        "load": {
            "model_path": "/models",
            "device": {"kind": "cuda", "id": "GPU-00000000-0000-0000-0000-000000000000", "resource_group": "gpu-uma"},
            "part_overrides": [],
            "precision": {
                "compute_dtype": "native",
                "quantization": {"scheme": "int8_convrot", "excluded_modules": ["adaln_proj"]},
            },
            "offload": {"mode": "none", "after_use": "device"},
            "provider_options": provider_options,
        },
        "invoke": {"seed": 42, "steps": 8, "video_shift": 12.0, "audio_shift": 3.0},
        "recording": {"mode": "detailed"},
    }


def profile_of(settings: dict[str, Any]) -> dict[str, Any]:
    return config.build_profile("dit", settings, profile_id="phasyn-test", revision=1)


def ref2va_plan(profile: dict[str, Any], steps: int = 8) -> dict[str, Any]:
    job = make_job(
        task="ref2va",
        prompt="ref kv cache",
        width=768,
        height=448,
        frames=124,
        variant="ref2va",
        materials=[LOAD_PLAN_PLACEHOLDER],
    )
    plan, _ = build_plan(job, profile, model=local_manifest("ref2va"), sampling={"steps": steps})
    return plan


# ------------------------------------------------------------------------------------------------ the option


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, None),
        ({"mode": "off"}, None),
        ({"mode": "skip"}, rules.RefKvCachePolicy(1, "fp8", (), None)),
        (
            {"mode": "skip", "start_step": 2, "cache_dtype": "bf16", "refresh_steps": [5, 3], "max_cache_bytes": 0},
            rules.RefKvCachePolicy(2, "bf16", (3, 5), 0),
        ),
    ],
)
def test_option_values(raw: Any, expected: rules.RefKvCachePolicy | None) -> None:
    assert rules.parse_option(raw) == expected


@pytest.mark.parametrize(
    ("raw", "field"),
    [
        ([], ""),
        ({"mode": "on"}, "mode"),
        ({"mode": "skip", "layers": [1]}, "layers"),
        ({"mode": "off", "cache_dtype": "fp8"}, "cache_dtype"),  # off with settings it would ignore
        ({"mode": "skip", "start_step": 0}, "start_step"),  # step 0 always fills the cache
        ({"mode": "skip", "start_step": True}, "start_step"),
        ({"mode": "skip", "cache_dtype": "fp16"}, "cache_dtype"),
        ({"mode": "skip", "start_step": 3, "refresh_steps": [2]}, "refresh_steps"),  # already a full step
        ({"mode": "skip", "refresh_steps": [4, 4]}, "refresh_steps"),
        ({"mode": "skip", "refresh_steps": "4"}, "refresh_steps"),
        ({"mode": "skip", "max_cache_bytes": -1}, "max_cache_bytes"),
    ],
)
def test_option_rejections(raw: Any, field: str) -> None:
    with pytest.raises(rules.OptionError) as err:
        rules.parse_option(raw)
    assert err.value.field == field


def test_the_settings_schema_takes_the_option_and_refuses_unknown_values() -> None:
    validator = jsonschema.Draft202012Validator(config.build_settings_schema("dit"))
    for value in (None, {"mode": "off"}, SKIP, {**SKIP, "refresh_steps": [4], "max_cache_bytes": 12 * GIB}):
        assert validator.is_valid(dit_settings(ref_kv_cache=value)), value
    for value in ({"mode": "skip", "layers": "all"}, {"mode": "skip", "start_step": 0}, {"cache_dtype": "fp8"}):
        assert not validator.is_valid(dit_settings(ref_kv_cache=value)), value
    for role in ("conditioning", "video_decode"):
        assert "ref_kv_cache" not in config.provider_options_schema(role)


def test_load_rules() -> None:
    assert config.check_supported("dit", dit_settings(), {}) == config.check_supported(
        "dit", dit_settings(ref_kv_cache={"mode": "off"}), {}
    )
    notes = config.check_supported("dit", dit_settings(ref_kv_cache=SKIP), {})
    assert any("ref_kv_cache skip" in note for note in notes)
    for options, words in (
        ({"mode": "exact", "adaln": {"mode": "online"}}, "mode=exact"),
        ({"variant": "fl2va", "adaln": {"mode": "online"}}, "Ref2VA"),
        ({"attention": {"provider": "fp8_fa_sm120"}}, "fp8_fa_sm120"),
        ({"attention": {"provider": "subblock_sparse_attn"}}, "subblock_sparse_attn"),
    ):
        settings = dit_settings(ref_kv_cache=SKIP, **options)
        if options.get("mode") == "exact":
            settings["load"]["precision"]["quantization"] = {"scheme": "none"}
        with pytest.raises(ComponentError) as err:
            config.check_supported("dit", settings, {})
        assert err.value.code == "UNSUPPORTED_SETTING" and words in err.value.message, err.value.message
    with pytest.raises(ComponentError) as err:
        config.check_supported("dit", dit_settings(ref_kv_cache={"mode": "skip", "start_step": 0}), {})
    assert err.value.details == {"field": "ref_kv_cache.start_step"}


# ------------------------------------------------------------------------------------------------ the profile


def test_off_is_the_profile_of_today() -> None:
    today = profile_of(dit_settings())
    for value in (None, {"mode": "off"}):
        off = profile_of(dit_settings(ref_kv_cache=value))
        assert off == today and canonical_digest(off) == canonical_digest(today)
    assert ref2va_plan(profile_of(dit_settings(ref_kv_cache={"mode": "off"}))) == ref2va_plan(today)


def test_skip_adds_one_explicit_extension() -> None:
    today = profile_of(dit_settings())
    skip = profile_of(dit_settings(ref_kv_cache={"mode": "skip", "refresh_steps": [4]}))
    ext = skip["extensions"][-1]
    assert skip["extensions"][:-1] == today["extensions"] and {k: v for k, v in skip.items() if k != "extensions"} == {
        k: v for k, v in today.items() if k != "extensions"
    }
    assert ext == {
        "namespace": rules.EXTENSION,
        "schema_digest": config.EXTENSION_DIGESTS[rules.EXTENSION],
        "values": {
            "mode": "skip",
            "start_step": 1,
            "cache_dtype": "fp8",
            "refresh_steps": [4],
            "max_cache_bytes": None,
        },
    }
    assert config.EXTENSION_DIGESTS[rules.EXTENSION] == canonical_digest(
        dict(PROFILE_EXTENSION_SCHEMAS[rules.EXTENSION])
    )
    jsonschema.Draft202012Validator(rules.EXTENSION_SCHEMA).validate(ext["values"])


def test_plan_time_diagnostics() -> None:
    skip = profile_of(dit_settings(ref_kv_cache=SKIP))
    model = local_manifest("ref2va")
    assert [d for d in validate_profile(skip, model=model) if rules.EXTENSION in " ".join(d["field_paths"])] == []
    for edit, words in (
        (lambda p: p.update(mode="exact"), "mode=exact"),
        (lambda p: p["attention"].update(provider="fp8_fa_sm120"), "fp8_fa_sm120"),
        (lambda p: p["extensions"][-1]["values"].pop("max_cache_bytes"), "max_cache_bytes"),
        (lambda p: p["extensions"][-1]["values"].update(mode="off"), "skip"),
    ):
        profile = copy.deepcopy(skip)
        edit(profile)
        diags = [d for d in validate_profile(profile, model=model) if d["severity"] == "error"]
        assert any(words in d["message"] for d in diags), diags
    fl2va = [d for d in validate_profile(skip, model=local_manifest("fl2va")) if d["severity"] == "error"]
    assert any("Ref2VA" in d["message"] for d in fl2va)


def test_the_stage_policy_carries_the_cache() -> None:
    plan = ref2va_plan(profile_of(dit_settings(ref_kv_cache={**SKIP, "refresh_steps": [4]})))
    for stage in ("load_dit", "assemble_inputs", "denoise_av"):
        policy = resolve_stage_policy(plan, stage, sm=(12, 1))
        assert policy.ref_kv_cache == rules.RefKvCachePolicy(1, "fp8", (4,), None)
    assert resolve_stage_policy(ref2va_plan(profile_of(dit_settings())), "denoise_av", sm=(12, 1)).ref_kv_cache is None
    for edit, reason in (
        (lambda p: p["attention"].update(provider="fp8_fa_sm120"), "REF_KV_CACHE_ATTENTION_UNSUPPORTED"),
        (lambda p: p.update(mode="exact"), "REF_KV_CACHE_NOT_EXACT"),
        (lambda p: p["extensions"][-1]["values"].update(start_step=0), "EXTENSION_VALUE_INVALID"),
        (lambda p: p["extensions"].append(copy.deepcopy(p["extensions"][-1])), "EXTENSION_VALUE_INVALID"),
    ):
        bad = copy.deepcopy(plan)
        edit(bad["effective_profile"])
        if bad["effective_profile"]["mode"] == "exact":  # the online INT8 rule refuses exact first otherwise
            bad["effective_profile"]["components"]["transformer"]["quantization"] = {
                "scheme": "none",
                "provider": "native",
            }
            bad["effective_profile"]["adaln"]["mode"] = "off"
        with pytest.raises(UnsupportedCombination) as err:
            resolve_stage_policy(bad, "denoise_av", sm=(12, 0))  # 12.0: fp8_fa_sm120 itself is allowed there
        assert err.value.reason_code == reason, err.value.message


def test_denoise_av_takes_the_path_of_today_when_off() -> None:
    run = SimpleNamespace(policy=SimpleNamespace(ref_kv_cache=None))
    assert denoise_av._planned_ref_skip(run, {}, 8) is None  # type: ignore[arg-type]
    assert denoise_av._open_ref_kv_cache(run, None, None, 8, None) is None  # type: ignore[arg-type]


# ------------------------------------------------------------------------------------------------ plan and sizes


def test_step_plan() -> None:
    plan = rules.step_plan
    assert plan(8, start_step=1) == ("fill",) + ("skip",) * 7
    assert plan(8, start_step=1, refresh_steps=[4]) == ("fill", "skip", "skip", "skip", "fill", "skip", "skip", "skip")
    assert plan(8, start_step=3) == ("full", "full", "fill") + ("skip",) * 5  # the cache holds the last full step
    assert plan(4, start_step=1, refresh_steps=[2, 3]) == ("fill", "skip", "full", "full")
    assert plan(1, start_step=1) == ("full",) and plan(4, start_step=4) == ("full",) * 4
    for steps in range(1, 12):
        for start in range(1, 6):
            p = plan(steps, start_step=start, refresh_steps=[5, 7])
            assert p[0] != "skip" and all(p[s - 1] in ("fill", "skip") for s in range(1, steps) if p[s] == "skip")


# reference rows R and live rows N of a swap segment by reference-video short edge:
# R = 32 latent frames x rows per frame + 3,072 image rows + 356-358 audio rows
REAL = {448: (14_628, 50_896), 576: (21_860, 59_258), 768: (35_686, 75_229)}


def test_cache_bytes_at_the_real_sizes() -> None:
    def gib(edge: int, dtype: str) -> float:
        return rules.cache_bytes(layers=50, ref_rows=REAL[edge][0], heads=56, head_dim=128, cache_dtype=dtype) / GIB

    assert rules.cache_bytes(layers=50, ref_rows=14_628, heads=56, head_dim=128, cache_dtype="fp8") == (
        50 * 2 * 14_628 * 56 * 128 + 50 * 2 * 56 * 4
    )
    assert round(gib(448, "fp8"), 2) == 9.77 and round(gib(448, "bf16"), 2) == 19.53
    assert round(gib(576, "fp8"), 2) == 14.59 and round(gib(768, "fp8"), 2) == 23.82
    assert round(gib(768, "bf16"), 2) == 47.65
    assert round(rules.kv_buffer_bytes(used_rows=75_229, heads=56, head_dim=128) / GIB, 2) == 2.01


def test_flop_model() -> None:
    assert (
        dit_flop(50_944, 8).total == dit_flop(50_944, 8, ref_skip=None).total == dit_step_flop(50_944)["total_flop"] * 8
    )
    for edge, (refs, live) in REAL.items():
        n = (live + 63) // 64 * 64
        m = (live - refs + 63) // 64 * 64
        ratio = dit_skip_step_flop(n, m)["total_flop"] / dit_step_flop(n)["total_flop"]
        assert abs(ratio - m / n) < 1e-12, edge  # both terms scale with the query rows
        run = dit_flop(n, 8, ref_skip=(m, 7))
        assert abs(run.total / dit_flop(n, 8).total - (1 + 7 * m / n) / 8) < 1e-12
        assert run.detail["ref_kv_cache"]["skipped_evaluations"] == 7
    assert dit_flop(1024, 2, ref_skip=(512, 9)).detail["ref_kv_cache"]["skipped_evaluations"] == 2


# ------------------------------------------------------------------------------------------------ CPU numerics


@pytest.mark.gpu
def test_cpu_equivalence(tmp_path: Path) -> None:
    """Runs ``ref_kv_cache_cpu.py`` under a runtime tuple's interpreter (CPU only, ``CUDA_VISIBLE_DEVICES=``)."""
    python = os.environ.get("PHASYN_H3_RUNTIME_PYTHON")
    if not python:
        pytest.skip(
            "PHASYN_H3_RUNTIME_PYTHON 未指向 runtime tuple 的 python（需要 torch＋釘版 SGLang）；未驗證，不算通過"
        )
    script = Path(__file__).resolve().parent / "ref_kv_cache_cpu.py"
    env = dict(os.environ)
    env.update(CUDA_VISIBLE_DEVICES="")
    result = subprocess.run(
        [python, "-I", "-B", str(script), "--work", str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=1800,
        env=env,
        check=False,
    )
    assert result.returncode == 0, result.stdout[-6000:] + result.stderr[-3000:]
