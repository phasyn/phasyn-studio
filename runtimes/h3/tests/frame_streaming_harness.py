"""Test support for the frame-streaming reference-video encode (runtime tuple only; no SGLang ServerArgs needed).

* :func:`stage_module` — a pinned MiniMax-H3 stage helper module (``reference_encoding``, ``keyframe_encoding``,
  ``packed_tokens``), importable without a GPU: the ``pipelines_core.stages`` package ``__init__`` chain imports the
  whole DiT stack and a kernel package that queries the device at import, so its packages are stood in by empty
  namespace modules (only when the real package is not loaded); the helper modules themselves are the real ones.
* :func:`build_encoder` — the encode half of ``MiniMaxH3VideoVAE`` the way ``loaders._load_video_vae_half`` builds it
  for ``encode_only``: meta construction, the decoder half deleted unread, ``encoder.*`` and ``quant_conv.*`` read
  from the checkpoint with strict state loading, ``finalize_loaded_model``.  The ViT decoder is not constructed at all
  (building its attention needs SGLang's global ServerArgs); it is deleted before anything is read anyway.
* :func:`random_encoder` — a small ``AutoencoderKLLegacy`` (same classes, fewer channels) with random weights, for
  the structure of the streaming without the real checkpoint.
* :func:`reference_frames` — a crop of a deterministic synthetic uint8 video, or of a real one.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path
from typing import Any


H3_STAGES = "sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3"


def stage_module(name: str) -> Any:
    import sglang.multimodal_gen as mg  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.

    root = Path(mg.__path__[0]) / "runtime"
    parts = ["pipelines_core", "stages", "model_specific_stages", "minimax_h3"]
    for depth in range(1, len(parts) + 1):
        full = "sglang.multimodal_gen.runtime." + ".".join(parts[:depth])
        if full not in sys.modules:
            stub = types.ModuleType(full)
            stub.__path__ = [str(root.joinpath(*parts[:depth]))]
            sys.modules[full] = stub
    return importlib.import_module(f"{H3_STAGES}.{name}")


def vae_config(vae_dir: Path) -> Any:
    from sglang.multimodal_gen.configs.models.vaes.minimax_h3_video import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        MiniMaxH3VideoVAEConfig,
    )

    config = json.loads((vae_dir / "config.json").read_text(encoding="utf-8"))
    config.pop("_class_name", None)
    out = MiniMaxH3VideoVAEConfig()
    out.update_model_arch(config)
    out.post_init()
    return out


def build_encoder(vae_dir: Path, device: Any = "cpu") -> tuple[Any, Any]:
    """(the FP32 encode half on ``device``, its arch config)."""
    import torch
    from safetensors import safe_open
    from sglang.multimodal_gen.runtime.loader.utils import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        finalize_loaded_model,
        initialize_model,
        load_model_state_dict,
    )
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3 import MiniMaxH3VideoVAE  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae import klvae  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.

    class _DecoderNotBuilt(torch.nn.Module):
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            super().__init__()

    config = vae_config(vae_dir)
    saved = klvae.ViT3DDecoder
    klvae.ViT3DDecoder = _DecoderNotBuilt
    try:
        vae = initialize_model(
            MiniMaxH3VideoVAE, {"config": config}, torch.float32, torch.device("meta")
        )
    finally:
        klvae.ViT3DDecoder = saved
    for name in ("decoder", "post_quant_conv"):
        delattr(vae, name)
    loaded = {}
    with safe_open(
        str(vae_dir / "source" / "model.safetensors"), framework="pt", device="cpu"
    ) as handle:
        for name in handle.keys():  # noqa: SIM118 (safe_open is not a mapping)
            if name.split(".", 1)[0] in ("encoder", "quant_conv"):
                loaded[name] = handle.get_tensor(name)
    load_model_state_dict(vae, loaded, strict=True, assign=True)
    vae = finalize_loaded_model(vae)
    del loaded
    return vae.to(torch.device(device)), config.arch_config


def random_encoder(seed: int = 0, *, ch: int = 32) -> Any:
    """A small ``AutoencoderKLLegacy`` encode half (the H3 encoder classes and config shape; ``ch`` channels, a multiple
    of the 32 GroupNorm groups)."""
    import torch
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae import klvae

    class _DecoderNotBuilt(torch.nn.Module):
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            super().__init__()

    saved = klvae.ViT3DDecoder
    klvae.ViT3DDecoder = _DecoderNotBuilt
    try:
        torch.manual_seed(seed)
        vae = klvae.AutoencoderKLLegacy(
            in_channels=3,
            ch=ch,
            embed_dim=4,
            z_channels=4,
            use_3d_conv=True,
            ch_mult=[1, 2, 2, 4, 4, 8],
            space_down=[2, 2, 2, 2, 1, 1],
            time_down=[1, 2, 2, 1, 1, 1],
            padding_mode="reflect",
            use_t_isolated_gn=True,
            causal_encoder=True,
            use_vit_decoder=True,
            clip_length=17,
            token_drop=3,
            encoder_tiling=True,
            tile_size=64,
            tile_overlap_min=32,
        )
    finally:
        klvae.ViT3DDecoder = saved
    for name in ("decoder", "post_quant_conv"):
        delattr(vae, name)
    with (
        torch.no_grad()
    ):  # non-trivial norm affine parameters (the defaults are ones and zeros)
        for module in vae.encoder.modules():
            if isinstance(module, torch.nn.GroupNorm):
                module.weight.uniform_(0.5, 1.5)
                module.bias.uniform_(-0.2, 0.2)
    return vae.eval()


def synthetic_frames(frames: int, height: int, width: int, seed: int = 0) -> Any:
    """A deterministic uint8 video ``[T, H, W, 3]`` with structure in space and time (synthetic test data)."""
    import numpy as np  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    rng = np.random.default_rng(seed)
    t = np.arange(frames)[:, None, None, None]
    y = np.arange(height)[None, :, None, None]
    x = np.arange(width)[None, None, :, None]
    c = np.arange(3)[None, None, None, :]
    wave = (
        127.5
        + 60 * np.sin(0.11 * x + 0.07 * y + 0.5 * t + c)
        + 40 * np.cos(0.05 * x * (c + 1) - 0.3 * t)
    )
    noise = rng.normal(0.0, 12.0, size=(frames, height, width, 3))
    return np.clip(wave + noise, 0, 255).astype(np.uint8)


__all__ = [
    "build_encoder",
    "random_encoder",
    "stage_module",
    "synthetic_frames",
    "vae_config",
]
