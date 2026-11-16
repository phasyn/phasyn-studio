"""MiniMax H3 facts read from pinned upstream sources (no torch, no network).

Citation prefixes used throughout this package:

* ``SG:``  sgl-project/sglang @ de487f8039e06853b5f376fd5f068ea9d7c400bb,
  ``python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/``
* ``SGR:`` same SGLang revision, ``python/sglang/multimodal_gen/`` root
* ``H3:``  MiniMax-AI/MiniMax-H3 @ d21241f0a4b3acbb34c97dae47fa417b7065e438

Rule identifiers (``RULE-nnn``, ``REQ-nnn``, ``ADR-nnn`` …) refer to ````
(anchor = lower-case identifier, e.g. ````).

Every number here is either copied from those files or derived from them by
plain arithmetic that is spelled out next to it.  Derived byte counts are
estimates, never measurements.
"""

from __future__ import annotations

from types import MappingProxyType

FAMILY = "minimax_h3"

SGLANG_REVISION = "de487f8039e06853b5f376fd5f068ea9d7c400bb"
H3_GIT_REVISION = "d21241f0a4b3acbb34c97dae47fa417b7065e438"
SOURCE_REPO = "MiniMaxAI/MiniMax-H3"
SOURCE_REVISION = "42ed227ee7df40d41602854ae760620d6eb651fe"  # Hugging Face snapshot of MiniMaxAI/MiniMax-H3
LICENSE_URL = f"https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/{SOURCE_REVISION}/LICENSE"

# --- tasks / variants -------------------------------------------------------
# SG:task_profiles.py:32-38 MINIMAX_H3_TASK_PARTITIONS (t2va->fl2va, fl2va->fl2va, ref2va->ref2va)
TASK_VARIANT = MappingProxyType({"t2va": "fl2va", "fl2va": "fl2va", "ref2va": "ref2va"})
# H3:FL2VA/model_index.json _minimax_h3.tasks ; H3:Ref2VA/model_index.json _minimax_h3.tasks
VARIANT_TASKS = MappingProxyType({"fl2va": ("t2va", "fl2va"), "ref2va": ("ref2va",)})
# SGR:runtime/pipelines/minimax_h3_pipeline.py:39,74-89 (variant -> partition subfolder)
VARIANT_SUBFOLDER = MappingProxyType({"fl2va": "FL2VA", "ref2va": "Ref2VA"})
# SG:task_profiles.py:72-76 ordered keyframe signatures (0,), (-1,), (0, -1)
KEYFRAME_SIGNATURES = ((0,), (-1,), (0, -1))

# --- time -------------------------------------------------------------------
FPS = 24  # SG:constants.py:29 MINIMAX_H3_SUPPORTED_FPS
MIN_DURATION_SECONDS = 4  # SG:constants.py:30 ; SG:request_validation.py:117-126 (inclusive)
MAX_DURATION_SECONDS = 15  # SG:constants.py:31
FRAME_GROUP = 17  # SG:time_request.py:5-10  F + (5 - F) % 17
FRAME_OFFSET = 5
LATENT_T_GROUP = 5  # SG:time_request.py:13-16  ((F - 5) // 17) * 5 + 2
LATENT_T_HEAD = 2  # SG:time_request.py:13-16  (latent frames of the leading 5 frames)
AUDIO_LATENT_HZ = 40  # SG:time_request.py:27-29  round(seconds * 40)
FRAME_ALIGNMENT_RULE = "sglang_h3_17n_plus_5"

# --- space ------------------------------------------------------------------
CANVAS_MULTIPLE = 32  # SG:resolved_plan.py:45 ; SG:canvas.py:22
BASE_SHORT_EDGE = 768  # SG:resolved_plan.py:43 ; SG:constants.py:38 (only verified short edge)
MAX_PIXELS = BASE_SHORT_EDGE * 1344  # SG:resolved_plan.py:44 soft area cap = 1,032,192
MIN_ASPECT_RATIO = 1.0 / 4.0  # SG:resolved_plan.py:46
MAX_ASPECT_RATIO = 4.0  # SG:resolved_plan.py:47
SHAPE_POLICY_VERSION = "adapt_shape_v1"  # SG:resolved_plan.py:42
REFERENCE_IMAGE_SHORT_EDGE = 2048  # SG:reference_encoding.py:47 (upscale allowed, no area cap)
REFERENCE_IMAGE_MULTIPLE = 32  # SG:reference_encoding.py:48

# --- latents / packing ------------------------------------------------------
VIDEO_LATENT_CHANNELS = 24  # H3:FL2VA/transformer/config.json latents_dim
AUDIO_LATENT_CHANNELS = 32  # H3:FL2VA/transformer/config.json audio_latents_dim
AUDIO_CHANNELS = 2  # SG:reference_encoding.py:50 ; stereo L/R rows (SG:stages/latent_preparation.py:99-100)
AUDIO_SAMPLE_RATE = 32000  # SG:reference_encoding.py:49 ; H3:FL2VA/audio_vae/config.json
VAE_SPATIAL_FACTOR = (
    16  # H3:FL2VA/video_vae/source/config.json vae_ratio ; SGR:configs/models/vaes/minimax_h3_video.py:16
)
VAE_TEMPORAL_FACTOR = 4  # SGR:configs/models/vaes/minimax_h3_video.py:15
VAE_CLIP_LENGTH = 17  # H3:FL2VA/video_vae/config.json vae_clip_length
VAE_DEFAULT_TILE = 256  # H3:FL2VA/video_vae/config.json vae_tile_size
VAE_DEFAULT_TILE_OVERLAP = 64  # H3:FL2VA/video_vae/config.json vae_tile_overlap_min
PATCH_SIZE = (1, 2, 2)  # H3:FL2VA/transformer/config.json patch_size
TOKEN_STRIDE = VAE_SPATIAL_FACTOR * PATCH_SIZE[1]  # 32 px per DiT token side
PACKED_ALIGNMENT = 64  # SGR:configs/models/dits/minimax_h3.py:9
LATENT_WIRE_DTYPE = "F32"  # SG:stages/latent_preparation.py:115-130 (fp32 noise/denoise state);

# --- DiT (H3:FL2VA/transformer/config.json; identical for Ref2VA) -----------
DIT_NUM_LAYERS = 50
DIT_REFINER_LAYERS = 2
DIT_HIDDEN = 5376
DIT_HEADS = 56
DIT_HEAD_DIM = 128
DIT_FFN = 14336
DIT_TEXT_DIM = 5120
DIT_TIME_EMBED_DIM = 2688
DIT_ADALN_OUT = 96768  # 18 * 5376
DIT_FINAL_ADALN_OUT = 10752
# index metadata.total_size (H3:FL2VA/transformer/model.safetensors.index.json, same for Ref2VA)
DIT_INDEX_BYTES = 66_280_430_144
DIT_DIFFUSERS_INDEX_BYTES = 66_280_430_080  # H3:transformer/diffusion_pytorch_model.safetensors.index.json

# --- Qwen3-VL conditioner (H3:FL2VA/text_encoder/config.json) ---------------
TEXT_HIDDEN = 5120
TEXT_CHECKPOINT_LAYERS = 64
TEXT_SELECTED_LAYER = 50  # SGR:configs/models/encoders/minimax_h3_qwen3vl.py:11
TEXT_HEADS = 64
TEXT_KV_HEADS = 8
TEXT_HEAD_DIM = 128
TEXT_FFN = 25600
TEXT_VOCAB = 151936
TEXT_INDEX_BYTES = 66_714_780_128  # H3:FL2VA/text_encoder/model.safetensors.index.json total_size
QWEN_VIDEO_SAMPLE_FPS = 2.0  # SG:reference_encoding.py:687 MINIMAX_H3_QWEN_VIDEO_SAMPLE_FPS
QWEN_VISION_WRAP_TOKENS = 2  # SG:presentation.py:21-22 <|vision_start|> … <|vision_end|> per vision block
# phasyn_h3.recipe.abi.tensors.CONDITIONING_TAP mirrors SGR:runtime/models/encoders/minimax_h3_qwen3vl.py:44-51,281,323

# --- VAEs ---------------------------------------------------------------------
# Native FL2VA/video_vae ships a single model.safetensors without an index; the
# closest pinned byte count is the Diffusers vae index (same weights, other layout).
VIDEO_VAE_INDEX_BYTES = 10_415_475_936  # H3:vae/diffusion_pytorch_model.safetensors.index.json
VIDEO_VAE_DECODER_LAYERS = 36  # H3:vae/config.json decoder_num_layers (ViT decoder)
VIDEO_VAE_DECODER_DIM = 32 * 64  # decoder_num_attention_heads * decoder_attention_head_dim
VIDEO_VAE_DECODER_FFN_MULT = 4  # H3:vae/config.json decoder_ffn_mult
VIDEO_VAE_BASE_CHANNELS = 128  # H3:FL2VA/video_vae/source/config.json ch
AUDIO_VAE_APPROX_BYTES = 605_000_000  # approximate size shown on the MiniMax-H3 Hugging Face model card, NOT exact
AUDIO_VAE_DECODER_DIM = 1024  # H3:FL2VA/audio_vae/metadata.json decoder_dim
AUDIO_VAE_UPSAMPLE = 800  # prod(decoder_rates [5,5,2,2,2,2,2]) = 32000 / 40

# --- sampling -----------------------------------------------------------------
# SGR:runtime/pipelines/minimax_h3_pipeline.py:48-52 (scheduler=null);
# loop math in SGR:runtime/models/schedulers/scheduling_minimax_h3_euler_ancestral.py
SCHEDULER_ID = "h3_euler"
DEFAULT_STEPS = 50  # SG:stages/timestep_preparation.py:154-155
MAX_STEPS = 200  # schemas/job-request.schema.json sampling.steps maximum (phasyn_h3.recipe.abi)
DEFAULT_VIDEO_SHIFT = 12.0  # SG:task_profiles.py:154 ; H3:FL2VA/model_index.json sigma_shift_scales.video
DEFAULT_AUDIO_SHIFT = 3.0  # SG:task_profiles.py:155 ; H3:FL2VA/model_index.json sigma_shift_scales.audio
SCHEDULE_SEMANTICS = "sglang_h3_updates_v1"
RNG_POLICY_ID = "h3_native_fp32_draw_order_v1"
# SG:request_validation.py:41,359-367 rejects seeds above the signed int64 maximum; the
# condition-noise generator is additionally seeded with seed + 1 (SG:condition_noise.py:177).
SGLANG_MAX_SEED = (1 << 63) - 1
IMGVID_COND_NOISE_DEFAULT = 0.999  # SG:denoise_loop.py:30
AUDIO_COND_NOISE_DEFAULT = 1.0  # SG:denoise_loop.py:32

# "model" merge layer defaults for job-request fields (dotted path -> value)
MODEL_DEFAULTS = MappingProxyType(
    {
        "sampling.steps": DEFAULT_STEPS,
        "sampling.video_shift": int(DEFAULT_VIDEO_SHIFT),
        "sampling.audio_shift": int(DEFAULT_AUDIO_SHIFT),
        "sampling.scheduler": SCHEDULER_ID,
        "output.fps": FPS,
    }
)

# --- runtime ------------------------------------------------------------------
RUNTIME_SGLANG = "sglang_h3"
RUNTIME_DIFFUSERS = "diffusers_h3"
# SGR:runtime/managers/memory_managers/layerwise_offload.py:1034-1038 clamps CUDA prefetch 0 -> 1
SGLANG_MIN_PREFETCH = 1
STREAMED_OFFLOADS = frozenset({"block", "leaf", "nvme"})

# --- layerwise hosting (SGR:runtime/managers/memory_managers/layerwise_offload.py) ----------------
# _plan_layer_hosting (:1279-1395): per layer pinned -> pageable copy -> stays on the checkpoint
# mapping when the copies do not fit; only contiguous views of the mapping stay mapped (:1504-1534).
# MappedLayerCourier (:686-785) stages mapped layers through two pinned slots sized by the largest
# mapped layer (+2 x 4 KiB per tensor for O_DIRECT, rounded up to 4 KiB); built only when a manager
# has mapped bytes (:2186-2232).  Each layer group (``layer_names``) gets its own manager/courier.
COURIER_SLOTS = 2
COURIER_ALIGN = 4096
# host_memory_budget.py:48-50 HOST_COPY_RESERVE_BYTES: pageable copies are made only while
# MemAvailable - 4 GiB still holds them (host_copies_would_not_fit, :231-241).
HOST_COPY_RESERVE_BYTES = 4 << 30
# SGR:runtime/models/dits/minimax_h3.py:2270-2274 layer_names = ["blocks", "token_refiner.blocks"];
# the native checkpoint stores q/k/v grouped per head, so qkv_proj is reordered at load and marked
# checkpoint_mapping_unsafe (:1072-1115) -> it never stays mapped (fsdp_load.py:758-811); on a
# shared CPU/GPU pool the copy goes to a HostSpill file instead (fsdp_load.py:336-346).
DIT_QKV_GROUPED_IN_CHECKPOINT = True  # SGR:configs/models/dits/minimax_h3.py:127 qkv_checkpoint_grouped

# --- AdaLN cache modes (SGR:runtime/models/dits/minimax_h3_adaln_cache.py) --------------------
# online/fixed drop every adaln_proj (blocks and final layer) from the DiT: the loader filters
# ``.adaln_proj.linear.`` keys (SGR:runtime/loader/component_loaders/transformer_loader.py:68-69,
# 422-471) and the blocks are built with adaln_proj=None (SGR:runtime/models/dits/minimax_h3.py:1586-1600).
# One (plan, timestep) page = 50 layers x 6*3*hidden + 2*hidden BF16 (:112-145, ~9.25 MiB).
ADALN_PAGE_BYTES = (DIT_NUM_LAYERS * DIT_ADALN_OUT + DIT_FINAL_ADALN_OUT) * 2
ADALN_GPU_PLANS = 64  # SGR:envs.py:344-350 SGLANG_DIFFUSION_MINIMAX_H3_ADALN_GPU_PLANS default
ADALN_MAX_PLAN_WIDTH = 4  # :48-53 MINIMAX_H3_ADALN_MAX_PLAN_WIDTH (the shim keeps the default)
# online: the rebuild slab is allocated once on the DiT device (:510-552) = 64 x 4 pages = 2.31 GiB;
# the host tier is a pinned slab of min(host_cache_bytes, MemAvailable - reserve) // page pages
# (:129-165, 316-364); the rebuild pass streams one adaln_proj layer at a time onto the device (:746-790).

__all__ = [name for name in dir() if name.isupper()]
