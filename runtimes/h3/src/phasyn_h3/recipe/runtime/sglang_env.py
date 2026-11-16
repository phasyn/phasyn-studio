"""SGLang process environment for one component process (imports SGLang lazily).

Responsibilities:

* offline enforcement before any SGLang/HF import (no Hub downloads of weights
  or kernels — : FA3 kernels would otherwise come from the Hub);
* single-process distributed init that mirrors the pinned GPU worker
  (``runtime/managers/gpu_worker.py:392-443``) without its network listeners: the one-rank group
  meets over a file store instead of a TCP store (which listens on every interface), and NCCL
  bootstraps on the loopback interface;
* explicit ``ServerArgs`` with ``performance_mode="manual"`` (no auto-tuning), every
  offload knob set from the frozen profile, and a post-construction check that
  SGLang did not rewrite any of them (no silent fallback).
"""

from __future__ import annotations

import atexit
import contextlib
import os
import threading
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .acceleration import CONVROT_BACKEND, attention_plan, server_args_overrides
from .errors import UnsupportedCombination
from .policy import STAGE_PRIMARY_COMPONENT, StagePolicy

OFFLINE_ENV = {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "DO_NOT_TRACK": "1",
    # FA3 kernels: use the sgl-kernel build in the lock, never kernels-community
    # from the Hub (flash_attention_v3.py:31-69).
    "SGLANG_USE_SGL_FA3_KERNEL": "1",
    # Keep the upstream streaming temporal decode (klvae.py:59-65) explicit.
    "MINIMAX_H3_VAE_DECODER_STREAM_TEMPORAL_CAT": "1",
}
# srt Fp8Config reads SGLANG_FP8_IGNORED_LAYERS (srt/layers/quantization/fp8.py:283-287),
# Fp8LinearMethod SGLANG_FORCE_FP8_MARLIN (fp8.py:127-130), fp8_utils USE_TRITON_W8A8_FP8_KERNEL
FP8_OVERRIDE_ENV = ("SGLANG_FP8_IGNORED_LAYERS", "SGLANG_FORCE_FP8_MARLIN", "USE_TRITON_W8A8_FP8_KERNEL")
# NCCL opens its bootstrap sockets on the host's first non-loopback interface, also for a single rank, and
# the CPU-side (gloo) groups SGLang creates listen on the address the host name resolves to. A component is
# one process on one GPU, so both stay on loopback unless the runtime's own environment (the Node
# configuration) names another interface.
LOCAL_ONLY_ENV = {"NCCL_SOCKET_IFNAME": "lo", "GLOO_SOCKET_IFNAME": "lo"}


def apply_process_environment(workdir: Path) -> dict[str, str]:
    """Set offline/caching env vars; returns what was set (for diagnostics)."""
    applied = dict(OFFLINE_ENV)
    cache_root = workdir / "sglang-cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    applied["SGLANG_DIFFUSION_CACHE_ROOT"] = str(cache_root)
    applied["SGLANG_CACHE_DIR"] = str(cache_root)
    applied["TORCHINDUCTOR_CACHE_DIR"] = str(workdir / "inductor-cache")
    applied["TRITON_CACHE_DIR"] = str(workdir / "triton-cache")
    # convrot_int8 `auto` may silently take comfy_kitchen or leave layers BF16;
    # the shim only runs the JIT backend (acceleration.CONVROT_BACKEND)
    applied["SGLANG_DIFFUSION_CONVROT_INT8_BACKEND"] = CONVROT_BACKEND
    for key, value in applied.items():
        os.environ[key] = value
    os.environ.pop("MINIMAX_H3_VAE_DECODER_TEMPORAL_CAT_DTYPE", None)
    # PDD heads are installed only from the plan (phasyn_h3.recipe.runtime.pdd), never from the
    # environment: SGLang would load them into every DiT it builds (minimax_h3.py:2281-2283)
    os.environ.pop("SGLANG_DIFFUSION_MINIMAX_H3_PDD_HEADS", None)
    # the FP8 linear path comes from the profile only: these would silently add BF16 layers
    # (Fp8Config ignored_layers), switch to weight-only Marlin, or swap the GEMM kernel
    for name in FP8_OVERRIDE_ENV:
        os.environ.pop(name, None)
    from .toolchain import apply_jit_environment

    # nvcc/ninja for SGLang JIT kernels + one stable build cache (toolchain.py)
    toolchain = apply_jit_environment()
    applied["SGLANG_JIT_CACHE_DIR"] = toolchain.cache_dir
    if toolchain.cuda_home:
        applied["CUDA_HOME"] = os.environ.get("CUDA_HOME", toolchain.cuda_home)
    return applied


def _rendezvous_file(workdir: Path) -> Path:
    """A fresh file-store path for this process's one-rank group, removed when the process exits.

    ``torch.distributed`` needs a store to form a group. Its TCP store listens on every interface whatever
    address the URL names; the file store needs no socket at all.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    path = workdir / f"dist-rendezvous-{os.getpid()}-{uuid.uuid4().hex}"

    def remove() -> None:
        with contextlib.suppress(OSError):
            path.unlink()

    atexit.register(remove)
    return path


@dataclass(frozen=True)
class ServerArgsKey:
    model_path: str
    variant: str
    knobs_digest: str


class SglangSession:
    """Owns the process-wide SGLang state (distributed groups, ServerArgs)."""

    def __init__(self, workdir: Path) -> None:
        self.workdir = workdir
        self._lock = threading.Lock()
        self._initialized = False
        self._key: ServerArgsKey | None = None
        self.server_args: Any = None

    # -- process init ------------------------------------------------------
    def ensure_process(self, torch_device: Any) -> None:
        with self._lock:
            if self._initialized:
                return
            apply_process_environment(self.workdir)
            for key, value in LOCAL_ONLY_ENV.items():
                os.environ.setdefault(key, value)
            os.environ["LOCAL_RANK"] = "0"
            os.environ["RANK"] = "0"
            os.environ["WORLD_SIZE"] = "1"
            from sglang.multimodal_gen.runtime.distributed.parallel_state import (
                maybe_init_distributed_environment_and_model_parallel,
            )
            from sglang.multimodal_gen.runtime.platforms import current_platform

            if torch_device.type == "cuda":
                current_platform.set_device(torch_device)
            maybe_init_distributed_environment_and_model_parallel(
                tp_size=1,
                sp_size=1,
                cfg_degree=1,
                ulysses_degree=1,
                ring_degree=1,
                dp_size=1,
                distributed_init_method=f"file://{_rendezvous_file(self.workdir)}",
            )
            from sglang.srt.runtime_context import get_context, publish
            from sglang.srt.server_args import ServerArgs as SrtServerArgs

            if get_context()._server_args is None:
                publish(SrtServerArgs(model_path="dummy", tp_size=1), role="diffusion_gpu_worker")
            if torch_device.type == "cuda":
                from .upstream_patches import ensure_uuid_device_ids

                # NVML capability queries (H3 validate_server_args, attention resolvers)
                # must accept the actor's GPU-UUID CUDA_VISIBLE_DEVICES
                ensure_uuid_device_ids()
            self._initialized = True

    # -- server args -------------------------------------------------------
    @staticmethod
    def build_kwargs(
        *,
        model_path: str,
        variant: str,
        policy: StagePolicy,
        transformer_weights_path: str | None = None,
        adaln_cache_path: str | None = None,
    ) -> dict[str, Any]:
        """Explicit ServerArgs kwargs for the frozen policy (pure function)."""
        comps = policy.components
        layerwise: list[str] = []
        prefetch: dict[str, float] = {}
        resident: dict[str, float] = {}
        for name, comp in comps.items():
            if comp.layerwise:
                layerwise.append(name)
                prefetch[name] = float(comp.prefetch_depth)
                resident[name] = float(comp.resident_layers)
        transformer = comps.get("transformer")
        text_encoder = comps.get("text_encoder")
        vaes = [comps[c] for c in ("video_vae", "audio_vae") if c in comps]
        video_vae = comps.get("video_vae")
        # FP32 decode (official precision) needs the override at load: without it
        # the loader rounds the decoder linears to the pipeline's fp16 decode dtype
        # (vae_loader.py:267-311).  The fp16 recipe is the pipeline default, so it
        # gets no override -- an fp16 entry would also load the encoder in fp16.
        precisions = {"video_vae": "fp32"} if video_vae is not None and video_vae.compute_dtype == "fp32" else {}
        kwargs: dict[str, Any] = {
            "model_path": model_path,
            "model_variant": variant,
            "pipeline_class_name": "MiniMaxH3Pipeline",
            "performance_mode": "manual",
            "num_gpus": 1,
            "tp_size": 1,
            "sp_degree": 1,
            "ulysses_degree": 1,
            "ring_degree": 1,
            "dp_size": 1,
            "enable_cfg_parallel": False,
            "use_fsdp_inference": False,
            "attention_backend": policy.sglang_attention_backend,
            "enable_torch_compile": False,
            "enable_breakable_cuda_graph": False,
            "pin_cpu_memory": True,
            "dit_cpu_offload": bool(transformer.component_cpu_offload) if transformer else False,
            "dit_layerwise_offload": bool(transformer.layerwise) if transformer else False,
            "dit_offload_prefetch_size": float(transformer.prefetch_depth)
            if transformer and transformer.layerwise
            else 1.0,
            "dit_layerwise_resident_layers": float(transformer.resident_layers)
            if transformer and transformer.layerwise
            else 0.0,
            "dit_layerwise_residency_policy": "leading",
            "text_encoder_cpu_offload": bool(text_encoder.component_cpu_offload) if text_encoder else False,
            "vae_cpu_offload": any(v.component_cpu_offload for v in vaes),
            "layerwise_offload_components": layerwise or None,
            "layerwise_prefetch_size": prefetch,
            "layerwise_resident_layers": resident,
            "minimax_h3_adaln_online": policy.adaln_mode == "online",
            "minimax_h3_adaln_cache_path": adaln_cache_path if policy.adaln_mode == "fixed" else None,
            "minimax_h3_adaln_host_cache_gb": policy.adaln_host_cache_bytes / 1e9,
            "component_precisions": precisions,
            "warmup_mode": "off",
            # LoRA is attached by the shim (phasyn_h3.recipe.runtime.lora), never by SGLang's
            # pipeline entry point, which this shim does not build (pipeline.py:194-234)
            "lora_path": None,
        }
        if transformer_weights_path is not None:
            kwargs["transformer_weights_path"] = transformer_weights_path
        # online DiT quantization / approximate DiT attention (acceleration.py)
        kwargs.update(
            server_args_overrides(
                transformer_component=(policy.effective_profile.get("components") or {}).get("transformer"),
                attention=attention_plan(
                    policy.attention_provider_effective, policy.sglang_attention_backend, policy.effective_profile
                ),
                dit_stage=STAGE_PRIMARY_COMPONENT.get(policy.stage_kind) == "transformer",
            )
        )
        return kwargs

    @staticmethod
    def verify_server_args(server_args: Any, kwargs: Mapping[str, Any]) -> None:
        """Fail if SGLang rewrote any requested knob (no silent fallback)."""
        checked: tuple[str, ...] = (
            "performance_mode",
            "num_gpus",
            "tp_size",
            "use_fsdp_inference",
            "attention_backend",
            "enable_torch_compile",
            "dit_cpu_offload",
            "dit_layerwise_offload",
            "dit_offload_prefetch_size",
            "dit_layerwise_resident_layers",
            "text_encoder_cpu_offload",
            "vae_cpu_offload",
            "minimax_h3_adaln_online",
            "minimax_h3_adaln_cache_path",
            "lora_path",
            "component_precisions",
        )
        # acceleration knobs are verified only when the shim set them
        checked += tuple(
            name
            for name in (
                "quantization",
                "quantization_ignored_layers",
                "component_attention_backends",
                "attention_backend_config",
            )
            if name in kwargs
        )
        changed = []
        for name in checked:
            want = kwargs.get(name)
            have = getattr(server_args, name, None)
            if isinstance(want, str) and isinstance(have, str):
                same = want.lower() == have.lower()
            else:
                same = want == have
            if not same:
                changed.append(f"{name}: requested={want!r} effective={have!r}")
        if changed:
            raise UnsupportedCombination(
                "SGLANG_REWROTE_SERVER_ARGS",
                "釘版 SGLang 改寫了 profile 設定（不接受默默 fallback）：" + "; ".join(changed),
            )

    def server_args_for(self, key_kwargs: Mapping[str, Any]) -> Any:
        """(Re)build ServerArgs when the frozen knobs change; returns it."""
        from phasyn_h3.recipe.abi.canonical import canonical_digest

        key = ServerArgsKey(
            model_path=str(key_kwargs["model_path"]),
            variant=str(key_kwargs["model_variant"]),
            knobs_digest=canonical_digest({k: v for k, v in key_kwargs.items()}),
        )
        with self._lock:
            if self._key == key and self.server_args is not None:
                return self.server_args
            from sglang.multimodal_gen.runtime.server_args import ServerArgs, set_global_server_args

            server_args = ServerArgs.from_kwargs(**dict(key_kwargs))
            self.verify_server_args(server_args, key_kwargs)
            set_global_server_args(server_args)
            self.server_args = server_args
            self._key = key
            return server_args

    @property
    def key(self) -> ServerArgsKey | None:
        return self._key


__all__ = [
    "FP8_OVERRIDE_ENV",
    "LOCAL_ONLY_ENV",
    "OFFLINE_ENV",
    "ServerArgsKey",
    "SglangSession",
    "apply_process_environment",
]
