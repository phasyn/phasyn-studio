"""Shim error types and failure classification (torch-free).

Every exception raised out of a stage carries ``error_code`` (``phasyn_h3.host`` maps it to a component contract code) so the host never has to guess, plus a
machine ``reason_code`` that diagnostics reuse.
"""

from __future__ import annotations

from typing import Any

from phasyn_h3.recipe.abi.errors import diagnostic


class ShimError(Exception):
    """Base class: a failure with a contract error code and a reason code."""

    error_code = "MODEL_ERROR"

    def __init__(
        self,
        reason_code: str,
        message: str,
        *,
        error_code: str | None = None,
        field_path: str | None = None,
        expected: Any = None,
        actual: Any = None,
    ) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message
        if error_code is not None:
            self.error_code = error_code
        self.field_path = field_path
        self.expected = expected
        self.actual = actual

    def as_diagnostic(self) -> dict[str, Any]:
        return diagnostic(
            self.error_code,
            f"[{self.reason_code}] {self.message}",
            field_paths=[self.field_path] if self.field_path else [],
            expected=None if self.expected is None else str(self.expected),
            actual=None if self.actual is None else str(self.actual),
        )


class UnsupportedCombination(ShimError):
    """A profile/plan asks for something the pinned runtime cannot honour."""

    error_code = "UNSUPPORTED_COMBINATION"


class InvalidStageInput(ShimError):
    """A stage input is missing, malformed or fails integrity checks."""

    error_code = "INVALID_ARGUMENT"


class IntegrityMismatch(ShimError):
    error_code = "INTEGRITY_MISMATCH"


class EncoderContractMismatch(ShimError):
    error_code = "ENCODER_CONTRACT_MISMATCH"


class ModelFilesMissing(ShimError):
    """Weights are not on disk; the runtime never downloads (offline enforcement)."""

    error_code = "MODEL_ERROR"


class AdalnCacheMiss(ShimError):
    error_code = "UNSUPPORTED_COMBINATION"

    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__("ADALN_CACHE_MISS", message, **kwargs)


class ComponentBusy(ShimError):
    error_code = "STATE_CONFLICT"


class GpuOutOfMemory(ShimError):
    error_code = "GPU_OOM"


def classify_exception(exc: BaseException) -> str:
    """Map an arbitrary exception to a contract error code.

    ``torch.cuda.OutOfMemoryError`` is matched by name so this module stays
    torch-free; a Python ``MemoryError`` (the host ran out) is ``HOST_OOM``; CUDA
    device faults become ``GPU_DEVICE_LOST`` (the process must be replaced),
    everything else ``MODEL_ERROR``.
    """
    code = getattr(exc, "error_code", None)
    if isinstance(code, str) and code:
        return code
    names = {cls.__name__ for cls in type(exc).__mro__}
    text = f"{type(exc).__name__}: {exc}".lower()
    if "OutOfMemoryError" in names or "out of memory" in text or "cuda_error_out_of_memory" in text:
        return "GPU_OOM"
    if isinstance(exc, MemoryError):
        return "HOST_OOM"
    if (
        "device-side assert" in text
        or "illegal memory access" in text
        or "cudaerrorlaunchfailure" in text
        or "device lost" in text
        or "unspecified launch failure" in text
    ):
        return "GPU_DEVICE_LOST"
    return "MODEL_ERROR"


__all__ = [
    "AdalnCacheMiss",
    "ComponentBusy",
    "EncoderContractMismatch",
    "GpuOutOfMemory",
    "IntegrityMismatch",
    "InvalidStageInput",
    "ModelFilesMissing",
    "ShimError",
    "UnsupportedCombination",
    "classify_exception",
]
