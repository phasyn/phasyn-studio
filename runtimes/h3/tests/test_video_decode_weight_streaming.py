"""``provider_options.weight_streaming`` of ``h3.video_decode`` (opt-in weight-streaming decode).

Static (torch-free): the settings schema and the combination rules; with the option absent or ``enabled=false``
nothing that reaches the runtime changes (host options, runtime profile, process environment); the resolved option
reaches the runtime; the checkpoint layout rules of the streamed blocks.

``gpu``-marked (a runtime tuple; CUDA is not needed): the early release of each clip's output in the callback-only
temporal decode, and — with ``PHASYN_TEST_MODELS_DIR`` — the streamed decode against the resident decode on the CPU
with real weights (truncated decoder, small crop): bit for bit, for every source / slot count / pass size.
"""

from __future__ import annotations

import copy
import json
import os
import struct
from pathlib import Path
from typing import Any

import pytest
from h3_examples import component, models_dir
from phasyn_components.errors import ComponentError

from phasyn_h3 import config
from phasyn_h3.plan import ALLOCATOR_CONF_ENV, DIT_ALLOCATOR_CONF, apply_runtime_env
from phasyn_h3.providers import VideoDecodeProvider
from phasyn_h3.recipe.abi.tensors import read_header_from_file
from phasyn_h3.recipe.runtime.errors import UnsupportedCombination
from phasyn_h3.recipe.runtime.stages import vae_weight_streaming as ws


STREAM = "vae-gpu1-fp32-stream"
STREAM_FP16 = "vae-gpu1-fp16-stream"
RESIDENT = "vae-gpu0"


def settings(component_id: str, **options: Any) -> dict[str, Any]:
    out: dict[str, Any] = copy.deepcopy(component(component_id)["settings"])
    out["load"]["provider_options"].update(options)
    return out


def provider_for(doc: dict[str, Any]) -> VideoDecodeProvider:
    """A provider with the option state ``load()`` sets (``merged_options``), without loading anything."""
    provider = VideoDecodeProvider.__new__(VideoDecodeProvider)
    precision, offload, options = config.merged_options("video_decode", doc["load"])
    provider.precision, provider.offload, provider.options = precision, offload, options
    return provider


def check(doc: dict[str, Any]) -> list[str]:
    return config.check_supported("video_decode", doc, {})


# ---------------------------------------------------------------------------------------------- schema and rules


@pytest.mark.static
def test_the_option_exists_only_for_video_decode_and_the_schema_validates_it() -> None:
    import jsonschema  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    schema = VideoDecodeProvider.describe(None).settings_schema
    props = schema["properties"]["load"]["properties"]["provider_options"][
        "properties"
    ]["weight_streaming"]
    assert set(props["properties"]) == {
        "enabled",
        "source",
        "slots",
        "precision",
        "tiles_per_pass",
    }
    assert props["additionalProperties"] is False
    for role in config.ROLE_COMPONENTS:
        has = "weight_streaming" in config.provider_options_schema(role)
        assert has == (role == "video_decode"), role
    jsonschema.validate(component(STREAM)["settings"], schema)
    jsonschema.validate(component(RESIDENT)["settings"], schema)
    for bad in (
        {"enabled": True, "source": "ram"},
        {"enabled": True, "slots": 0},
        {"enabled": True, "slots": 5},
        {"enabled": True, "precision": "bf16"},
        {"enabled": True, "tiles_per_pass": 0},
        {"enabled": "yes"},
        {"enabled": True, "group": 28},
    ):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(settings(STREAM, weight_streaming=bad), schema)


@pytest.mark.static
@pytest.mark.parametrize(
    ("component_id", "precision", "mode"),
    [(STREAM, "fp32", "exact"), (STREAM_FP16, "fp16", "approximate")],
)
def test_the_streaming_templates_load_on_gpu_1_with_their_precision(
    component_id: str, precision: str, mode: str
) -> None:
    import jsonschema  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    doc = component(component_id)
    assert doc["provider_id"] == "h3.video_decode"
    # gpu-1 is the resource group of venc-gpu1 / aenc-gpu1 / audio-gpu1: the Node's try-lock and the run's runner keep
    # the decode from overlapping their calls (HANDOFF.md, scheduling requirement)
    assert doc["settings"]["load"]["device"]["resource_group"] == "gpu-1"
    jsonschema.validate(
        doc["settings"], VideoDecodeProvider.describe(None).settings_schema
    )
    check(doc["settings"])
    profile = config.build_profile(
        "video_decode", doc["settings"], profile_id="p", revision=1
    )
    assert (
        profile["mode"] == mode
        and profile["components"]["video_vae"]["offload"] == "none"
    )
    resolved = config.weight_streaming_settings("video_decode", doc["settings"]["load"])
    assert resolved == {
        "source": "nvme",
        "slots": 2,
        "precision": precision,
        "tiles_per_pass": None,
    }
    assert ws.StreamingConfig.from_mapping(resolved).precision == precision


@pytest.mark.static
def test_the_combination_rules() -> None:
    assert check(settings(STREAM)) == []
    assert (
        check(settings(STREAM, weight_streaming={"enabled": True})) == []
    )  # every field has a default
    pinned = check(
        settings(
            STREAM,
            weight_streaming={"enabled": True, "source": "pinned_host", "slots": 3},
        )
    )
    assert len(pinned) == 1 and "9.0 GiB" in pinned[0]

    def refused(doc: dict[str, Any], words: str) -> None:
        with pytest.raises(ComponentError) as exc:
            check(doc)
        assert exc.value.code == "UNSUPPORTED_SETTING" and words in str(exc.value), str(
            exc.value
        )

    refused(settings(STREAM, video_vae_scope="full"), "video_vae_scope=decode_only")
    doc = settings(STREAM)
    doc["load"]["offload"] = {
        "mode": "component",
        "max_pinned_bytes": 1,
        "after_use": "host",
    }
    refused(doc, "offload.mode=none")
    doc = settings(STREAM)
    doc["load"]["offload"] = {"mode": "none", "after_use": "host"}
    refused(doc, "after_use")
    doc = settings(STREAM)
    doc["load"]["offload"] = {
        "mode": "none"
    }  # the role default after_use is host: must be stated
    refused(doc, "after_use")
    refused(
        settings(STREAM, weight_streaming={"enabled": True, "precision": "fp16"}),
        "precision=fp16",
    )
    # fp16 streaming follows the fp16 rules: approximate profile, compute_dtype fp16
    doc = settings(
        STREAM,
        mode="approximate",
        weight_streaming={"enabled": True, "precision": "fp16"},
    )
    doc["load"]["precision"] = {"compute_dtype": "fp16"}
    assert any("fp16" in note for note in check(doc))
    doc["load"]["provider_options"]["mode"] = "exact"
    refused(doc, "approximate")
    # off: the other fields are not interpreted
    assert (
        check(
            settings(
                STREAM, video_vae_scope="full", weight_streaming={"enabled": False}
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
        {"enabled": False, "source": "pinned_host", "slots": 4, "precision": "fp16"},
    ],
    ids=["absent", "disabled", "disabled-with-fields"],
)
def test_off_changes_nothing_that_reaches_the_runtime(
    off: dict[str, Any] | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = settings(RESIDENT)
    doc = (
        settings(RESIDENT) if off is None else settings(RESIDENT, weight_streaming=off)
    )
    assert config.weight_streaming_settings("video_decode", doc["load"]) is None
    # the orchestration options H3Host gets, exactly as before the option existed
    assert provider_for(doc).host_options() == {"video_vae_scope": "decode_only"}
    assert "weight_streaming" not in provider_for(doc).observe_loaded()
    # the runtime profile (and so every plan and its digest) is the same document
    kwargs: dict[str, Any] = {"profile_id": "p", "revision": 1}
    profile = config.build_profile("video_decode", doc, **kwargs)
    assert json.dumps(profile, sort_keys=True) == json.dumps(
        config.build_profile("video_decode", base, **kwargs), sort_keys=True
    )
    # the component process environment: no allocator setting for a resident decode
    for name in ALLOCATOR_CONF_ENV:
        monkeypatch.delenv(name, raising=False)
    env = apply_runtime_env(
        model_root=Path("/models"),
        options=provider_for(doc).options,
        role="video_decode",
    )
    assert not set(env) & set(ALLOCATOR_CONF_ENV)
    assert check(doc) == []


@pytest.mark.static
def test_the_default_settings_and_role_defaults_do_not_carry_the_option() -> None:
    assert (
        "weight_streaming"
        not in config.ROLE_DEFAULTS["video_decode"]["provider_options"]
    )
    assert (
        "weight_streaming"
        not in config.default_settings("video_decode")["load"]["provider_options"]
    )


# ---------------------------------------------------------------------------------------------- on


@pytest.mark.static
def test_on_reaches_the_runtime_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = settings(STREAM)
    resolved = {
        "source": "nvme",
        "slots": 2,
        "precision": "fp32",
        "tiles_per_pass": None,
    }
    assert config.weight_streaming_settings("video_decode", doc["load"]) == resolved
    provider = provider_for(doc)
    assert provider.host_options() == {
        "video_vae_scope": "decode_only",
        "weight_streaming": resolved,
    }
    assert ws.StreamingConfig.from_mapping(resolved) == ws.StreamingConfig()
    # precision follows compute_dtype when the field is left out
    doc = settings(
        STREAM,
        mode="approximate",
        weight_streaming={"enabled": True, "tiles_per_pass": 14},
    )
    doc["load"]["precision"] = {"compute_dtype": "fp16"}
    got = config.weight_streaming_settings("video_decode", doc["load"])
    assert got == {
        "source": "nvme",
        "slots": 2,
        "precision": "fp16",
        "tiles_per_pass": 14,
    }
    # the streaming decoder's allocator gets expandable segments; an operator's own setting is left alone
    for name in ALLOCATOR_CONF_ENV:
        monkeypatch.delenv(name, raising=False)
    env = apply_runtime_env(
        model_root=Path("/models"), options=provider.options, role="video_decode"
    )
    assert (
        env[ALLOCATOR_CONF_ENV[0]]
        == DIT_ALLOCATOR_CONF
        == os.environ[ALLOCATOR_CONF_ENV[0]]
    )
    monkeypatch.delenv(ALLOCATOR_CONF_ENV[0])
    monkeypatch.setenv(ALLOCATOR_CONF_ENV[1], "max_split_size_mb:64")
    env = apply_runtime_env(
        model_root=Path("/models"), options=provider.options, role="video_decode"
    )
    assert (
        ALLOCATOR_CONF_ENV[0] not in env
        and os.environ[ALLOCATOR_CONF_ENV[1]] == "max_split_size_mb:64"
    )


@pytest.mark.static
def test_the_runtime_config_is_strict() -> None:
    assert (
        ws.StreamingConfig.from_mapping(
            {
                "source": "pinned_host",
                "slots": 4,
                "precision": "fp16",
                "tiles_per_pass": 7,
            }
        ).tiles_per_pass
        == 7
    )
    for bad in (
        {"enabled": True},
        {"source": "nvme", "group": 1},
        {"slots": 0},
        {"slots": 2.0},
        {"slots": True},
        {"precision": "native"},
        {"tiles_per_pass": 0},
        "nvme",
    ):
        with pytest.raises(UnsupportedCombination):
            ws.StreamingConfig.from_mapping(bad)  # type: ignore[arg-type]  # Deliberately malformed input.


# ---------------------------------------------------------------------------------------------- checkpoint layout


def _write_header(path: Path, entries: list[tuple[str, str, list[int]]]) -> None:
    """A safetensors file whose tensors lie in the given order (data zero-filled)."""
    sizes = {"F32": 4, "F16": 2}
    header: dict[str, Any] = {}
    offset = 0
    for name, dtype, shape in entries:
        nbytes = sizes[dtype]
        for d in shape:
            nbytes *= d
        header[name] = {
            "dtype": dtype,
            "shape": shape,
            "data_offsets": [offset, offset + nbytes],
        }
        offset += nbytes
    raw = json.dumps(header).encode()
    raw += b" " * (-len(raw) % 8)
    path.write_bytes(struct.pack("<Q", len(raw)) + raw + bytes(offset))


def _layout(
    blocks: int = 3, *, dtype: str = "F32", shuffle: bool = False
) -> list[tuple[str, str, list[int]]]:
    out: list[tuple[str, str, list[int]]] = [
        ("decoder.norm_out.weight", "F32", [8]),
        ("post_quant_conv.bias", "F32", [4]),
    ]
    for i in range(blocks):
        out += [
            (
                f"decoder.transformer_blocks.{i}.attn.to_qkv.weight",
                dtype if i == 1 else "F32",
                [24, 8],
            ),
            (f"decoder.transformer_blocks.{i}.scale2", "F32", [8]),
        ]
    if shuffle:  # a shell tensor between block 1's two tensors
        out.insert(4, out.pop(0))
    return out


@pytest.mark.static
def test_the_block_index_of_a_checkpoint(tmp_path: Path) -> None:
    path = tmp_path / "model.safetensors"
    _write_header(path, _layout())
    header = read_header_from_file(path)
    index = ws.block_index(path, header, keep=list(header.tensors), num_blocks=3)
    assert index.num_blocks == 3 and index.local_names == (
        "attn.to_qkv.weight",
        "scale2",
    )
    assert (
        index.shell == ("decoder.norm_out.weight", "post_quant_conv.bias")
        and index.shell_bytes == 48
    )
    for span in index.blocks:
        assert (
            span.nbytes == 24 * 8 * 4 + 8 * 4 and span.end - span.start == span.nbytes
        )
    assert index.blocks[1].start == index.blocks[0].end
    assert index.truncated(2).blocks == index.blocks[:2]

    def refused(entries: list[tuple[str, str, list[int]]], num_blocks: int = 3) -> str:
        _write_header(path, entries)
        head = read_header_from_file(path)
        with pytest.raises(UnsupportedCombination) as exc:
            ws.block_index(path, head, keep=list(head.tensors), num_blocks=num_blocks)
        return exc.value.reason_code

    assert (
        refused(_layout(), num_blocks=4) == "WEIGHT_STREAMING_LAYOUT"
    )  # the decoder has more layers
    assert (
        refused(_layout(dtype="F16")) == "WEIGHT_STREAMING_LAYOUT"
    )  # streaming reads FP32 only
    assert (
        refused(_layout(shuffle=True)) == "WEIGHT_STREAMING_LAYOUT"
    )  # not one contiguous range
    other = _layout()
    other[-2] = ("decoder.transformer_blocks.2.attn.to_qkv.weight", "F32", [16, 8])
    assert refused(other) == "WEIGHT_STREAMING_LAYOUT"  # block 2 differs from block 0


@pytest.mark.static
def test_direct_reads_return_the_file_bytes(tmp_path: Path) -> None:
    import mmap  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    path = tmp_path / "blob.bin"
    data = os.urandom(3 * 4096 + 1000)
    path.write_bytes(data)
    try:
        reader = ws.DirectReader(str(path), len(data))
    except (
        UnsupportedCombination
    ) as exc:  # tmpfs and some other file systems refuse O_DIRECT
        pytest.skip(f"O_DIRECT not available on {tmp_path}: {exc.message}")
    try:
        buf = mmap.mmap(-1, ws.DirectReader.buffer_bytes(len(data)))  # page aligned
        for start, end in (
            (0, 10),
            (4095, 4097),
            (5000, 3 * 4096 + 1000),
            (8192, 12288),
        ):
            view = memoryview(buf)
            base = reader.read_into(start, end, view)
            assert bytes(view[base : base + end - start]) == data[start:end], (
                start,
                end,
            )
    finally:
        reader.close()


# ---------------------------------------------------------------------------------------------- runtime tuple


@pytest.mark.gpu
def test_the_early_release_drops_each_clip_before_the_next() -> None:
    """``_stream_to_sink`` with and without ``release_clip_outputs``: the same frames; with it, no clip output is alive
    when the next clip decodes (without it, the last split's view keeps the previous clip's output)."""
    torch = pytest.importorskip(
        "torch", reason="需要 runtime tuple 環境；未驗證，不算通過"
    )
    import types  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.
    import weakref  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.klvae import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        AutoencoderKL,
    )

    from phasyn_h3.recipe.runtime.stages.vae_streaming import _stream_to_sink  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    def run(*, release: bool) -> tuple[list[Any], list[bool]]:
        fake = types.SimpleNamespace(vae_ratio_t=4, clip_length=17, token_drop=3)
        fake.frame_pre_padding = (-fake.clip_length) % fake.vae_ratio_t
        fake.tokens_chunk_size = -(-fake.clip_length // fake.vae_ratio_t)
        fake.token_overlap = (-fake.token_drop) % fake.tokens_chunk_size
        fake.frame_overlap = max(
            fake.token_overlap * fake.vae_ratio_t - fake.frame_pre_padding, 0
        )
        fake._blend_weight_cache = {}
        for name in (
            "_decode_temporal_output_frame_plan",
            "_decode_temporal_pad_frames",
            "blend",
        ):
            setattr(fake, name, types.MethodType(getattr(AutoencoderKL, name), fake))
        alive: list[Any] = []
        seen: list[bool] = []

        def decode(clip_z: Any) -> Any:
            seen.append(any(ref() is not None for ref in alive))
            out = clip_z.repeat_interleave(fake.vae_ratio_t, dim=2)[:, :3] * 1.5
            alive.append(weakref.ref(out))
            return out

        fake._adaptive_decode = decode
        z = torch.arange(1 * 3 * 17 * 2 * 2, dtype=torch.float32).reshape(
            1, 3, 17, 2, 2
        )
        frames: list[Any] = []
        _stream_to_sink(
            fake,
            z,
            None,
            None,
            3,
            0,
            None,
            lambda part: frames.append(part.clone()),
            release_clip_outputs=release,
        )
        return frames, seen

    kept, kept_seen = run(release=False)
    released, released_seen = run(release=True)
    assert len(kept) == len(released) and all(
        torch.equal(a, b) for a, b in zip(kept, released, strict=True)
    )
    assert released_seen == [False, False, False]
    assert kept_seen == [
        False,
        True,
        True,
    ]  # the bug the flag removes: the previous clip's output is still alive


@pytest.mark.gpu
def test_streamed_decode_equals_the_resident_decode_on_the_cpu() -> None:
    """Real checkpoint, decoder truncated to 2 blocks, one temporal clip of a 24x40 latent crop (6 tiles), on the CPU:
    the streamed decode (every source, slot count and pass size) equals the resident decode bit for bit."""
    torch = pytest.importorskip(
        "torch", reason="需要 runtime tuple 環境；未驗證，不算通過"
    )
    root = models_dir()
    from weight_streaming_harness import (  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.
        build_resident,
        build_streaming,
        decode,
        load_test_latent,
    )

    vae_dir = root / "MiniMax-H3" / "Ref2VA" / "video_vae"
    resident = build_resident(vae_dir, blocks=2)
    z = load_test_latent(resident, frames=7, height=24, width=40)
    want = decode(resident, z)
    del resident
    for source in ("nvme", "pinned_host"):
        for slots, tiles in ((1, None), (2, 4), (3, 1)):
            cfg = ws.StreamingConfig(
                source=source, slots=slots, precision="fp32", tiles_per_pass=tiles
            )
            try:
                shell = build_streaming(vae_dir, cfg, blocks=2)
            except UnsupportedCombination as exc:
                if exc.reason_code == "WEIGHT_STREAMING_DIRECT_IO_UNAVAILABLE":
                    pytest.skip(exc.message)
                raise
            got = decode(shell, z, streamed=True)
            assert torch.equal(got, want), (source, slots, tiles)


@pytest.mark.gpu
def test_a_slot_that_cannot_be_built_leaves_no_slot_on_the_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Out of memory while the second slot materializes: the first one goes back to meta, nothing stays allocated."""
    torch = pytest.importorskip(
        "torch", reason="需要 runtime tuple 環境；未驗證，不算通過"
    )

    slots = [torch.nn.Linear(4, 4, device="meta") for _ in range(2)]
    original = torch.nn.Module.to_empty
    built = {"n": 0}

    def flaky(self: Any, *, device: Any, recurse: bool = True) -> Any:
        if str(device) != "meta":
            built["n"] += 1
            if built["n"] == 2:
                raise RuntimeError("fake out of memory")
        return original(self, device=device, recurse=recurse)

    monkeypatch.setattr(torch.nn.Module, "to_empty", flaky)
    state = ws.WeightStreamingState.__new__(ws.WeightStreamingState)
    state.config = ws.StreamingConfig(slots=2)
    state.slots = slots
    state.reader = None
    state.scale2 = []
    with pytest.raises(RuntimeError, match="fake out of memory"):
        ws.BlockStreamer(state, "cpu")
    assert built["n"] == 2
    assert all(p.is_meta for slot in slots for p in slot.parameters())
