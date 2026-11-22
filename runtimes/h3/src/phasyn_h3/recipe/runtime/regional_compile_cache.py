"""Actor-private, bounded live specializations for a weight-free H3 activation."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import stat
import tempfile
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from types import FunctionType
from typing import Any

from . import SGLANG_SOURCE_REVISION
from .errors import classify_exception


MAX_SIGNATURES = 4
REGION = "h3.mlp.silu_mul.v1"


def _gate(hidden: Any) -> Any:
    import torch

    gate, up = hidden.chunk(2, dim=-1)
    return torch.nn.functional.silu(gate) * up


def signature(hidden: Any, attention: str, *, reuse: bool) -> dict[str, Any]:
    """Describe the input and execution settings affecting this specialization."""
    import torch

    return {
        "region": REGION,
        "sglang": SGLANG_SOURCE_REVISION,
        "torch": str(torch.__version__),
        "torch_cuda": torch.version.cuda,
        "shape": list(hidden.shape),
        "stride": list(hidden.stride()),
        "dtype": str(hidden.dtype),
        "device": str(hidden.device),
        "architecture": list(torch.cuda.get_device_capability(hidden.device))
        if hidden.is_cuda
        else torch.backends.cpu.get_cpu_capability(),
        "compiler": "inductor",
        "attention": attention,
        "reuse_input": reuse,
        "inference_mode": torch.is_inference_mode_enabled(),
        "grad_mode": torch.is_grad_enabled(),
        "autocast": torch.is_autocast_enabled(hidden.device.type),
        "autocast_dtype": str(torch.get_autocast_dtype(hidden.device.type)),
    }


def digest(spec: dict[str, Any]) -> str:
    """Compute the stable SHA-256 identity of a specialization."""
    return hashlib.sha256(
        json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def disk_bytes(path: Path) -> int:
    """Count regular files retained under this specialization."""
    size = 0
    for root, _, names in os.walk(path):
        for name in names:
            entry = (Path(root) / name).lstat()
            if stat.S_ISREG(entry.st_mode):
                size += entry.st_size
    return size


@contextlib.contextmanager
def _directories(root: Path) -> Iterator[None]:
    # The component is a single actor process. No environment survives the compile call.
    overrides = {
        "TORCHINDUCTOR_CACHE_DIR": str(root / "inductor"),
        "TRITON_CACHE_DIR": str(root / "triton"),
    }
    previous = {key: os.environ.get(key) for key in overrides}
    os.environ.update(overrides)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


class CompilerInactiveError(RuntimeError):
    """Dynamo bypassed the backend or attempted a second graph for this signature."""


CompilerInactiveError.__name__ = CompilerInactiveError.__qualname__ = "CompilerInactive"
CompilerInactive = CompilerInactiveError


def _check_dispatch(observed: list[bool]) -> None:
    if not observed:
        raise CompilerInactive("Inductor was bypassed")


def _compile(fn: Callable[..., Any], observed: list[bool]) -> Any:
    import torch
    from torch import _inductor
    from torch._functorch import config as functorch_config

    def compile_graph(graph: Any, inputs: list[Any]) -> Any:
        if observed:
            raise CompilerInactive("specialization changed")
        observed.append(True)
        with functorch_config.patch(enable_remote_autograd_cache=False):
            return _inductor.compile(
                graph,
                inputs,
                options={
                    "triton.cudagraphs": False,
                    "cutlass.use_binary_remote_cache": False,
                    "cuda.use_binary_remote_cache": False,
                    "compile_threads": 1,
                    "fx_graph_remote_cache": False,
                    "autotune_remote_cache": False,
                    "bundled_autotune_remote_cache": False,
                },
            )

    return torch.compile(fn, backend=compile_graph, fullgraph=True, dynamic=False)


def _clock(hidden: Any) -> float:
    if hidden.is_cuda:
        import torch

        torch.cuda.synchronize(hidden.device)
    return time.perf_counter()


@dataclass
class Entry:
    """Own a compiled gate and its private on-disk compiler directory."""

    directory: tempfile.TemporaryDirectory[str]
    function: FunctionType
    compiled: Any
    size: int = 0

    def close(self) -> None:
        """Release the code identity and remove its private compiler directory."""
        from torch._dynamo import reset_code  # type: ignore[attr-defined]  # pinned code-object reset

        # Reset only the unique code object this entry owns.
        reset_code(self.function.__code__)
        self.directory.cleanup()


class RegionBank:
    """Manage the live set of specializations owned by this actor."""

    def __init__(self, workdir: Path) -> None:
        """Start an empty compiler cache under the actor workspace."""
        self.workdir = workdir
        self.directory: tempfile.TemporaryDirectory[str] | None = None
        self.entries: OrderedDict[str, Entry] = OrderedDict()

    @property
    def size(self) -> int:
        """Return the number of retained compiler bytes."""
        return sum(entry.size for entry in self.entries.values())

    def trim(self, budget: int, *, adding: bool = False) -> int:
        """Evict the oldest specializations until both retention limits hold."""
        evicted = 0
        while self.entries and (
            len(self.entries) + int(adding) > MAX_SIGNATURES or self.size > budget
        ):
            self.entries.popitem(last=False)[1].close()
            evicted += 1
        return evicted

    def close(self) -> None:
        """Release every specialization and the actor-private directory."""
        while self.entries:
            self.entries.popitem(last=False)[1].close()
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None

    def build(self, key: str, hidden: Any) -> tuple[Entry, Any, float]:
        # Distinct code identities keep Dynamo guards and eviction local to a signature.
        """Compile the gate for this real input and measure its first execution."""
        if self.directory is None:
            self.directory = tempfile.TemporaryDirectory(
                prefix="h3-regions-", dir=self.workdir
            )
        directory = tempfile.TemporaryDirectory(
            prefix=key[:12] + "-", dir=self.directory.name
        )
        original = FunctionType(
            _gate.__code__.replace(co_name="h3_gate_" + key), _gate.__globals__
        )
        entry = Entry(directory, original, None)
        try:
            started = _clock(hidden)
            with _directories(Path(directory.name)):
                observed: list[bool] = []
                entry.compiled = _compile(original, observed)
                output = entry.compiled(hidden)
                _check_dispatch(observed)
            elapsed = _clock(hidden) - started
            entry.size = disk_bytes(Path(directory.name))
        except BaseException:
            entry.close()
            raise
        return entry, output, elapsed


def compiler_failure(exc: Exception) -> str | None:
    """Identify recoverable compiler errors while propagating device and memory failures."""
    from torch._dynamo import exc as dynamo

    chain: BaseException | None = exc
    while chain is not None:
        if classify_exception(chain) in {
            "HOST_OOM",
            "GPU_OOM",
            "GPU_DEVICE_LOST",
            "CANCELLED",
        }:
            return None
        chain = chain.__cause__
    if isinstance(
        exc, (dynamo.TorchDynamoException, CompilerInactive, ImportError, OSError)
    ):
        return type(exc).__name__
    return None
