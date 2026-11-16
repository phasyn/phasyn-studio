"""Qwen-Image 2.1 image generation components (phasyn_qimg).

| provider_id          | device     | inputs → outputs                                                        |
|----------------------|------------|-------------------------------------------------------------------------|
| ``qimg.prepare``     | cpu        | references (≤ 4) + mask → ``qimg.prepared.v1``                           |
| ``qimg.conditioning``| cuda/cpu   | prompt + negative_prompt + prepared → ``qimg.conditioning.v1``           |
| ``qimg.vae_encode``  | cuda/cpu   | prepared → ``qimg.ref_latents.v1``                                       |
| ``qimg.dit``         | cuda       | conditioning + ref_latents → ``qimg.latent.v1`` (``phasyn_qimg.dit``)    |
| ``qimg.vae_decode``  | cuda/cpu   | latent → ``image.asset.v1`` (RGBA PNG)                                   |
| ``image.compose``    | cpu        | image + prepared → image (final RGBA PNG) + image_white (white-matte RGB)|

Components exchange files only: a bundle (``phasyn_qimg.bundle``) is a small JSON document plus one safetensors
payload attachment. This module only holds constants; torch/diffusers/transformers/PIL are imported lazily inside
the providers' load()/invoke(), so the package can be installed where diffusers is absent (for example a runtime
that only serves the text encoder).

Qwen-Image 2.1 weights are licensed under the Qwen Research License (non-commercial research use only) and are
not distributed with this repository.
"""

from __future__ import annotations

# TypedValue type_id ---------------------------------------------------------
TYPE_PROMPT = "text.prompt.v1"
TYPE_IMAGE_FILE = "media.image.v1"
TYPE_REFERENCES = "qimg.references.v1"
TYPE_PREPARED = "qimg.prepared.v1"
TYPE_CONDITIONING = "qimg.conditioning.v1"
TYPE_REF_LATENTS = "qimg.ref_latents.v1"
TYPE_LATENT = "qimg.latent.v1"
TYPE_IMAGE_ASSET = "image.asset.v1"

# bundle kind（bundle 文件的 kind 欄位；consumer 依此拒絕接錯的檔案）------------------
KIND_PREPARED = "qimg_prepared"
KIND_CONDITIONING = "qimg_conditioning"
KIND_REF_LATENTS = "qimg_ref_latents"
KIND_LATENT = "qimg_latent"
KIND_BY_TYPE = {
    TYPE_PREPARED: KIND_PREPARED,
    TYPE_CONDITIONING: KIND_CONDITIONING,
    TYPE_REF_LATENTS: KIND_REF_LATENTS,
    TYPE_LATENT: KIND_LATENT,
}

# Qwen-Image 2.1 的幾何：VAE 空間壓縮 16；一個 Qwen3-VL 影像 slot＝2×2 latent token（32×32 px）
VAE_SCALE_FACTOR = 16
SIZE_MULTIPLE = 32

__all__ = [
    "KIND_BY_TYPE",
    "KIND_CONDITIONING",
    "KIND_LATENT",
    "KIND_PREPARED",
    "KIND_REF_LATENTS",
    "SIZE_MULTIPLE",
    "TYPE_CONDITIONING",
    "TYPE_IMAGE_ASSET",
    "TYPE_IMAGE_FILE",
    "TYPE_LATENT",
    "TYPE_PREPARED",
    "TYPE_PROMPT",
    "TYPE_REFERENCES",
    "TYPE_REF_LATENTS",
    "VAE_SCALE_FACTOR",
]
