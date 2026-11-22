"""``provider_options.frame_streaming`` of ``h3.video_encode`` (opt-in frame-streaming reference-video encode).

Static (torch-free): the settings schema and the combination rules; with the option absent or ``enabled=false``
nothing that reaches the runtime changes (stage options, runtime profile, process environment); the resolved option
reaches the stage; the strict runtime config and the precision rule of the stage.

``gpu``-marked (a runtime tuple; CUDA is not needed, everything runs on the CPU):

* a small random-weight encoder of the H3 classes: with 17 frames per pass (one pass per clip) the streamed recipe
  equals ``minimax_h3_encode_reference_video_rows`` bit for bit; with fewer frames per pass the moments differ only
  by the convolutions' FP32 accumulation order — in FP64 the same comparison agrees to rounding level;
* the real checkpoint (``PHASYN_TEST_MODELS_DIR``) on a synthetic crop: the same two properties;
* the weights are moved, never changed, and are back on the device after a call, also after a failure;
* every encoder the streaming does not reproduce is refused.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

import pytest
from h3_examples import component, models_dir
from phasyn_components.errors import ComponentError

from phasyn_h3 import config
from phasyn_h3.plan import ALLOCATOR_CONF_ENV, DIT_ALLOCATOR_CONF, apply_runtime_env
from phasyn_h3.providers import VideoEncodeProvider
from phasyn_h3.recipe.runtime.errors import UnsupportedCombination
from phasyn_h3.recipe.runtime.stages import vae_frame_streaming as fs


STREAM = "venc-gpu1-fp32-stream"
STREAM_FP16 = "venc-gpu1-fp16-stream"
RESIDENT = "venc-gpu1"


def settings(component_id: str, **options: Any) -> dict[str, Any]:
    out: dict[str, Any] = copy.deepcopy(component(component_id)["settings"])
    out["load"]["provider_options"].update(options)
    return out


def provider_for(doc: dict[str, Any]) -> VideoEncodeProvider:
    """A provider with the option state ``load()`` sets (``merged_options``), without loading anything."""
    provider = VideoEncodeProvider.__new__(VideoEncodeProvider)
    precision, offload, options = config.merged_options("video_encode", doc["load"])
    provider.precision, provider.offload, provider.options = precision, offload, options
    return provider


def check(doc: dict[str, Any]) -> list[str]:
    return config.check_supported("video_encode", doc, {})


# ---------------------------------------------------------------------------------------------- schema and rules


@pytest.mark.static
def test_the_option_exists_only_for_video_encode_and_the_schema_validates_it() -> None:
    import jsonschema  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    schema = VideoEncodeProvider.describe(None).settings_schema
    props = schema["properties"]["load"]["properties"]["provider_options"][
        "properties"
    ]["frame_streaming"]
    assert set(props["properties"]) == {"enabled", "frames_per_pass", "precision"}
    assert props["additionalProperties"] is False
    for role in config.ROLE_COMPONENTS:
        has = "frame_streaming" in config.provider_options_schema(role)
        assert has == (role == "video_encode"), role
    # fp16 compute is offered to the video encode (only usable with frame_streaming, check_supported)
    assert config.COMPUTE_DTYPES["video_encode"] == ["native", "fp32", "fp16"]
    assert (
        "fp16" not in config.COMPUTE_DTYPES["reference"]
        and "fp16" not in config.COMPUTE_DTYPES["audio_encode"]
    )
    for cid in (STREAM, STREAM_FP16, RESIDENT):
        jsonschema.validate(component(cid)["settings"], schema)
    for bad in (
        {"enabled": True, "frames_per_pass": 0},
        {"enabled": True, "frames_per_pass": 18},
        {"enabled": True, "precision": "bf16"},
        {"enabled": "yes"},
        {"enabled": True, "tile_size": 128},  # tiles stay the checkpoint's 256 / 64
    ):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(settings(STREAM, frame_streaming=bad), schema)


@pytest.mark.static
@pytest.mark.parametrize(
    ("component_id", "precision", "mode"),
    [(STREAM, "fp32", "exact"), (STREAM_FP16, "fp16", "approximate")],
)
def test_the_streaming_templates_load_on_gpu_1_with_their_precision(
    component_id: str, precision: str, mode: str
) -> None:
    doc = component(component_id)
    assert doc["provider_id"] == "h3.video_encode"
    # gpu-1 is the resource group of aenc-gpu1 / audio-gpu1 (and a gpu-1 decode): the Node's try-lock and the run's
    # runner keep the encode from overlapping their calls (HANDOFF.md, scheduling requirement)
    assert doc["settings"]["load"]["device"]["resource_group"] == "gpu-1"
    check(doc["settings"])
    profile = config.build_profile(
        "video_encode", doc["settings"], profile_id="p", revision=1
    )
    assert profile["mode"] == mode
    assert (
        profile["vae"]["spatial_tile"] == 256
        and profile["vae"]["spatial_overlap"] == 64
    )
    resolved = config.frame_streaming_settings("video_encode", doc["settings"]["load"])
    assert resolved == {"frames_per_pass": 2, "precision": precision}
    assert fs.FrameStreamingConfig.from_mapping(resolved).precision == precision


@pytest.mark.static
def test_the_combination_rules() -> None:
    assert check(settings(STREAM)) == []
    assert (
        check(settings(STREAM, frame_streaming={"enabled": True})) == []
    )  # every field has a default
    assert (
        check(settings(STREAM, video_vae_scope="full")) == []
    )  # the streaming does not depend on the scope
    doc = settings(STREAM)
    doc["load"]["offload"] = {
        "mode": "component",
        "max_pinned_bytes": 1 << 30,
        "after_use": "host",
    }
    assert check(doc) == []

    def refused(doc: dict[str, Any], words: str) -> None:
        with pytest.raises(ComponentError) as exc:
            check(doc)
        assert exc.value.code == "UNSUPPORTED_SETTING" and words in str(exc.value), str(
            exc.value
        )

    refused(
        settings(STREAM, frame_streaming={"enabled": True, "frames_per_pass": 0}),
        "frames_per_pass",
    )
    refused(
        settings(STREAM, frame_streaming={"enabled": True, "frames_per_pass": True}),
        "frames_per_pass",
    )
    refused(
        settings(STREAM, frame_streaming={"enabled": True, "precision": "fp16"}),
        "precision=fp16",
    )
    refused(settings(STREAM, frame_streaming="on"), "object")
    # fp16 follows the fp16 rules: approximate profile, compute_dtype fp16, and only the streaming implements it
    doc = settings(STREAM_FP16)
    assert any("fp16" in note for note in check(doc))
    doc["load"]["provider_options"]["mode"] = "exact"
    refused(doc, "approximate")
    doc = settings(STREAM_FP16, frame_streaming={"enabled": False})
    refused(doc, "compute_dtype=fp16")
    doc = settings(RESIDENT, mode="approximate")
    doc["load"]["precision"] = {"compute_dtype": "fp16"}
    refused(doc, "compute_dtype=fp16")
    doc = settings(STREAM_FP16, frame_streaming={"enabled": True, "precision": "fp32"})
    refused(doc, "precision=fp32")
    # off: the other fields are not interpreted
    assert (
        check(
            settings(
                RESIDENT, frame_streaming={"enabled": False, "frames_per_pass": 99}
            )
        )
        == []
    )


# ---------------------------------------------------------------------------------------------- default off


@pytest.mark.static
@pytest.mark.parametrize(
    "off",
    [
        None,
        {"enabled": False},
        {"enabled": False, "frames_per_pass": 1, "precision": "fp16"},
    ],
    ids=["absent", "disabled", "disabled-with-fields"],
)
def test_off_changes_nothing_that_reaches_the_runtime(
    off: dict[str, Any] | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = settings(RESIDENT)
    doc = settings(RESIDENT) if off is None else settings(RESIDENT, frame_streaming=off)
    assert config.frame_streaming_settings("video_encode", doc["load"]) is None
    provider = provider_for(doc)
    # the encode_references stage dict gets exactly the options it got before the option existed
    assert provider.stage_options() == {"reference_scope": "visual"}
    assert (
        fs.stage_config({**provider.stage_options(), "kind": "encode_references"})
        is None
    )
    fs.check_precision(
        None, "fp32"
    )  # the stage's precision rule passes: the production encode runs
    assert provider.host_options() == {"video_vae_scope": "encode_only"}
    assert "frame_streaming" not in provider.observe_loaded()
    # the runtime profile (and so every plan and its digest) is the same document
    kwargs: dict[str, Any] = {"profile_id": "p", "revision": 1}
    profile = config.build_profile("video_encode", doc, **kwargs)
    assert json.dumps(profile, sort_keys=True) == json.dumps(
        config.build_profile("video_encode", base, **kwargs), sort_keys=True
    )
    # the component process environment: no allocator setting for the production encode
    for name in ALLOCATOR_CONF_ENV:
        monkeypatch.delenv(name, raising=False)
    env = apply_runtime_env(
        model_root=Path("/models"), options=provider.options, role="video_encode"
    )
    assert not set(env) & set(ALLOCATOR_CONF_ENV)
    assert check(doc) == []


@pytest.mark.static
def test_the_default_settings_and_role_defaults_do_not_carry_the_option() -> None:
    assert (
        "frame_streaming"
        not in config.ROLE_DEFAULTS["video_encode"]["provider_options"]
    )
    assert (
        "frame_streaming"
        not in config.default_settings("video_encode")["load"]["provider_options"]
    )
    assert (
        config.frame_streaming_settings("video_decode", settings(STREAM)["load"])
        is None
    )


# ---------------------------------------------------------------------------------------------- on


@pytest.mark.static
def test_on_reaches_the_stage_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = settings(STREAM)
    resolved = {"frames_per_pass": 2, "precision": "fp32"}
    assert config.frame_streaming_settings("video_encode", doc["load"]) == resolved
    provider = provider_for(doc)
    assert provider.stage_options() == {
        "reference_scope": "visual",
        "frame_streaming": resolved,
    }
    assert provider.host_options() == {
        "video_vae_scope": "encode_only"
    }  # nothing changes at load
    assert fs.stage_config(provider.stage_options()) == fs.FrameStreamingConfig()
    # precision follows compute_dtype when the field is left out
    doc = settings(STREAM_FP16, frame_streaming={"enabled": True, "frames_per_pass": 5})
    assert config.frame_streaming_settings("video_encode", doc["load"]) == {
        "frames_per_pass": 5,
        "precision": "fp16",
    }
    # the streaming encoder's allocator gets expandable segments; an operator's own setting is left alone
    for name in ALLOCATOR_CONF_ENV:
        monkeypatch.delenv(name, raising=False)
    env = apply_runtime_env(
        model_root=Path("/models"), options=provider.options, role="video_encode"
    )
    assert (
        env[ALLOCATOR_CONF_ENV[0]]
        == DIT_ALLOCATOR_CONF
        == os.environ[ALLOCATOR_CONF_ENV[0]]
    )
    monkeypatch.delenv(ALLOCATOR_CONF_ENV[0])
    monkeypatch.setenv(ALLOCATOR_CONF_ENV[1], "max_split_size_mb:64")
    env = apply_runtime_env(
        model_root=Path("/models"), options=provider.options, role="video_encode"
    )
    assert (
        ALLOCATOR_CONF_ENV[0] not in env
        and os.environ[ALLOCATOR_CONF_ENV[1]] == "max_split_size_mb:64"
    )


@pytest.mark.static
def test_the_runtime_config_and_the_stage_precision_rule_are_strict() -> None:
    assert (
        fs.FrameStreamingConfig.from_mapping(
            {"frames_per_pass": 17, "precision": "fp16"}
        ).frames_per_pass
        == 17
    )
    for bad in (
        {"enabled": True},
        {"frames_per_pass": 0},
        {"frames_per_pass": 18},
        {"frames_per_pass": 2.0},
        {"frames_per_pass": True},
        {"precision": "native"},
        "fp32",
    ):
        with pytest.raises(UnsupportedCombination):
            fs.FrameStreamingConfig.from_mapping(bad)  # type: ignore[arg-type]
    fs.check_precision(fs.FrameStreamingConfig(precision="fp16"), "fp16")
    with pytest.raises(UnsupportedCombination) as exc:
        fs.check_precision(
            None, "fp16"
        )  # an fp16 video VAE encode exists only streamed
    assert exc.value.reason_code == "VAE_FP16_ENCODE_NEEDS_FRAME_STREAMING"
    with pytest.raises(UnsupportedCombination):
        fs.check_precision(fs.FrameStreamingConfig(precision="fp32"), "fp16")


# ---------------------------------------------------------------------------------------------- runtime tuple (CPU)


def _runtime() -> Any:
    torch = pytest.importorskip(
        "torch", reason="需要 runtime tuple 環境；未驗證，不算通過"
    )
    pytest.importorskip("sglang", reason="需要 runtime tuple 環境；未驗證，不算通過")
    import frame_streaming_harness as harness  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    for name in ("reference_encoding", "keyframe_encoding", "packed_tokens"):
        harness.stage_module(name)
    return torch, harness


class _Arch:
    latent_channels = 4
    latents_mean = (0.1, -0.2, 0.3, 0.0)
    latents_std = (1.0, 2.0, 0.5, 1.5)


def _rel(a: Any, b: Any) -> float:
    d = (a.double() - b.double()).pow(2).mean().sqrt()
    return float(d / b.double().pow(2).mean().sqrt())


def _production_moments(vae: Any, frames: Any) -> Any:
    """``encode_videos``' moments (``encode_temporal``) of the processor-converted video, as production builds them
    (an FP64 copy of the module gets the FP32-converted video cast to FP64, as the streamed path does)."""
    import torch

    weight = next(vae.parameters())
    processor = vae.processor
    video = processor.convert_numpy_to_tensor(frames, weight.device)
    video = (
        processor.transform_tensor(video, runtime_owned=True)
        .transpose(0, 1)
        .unsqueeze(0)
    )
    used = processor.get_suitable_video_length(int(video.shape[2]))
    h, w = processor._align_to_total_patch_size(
        int(video.shape[3]), int(video.shape[4])
    )
    video = processor._crop_to_align(video[:, :, :used], h, w, is_video=True).to(
        weight.dtype
    )
    with torch.inference_mode():
        return vae.encode_temporal(video)


@pytest.mark.gpu
def test_streamed_recipe_equals_the_production_function_with_one_pass_per_clip() -> (
    None
):
    """Random-weight H3 encoder, 22 synthetic frames (2 clips, the second padded), 8 tiles of 64 px (overlap 32)."""
    torch, harness = _runtime()
    reference = harness.stage_module("reference_encoding")
    vae = harness.random_encoder(0)
    frames = harness.synthetic_frames(22, 96, 160)
    want = reference.minimax_h3_encode_reference_video_rows(vae, frames, _Arch)
    rows, lt, lh, lw, facts = fs.stream_reference_video_rows(
        vae, frames, _Arch, fs.FrameStreamingConfig(17)
    )
    assert (lt, lh, lw) == tuple(want[1:]) and torch.equal(rows, want[0])
    assert (
        facts["clips"] == 2
        and facts["tiles_per_clip"] == 8
        and facts["tail_start_level"] == 3
    )
    assert facts["weights_in_host_memory"]["parked_bytes"] > 0
    # fewer frames per pass: the same latent shape; the rows differ only where an FP32 difference of the moments
    # flips the FP16 rounding of the sample (the moments are compared below)
    rows2, *dims, _facts = fs.stream_reference_video_rows(
        vae, frames, _Arch, fs.FrameStreamingConfig(2)
    )
    assert tuple(dims) == tuple(want[1:]) and _rel(rows2, want[0]) < 1e-4


@pytest.mark.gpu
@pytest.mark.parametrize("frames_per_pass", [1, 2, 3, 5])
def test_fewer_frames_per_pass_change_only_the_accumulation_order(
    frames_per_pass: int,
) -> None:
    """The streamed moments against ``encode_temporal``: FP32 within 1e-5 relative; the FP64 copies of the same two
    computations agree to rounding level (so the FP32 difference is the convolutions' accumulation order)."""
    torch, harness = _runtime()
    vae = harness.random_encoder(1)
    frames = harness.synthetic_frames(22, 96, 160, seed=1)
    cfg = fs.FrameStreamingConfig(frames_per_pass)
    want = _production_moments(vae, frames)
    with torch.inference_mode():
        got, _facts = fs.stream_moments(vae, frames, cfg, device=torch.device("cpu"))
    assert got.shape == want.shape and _rel(got, want) < 1e-5
    vae64 = copy.deepcopy(vae).double()
    with torch.inference_mode():
        got64, _ = fs.stream_moments(vae64, frames, cfg, device=torch.device("cpu"))
        want64 = _production_moments(vae64, frames)
    # the processor converts in FP32 on both paths; every layer after that runs in FP64
    assert got64.dtype == torch.float64 and _rel(got64, want64) < 1e-12


@pytest.mark.gpu
def test_the_weights_are_moved_never_changed_and_always_restored() -> None:
    torch, harness = _runtime()
    vae = harness.random_encoder(2)
    before = {name: p.detach().clone() for name, p in vae.named_parameters()}
    frames = harness.synthetic_frames(22, 64, 64, seed=2)
    fs.stream_reference_video_rows(vae, frames, _Arch, fs.FrameStreamingConfig(2))
    after = dict(vae.named_parameters())
    assert all(torch.equal(before[n], after[n]) for n in before)
    assert all(
        not p.is_inference() for p in after.values()
    )  # still ordinary tensors, as loaded

    calls = 0

    def cancel() -> (
        None
    ):  # the stage's cancel point, raised in the middle of the first clip's heads
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        fs.stream_reference_video_rows(
            vae, frames, _Arch, fs.FrameStreamingConfig(2), check_cancel=cancel
        )
    after = dict(vae.named_parameters())
    assert all(
        torch.equal(before[n], after[n]) and after[n].device == before[n].device
        for n in before
    )


@pytest.mark.gpu
def test_a_failed_start_puts_every_weight_back() -> None:
    """fp16 setup (copies made while the FP32 weights go to the host) failing half way: nothing stays parked."""
    torch, harness = _runtime()
    vae = harness.random_encoder(5)
    before = {name: p.detach().clone() for name, p in vae.named_parameters()}
    streamer = fs.CausalStreamEncoder(
        vae, dtype=torch.float16, device=torch.device("cpu")
    )
    park = streamer.parking.park
    calls = 0

    def failing(params: Any = None) -> None:
        nonlocal calls
        calls += 1
        if calls == 5:
            raise RuntimeError("out of memory")
        park(params)

    streamer.parking.park = failing  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="out of memory"), streamer:
        pass
    assert calls == 5 and not streamer.parking._parked and streamer._half is None
    after = dict(vae.named_parameters())
    assert all(
        torch.equal(before[n], after[n]) and not after[n].is_inference() for n in before
    )


@pytest.mark.gpu
def test_unsupported_encoders_are_refused() -> None:
    torch, harness = _runtime()
    frames = harness.synthetic_frames(22, 64, 64)

    def refused(vae: Any) -> str:
        with pytest.raises(UnsupportedCombination) as exc:
            fs.stream_reference_video_rows(
                vae, frames, _Arch, fs.FrameStreamingConfig(2)
            )
        return str(exc.value.reason_code)

    vae = harness.random_encoder(3)
    vae.encoder.norm_out = torch.nn.GroupNorm(
        32, vae.encoder.norm_out.num_channels
    )  # normalizes over time too
    assert refused(vae) == "FRAME_STREAMING_UNSUPPORTED_VAE"
    vae = harness.random_encoder(3)
    vae.stack_tiling = True
    assert refused(vae) == "FRAME_STREAMING_UNSUPPORTED_VAE"
    vae = harness.random_encoder(3)
    vae.isolated_first_frame = True
    assert refused(vae) == "FRAME_STREAMING_UNSUPPORTED_VAE"
    vae = harness.random_encoder(3)
    vae.encode_temporal = lambda x: x  # an instance override of a re-stated method
    assert refused(vae) == "FRAME_STREAMING_UNSUPPORTED_VAE"
    vae = harness.random_encoder(3)
    vae.encoder.conv_in.causal = False
    assert refused(vae) == "FRAME_STREAMING_UNSUPPORTED_VAE"
    with pytest.raises(UnsupportedCombination) as exc:  # fp16 needs CUDA
        fs.stream_reference_video_rows(
            harness.random_encoder(3),
            frames,
            _Arch,
            fs.FrameStreamingConfig(2, precision="fp16"),
        )
    assert exc.value.reason_code == "FRAME_STREAMING_INVALID"


@pytest.mark.gpu
def test_streamed_recipe_with_the_real_checkpoint() -> None:
    """Real encoder weights (``PHASYN_TEST_MODELS_DIR``), 22 synthetic frames of 96x160 with 64 px tiles: one pass
    per clip is bit-identical to the production function, two frames per pass within the FP32 accumulation order."""
    torch, harness = _runtime()
    root = models_dir()
    reference = harness.stage_module("reference_encoding")
    vae, arch = harness.build_encoder(root / "MiniMax-H3" / "Ref2VA" / "video_vae")
    vae.tile_size, vae.tile_overlap_min = (
        64,
        32,
    )  # several tiles on a small crop (both paths read these)
    frames = harness.synthetic_frames(22, 96, 160, seed=4)
    want = reference.minimax_h3_encode_reference_video_rows(vae, frames, arch)
    rows, lt, lh, lw, _facts = fs.stream_reference_video_rows(
        vae, frames, arch, fs.FrameStreamingConfig(17)
    )
    assert (lt, lh, lw) == tuple(want[1:]) and torch.equal(rows, want[0])
    with torch.inference_mode():
        got, _ = fs.stream_moments(
            vae, frames, fs.FrameStreamingConfig(2), device=torch.device("cpu")
        )
    assert _rel(got, _production_moments(vae, frames)) < 1e-5
