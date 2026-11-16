"""decode_audio: AudioVAE decode → float32 stereo WAV (L,R) at the native 32 kHz.

Upstream recipe (``S/stages/decoding.py:56-86, 316-364``): reverse-normalize
with the audio VAE stats, deterministic cuDNN context, audio VAE dtype autocast,
``audio_vae.decode`` on ``[2,32,T]`` (stereo channels are the decoder batch) →
``[2,1,L]``; channel 0 = L, channel 1 = R (``:199-225``).  The wire latent
``[1,2,T,32]`` is converted explicitly to the VAE-native ``[2,32,T]``.
"""

from __future__ import annotations

import time

from phasyn_h3.recipe.abi import media_types
from phasyn_h3.recipe.abi.stage import OutputFile, StageResult

from ..errors import InvalidStageInput
from .common import StageRun
from .decode_video import load_target_latents
from .normalization import ensure_vae_arch

NATIVE_SAMPLE_RATE = 32000


def run(run: StageRun) -> StageResult:
    import numpy as np
    import torch
    from phasyn_media.audio import write_wav_f32
    from sglang.multimodal_gen.runtime.managers.forward_context import set_forward_context
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.stages.decoding import (
        _deterministic_audio_decode_context,
        _reverse_normalize_latents,
    )
    from sglang.multimodal_gen.runtime.utils.precision import autocast_enabled_for_device, resolve_precision

    geometry = run.geometry
    latent, _meta = load_target_latents(run, "audio_latent")
    if list(latent.shape) != list(geometry["audio_latent_shape"]):
        raise InvalidStageInput(
            "AUDIO_LATENT_SHAPE", f"audio_latent {list(latent.shape)} ≠ geometry {geometry['audio_latent_shape']}"
        )
    run.progress("audio_decode", "items", 0, 1)
    with run.provider.use_component(run, "audio_vae") as audio_vae:
        server_args = run.provider.server_args()
        arch = ensure_vae_arch(run.plan, "audio_vae", server_args.pipeline_config.audio_vae_config)
        device = run.provider.torch_device()
        native = latent[0].permute(0, 2, 1).contiguous().to(device=device, dtype=torch.float32)  # [2,32,T]
        z = _reverse_normalize_latents(
            native, mean_values=arch.latents_mean, std_values=arch.latents_std, name="audio_vae"
        )
        dtype = resolve_precision(server_args, "audio_vae", precision_attr="audio_vae_precision")
        enabled = autocast_enabled_for_device(z, dtype, server_args.disable_autocast)
        autocast = (
            torch.autocast(device_type="cuda", dtype=dtype, enabled=enabled)
            if z.is_cuda
            else torch.autocast("cpu", enabled=False)
        )
        run.check_cancel()
        run.provider.backend.synchronize()
        started = time.perf_counter()
        with (
            torch.inference_mode(),
            _deterministic_audio_decode_context(),
            autocast,
            set_forward_context(current_timestep=0, attn_metadata=None),
        ):
            waveform = audio_vae.decode(z)
        run.provider.backend.synchronize()
        seconds = time.perf_counter() - started
        run.measure(compute_seconds=seconds)  # no audio-VAE formula in the cost model
        sample_rate = int(getattr(audio_vae, "sample_rate", 0))
        if sample_rate > 0 and waveform.ndim == 3:
            run.cost("decode_audio", work=int(waveform.shape[-1]) / sample_rate, unit="second", seconds=seconds)
    if waveform.ndim != 3 or int(waveform.shape[0]) != 2 or int(waveform.shape[1]) != 1:
        raise InvalidStageInput("AUDIO_WAVEFORM_SHAPE", f"audio VAE 輸出 {list(waveform.shape)}，預期 [2,1,L]")
    if sample_rate != NATIVE_SAMPLE_RATE:
        raise InvalidStageInput("AUDIO_SAMPLE_RATE", f"audio VAE sample_rate={sample_rate}，預期原生 32000")
    lr = (
        waveform[:, 0, :].float().transpose(0, 1).contiguous().cpu().numpy().astype(np.float32, copy=False)
    )  # [N,2] L,R
    if not np.isfinite(lr).all():
        raise InvalidStageInput("AUDIO_NONFINITE", "PCM 含 NaN/Inf；不輸出")
    path = run.output_dir / "pcm.wav"
    info = write_wav_f32(path, lr, sample_rate)
    run.outputs.append(OutputFile(name="pcm", path=path, media_type=media_types.PCM_WAV, kind="media"))
    run.fact(
        "AUDIO_DECODE",
        {
            "samples": int(lr.shape[0]),
            "channels": "L,R",
            "sample_rate": sample_rate,
            "seconds": round(lr.shape[0] / sample_rate, 6),
            "audio_info": repr(info)[:200],
        },
    )
    run.progress("audio_decode", "items", 1, 1)
    return run.result()


__all__ = ["run"]
