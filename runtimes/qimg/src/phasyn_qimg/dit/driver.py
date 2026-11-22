# SPDX-License-Identifier: Apache-2.0
# Portions adapted from diffusers 578c9b2 (src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py,
# QwenImage21Pipeline.__call__; src/diffusers/schedulers/scheduling_flow_match_euler_discrete.py, step),
# Copyright 2026 Qwen-Image Team, The HuggingFace Team and Copyright 2025 Stability AI, Katherine Crowson
# and The HuggingFace Team; modified by the Phasyn Studio authors (denoise loop extracted from the pipeline
# into standalone functions with an observer for cancellation, timing and previews).
"""Qwen-Image 2.1 denoise driver: reproduces the denoise path of ``QwenImage21Pipeline.__call__``.

Step by step, as in the pipeline:

- Initial noise: CPU ``torch.Generator(seed)`` and ``torch.randn((B,1,C,H,W), dtype=prompt_embeds.dtype)`` on the
  CPU, then moved to the device (the CPU-generator path of ``randn_tensor``), packed with
  ``view(B,C,H·W).transpose(1,2)`` (not made contiguous).
- Reference latents (already normalized and packed) are prepended to the target latents;
  ``img_shapes`` = each reference (1,h,w) followed by the target (1,H,W).
- ``image_pad_mask`` gets the target's image slots appended (one slot per 2×2 latent tokens).
- The prefix (text + references) is modulated at t=0 (``causal_condition``): step 0 runs with
  ``kv_cache_mode="extract"`` to fill the KV cache, later steps use ``"cached"`` and only recompute target
  tokens. With CFG each branch has its own cache.
- CFG: ``neg + s·(cond - neg)`` when guidance > 1.
- FlowMatch Euler: ``sample.float() + (sigma[i+1] - sigma[i])·v``, cast back to the dtype of ``v``; sigma lives on the
  device (as in the scheduler).

Every tensor operation keeps the pipeline's order, dtype and layout, so the same inputs on the same device
give bit-identical results (keep the order when changing this).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .. import VAE_SCALE_FACTOR
from ..latents import latent_hw
from .schedule import Schedule


IMG_TOKENS_PER_SLOT = 4


@dataclass
class Branch:
    """一個 CFG 分支的條件（裝置上的 tensor）。``mask`` 為 None 表示沒有 padding（與 encode_prompt 相同語意）."""

    embeds: Any
    image_pad_mask: Any
    mask: Any = None


@dataclass
class DenoiseRequest:
    """Inputs, schedule and guidance for a single denoising pass."""

    width: int
    height: int
    seed: int
    guidance: float
    schedule: Schedule
    positive: Branch
    negative: Branch | None = None
    ref_latents: Any = None
    ref_shapes: list[tuple[int, int]] = field(default_factory=list)

    @property
    def cfg(self) -> bool:
        """Report whether classifier-free guidance is required."""
        return self.guidance > 1


class StepObserver(Protocol):
    """Callbacks used to record an individual denoising step."""

    def check_cancelled(self) -> None:
        """Raise if the caller cancelled the current job."""
        ...

    def step_start(self, index: int) -> None:
        """Begin measurements for this denoising step."""
        ...

    def forward_done(self, index: int, branch: str) -> None:
        """Record the completion of a denoiser forward pass."""
        ...

    def step_end(self, index: int, *, sigma: float, forwards: int) -> None:
        """Finish measurements for this denoising step."""
        ...

    def wants_preview(self, index: int) -> bool:
        """Report whether this step should publish a preview."""
        ...

    def preview(self, index: int, x0: Callable[[], Any]) -> None:
        """Publish the intermediate preview for this step."""
        ...


@dataclass
class DenoiseResult:
    """The generated latents and measured per-branch work."""

    latents: Any
    kv_cache: bool
    forwards: int
    noise_dtype: str
    img_shapes: list[tuple[int, int, int]]


def initial_noise(  # noqa: PLR0913 - Keep the published runtime API.
    *, seed: int, channels: int, height: int, width: int, dtype: Any, device: Any
) -> Any:
    """``randn_tensor(shape, generator=torch.Generator("cpu").manual_seed(seed), device, dtype)`` 的 CPU 路徑+打包."""
    import torch

    h, w = latent_hw(width, height)
    generator = torch.Generator("cpu").manual_seed(int(seed))
    shape = (1, 1, channels, h, w)
    latents = torch.randn(
        shape, generator=generator, device="cpu", dtype=dtype, layout=torch.strided
    ).to(device)
    return latents.view(1, channels, h * w).transpose(1, 2)


def _append_target_slots(mask: Any, target_tokens: int) -> Any:
    import torch

    return torch.cat(
        [mask, mask.new_ones(mask.shape[0], target_tokens // IMG_TOKENS_PER_SLOT)],
        dim=1,
    )


def _schedule_tensors(schedule: Schedule, device: Any) -> tuple[Any, Any]:
    """同 ``set_timesteps``：``from_numpy(sigmas).to(float32, device)``、``timesteps = sigmas * N``、terminal 0."""
    import torch

    sigmas = torch.from_numpy(schedule.sigmas).to(dtype=torch.float32, device=device)
    timesteps = sigmas * schedule.num_train_timesteps
    sigmas = torch.cat([sigmas, torch.zeros(1, device=sigmas.device)])
    return sigmas, timesteps


def denoise(
    transformer: Any,
    request: DenoiseRequest,
    *,
    device: Any,
    observer: StepObserver | None = None,
    use_kv_cache: bool = True,
) -> DenoiseResult:
    """單次 invoke 內的完整去噪迴圈；回傳最後一次 Euler 更新後的打包 latent（正規化空間）."""
    import torch

    if request.cfg and request.negative is None:
        raise ValueError("guidance > 1 需要負向條件（CFG 分支）")
    dtype, latents = _initial_latents(transformer, request, device)
    ref = request.ref_latents
    img_shapes = [
        [
            *[(1, int(h), int(w)) for h, w in request.ref_shapes],
            (1, request.height // VAE_SCALE_FACTOR, request.width // VAE_SCALE_FACTOR),
        ]
    ]
    sigmas, timesteps = _schedule_tensors(request.schedule, device)
    target_tokens = int(latents.shape[1])
    pos_mask = _append_target_slots(request.positive.image_pad_mask, target_tokens)
    neg = request.negative if request.cfg else None
    neg_mask = (
        _append_target_slots(neg.image_pad_mask, target_tokens)
        if neg is not None
        else None
    )
    cache_enabled, cond_cache, neg_cache = _branch_caches(
        transformer, neg, use_kv_cache=use_kv_cache
    )
    attention_kwargs: dict[str, Any] = {}
    forwards = 0

    with torch.inference_mode():
        for i, t in enumerate(timesteps):
            if observer is not None:
                observer.check_cancelled()
                observer.step_start(i)
            kv_mode = (
                "extract"
                if (cache_enabled and i == 0)
                else ("cached" if cache_enabled else None)
            )
            latent_model_input = latents
            if ref is not None:
                latent_model_input = torch.cat([ref, latents], dim=1)
            timestep = t.expand(latents.shape[0]).to(latents.dtype)
            with transformer.cache_context("cond"):
                noise_pred = transformer(
                    hidden_states=latent_model_input,
                    timestep=timestep / 1000,
                    encoder_hidden_states=request.positive.embeds,
                    encoder_hidden_states_mask=request.positive.mask,
                    img_shapes=img_shapes,
                    img_mask=pos_mask,
                    attention_kwargs=attention_kwargs,
                    kv_cache=cond_cache,
                    kv_cache_mode=kv_mode,
                    return_dict=False,
                )[0]
            noise_pred = noise_pred[:, -latents.size(1) :]
            forwards += 1
            if observer is not None:
                observer.forward_done(i, "cond")
            if neg is not None:
                with transformer.cache_context("uncond"):
                    neg_noise_pred = transformer(
                        hidden_states=latent_model_input,
                        timestep=timestep / 1000,
                        encoder_hidden_states=neg.embeds,
                        encoder_hidden_states_mask=neg.mask,
                        img_shapes=img_shapes,
                        img_mask=neg_mask,
                        attention_kwargs=attention_kwargs,
                        kv_cache=neg_cache,
                        kv_cache_mode=kv_mode,
                        return_dict=False,
                    )[0]
                neg_noise_pred = neg_noise_pred[:, -latents.size(1) :]
                forwards += 1
                if observer is not None:
                    observer.forward_done(i, "uncond")
                noise_pred = neg_noise_pred + request.guidance * (
                    noise_pred - neg_noise_pred
                )

            sigma = sigmas[i]
            sigma_next = sigmas[i + 1]
            if observer is not None and observer.wants_preview(i):
                _submit_x0(observer, i, latents, noise_pred, sigma)
            sample = latents.to(torch.float32)
            dt = sigma_next - sigma
            prev_sample = sample + dt * noise_pred
            latents = prev_sample.to(noise_pred.dtype)
            if observer is not None:
                observer.step_end(
                    i,
                    sigma=float(request.schedule.sigmas[i]),
                    forwards=2 if neg is not None else 1,
                )

    return DenoiseResult(
        latents=latents,
        kv_cache=cache_enabled,
        forwards=forwards,
        noise_dtype=str(dtype).replace("torch.", ""),
        img_shapes=[(int(f), int(h), int(w)) for f, h, w in img_shapes[0]],
    )


def _initial_latents(
    transformer: Any, request: DenoiseRequest, device: Any
) -> tuple[Any, Any]:
    embeds = request.positive.embeds
    dtype = embeds.dtype
    channels = int(transformer.config.in_channels)
    latents = initial_noise(
        seed=request.seed,
        channels=channels,
        height=request.height,
        width=request.width,
        dtype=dtype,
        device=device,
    )
    return dtype, latents


def _branch_caches(
    transformer: Any, neg: Any, *, use_kv_cache: bool
) -> tuple[bool, Any, Any]:
    from diffusers.models.transformers.transformer_qwenimage21 import QwenImage21KVCache

    num_blocks = len(transformer.transformer_blocks)
    cache_enabled = bool(use_kv_cache and transformer.config.causal_condition)
    cond_cache = QwenImage21KVCache(num_blocks) if cache_enabled else None
    neg_cache = (
        QwenImage21KVCache(num_blocks) if cache_enabled and neg is not None else None
    )
    return cache_enabled, cond_cache, neg_cache


def _submit_x0(
    observer: StepObserver, i: int, latents: Any, noise_pred: Any, sigma: Any
) -> None:
    import torch

    pre_step, model_output, step_sigma = latents, noise_pred, sigma

    def x0(s: Any = pre_step, v: Any = model_output, sg: Any = step_sigma) -> Any:
        # x0 estimate for previews: x0 = sample - sigma * v (read-only; sampling state is unchanged)
        sg32 = torch.as_tensor(sg, device=s.device, dtype=torch.float32)
        return s[:1].detach().float() - sg32 * v[:1].detach().float()

    observer.preview(i, x0)


__all__ = [
    "Branch",
    "DenoiseRequest",
    "DenoiseResult",
    "StepObserver",
    "denoise",
    "initial_noise",
]
