"""LoRA stacks on the H3 DiT (``provider_options.loras``): identity stability, validation, order and the numerics.

Torch-free except the last block (``pytest.importorskip("torch")``: run it with a runtime tuple's interpreter,
e.g. ``deploy/runtimes/x86_64/.venv/bin/python -m pytest``; CPU only).
"""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest
from phasyn_components.errors import ComponentError

from phasyn_h3 import config
from phasyn_h3.lora_facts import pai_compatibility, pai_stack_compatibility
from phasyn_h3.plan import BUNDLED_LORA_DIR, build_plan, make_job
from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.adapter import local_manifest
from phasyn_h3.recipe.adapter.lora_rules import validate_lora_bindings
from phasyn_h3.recipe.adapter.loras import (
    STACK_ALGORITHM,
    adaln_lora_signature,
    adapters_signature,
    contract_enforced,
    lora_identity,
    lora_role,
    stack_accepted_steps,
    stack_problems,
)
from phasyn_h3.recipe.runtime.errors import UnsupportedCombination
from phasyn_h3.recipe.runtime.lora import PreparedAdapter, _stack_prepared
from phasyn_h3.recipe.runtime.lora_inplace import add_lora_
from phasyn_h3.recipe.runtime.lora_policy import (
    LoraSpec,
    check_lora_schedule,
    resolve_lora_policy,
)
from phasyn_h3.recipe.runtime.lora_stack import Contribution, stack_factors


GIB = 1 << 30
PAI = "pai-h3-fl2va-acc8.json"


def pai_manifest() -> dict[str, Any]:
    return json.loads((BUNDLED_LORA_DIR / PAI).read_text(encoding="utf-8"))


def style_manifest(
    lora_id: str = "style-a", *, touches_adaln: bool = False, rank: int = 32
) -> dict[str, Any]:
    """A synthetic PEFT concept LoRA trained on the native 50-step schedule."""
    targets = ["to_q", "to_k", "to_v", "to_out.0", "ff.net.0.proj", "ff.net.2"]
    if touches_adaln:
        targets.append("adaln_proj.linear")
    return {
        "schema_version": "1.0",
        "lora_id": lora_id,
        "family": "minimax_h3",
        "label": lora_id,
        "source_repo": "local:test",
        "source_revision": "0" * 39 + str(len(lora_id) % 10),
        "license_url": "https://example.invalid/license",
        "file": {
            "relative_path": f"loras/{lora_id}.safetensors",
            "sha256": canonical_digest({"file": lora_id})[-64:].rjust(64, "0"),
            "size_bytes": 1000 + rank,
        },
        "format": "peft_diffusers",
        "variants": ["fl2va"],
        "rank": rank,
        "alpha": float(rank),
        "alpha_source": "file_metadata",
        "touches_adaln": touches_adaln,
        "targets": targets,
        "pdd": None,
        "sampling_contract": {
            "steps": [50],
            "video_shift": 12.0,
            "audio_shift": 3.0,
            "scheduler": "h3_euler",
        },
        "fixed_scale": None,
        "status": "verified",
        "is_fixture": True,
    }


def binding(manifest: dict[str, Any], scale: float) -> dict[str, Any]:
    return {
        "lora_id": manifest["lora_id"],
        "revision": manifest["source_revision"],
        "scale": float(scale),
        "manifest": {**manifest, "status": "verified"},
    }


def dit_settings(**options: Any) -> dict[str, Any]:
    provider_options: dict[str, Any] = {
        "variant": "fl2va",
        "shared_from": None,
        "mode": "approximate",
        "attention": {
            "provider": "auto_exact",
            "reject_quadratic_materialization": True,
        },
        "adaln": {
            "mode": "fixed",
            "host_cache_bytes": 8 * GIB,
            "cache_ref": "h3-fl2va-pdd8",
        },
        "bounded_fp8_load": True,
    }
    provider_options.update(options)
    return {
        "load": {
            "model_path": "/models",
            "device": {
                "kind": "cuda",
                "id": "GPU-00000000-0000-4000-8000-000000000001",
                "resource_group": "gpu-0",
            },
            "part_overrides": [],
            "precision": {
                "compute_dtype": "native",
                "quantization": {
                    "scheme": "fp8_e4m3",
                    "excluded_modules": ["adaln_proj"],
                },
            },
            "offload": {
                "mode": "block",
                "prefetch_depth": 1,
                "resident_layers": 0,
                "after_use": "host",
            },
            "provider_options": provider_options,
        },
        "invoke": {"seed": 42, "steps": 8, "video_shift": 12.0, "audio_shift": 3.0},
        "recording": {"mode": "detailed"},
    }


def profile_of(
    settings: dict[str, Any], manifests: list[dict[str, Any]]
) -> dict[str, Any]:
    return config.build_profile(
        "dit", settings, profile_id="phasyn-test", revision=1, lora_manifests=manifests
    )


def plan_of(
    profile: dict[str, Any], bindings: list[dict[str, Any]], steps: int = 8
) -> dict[str, Any]:
    job = make_job(
        task="t2va",
        prompt="stack",
        width=768,
        height=448,
        frames=124,
        variant="fl2va",
        materials=[],
    )
    plan, _ = build_plan(
        job,
        profile,
        model=local_manifest("fl2va"),
        sampling={"steps": steps, "video_shift": 12.0, "audio_shift": 3.0},
        lora_bindings=bindings,
    )
    return plan


# ------------------------------------------------------------------------------------- identity of one LoRA


def _old_adapters_signature(
    bindings: list[dict[str, Any]], merge_mode: str = "dynamic"
) -> str:
    """The implementation before stacks existed (main c203bb0c), kept verbatim as the reference."""
    entries = sorted(
        (lora_identity(b) for b in bindings),
        key=lambda e: (e["lora_id"], e["revision"], e["sha256"]),
    )
    if not entries:
        return "none"
    return canonical_digest(
        {"kind": "h3_lora_adapters_v1", "merge_mode": merge_mode, "loras": entries}
    )


def _old_adaln_signature(bindings: list[dict[str, Any]]) -> str:
    entries = sorted(
        (
            {**lora_identity(b), "targets": ["adaln_proj.linear"]}
            for b in bindings
            if b["manifest"].get("touches_adaln")
        ),
        key=lambda e: (e["lora_id"], e["revision"], e["sha256"]),
    )
    if not entries:
        return "none"
    return canonical_digest({"kind": "h3_adaln_lora_v1", "loras": entries})


@pytest.mark.parametrize("merge_mode", ["dynamic", "merge"])
def test_single_lora_signatures_unchanged(merge_mode: str) -> None:
    for one in ([binding(pai_manifest(), 1.0)], [binding(style_manifest(), 0.7)], []):
        assert adapters_signature(
            one, merge_mode=merge_mode
        ) == _old_adapters_signature(one, merge_mode)
        assert adaln_lora_signature(one) == _old_adaln_signature(one)


def test_single_lora_profile_and_plan_identical_for_both_forms() -> None:
    """``lora: {...}`` (today) and ``loras: [{...}]`` give the same profile and plan; the old form is untouched."""
    entry = {"manifest_path": PAI, "scale": 1.0}
    old = profile_of(dit_settings(lora=dict(entry)), [pai_manifest()])
    via_legacy_param = config.build_profile(
        "dit",
        dit_settings(lora=dict(entry)),
        profile_id="phasyn-test",
        revision=1,
        lora_manifest=pai_manifest(),
    )
    listed = profile_of(dit_settings(lora=None, loras=[dict(entry)]), [pai_manifest()])
    assert old == via_legacy_param == listed
    assert old["lora"] == [
        {
            "model_id": "pai-h3-fl2va-acc8",
            "revision": pai_manifest()["source_revision"],
            "scale": 1.0,
            "alpha": None,
        }
    ]
    one = [binding(pai_manifest(), 1.0)]
    assert canonical_digest(plan_of(old, one)) == canonical_digest(plan_of(listed, one))


def test_single_compatibility_declaration_unchanged() -> None:
    manifest = pai_manifest()
    declaration = pai_compatibility(PAI, manifest)
    assert declaration is not None
    assert declaration["adapters"] == {
        "layout": "single",
        "path": ["provider_options", "lora"],
        "key": ["manifest_path"],
        "key_encoding": "canonical_sha256",
        "allow_absent": True,
    }
    assert declaration["revision"] == "pai-h3-fl2va-acc8-v1"
    assert [rule["id"] for rule in declaration["rules"]] == ["pai-h3-fl2va-acc8"]
    stacked = pai_stack_compatibility(
        [(PAI, manifest), ("style-a.json", style_manifest())]
    )
    assert stacked is not None
    assert stacked["adapters"]["layout"] == "list"
    assert stacked["adapters"]["path"] == ["provider_options", "loras"]
    assert (
        stacked["rules"] == declaration["rules"]
    )  # the PAI member keeps its exact rule; the style LoRA is unlisted
    assert pai_stack_compatibility([("style-a.json", style_manifest())]) is None


# ------------------------------------------------------------------------------------- identity of a stack


def test_stack_signature_covers_every_member_scale_and_order() -> None:
    pai, style, other = (
        binding(pai_manifest(), 1.0),
        binding(style_manifest(), 0.8),
        binding(style_manifest("style-b"), 0.5),
    )
    stack = adapters_signature([pai, style])
    assert stack not in {adapters_signature([pai]), adapters_signature([style]), "none"}
    assert adapters_signature([pai, {**style, "scale": 0.9}]) != stack
    assert (
        adapters_signature([style, pai]) != stack
    )  # order is part of the arithmetic (concatenation order)
    assert adapters_signature([pai, style, other]) not in {
        stack,
        adapters_signature([pai, other, style]),
    }
    assert adapters_signature([pai, style], merge_mode="merge") != stack
    doc = {
        "kind": "h3_lora_adapters_v1",
        "merge_mode": "dynamic",
        "loras": [lora_identity(pai), lora_identity(style)],
        "stack": STACK_ALGORITHM,
    }
    assert stack == canonical_digest(doc)


def test_adaln_signature_of_a_stack() -> None:
    """Only AdaLN-touching members enter: PDD + a LoRA without AdaLN factors reuses the PDD sidecar."""
    pai = binding(pai_manifest(), 1.0)
    plain = binding(style_manifest(), 0.8)
    adaln = binding(style_manifest("style-adaln", touches_adaln=True), 0.8)
    assert adaln_lora_signature([pai, plain]) == adaln_lora_signature([pai])
    both = adaln_lora_signature([pai, adaln])
    assert both not in {adaln_lora_signature([pai]), adaln_lora_signature([adaln])}
    assert adaln_lora_signature([adaln, pai]) != both
    assert adaln_lora_signature([pai, {**adaln, "scale": 0.5}]) != both


def test_stack_profile_keeps_order_and_scales() -> None:
    pai, style = pai_manifest(), style_manifest()
    profile = profile_of(
        dit_settings(
            loras=[
                {"manifest_path": PAI, "scale": 1.0},
                {"manifest_path": "style-a.json", "scale": 0.8},
            ]
        ),
        [pai, style],
    )
    assert [(e["model_id"], e["scale"]) for e in profile["lora"]] == [
        ("pai-h3-fl2va-acc8", 1.0),
        ("style-a", 0.8),
    ]


# ------------------------------------------------------------------------------------- validation


def test_roles() -> None:
    assert lora_role(pai_manifest()) == "acceleration"
    assert lora_role(style_manifest()) == "style"
    turbo = json.loads(
        (BUNDLED_LORA_DIR / "lx-h3-ref2v-turbo8-v1.0-768p.json").read_text(
            encoding="utf-8"
        )
    )
    assert (
        lora_role(turbo) == "acceleration"
    )  # PEFT, but its contract excludes the native 50 steps
    assert lora_role({**style_manifest(), "role": "acceleration"}) == "acceleration"


def test_stack_problems() -> None:
    pai, style = pai_manifest(), style_manifest()
    assert stack_problems([pai]) == []
    assert stack_problems([pai, style]) == []
    reasons = lambda ms: [p.reason for p in stack_problems(ms)]  # noqa: E731
    assert reasons([pai, {**pai, "lora_id": "pai-copy"}]) == ["LORA_STACK_ACCELERATORS"]
    assert "LORA_STACK_DUPLICATE" in reasons([pai, style, style])
    assert "LORA_STACK_PTD" in reasons(
        [{**pai, "ptd": {"hops": 8, "hop_files": []}}, style]
    )
    assert "LORA_STACK_PDD_NOT_ADDITIVE" in reasons(
        [style, {**pai, "lora_id": "x", "role": "style"}]
    )
    assert reasons([style_manifest(f"s{i}") for i in range(5)]) == [
        "LORA_STACK_TOO_MANY"
    ]
    other_grid = {
        **style_manifest("style-b"),
        "sampling_contract": {"steps": [50], "video_shift": 5.0, "audio_shift": 3.0},
    }
    assert reasons([style, other_grid]) == ["LORA_STACK_CONTRACT_CONFLICT"]
    assert reasons([style, style_manifest("style-b")]) == []


def test_contract_owner_and_accepted_steps() -> None:
    pai, style = pai_manifest(), style_manifest()
    assert stack_accepted_steps([pai, style]) == [8]
    assert stack_accepted_steps([style, pai]) == [8]
    assert stack_accepted_steps([style, style_manifest("style-b")]) == [50]
    assert [contract_enforced([style, pai], i) for i in range(2)] == [False, True]
    assert [contract_enforced([style, style_manifest("b")], i) for i in range(2)] == [
        True,
        True,
    ]


def test_configured_loras_refuses_both_forms_and_runtime_conflicts() -> None:
    entry = {"manifest_path": PAI, "scale": 1.0}
    assert config.configured_loras({"lora": entry}) == [entry]
    assert config.configured_loras({"lora": None, "loras": [entry]}) == [entry]
    assert config.configured_loras({"lora": None, "loras": []}) == []
    with pytest.raises(ComponentError) as both:
        config.configured_loras({"lora": entry, "loras": [entry]})
    assert both.value.details["reason"] == "LORA_CONFIG_BOTH"
    with pytest.raises(ComponentError) as conflict:
        config.lora_runtime_values(
            [
                {**entry, "merge_mode": "merge"},
                {"manifest_path": "b.json", "merge_mode": "dynamic"},
            ]
        )
    assert conflict.value.details["reason"] == "LORA_STACK_RUNTIME_CONFLICT"
    with pytest.raises(ComponentError):
        config.check_supported("dit", dit_settings(mode="exact", loras=[entry]), {})


def test_plan_rules_pai8_plus_style() -> None:
    """PAI 8 steps + a 50-step style LoRA: the PAI contract binds, the style contract does not."""
    pai, style = pai_manifest(), style_manifest()
    bindings = [binding(pai, 1.0), binding(style, 0.8)]
    profile = profile_of(
        dit_settings(
            loras=[
                {"manifest_path": PAI, "scale": 1.0},
                {"manifest_path": "style-a.json", "scale": 0.8},
            ]
        ),
        [pai, style],
    )
    plan = plan_of(profile, bindings)
    assert [b["lora_id"] for b in plan["loras"]] == ["pai-h3-fl2va-acc8", "style-a"]
    diagnostics = validate_lora_bindings(
        profile,
        bindings,
        request={"sampling": {"steps": 8, "video_shift": 12.0, "audio_shift": 3.0}},
        model=local_manifest("fl2va"),
    )
    assert not [d for d in diagnostics if d.get("severity") == "error"], diagnostics
    assert any(d.get("code") == "LORA_STACK_CONTRACT_OWNER" for d in diagnostics)
    policy = resolve_lora_policy(plan, profile, adaln_mode="fixed")
    assert policy is not None
    assert [(s.lora_id, s.stack_role, s.contract_enforced) for s in policy.specs] == [
        ("pai-h3-fl2va-acc8", "acceleration", True),
        ("style-a", "style", False),
    ]
    assert policy.adapters_signature == adapters_signature(bindings)
    assert policy.adaln_signature == adaln_lora_signature(
        [bindings[0]]
    )  # the PDD sidecar is reused
    check_lora_schedule(
        policy, updates=8, schedule={"video_shift": 12.0, "audio_shift": 3.0}
    )
    with pytest.raises(UnsupportedCombination):
        check_lora_schedule(
            policy, updates=50, schedule={"video_shift": 12.0, "audio_shift": 3.0}
        )


def test_plan_rules_refuse_two_accelerators() -> None:
    pai = pai_manifest()
    copy_ = {**copy.deepcopy(pai), "lora_id": "pai-copy"}
    bindings = [binding(pai, 1.0), binding(copy_, 1.0)]
    profile = profile_of(
        dit_settings(
            loras=[
                {"manifest_path": PAI, "scale": 1.0},
                {"manifest_path": "copy.json", "scale": 1.0},
            ]
        ),
        [pai, copy_],
    )
    diagnostics = validate_lora_bindings(
        profile,
        bindings,
        request={"sampling": {"steps": 8, "video_shift": 12.0, "audio_shift": 3.0}},
        model=local_manifest("fl2va"),
    )
    assert any("LORA_STACK_ACCELERATORS" in str(d.get("message")) for d in diagnostics)
    plan = {"loras": bindings, "model": local_manifest("fl2va")}
    with pytest.raises(UnsupportedCombination) as refused:
        resolve_lora_policy(plan, profile, adaln_mode="fixed")
    assert refused.value.reason_code == "LORA_STACK_ACCELERATORS"


def test_style_only_stack_keeps_every_contract() -> None:
    styles = [style_manifest(), style_manifest("style-b")]
    bindings = [binding(m, 0.5) for m in styles]
    profile = profile_of(
        dit_settings(
            adaln={"mode": "off"},
            loras=[
                {"manifest_path": "a", "scale": 0.5},
                {"manifest_path": "b", "scale": 0.5},
            ],
        ),
        styles,
    )
    diagnostics = validate_lora_bindings(
        profile,
        bindings,
        request={"sampling": {"steps": 8, "video_shift": 12.0, "audio_shift": 3.0}},
        model=local_manifest("fl2va"),
    )
    steps_errors = [
        d
        for d in diagnostics
        if d["severity"] == "error" and "sampling.steps" in d["field_paths"]
    ]
    assert (
        len(steps_errors) == 2
    )  # no accelerator: both members' 50-step contracts bind (8 steps refused twice)


# ------------------------------------------------------------------------------------- numerics (CPU)


def _torch() -> Any:
    return pytest.importorskip("torch")


def _contribution(
    torch: Any,
    lora_id: str,
    shape_a: tuple[int, ...],
    shape_b: tuple[int, ...],
    params: tuple[float, float, int],
) -> Any:
    """Random factors; ``params`` = (alpha, scale, seed), the rank is ``shape_a[-2]``."""
    alpha, scale, seed = params
    rank = shape_a[-2]
    gen = torch.Generator().manual_seed(seed)
    return Contribution(
        lora_id=lora_id,
        a=torch.randn(shape_a, generator=gen, dtype=torch.float32),
        b=torch.randn(shape_b, generator=gen, dtype=torch.float32),
        rank=rank,
        alpha=alpha,
        scale=scale,
    )


def _reference(torch: Any, x: Any, parts: list[Any], out_features: int) -> Any:
    """Σᵢ eᵢ·(x·Aᵢᵀ)·Bᵢᵀ per member, each the way one LoRA is applied (2-D or q/k/v groups)."""
    total = torch.zeros(x.shape[0], out_features, dtype=torch.float64)
    for part in parts:
        a, b = part.a.double(), part.b.double()
        if a.dim() == 2:
            total += part.effective_scale * (x.double() @ a.t()) @ b.t()
        else:
            width = b.shape[1]
            for g in range(a.shape[0]):
                total[:, g * width : (g + 1) * width] += (
                    part.effective_scale * (x.double() @ a[g].t()) @ b[g].t()
                )
    return total


def _apply(
    torch: Any, x: Any, stacked: Any, out_features: int, chunk_tokens: int
) -> Any:

    out = torch.zeros(x.shape[0], out_features, dtype=torch.float32)
    scale = stacked.strength * (
        stacked.alpha / stacked.rank if stacked.alpha != stacked.rank else 1.0
    )
    add_lora_(out, x, stacked.a, stacked.b, scale=scale, chunk_tokens=chunk_tokens)
    return out


@pytest.mark.parametrize("chunk_tokens", [0, 3])
@pytest.mark.parametrize("scales", [(1.0, 1.0), (1.0, 0.8), (0.5, -1.25)])
def test_stack_equals_summed_deltas_dense(
    chunk_tokens: int, scales: tuple[float, float]
) -> None:
    torch = _torch()

    fan_in, fan_out = 12, 10
    parts = [
        _contribution(torch, "acc", (4, fan_in), (fan_out, 4), (4.0, scales[0], 1)),
        _contribution(torch, "style", (2, fan_in), (fan_out, 2), (1.0, scales[1], 2)),
    ]
    x = torch.randn(7, fan_in, generator=torch.Generator().manual_seed(3))
    stacked = stack_factors(parts, layer="blocks.0.mlp.fc2")
    assert stacked.rank == 6 and stacked.alpha == 6.0
    assert stacked.folded == (parts[0].effective_scale != parts[1].effective_scale)
    got = _apply(torch, x, stacked, fan_out, chunk_tokens).double()
    torch.testing.assert_close(
        got, _reference(torch, x, parts, fan_out), rtol=1e-5, atol=1e-5
    )


def test_stack_equals_summed_deltas_grouped_qkv() -> None:
    torch = _torch()

    fan_in, width = 8, 5
    parts = [
        _contribution(torch, "acc", (3, 4, fan_in), (3, width, 4), (4.0, 1.0, 4)),
        _contribution(torch, "style", (3, 2, fan_in), (3, width, 2), (4.0, 0.6, 5)),
    ]
    x = torch.randn(9, fan_in, generator=torch.Generator().manual_seed(6))
    stacked = stack_factors(parts, layer="blocks.0.attn.qkv_proj")
    assert tuple(stacked.a.shape) == (3, 6, fan_in) and tuple(stacked.b.shape) == (
        3,
        width,
        6,
    )
    got = _apply(torch, x, stacked, 3 * width, 4).double()
    torch.testing.assert_close(
        got, _reference(torch, x, parts, 3 * width), rtol=1e-5, atol=1e-5
    )


def test_stack_order_changes_layout_not_result() -> None:
    torch = _torch()

    parts = [
        _contribution(torch, "a", (3, 6), (4, 3), (3.0, 1.0, 7)),
        _contribution(torch, "b", (2, 6), (4, 2), (2.0, 0.5, 8)),
    ]
    x = torch.randn(5, 6, generator=torch.Generator().manual_seed(9))
    forward, backward = (
        stack_factors(parts, layer="l"),
        stack_factors(parts[::-1], layer="l"),
    )
    assert forward.sources == ("a", "b") and backward.sources == ("b", "a")
    assert not torch.equal(forward.a, backward.a)
    torch.testing.assert_close(
        _apply(torch, x, forward, 4, 0),
        _apply(torch, x, backward, 4, 0),
        rtol=1e-5,
        atol=1e-5,
    )


def test_single_member_layer_passes_through_bit_for_bit() -> None:
    """A layer only one member touches keeps that member's tensors, rank, alpha and strength (the single-LoRA path)."""
    torch = _torch()

    only = _contribution(torch, "acc", (4, 6), (5, 4), (8.0, 1.0, 10))
    stacked = stack_factors([only], layer="blocks.0.adaln_proj.linear")
    assert stacked.a is only.a and stacked.b is only.b
    assert (stacked.rank, stacked.alpha, stacked.strength, stacked.folded) == (
        4,
        8.0,
        1.0,
        False,
    )


def test_equal_scales_keep_factors_unrounded_in_bf16() -> None:
    torch = _torch()

    parts = [
        _contribution(torch, n, (2, 6), (4, 2), (2.0, 1.0, s))
        for n, s in (("a", 11), ("b", 12))
    ]
    parts = [
        type(p)(p.lora_id, p.a.bfloat16(), p.b.bfloat16(), p.rank, p.alpha, p.scale)
        for p in parts
    ]
    stacked = stack_factors(parts, layer="l")
    assert not stacked.folded
    assert torch.equal(stacked.b[:, :2], parts[0].b) and torch.equal(
        stacked.b[:, 2:], parts[1].b
    )


def test_stack_refuses_offsets_and_mismatched_shapes() -> None:
    torch = _torch()

    a = _contribution(torch, "a", (2, 6), (4, 2), (2.0, 1.0, 13))
    with pytest.raises(UnsupportedCombination) as offset:
        stack_factors(
            [Contribution("p", a.a, a.b, 2, 2.0, 1.0, offset=torch.zeros(4)), a],
            layer="l",
        )
    assert offset.value.reason_code == "LORA_STACK_OFFSET_UNSUPPORTED"
    wrong = _contribution(torch, "w", (2, 7), (4, 2), (2.0, 1.0, 14))
    with pytest.raises(UnsupportedCombination) as shape:
        stack_factors([a, wrong], layer="l")
    assert shape.value.reason_code == "LORA_STACK_SHAPE"


def test_stacked_adapter_layers_and_scaling() -> None:
    """The actor's per-layer merge of prepared members: union of layers, single-member layers untouched."""
    torch = _torch()

    def spec(lora_id: str, rank: int, scale: float, fmt: str) -> LoraSpec:
        return LoraSpec(
            lora_id=lora_id,
            revision="0" * 40,
            relative_path=f"loras/{lora_id}",
            sha256="0" * 64,
            size_bytes=1,
            format=fmt,
            rank=rank,
            alpha=float(rank),
            alpha_source="file_metadata",
            scale=scale,
            touches_adaln=False,
            targets=(),
            pdd_num_steps=None,
            pdd_block_size=None,
            steps=(8,),
            video_shift=12.0,
            audio_shift=3.0,
            adaln_handling="none",
        )

    def prepared(rank: int, layers: list[str], seed: int) -> PreparedAdapter:
        gen = torch.Generator().manual_seed(seed)
        tensors = {}
        for name in layers:
            tensors[f"{name}.lora_A"] = torch.randn(rank, 6, generator=gen)
            tensors[f"{name}.lora_B"] = torch.randn(4, rank, generator=gen)
        return PreparedAdapter(
            tensors=tensors, layers=layers, heads={}, source_modules=[]
        )

    acc, style = (
        spec("acc", 4, 1.0, "pdd_videox_fun"),
        spec("style", 2, 0.5, "peft_diffusers"),
    )
    p_acc = prepared(4, ["blocks.0.adaln_proj.linear", "blocks.0.mlp.fc2"], 1)
    p_style = prepared(2, ["blocks.0.mlp.fc2"], 2)
    adaln_a = p_acc.tensors["blocks.0.adaln_proj.linear.lora_A"]
    combined, multi, folded = _stack_prepared([(acc, p_acc), (style, p_style)])
    assert combined.layers == ["blocks.0.adaln_proj.linear", "blocks.0.mlp.fc2"]
    assert (multi, folded) == (1, 1)
    assert combined.tensors["blocks.0.adaln_proj.linear.lora_A"] is adaln_a
    assert combined.layer_scaling("blocks.0.adaln_proj.linear", acc) == (4, 4.0, 1.0)
    assert combined.layer_scaling("blocks.0.mlp.fc2", acc) == (6, 6.0, 1.0)
    assert tuple(combined.tensors["blocks.0.mlp.fc2.lora_A"].shape) == (6, 6)
    assert (
        not p_acc.tensors and not p_style.tensors
    )  # members' factors handed over, not duplicated
