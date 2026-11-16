"""Media types of the files H3 stages write (bundle manifests, payloads and media tracks)."""

from __future__ import annotations

METADATA = "application/json"
TENSOR_BUNDLE = "application/vnd.phasyn.tensor-bundle+json"
CONDITIONING_BUNDLE = "application/vnd.phasyn.conditioning-bundle+json"
SAFETENSORS = "application/x-safetensors"
SIGMA_GRID = "application/vnd.phasyn.sigma-grid+safetensors"
VIDEO_TRACK = "video/mp4"
PCM_WAV = "audio/wav"

__all__ = ["CONDITIONING_BUNDLE", "METADATA", "PCM_WAV", "SAFETENSORS", "SIGMA_GRID", "TENSOR_BUNDLE", "VIDEO_TRACK"]
