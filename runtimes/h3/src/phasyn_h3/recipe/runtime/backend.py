"""Device backend: facts, memory telemetry and release primitives.

``DeviceBackend`` is the seam between the torch-free provider logic and CUDA.
``TorchCudaBackend`` imports torch lazily (inside the actor only); tests use a
fake.  Nothing here allocates device memory except what callers ask for.
"""

from __future__ import annotations

import contextlib
import gc
import hashlib
import os
import platform
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol

from phasyn_components.upstream import library_versions

from . import PROVIDER_ID, PROVIDER_VERSION, SGLANG_SOURCE_REVISION
from ._observations import RuntimeObservation


KERNEL_PACKAGES = (
    "torch",
    "torchvision",
    "torchaudio",
    "triton",
    "sglang",
    "sglang-kernel",
    "flashinfer-python",
    "flash-attn-4",
    "flash-attn",
    "quack-kernels",
    "tilelang",
    "nvidia-cutlass-dsl",
    "cuda-tile",
    "cuda-toolkit",
    "cuda-bindings",
    "nvidia-cudnn-cu13",
    "nvidia-nccl-cu13",
    "nvidia-cublas",
    "bitsandbytes",
    "transformers",
    "diffusers",
    "cache-dit",
    "safetensors",
    "st-attn",
    "vsa",
    "xformers",
    "sageattention",
    "transformer-engine",
    "nvidia-ml-py",
)


# A resident (offload=none) DiT starts on the device, so SGLang materializes the whole BF16
# checkpoint there before any quantization (transformer_loader.py:54-65, 484-498): the native H3
# DiT without AdaLN projections is ~40 GB in BF16.  Block offload keeps the checkpoint on the CPU
# and the runtime quantizes FP8 one layer at a time (fp8_layerwise_quant.v1).
H3_DIT_BF16_DEVICE_BYTES = 40 * 10**9


@dataclass(frozen=True)
class RuntimeFacts:
    """Identify the actual device and runtime used for this execution."""

    arch: str | None = None  # "x86_64" | "aarch64"
    sm: tuple[int, int] | None = None
    torch: str | None = None
    cuda_runtime: str | None = None
    packages: Mapping[str, str | None] = field(default_factory=dict)
    total_memory_bytes: int | None = None  # device memory (torch device properties)
    integrated: bool | None = None  # unified-memory (UMA) GPU vs discrete

    @property
    def sm_major(self) -> int | None:
        """Return the major CUDA compute capability."""
        return None if self.sm is None else self.sm[0]


class DeviceBackend(Protocol):
    """Define how the runtime observes and synchronizes its device."""

    def facts(self) -> RuntimeFacts:
        """Return the observed runtime facts for reporting."""
        ...

    def environment(self) -> dict[str, Any]:
        """Describe the environment that executes this component."""
        ...

    def memory_snapshot(self) -> dict[str, int | None]:
        """Read the current device memory counters."""
        ...

    def reset_peak(self) -> None:
        """Reset peak device memory counters before measuring the next phase."""
        ...

    def synchronize(self) -> bool:
        """Wait for previously submitted device work."""
        ...

    def empty_cache(self) -> None:
        """Release cached allocations that are no longer in use."""
        ...


def _status_bytes(key: str) -> int | None:
    """A ``kB`` field of /proc/self/status (VmRSS, VmHWM) in bytes; None when unknown."""
    try:
        with Path("/proc/self/status").open(encoding="ascii") as fh:
            for line in fh:
                if line.startswith(key + ":"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def host_memory_snapshot(*, peak_scope: str) -> dict[str, Any]:
    """Host side of RUNTIME_MEMORY: current/peak RSS of this actor process.

    ``peak_host_bytes`` is VmHWM, the process lifetime peak (``peak_scope`` says so); the recipe never
    resets it — the component host measures the call; ``max_rss_bytes`` is the lifetime peak (getrusage).
    """
    resource = import_module("resource")

    snap: dict[str, Any] = {
        "rss_bytes": _status_bytes("VmRSS"),
        "peak_host_bytes": _status_bytes("VmHWM"),
        "host_peak_scope": peak_scope,
    }
    try:
        snap["max_rss_bytes"] = (
            int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024
        )  # KiB on Linux
    except (OSError, ValueError):
        snap["max_rss_bytes"] = None
    return snap


def runtime_lock_digest() -> str | None:
    """SHA-256 of this tuple's lock: explicit env override, else ``<tuple>/uv.lock`` next to ``<tuple>/.venv``."""
    explicit = os.environ.get("PHASYN_RUNTIME_LOCK_DIGEST")
    if explicit:
        return explicit
    lock = Path(sys.prefix).parent / "uv.lock"
    return hashlib.sha256(lock.read_bytes()).hexdigest() if lock.is_file() else None


class TorchCudaBackend:
    """CUDA backend for one device; ``device_index`` is the *visible* ordinal."""

    def __init__(self, device: Mapping[str, Any], *, visible_index: int | None) -> None:
        """Select the CUDA device observed by this backend."""
        self.device_uuid = device.get("device_uuid")
        self.physical_index = device.get("device_index")
        self.visible_index = visible_index
        self._facts: RuntimeFacts | None = None

    # -- lazy torch ------------------------------------------------------
    @staticmethod
    def _torch() -> Any:
        import torch

        return torch

    def _has_device(self) -> bool:
        torch = self._torch()
        return self.visible_index is not None and torch.cuda.is_available()

    def torch_device(self) -> Any:
        """Return the torch device selected for this runtime."""
        torch = self._torch()
        if not self._has_device():
            return torch.device("cpu")
        return torch.device("cuda", int(self.visible_index or 0))

    # -- facts -----------------------------------------------------------
    def facts(self) -> RuntimeFacts:
        """Return the observed runtime facts for reporting."""
        if self._facts is None:
            torch = self._torch()
            sm = None
            total = None
            integrated = None
            if self._has_device():
                sm = tuple(
                    torch.cuda.get_device_capability(int(self.visible_index or 0))
                )
                props = torch.cuda.get_device_properties(int(self.visible_index or 0))
                total = int(props.total_memory)
                integrated = bool(getattr(props, "is_integrated", False))
            self._facts = RuntimeFacts(
                arch=platform.machine(),
                sm=sm,
                torch=torch.__version__,
                cuda_runtime=torch.version.cuda,
                packages=library_versions(KERNEL_PACKAGES, vcs=()),
                total_memory_bytes=total,
                integrated=integrated,
            )
        return self._facts

    def _nvml(self) -> dict[str, Any]:
        """Driver/device facts via NVML (read-only queries, no CUDA context).

        Every query is independent: a device that does not support one of them
        (a unified-memory GPU answers ``nvmlDeviceGetMemoryInfo`` with
        NOT_SUPPORTED) loses only that field, never the driver version.  Failed
        queries are listed in ``nvml_errors`` (query -> message).
        """
        try:
            import pynvml  # type: ignore[import-untyped]  # nvidia-ml-py
        except ImportError:
            return {}
        with RuntimeObservation() as initialization:
            pynvml.nvmlInit()
        if (exc := initialization.error) is not None:
            return {"nvml_error": str(exc)[:200]}
        out: dict[str, Any] = {}
        errors: dict[str, str] = {}

        def query(key: str, call: Any) -> Any:
            with RuntimeObservation() as field_query:
                return call()
            exc = field_query.failure()
            errors[key] = str(exc)[:200] or type(exc).__name__
            return None

        def text(value: Any) -> str:
            return value.decode() if isinstance(value, bytes) else str(value)

        try:
            _driver_versions(query, pynvml, out, text)
            _device_memory(query, pynvml, self, out, text)
        finally:
            with contextlib.suppress(Exception):
                pynvml.nvmlShutdown()
        if errors:
            out["nvml_errors"] = errors
        return out

    def environment(self) -> dict[str, Any]:
        """Deterministic facts for environment_fingerprint (no volatile numbers)."""
        torch = self._torch()
        facts = self.facts()
        nvml = self._nvml()
        device: dict[str, Any] = {
            "uuid": self.device_uuid,
            "physical_index": self.physical_index,
            "visible_index": self.visible_index,
        }
        if self._has_device():
            props = torch.cuda.get_device_properties(int(self.visible_index or 0))
            device.update(
                {
                    "name": props.name,
                    "sm": f"{facts.sm[0]}.{facts.sm[1]}" if facts.sm else None,
                    "total_bytes": int(props.total_memory),
                    "multiprocessors": int(props.multi_processor_count),
                    "integrated": bool(getattr(props, "is_integrated", False)),
                }
            )
        cudnn = None
        with RuntimeObservation() as cudnn_query:
            cudnn = torch.backends.cudnn.version()
        if cudnn_query.error is not None:
            cudnn = None
        return {
            "provider_id": PROVIDER_ID,
            "provider_version": PROVIDER_VERSION,
            "python": platform.python_version(),
            "python_implementation": sys.implementation.name,
            "machine": platform.machine(),
            "os": platform.system(),
            "torch": torch.__version__,
            "torch_cuda_arch_list": list(torch.cuda.get_arch_list())
            if torch.cuda.is_available()
            else [],
            "cuda_runtime": torch.version.cuda,
            "cudnn": cudnn,
            "driver_version": nvml.get("driver_version"),
            "cuda_driver_api": nvml.get("cuda_driver_api"),
            "device": device,
            "sglang_source_revision": SGLANG_SOURCE_REVISION,
            "runtime_lock_digest": runtime_lock_digest(),
            "kernel_packages": dict(sorted(facts.packages.items())),
        }

    # -- memory ----------------------------------------------------------
    def memory_snapshot(self) -> dict[str, int | None]:
        """Read the current device memory counters."""
        torch = self._torch()
        snap: dict[str, int | None] = {
            "allocated_bytes": None,
            "reserved_bytes": None,
            "max_allocated_bytes": None,
            "max_reserved_bytes": None,
            "nvml_used_bytes": None,
            "nvml_total_bytes": None,
        }
        if self._has_device():
            idx = int(self.visible_index or 0)
            snap.update(
                {
                    "allocated_bytes": int(torch.cuda.memory_allocated(idx)),
                    "reserved_bytes": int(torch.cuda.memory_reserved(idx)),
                    "max_allocated_bytes": int(torch.cuda.max_memory_allocated(idx)),
                    "max_reserved_bytes": int(torch.cuda.max_memory_reserved(idx)),
                }
            )
        nvml = self._nvml()
        snap["nvml_used_bytes"] = nvml.get("used_bytes")
        snap["nvml_total_bytes"] = nvml.get("total_bytes")
        snap.update(host_memory_snapshot(peak_scope="process"))
        return snap

    def reset_peak(self) -> None:
        """Restart the device allocator's peak for the next stage (the host peak stays process-wide)."""
        if self._has_device():
            self._torch().cuda.reset_peak_memory_stats(int(self.visible_index or 0))

    def synchronize(self) -> bool:
        """Wait for previously submitted device work."""
        if not self._has_device():
            return False
        self._torch().cuda.synchronize(int(self.visible_index or 0))
        return True

    def empty_cache(self) -> None:
        """Release cached allocations that are no longer in use."""
        gc.collect()
        self.empty_cache_after_collection()

    def empty_cache_after_collection(self) -> None:
        """Flush CUDA blocks after the caller collected references and synchronized.

        Only the stage-end provider hook uses this optional fast path. Other
        callers retain ``empty_cache`` and its full Python collection.
        """
        if self._has_device():
            self._torch().cuda.empty_cache()


__all__ = [
    "H3_DIT_BF16_DEVICE_BYTES",
    "KERNEL_PACKAGES",
    "DeviceBackend",
    "RuntimeFacts",
    "TorchCudaBackend",
    "host_memory_snapshot",
    "runtime_lock_digest",
]


def _driver_versions(query: Any, pynvml: Any, out: dict[str, Any], text: Any) -> None:
    driver = query("driver_version", pynvml.nvmlSystemGetDriverVersion)
    if driver is not None:
        out["driver_version"] = text(driver)
    cuda_driver = query("cuda_driver_api", pynvml.nvmlSystemGetCudaDriverVersion_v2)
    if cuda_driver is not None:
        out["cuda_driver_api"] = (
            f"{int(cuda_driver) // 1000}.{(int(cuda_driver) % 1000) // 10}"
        )


def _device_memory(
    query: Any, pynvml: Any, self: TorchCudaBackend, out: dict[str, Any], text: Any
) -> None:
    handle = query(
        "device_handle",
        lambda: (
            pynvml.nvmlDeviceGetHandleByUUID(self.device_uuid)
            if self.device_uuid and str(self.device_uuid).startswith("GPU-")
            else pynvml.nvmlDeviceGetHandleByIndex(int(self.physical_index or 0))
        ),
    )
    if handle is not None:
        name = query("name", lambda: pynvml.nvmlDeviceGetName(handle))
        if name is not None:
            out["name"] = text(name)
        mem = query("memory", lambda: pynvml.nvmlDeviceGetMemoryInfo(handle))
        if mem is not None:
            out["total_bytes"] = int(mem.total)
            out["used_bytes"] = int(mem.used)
