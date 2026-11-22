"""Architecture facts for the ETA estimator (pure; ``describe`` reports them as ``facts.cost_model``).

The estimator predicts each stage's work from the request and multiplies it by a time per unit that
the controller fits from recordings. These facts let it count the work for the model a component
really serves: FLOP coefficients from the checkpoint configs (``transformer/config.json``,
``text_encoder/config.json``), the Qwen3-VL processor limits from the processor configs, and the
pinned runtime's geometry rules (``constants``). Nothing here is a measured time or throughput.

The keys are the wire names the Studio estimator reads (``flops_per_row`` …). A value that cannot be
read from the model's files is left out; the client then falls back to its architecture defaults and
says so.
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from typing import Any

from . import constants


# The values the pinned configs hold (H3:FL2VA/transformer/config.json, H3:FL2VA/text_encoder/config.json)
PINNED_TRANSFORMER_CONFIG: Mapping[str, Any] = {
    "num_layers": constants.DIT_NUM_LAYERS,
    "hidden_size": constants.DIT_HIDDEN,
    "num_attention_heads": constants.DIT_HEADS,
    "attention_head_dim": constants.DIT_HEAD_DIM,
    "ffn_hidden_size": constants.DIT_FFN,
}
PINNED_TEXT_ENCODER_CONFIG: Mapping[str, Any] = {
    "text_config": {
        "num_hidden_layers": constants.TEXT_CHECKPOINT_LAYERS,
        "hidden_size": constants.TEXT_HIDDEN,
        "num_attention_heads": constants.TEXT_HEADS,
        "num_key_value_heads": constants.TEXT_KV_HEADS,
        "head_dim": constants.TEXT_HEAD_DIM,
        "intermediate_size": constants.TEXT_FFN,
    }
}


def _positive_int(config: Mapping[str, Any], key: str) -> int:
    value = config[key]
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{key} must be a positive integer, got {value!r}")
    return value


def dit_flop_coefficients(config: Mapping[str, Any]) -> dict[str, int]:
    """DiT FLOPs per sampling step = ``flops_per_row·N + flops_per_row_squared·N²`` over N packed rows.

    Per block and row: q/k/v ``3·H·A``, out ``A·H``, gated MLP in ``H·2F`` and out ``F·H`` multiply-adds
    (×2 FLOPs), attention ``4·A`` per row pair; ``A`` = heads × head_dim. The token refiner, embeddings
    and AdaLN are not counted (``measure.dit_flop`` uses the same model).
    """
    layers = _positive_int(config, "num_layers")
    hidden = _positive_int(config, "hidden_size")
    attention = _positive_int(config, "num_attention_heads") * _positive_int(
        config, "attention_head_dim"
    )
    ffn = _positive_int(config, "ffn_hidden_size")
    block = (
        hidden * 3 * attention + attention * hidden + hidden * 2 * ffn + ffn * hidden
    )
    return {
        "flops_per_row": 2 * layers * block,
        "flops_per_row_squared": 4 * layers * attention,
    }


def text_encoder_flop_coefficients(
    config: Mapping[str, Any], *, tap_layer: int = constants.TEXT_SELECTED_LAYER
) -> dict[str, int]:
    """Qwen3-VL FLOPs for S conditioning tokens = ``flops_per_token·S + flops_per_token_squared·S²``.

    Only the layers up to the conditioning tap run (``tap_layer``, the pinned runtime's selected layer).
    Per layer and token: q ``H·A``, k and v ``2·H·kv·d``, out ``A·H``, SwiGLU MLP ``3·H·F`` multiply-adds
    (×2), causal attention ``2·A`` per token pair. The vision tower is not counted.
    ``hidden_size`` sizes the BF16 conditioning the encoder hands on.
    """
    text = config.get("text_config")
    if not isinstance(text, Mapping):
        text = config
    layers = min(int(tap_layer), _positive_int(text, "num_hidden_layers"))
    hidden = _positive_int(text, "hidden_size")
    heads = _positive_int(text, "num_attention_heads")
    head_dim = (
        _positive_int(text, "head_dim") if "head_dim" in text else hidden // heads
    )
    attention = heads * head_dim
    kv = _positive_int(text, "num_key_value_heads") * head_dim
    ffn = _positive_int(text, "intermediate_size")
    layer = hidden * attention + 2 * hidden * kv + attention * hidden + 3 * hidden * ffn
    return {
        "flops_per_token": 2 * layers * layer,
        "flops_per_token_squared": 2 * layers * attention,
        "hidden_size": hidden,
    }


def geometry_facts() -> dict[str, Any]:
    """The pinned runtime's geometry rules the estimator needs to count rows, tokens and pixels."""
    return {
        "fps": constants.FPS,
        "frame_group": constants.FRAME_GROUP,
        "frame_offset": constants.FRAME_OFFSET,
        "latent_per_group": constants.LATENT_T_GROUP,
        "latent_head": constants.LATENT_T_HEAD,
        "token_stride": constants.TOKEN_STRIDE,
        "audio_latent_hz": constants.AUDIO_LATENT_HZ,
        "audio_channels": constants.AUDIO_CHANNELS,
        "audio_sample_rate": constants.AUDIO_SAMPLE_RATE,
        "reference_video_short_edge": constants.BASE_SHORT_EDGE,
        "reference_video_max_pixels": constants.MAX_PIXELS,
        "canvas_multiple": constants.CANVAS_MULTIPLE,
        "reference_image_short_edge": constants.REFERENCE_IMAGE_SHORT_EDGE,
        "reference_image_multiple": constants.REFERENCE_IMAGE_MULTIPLE,
        "vae_spatial_factor": constants.VAE_SPATIAL_FACTOR,
        "vae_temporal_factor": constants.VAE_TEMPORAL_FACTOR,
        "vae_clip_length": constants.VAE_CLIP_LENGTH,
        "dit_patch_size": list(constants.PATCH_SIZE),
    }


def _pixel_limits(config: Mapping[str, Any]) -> tuple[int | None, int | None]:
    """(min, max) pixels of a Qwen3-VL processor config: ``size.shortest_edge`` / ``size.longest_edge`` (pixel counts in the Qwen2-VL family) or the older ``min_pixels`` / ``max_pixels``."""
    size = config.get("size")
    low = size.get("shortest_edge") if isinstance(size, Mapping) else None
    high = size.get("longest_edge") if isinstance(size, Mapping) else None
    low = config.get("min_pixels", low)
    high = config.get("max_pixels", high)

    def ok(value: Any) -> int | None:
        return (
            value
            if isinstance(value, int) and not isinstance(value, bool) and value > 0
            else None
        )

    return ok(low), ok(high)


def qwen_processor_facts(
    image_config: Mapping[str, Any] | None, video_config: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Qwen3-VL processor facts from ``preprocessor_config.json`` / ``video_preprocessor_config.json``.

    ``qwen_factor`` = patch × merge (pixels per vision-token side); keys that are missing or invalid in
    the files are left out. The sampling rate of reference videos and the two wrap tokens around each
    vision block are the pinned runtime's.
    """
    facts: dict[str, Any] = {
        "qwen_sample_fps": constants.QWEN_VIDEO_SAMPLE_FPS,
        "qwen_wrap_tokens": constants.QWEN_VISION_WRAP_TOKENS,
    }
    if image_config:
        patch, merge = image_config.get("patch_size"), image_config.get("merge_size")
        if all(
            isinstance(v, int) and not isinstance(v, bool) and v > 0
            for v in (patch, merge)
        ):
            facts["qwen_factor"] = int(patch) * int(merge)  # type: ignore[arg-type]
        temporal = image_config.get("temporal_patch_size")
        if (
            isinstance(temporal, int)
            and not isinstance(temporal, bool)
            and temporal > 0
        ):
            facts["qwen_temporal_patch"] = temporal
        low, high = _pixel_limits(image_config)
        if low is not None:
            facts["qwen_image_min_pixels"] = low
        if high is not None:
            facts["qwen_image_max_pixels"] = high
    if video_config:
        low, high = _pixel_limits(video_config)
        if low is not None:
            facts["qwen_video_min_pixels"] = low
        if high is not None:
            facts["qwen_video_max_pixels"] = high
    return facts


def dit_cost_model(transformer_config: Mapping[str, Any] | None) -> dict[str, Any]:
    """``facts.cost_model`` of a DiT component (FLOP coefficients only when the config was readable)."""
    facts: dict[str, Any] = {
        "row_align": constants.PACKED_ALIGNMENT,
        **geometry_facts(),
    }
    if transformer_config is not None:
        with contextlib.suppress(KeyError, TypeError, ValueError):
            facts.update(dit_flop_coefficients(transformer_config))
    return facts


def text_encoder_cost_model(
    text_encoder_config: Mapping[str, Any] | None,
    image_processor_config: Mapping[str, Any] | None = None,
    video_processor_config: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """``facts.cost_model`` of a text-encoder (conditioning) component."""
    facts: dict[str, Any] = {
        **geometry_facts(),
        **qwen_processor_facts(image_processor_config, video_processor_config),
    }
    if text_encoder_config is not None:
        with contextlib.suppress(KeyError, TypeError, ValueError):
            facts.update(text_encoder_flop_coefficients(text_encoder_config))
    return facts


__all__ = [
    "PINNED_TEXT_ENCODER_CONFIG",
    "PINNED_TRANSFORMER_CONFIG",
    "dit_cost_model",
    "dit_flop_coefficients",
    "geometry_facts",
    "qwen_processor_facts",
    "text_encoder_cost_model",
    "text_encoder_flop_coefficients",
]
