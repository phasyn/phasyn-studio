"""The pinned SGLang sources the recipe patches, wraps or reads privately — one table, one check.

Each entry is ``sha256(inspect.getsource(obj))`` at SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb.
Before a runtime patch or wrapper touches upstream code, its group is checked here
(``phasyn_components.upstream``); a different source — or a symbol that no longer exists — refuses
the patch with ``UPSTREAM_PATCH_SOURCE_MISMATCH`` instead of running on code nobody reviewed.
``phasyn-h3-importcheck --pins`` checks every group at once in a runtime environment.

Private attributes the recipe reads without patching (layerwise offload managers …) are checked
with :func:`check_attrs`.

Pure Python: the guarded modules are imported only when a check runs.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterable
from typing import Any

from phasyn_components.upstream import Mismatch, Pin, mismatches, missing_attrs

from .errors import UnsupportedCombination


_RT = "sglang.multimodal_gen.runtime"
_KLVAE = f"{_RT}.models.vaes.minimax_h3_video_vae.klvae"
_BASE_MODULE = f"{_RT}.models.vaes.minimax_h3_video_vae.base_module"
_VAE_VIT = f"{_RT}.models.vaes.minimax_h3_video_vae.vae_vit"
_DIT = f"{_RT}.models.dits.minimax_h3"
_SDPA = f"{_RT}.layers.attention.backends.sdpa"
_VAE_CNN = f"{_RT}.models.vaes.minimax_h3_video_vae.vae_cnn"
_VAE_CONV = f"{_RT}.models.vaes.minimax_h3_video_vae.conv"
_VAE_NORM = f"{_RT}.models.vaes.minimax_h3_video_vae.norm"
_VAE_PROCESSOR = f"{_RT}.models.vaes.minimax_h3_video_vae.processor"
_H3_STAGES = f"{_RT}.pipelines_core.stages.model_specific_stages.minimax_h3"

# group -> label -> (module, qualname, sha256 of inspect.getsource)
SOURCES: dict[str, dict[str, tuple[str, str, str]]] = {
    # upstream_patches.ensure_uuid_device_ids
    "uuid_device_ids": {
        "platforms/cuda.py device_id_to_physical_device_id": (
            f"{_RT}.platforms.cuda",
            "device_id_to_physical_device_id",
            "24715259493f77f44de51ef9f767110001e3bf3ce8d02c304a46bc761dd4d7cb",
        ),
    },
    # upstream_patches.install_adaln_online_quant_patch (§15.3)
    "adaln_online_quant": {
        "minimax_h3.py MiniMaxH3DiTModel.__init__": (
            f"{_RT}.models.dits.minimax_h3",
            "MiniMaxH3DiTModel.__init__",
            "5f784af9a857722deeed3046dba55d92302f79ec6719e84775ff8108645bbbd0",
        ),
    },
    # upstream_patches.install_fp8_layerwise_patch (§15.2)
    "fp8_layerwise_quant": {
        "layers/quantization/fp8.py Fp8LinearMethod.process_weights_after_loading": (
            f"{_RT}.layers.quantization.fp8",
            "Fp8LinearMethod.process_weights_after_loading",
            "2eb1293ccf6f69da6aa94abb42155c41de66712ecc5a5d3273049ee06139c595",
        ),
        "layers/quantization/fp8.py Fp8LinearMethod.apply": (
            f"{_RT}.layers.quantization.fp8",
            "Fp8LinearMethod.apply",
            "277f9f514d87afae00599dfce7458b729c819f18118310be6fa7052e419e18b9",
        ),
        "loader/transformer_load_utils.py _needs_device_weight_postprocess": (
            f"{_RT}.loader.transformer_load_utils",
            "_needs_device_weight_postprocess",
            "53a1d72483982b8e24ed894c77de2f5393334813ef6a3115c827ecdf8ac9a993",
        ),
        "loader/component_loaders/transformer_loader.py _resolve_checkpoint_load_device": (
            f"{_RT}.loader.component_loaders.transformer_loader",
            "_resolve_checkpoint_load_device",
            "d9b444bae69b37fe7710224d22ddb20b0ddc8448fa50aa68015aad2c39875dbe",
        ),
    },
    # bounded_fp8_load.bounded_fp8_load_scope
    "bounded_fp8_load": {
        "load_model_from_full_model_state_dict": (
            f"{_RT}.loader.fsdp_load",
            "load_model_from_full_model_state_dict",
            "2f578ec7f51d0776ae31d0a1353c512c3389727679ed82325758dd3a110358ac",
        ),
        "process_model_weights_after_loading": (
            f"{_RT}.loader.fsdp_load",
            "process_model_weights_after_loading",
            "f364cc7e874a205d4c0b58c04dc9a7d8ced5fefc861f8baf5227c474f7f0e5d4",
        ),
    },
    # quantized_cache.cache_scope: the loader pair it wraps (load, then post-process, in maybe_load_fsdp_model),
    # the pre-converted state dict a hit is handed to, and the convrot post-process that skips an INT8 weight
    "quantized_cache": {
        "quantized_cache: maybe_load_fsdp_model": (
            f"{_RT}.loader.fsdp_load",
            "maybe_load_fsdp_model",
            "538e1d7a388bfb9fd32f392402f5b761f1f52335bf38db2c73c638677825d59f",
        ),
        "quantized_cache: load_model_from_full_model_state_dict": (
            f"{_RT}.loader.fsdp_load",
            "load_model_from_full_model_state_dict",
            "2f578ec7f51d0776ae31d0a1353c512c3389727679ed82325758dd3a110358ac",
        ),
        "quantized_cache: process_model_weights_after_loading": (
            f"{_RT}.loader.fsdp_load",
            "process_model_weights_after_loading",
            "f364cc7e874a205d4c0b58c04dc9a7d8ced5fefc861f8baf5227c474f7f0e5d4",
        ),
        "quantized_cache: ConvRotInt8JitLinearMethod.process_weights_after_loading": (
            f"{_RT}.layers.quantization.convrot_int8_jit",
            "ConvRotInt8JitLinearMethod.process_weights_after_loading",
            "4a615fe39391a903b343bdb3456162f65a78b41f472ff0506deff3dd143dc907",
        ),
    },
    "regional_compile": {
        "minimax_h3.py MiniMaxH3MLP.forward (regional compile)": (
            _DIT,
            "MiniMaxH3MLP.forward",
            "d96a062886b092683475278d01ac9e1ac4244c9e12b00505cfda51390d365ecd",
        ),
        "minimax_h3.py _silu_mul": (
            _DIT,
            "_silu_mul",
            "6480e8ae34f6f7333a8746108c14eca6a2c507475acd3471669836fa6ec0ad16",
        ),
    },
    # mlp_token_chunk.chunked_mlp: the block MLP is row-wise (fc1, SiLU-and-mul, fc2), so row chunks compute
    # the same rows; wraps each block's ``mlp.forward`` for the loop only, above ENGAGE_ROWS
    "mlp_token_chunk": {
        "minimax_h3.py MiniMaxH3MLP.forward (row chunks)": (
            _DIT,
            "MiniMaxH3MLP.forward",
            "d96a062886b092683475278d01ac9e1ac4244c9e12b00505cfda51390d365ecd",
        ),
    },
    # ref_kv_cache.RefKvSession: what the skip path relies on. The model forward takes a
    # packed sequence without the reference rows (reduced kwargs), every block operation but attention is
    # row-wise, and the attention core hands the post-RoPE q/k/v to the backend's forward_varlen, which the
    # session's per-block proxy serves with the cached reference K/V.
    "ref_kv_cache": {
        "minimax_h3.py MiniMaxH3DiTModel.forward": (
            _DIT,
            "MiniMaxH3DiTModel.forward",
            "274135d3568715d7ceb5a86739dcb34d7b9009850a704987ca0487102913c750",
        ),
        "minimax_h3.py MiniMaxH3DiTModel._embed": (
            _DIT,
            "MiniMaxH3DiTModel._embed",
            "6a44b617a901e75da191ecf806132e6d10ba6a1264faf5e4df56fdc30545cab9",
        ),
        "minimax_h3.py MiniMaxH3DiTBlock.forward": (
            _DIT,
            "MiniMaxH3DiTBlock.forward",
            "1c83bf67248375dc8337c60e8b998710e1b1111f5173ec1fb02a05e06c94130a",
        ),
        "minimax_h3.py MiniMaxH3MLP.forward": (
            _DIT,
            "MiniMaxH3MLP.forward",
            "d96a062886b092683475278d01ac9e1ac4244c9e12b00505cfda51390d365ecd",
        ),
        "minimax_h3.py MiniMaxH3Attention.forward": (
            _DIT,
            "MiniMaxH3Attention.forward",
            "cea6bdb2ad9de828c7b6b7fc7218515272db2d76aacf1408a991bde70bb6cb77",
        ),
        "minimax_h3.py _minimax_h3_attention_core_impl": (
            _DIT,
            "_minimax_h3_attention_core_impl",
            "44440ad73b381b44b9774287bab7f14250f0c79524946d40068fc298b6dfbc78",
        ),
        "minimax_h3.py MiniMaxH3FinalLayer.forward": (
            _DIT,
            "MiniMaxH3FinalLayer.forward",
            "b62cda911a369ef6bed463bea8d3aad4f96b2ec8e65531b8aeeacf238a400bc9",
        ),
        "sdpa.py SDPAImpl.forward": (
            _SDPA,
            "SDPAImpl.forward",
            "8e874df59789715c43f516b8425c945e7768ce4a1f45fcd61a6424116ba3a8ba",
        ),
        "sdpa.py SDPAImpl.forward_varlen": (
            _SDPA,
            "SDPAImpl.forward_varlen",
            "885edef9593dc45d2796adcd9710d40f437411085d11ff1113e075a582ca3dd1",
        ),
    },
    # ref_kv_cache on the FlashAttention backend (checked only when the DiT is bound to it)
    "ref_kv_cache_fa": {
        "flash_attn.py FlashAttentionImpl.forward": (
            f"{_RT}.layers.attention.backends.flash_attn",
            "FlashAttentionImpl.forward",
            "a4bbc413c4d399c6efe6b069a30be3a0741850f2792541cc43f6fc40a7514842",
        ),
    },
    # nag.NagSession: the model forward takes the extended packed sequence (negative text rows after the live rows),
    # ``_embed`` writes text / video / audio rows and zeroes the rest (the wrapper fills the negative rows), every
    # block operation but attention is row-wise, and the attention core hands the post-RoPE q/k/v to the backend's
    # forward_varlen, which the session's proxy runs as the positive / negative / padding segments
    "nag": {
        "minimax_h3.py MiniMaxH3DiTModel.forward (NAG extended sequence)": (
            _DIT,
            "MiniMaxH3DiTModel.forward",
            "274135d3568715d7ceb5a86739dcb34d7b9009850a704987ca0487102913c750",
        ),
        "minimax_h3.py MiniMaxH3DiTModel._embed (NAG extended sequence)": (
            _DIT,
            "MiniMaxH3DiTModel._embed",
            "6a44b617a901e75da191ecf806132e6d10ba6a1264faf5e4df56fdc30545cab9",
        ),
        "minimax_h3.py MiniMaxH3DiTModel.refine_prompt_embeds (NAG extended sequence)": (
            _DIT,
            "MiniMaxH3DiTModel.refine_prompt_embeds",
            "2e7d0ab10ac28a5936912f70457da92bcae1d54bce6c21e3105bd2bbe0b881cc",
        ),
        "minimax_h3.py MiniMaxH3DiTBlock.forward (NAG extended sequence)": (
            _DIT,
            "MiniMaxH3DiTBlock.forward",
            "1c83bf67248375dc8337c60e8b998710e1b1111f5173ec1fb02a05e06c94130a",
        ),
        "minimax_h3.py MiniMaxH3Attention.forward (NAG extended sequence)": (
            _DIT,
            "MiniMaxH3Attention.forward",
            "cea6bdb2ad9de828c7b6b7fc7218515272db2d76aacf1408a991bde70bb6cb77",
        ),
        "minimax_h3.py _minimax_h3_attention_core_impl (NAG extended sequence)": (
            _DIT,
            "_minimax_h3_attention_core_impl",
            "44440ad73b381b44b9774287bab7f14250f0c79524946d40068fc298b6dfbc78",
        ),
        "minimax_h3.py MiniMaxH3FinalLayer.forward (NAG extended sequence)": (
            _DIT,
            "MiniMaxH3FinalLayer.forward",
            "b62cda911a369ef6bed463bea8d3aad4f96b2ec8e65531b8aeeacf238a400bc9",
        ),
    },
    # stages/vae_fp32_accel.fp32_decode_scope
    "vae_fp32_tile_batch": {
        "AutoencoderKL._run_tile_tasks": (
            _KLVAE,
            "AutoencoderKL._run_tile_tasks",
            "22106499e23ac39921b060aba49c88ef11fc82ec9865bd278ababa1a0f6e3c99",
        ),
        "AutoencoderKL.tiled_decode": (
            _KLVAE,
            "AutoencoderKL.tiled_decode",
            "2331e0c7fee5fd79d3eb0d13f42102128cb4a3b0bf8c2228d8dae005cebf47a5",
        ),
        "base_module._unfused_bias_linear": (
            _BASE_MODULE,
            "_unfused_bias_linear",
            "7f42b7b6a033dfe1247255c4ebcefa22a048bac056c3f4df31b7370ffbbc98ac",
        ),
        "base_module.FeedForward._forward_impl": (
            _BASE_MODULE,
            "FeedForward._forward_impl",
            "8ed968c1c118e1cc4647a72c70bea3e8559ad57d0b2833d2c474e738b1566227",
        ),
    },
    # stages/vae_streaming.streaming_decode_scope (checked on the loaded VAE instance)
    "vae_callback_decode": {
        "_decode_temporal_streaming": (
            _KLVAE,
            "AutoencoderKL._decode_temporal_streaming",
            "6fd1f3a52a01d63b340b192805d313eec3b6d65414c5ecc47519511228d20036",
        ),
        "decode_base": (
            _KLVAE,
            "AutoencoderKL.decode_base",
            "a7786174b91c4e55368eb93bff8a87f57a8133d50885a5e7b20035d07e28a720",
        ),
        "decode_temporal": (
            _KLVAE,
            "AutoencoderKL.decode_temporal",
            "3afcd0643997629f340082e04e8dab3a242c5e15fcaf7b151882fd2cdd3011fa",
        ),
        "_decode_temporal_output_frame_plan": (
            _KLVAE,
            "AutoencoderKL._decode_temporal_output_frame_plan",
            "cfd34c7e11e7492e61ffb955a1e55c3f4707a448973be6bcbdc1bcc782c1e21f",
        ),
        "trim_output": (
            _KLVAE,
            "AutoencoderKL.trim_output",
            "d9dea004903d75cf85f21212a3ce20dbebac7f8e5a99193279c99ba438e2ad93",
        ),
    },
    # stages/vae_weight_streaming.weight_streaming_scope (with "vae_fp32_tile_batch": _run_tile_tasks, tiled_decode):
    # the per-tile decode it splits into prologue / blocks / epilogue, the block loop it re-states layer-major,
    # and the constructors whose RoPE buffer the meta-built shell recomputes
    "vae_weight_streaming": {
        "AutoencoderKLLegacy.decode": (
            _KLVAE,
            "AutoencoderKLLegacy.decode",
            "2aa77badabe1e30249f521a73f3edcb10cb05c3f0ba3397f314516ecba0b9156",
        ),
        "ViT3DDecoder.forward": (
            _VAE_VIT,
            "ViT3DDecoder.forward",
            "203936a27dd7fefabe5530f078533ac4f9ec44e3808be97cabefd4380f2f081b",
        ),
        "ViT3DDecoder.__init__": (
            _VAE_VIT,
            "ViT3DDecoder.__init__",
            "f14a833e8517f9340f68ce7c5bc22a14ce01f7ae221cdcb0e73721957c88bc09",
        ),
        "ViTBase.forward_transformer_blocks": (
            _VAE_VIT,
            "ViTBase.forward_transformer_blocks",
            "229b14cf9fb539da6df310a6a20d9b438fdc0683a287ee65d504df4e89b00c42",
        ),
        "vae_vit._fused_blocks_available": (
            _VAE_VIT,
            "_fused_blocks_available",
            "82c97f38b8b66d316eb572218641546d5b45a741efcc2101d29d95a25da6e7b2",
        ),
        "vae_vit._run_fused_transformer_blocks": (
            _VAE_VIT,
            "_run_fused_transformer_blocks",
            "544dbda881e0b10c2ee4a21d5b18fb0a4232f1697955260b35792f497c8452bb",
        ),
        "base_module.TransformerBlock.forward": (
            _BASE_MODULE,
            "TransformerBlock.forward",
            "d9e5616d067e007b43864c2c09d793a57c0ae7a126410022845bbc94eca485cb",
        ),
        "base_module._scaled_residual_add": (
            _BASE_MODULE,
            "_scaled_residual_add",
            "fd2975bf0719ddc7fe167cf0c1f87dc7878aadc1146999407231ae3d96ac4b95",
        ),
        "base_module.RotaryEmbeddingND.__init__": (
            _BASE_MODULE,
            "RotaryEmbeddingND.__init__",
            "fbad5d04f8790911ce34e2db8903d5c25ae596cb6fe19acc7fcdb4dcd030171f",
        ),
    },
    # stages/vae_frame_streaming.stream_reference_video_rows: the reference-video recipe and the encoder forwards it
    # re-states pass by pass, and the per-frame norm the causal streaming relies on
    "vae_frame_streaming": {
        "reference_encoding.minimax_h3_encode_reference_video_rows": (
            f"{_H3_STAGES}.reference_encoding",
            "minimax_h3_encode_reference_video_rows",
            "dbf9aca0894e00b109ad53e70af5aed881575a751128393b055fd0802fec04fd",
        ),
        "AutoencoderKL.encode_videos": (
            _KLVAE,
            "AutoencoderKL.encode_videos",
            "07e9c5f62ab282f7ad7e7dd275cdcbaba0075bfcd63950dd2f69a86114a38e06",
        ),
        "AutoencoderKL.encode_temporal": (
            _KLVAE,
            "AutoencoderKL.encode_temporal",
            "75cc05cadc558f8d79932c69fbcf1069afec4cdd55303fee61b9392d99ca03d9",
        ),
        "AutoencoderKL.tiled_encode": (
            _KLVAE,
            "AutoencoderKL.tiled_encode",
            "8b7aa17d04dc8ede2f4d076e7a3aa0b1cd95b6cc5c123e50d15b737f6a898a24",
        ),
        "AutoencoderKL._adaptive_encode": (
            _KLVAE,
            "AutoencoderKL._adaptive_encode",
            "a0e4b9c1c2ab17508addcb0d5a6ff5832304bbacaf0c974b7c0ebd317078aaf3",
        ),
        "AutoencoderKLLegacy.encode_base": (
            _KLVAE,
            "AutoencoderKLLegacy.encode_base",
            "d0cee3b2868ef7fe1dbabd97394b70c6d7f023304be96bcda77ab3bc567d2e7e",
        ),
        "AutoencoderKLLegacy.encode": (
            _KLVAE,
            "AutoencoderKLLegacy.encode",
            "24db6b41111071e431fb1cc0c4337ed59fc8197b675911809e7d64c08b8863cb",
        ),
        "vae_cnn.EncoderFCN3D.forward": (
            _VAE_CNN,
            "EncoderFCN3D.forward",
            "f0ba6d7aa549c170b7dd06afa2097ddfb7ba8145c13840508d145721fa0f8bb9",
        ),
        "vae_cnn.ResnetBlock3D.forward": (
            _VAE_CNN,
            "ResnetBlock3D.forward",
            "db321d8b175ba1e20cfd316aa73d880543870978e63794753ce4b337a011ccce",
        ),
        "vae_cnn.Downsample3D.forward": (
            _VAE_CNN,
            "Downsample3D.forward",
            "80cfb209d65544367d29e1de4004af797bb93ff5752d199679afb938fc1a3654",
        ),
        "vae_cnn.norm_silu": (
            _VAE_CNN,
            "norm_silu",
            "5510f4a8d1b359a45002e12d291a362560730759b51e07f7d11d63ab66f2b345",
        ),
        "conv.BaseConv3d.forward": (
            _VAE_CONV,
            "BaseConv3d.forward",
            "11774263d5cc5afb5468b274e3d6a6e6dca20afdcd29d06a071898fc0f194f55",
        ),
        "conv.BaseConv3d._apply_padding": (
            _VAE_CONV,
            "BaseConv3d._apply_padding",
            "fe361c2cc8311958ccb2df157386421209a90a7cc43a7c43eaf386011c89c6df",
        ),
        "conv.BaseConv3d._apply_temporal_padding": (
            _VAE_CONV,
            "BaseConv3d._apply_temporal_padding",
            "6876ffa280ef844fec110c04582c7d69d338ae6e31caff18549633dbf272e408",
        ),
        "norm.TemporalIsolatedGroupNorm.forward": (
            _VAE_NORM,
            "TemporalIsolatedGroupNorm.forward",
            "03b4a82fd9206206f2bc2cc1357027772658d233a7cbdf90b48c5b79e768889d",
        ),
        "norm._merge_time_to_batch": (
            _VAE_NORM,
            "_merge_time_to_batch",
            "89e0a3b0bcb00ad8779c695d53efc6c9799fc1a0d55b7f4b995ab684c73b6b6b",
        ),
        "norm._split_time_from_batch": (
            _VAE_NORM,
            "_split_time_from_batch",
            "2b6abec5632ba7aab8404149f384891404765609e436338a863933ac36f4548b",
        ),
        "processor.VAEProcessor._crop_to_align": (
            _VAE_PROCESSOR,
            "VAEProcessor._crop_to_align",
            "0f42ca6b1e02e05e6f99d796e2a47b85d28b9b66bb45037a58d0355691fd8479",
        ),
    },
}

# Private SGLang attributes read without a source pin (§14)
LAYERWISE_MANAGER_ATTRS = (
    "release_all",
    "release_after_use",
    "prefetch_layer",
    "release_layer",
    "copy_stream",
    "layers_attr_str",
    "_gpu_layers",
    "_resident_set",
    "_courier_inflight",
    "_consolidated_cpu_weights",
    "_strided_cpu_weights",
    "_mapped_cpu_weights",
)
LAYERWISE_MODULE_ATTRS = (
    "layerwise_offload_managers",
    "_managed_layer_parameter_names",
)
ROPE_CACHE_MODULE = "sglang.srt.layers.rotary_embedding.factory"
ROPE_CACHE_ATTRS = ("_ROPE_DICT.clear",)


def _resolver(module: str, qualname: str, owner: object | None) -> Any:
    if (
        owner is not None
    ):  # the instance's own attribute (a subclass or a replaced method must match too)
        name = qualname.rsplit(".", 1)[-1]
        return lambda: getattr(owner, name)

    def target() -> object:
        obj: Any = importlib.import_module(module)
        for part in qualname.split("."):
            obj = getattr(obj, part)
        return obj

    return target


def pins(group: str, *, owner: object | None = None) -> list[Pin]:
    """The pins of one group; with ``owner`` they resolve on that object instead of the module."""
    return [
        Pin(label, _resolver(module, qualname, owner), digest)
        for label, (module, qualname, digest) in SOURCES[group].items()
    ]


def all_pins() -> list[Pin]:
    """Return the upstream source identities checked by this runtime."""
    return [pin for group in SOURCES for pin in pins(group)]


def mismatch_error(mismatch: Mismatch, *, what: str) -> UnsupportedCombination:
    """Build the diagnostic for a pinned source mismatch."""
    return UnsupportedCombination(
        "UPSTREAM_PATCH_SOURCE_MISMATCH",
        f"{mismatch.label} 的上游原始碼與釘版 SGLang de487f8 不同；{what}不套用在未審核的程式上",
        expected=mismatch.expected,
        actual=mismatch.actual,
    )


def check(group: str, *, what: str, owner: object | None = None) -> dict[str, str]:
    """Refuse (``UPSTREAM_PATCH_SOURCE_MISMATCH``) unless every pin of ``group`` matches; ``{label: sha256}``."""
    found = mismatches(pins(group, owner=owner))
    if found:
        raise mismatch_error(found[0], what=what)
    return {label: digest for label, (_m, _q, digest) in SOURCES[group].items()}


def check_attrs(obj: object, names: Iterable[str], *, what: str) -> None:
    """Refuse when ``obj`` no longer has the private attributes the recipe relies on (no silent fallback)."""
    missing = missing_attrs(obj, names)
    if missing:
        raise UnsupportedCombination(
            "UPSTREAM_PATCH_SOURCE_MISMATCH",
            f"{what}：釘版 SGLang de487f8 的 {', '.join(missing)} 不存在；不在未審核的上游上繼續",
            expected="present",
            actual="missing:" + ",".join(missing),
        )


__all__ = [
    "LAYERWISE_MANAGER_ATTRS",
    "LAYERWISE_MODULE_ATTRS",
    "ROPE_CACHE_ATTRS",
    "ROPE_CACHE_MODULE",
    "SOURCES",
    "all_pins",
    "check",
    "check_attrs",
    "mismatch_error",
    "pins",
]
