# SPDX-License-Identifier: Apache-2.0
# Uses the pinned SGLang MiniMax-H3 video VAE (de487f8039e06853b5f376fd5f068ea9d7c400bb,
# python/sglang/multimodal_gen/runtime/models/vaes/minimax_h3*.py and runtime/loader/utils.py),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
"""The training target: a clip's latents in the DiT's latent space, by the reference-video encode recipe.

Only the encoder half of the video VAE is built (the decoder is never constructed). Frames go through the
frame-streaming encode of :mod:`..stages.vae_frame_streaming` in FP32, the posterior is sampled under the
pinned scoped encode seed, cast to FP16 as the reference path does, and normalised with the checkpoint's
``latents_mean`` / ``latents_std``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..stages import vae_frame_streaming as fs


FRAMES_PER_PASS = 2


def _vae_config(vae_dir: Path) -> Any:
    from sglang.multimodal_gen.configs.models.vaes.minimax_h3_video import (  # type: ignore[import-untyped]
        MiniMaxH3VideoVAEConfig,
    )

    config = json.loads((vae_dir / "config.json").read_text(encoding="utf-8"))
    config.pop("_class_name", None)
    out = MiniMaxH3VideoVAEConfig()
    out.update_model_arch(config)
    out.post_init()
    return out


class TargetEncoder:
    """The FP32 encoder half of the H3 video VAE on one device."""

    def __init__(self, vae_dir: Path, device: Any) -> None:
        """Build the encoder from ``<vae_dir>/source/model.safetensors`` (encoder and quant_conv only)."""
        import torch
        from safetensors import safe_open
        from sglang.multimodal_gen.runtime.loader.utils import (  # type: ignore[import-untyped]
            finalize_loaded_model,
            initialize_model,
            load_model_state_dict,
        )
        from sglang.multimodal_gen.runtime.models.vaes.minimax_h3 import (  # type: ignore[import-untyped]
            MiniMaxH3VideoVAE,
        )
        from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae import klvae  # type: ignore[import-untyped]

        class _DecoderNotBuilt(torch.nn.Module):
            def __init__(self, *_a: Any, **_k: Any) -> None:
                super().__init__()

        config = _vae_config(vae_dir)
        saved = klvae.ViT3DDecoder
        klvae.ViT3DDecoder = _DecoderNotBuilt
        try:
            vae = initialize_model(
                MiniMaxH3VideoVAE,
                {"config": config},
                torch.float32,
                torch.device("meta"),
            )
        finally:
            klvae.ViT3DDecoder = saved
        for name in ("decoder", "post_quant_conv"):
            delattr(vae, name)
        loaded = {}
        with safe_open(
            str(vae_dir / "source" / "model.safetensors"), framework="pt", device="cpu"
        ) as handle:
            for name in handle.keys():  # noqa: SIM118 - safe_open is not a mapping
                if name.split(".", 1)[0] in ("encoder", "quant_conv"):
                    loaded[name] = handle.get_tensor(name)
        load_model_state_dict(vae, loaded, strict=True, assign=True)
        self.vae = finalize_loaded_model(vae).to(device)
        self.device = device
        raw = json.loads((vae_dir / "config.json").read_text(encoding="utf-8"))
        self.mean = torch.tensor(raw["latents_mean"], dtype=torch.float32).view(
            1, -1, 1, 1, 1
        )
        self.std = torch.tensor(raw["latents_std"], dtype=torch.float32).view(
            1, -1, 1, 1, 1
        )
        fs.check_encoder(self.vae)

    def encode(self, frames: Any) -> Any:
        """uint8 RGB frames [T, H, W, 3] (numpy) -> normalised latents [1, C, T', H/16, W/16] (CPU, FP32)."""
        import torch
        from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.klvae import (  # type: ignore[import-untyped]
            DiagonalGaussianDistribution,
        )
        from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.keyframe_encoding import (  # type: ignore[import-untyped]
            minimax_h3_scoped_encode_rng,
        )
        from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (  # type: ignore[import-untyped]
            MINIMAX_H3_REFERENCE_VIDEO_ENCODE_SEED,
        )

        config = fs.FrameStreamingConfig(
            frames_per_pass=FRAMES_PER_PASS, precision="fp32"
        )
        with (
            torch.inference_mode(),
            minimax_h3_scoped_encode_rng(
                MINIMAX_H3_REFERENCE_VIDEO_ENCODE_SEED, self.device
            ),
        ):
            moments, _facts = fs.stream_moments(
                self.vae, frames, config, device=self.device
            )
            z = (
                DiagonalGaussianDistribution(moments)
                .sample()
                .squeeze(0)
                .contiguous()
                .to(torch.float16)
            )
            del moments
        z = z.cpu()
        z = z[None] if z.dim() == 4 else z  # noqa: PLR2004 - [C, T, H, W] without batch
        return ((z.float() - self.mean) / self.std).contiguous()

    def close(self) -> None:
        """Release the encoder's device memory."""
        import torch

        del self.vae
        torch.cuda.empty_cache()


__all__ = ["TargetEncoder"]
