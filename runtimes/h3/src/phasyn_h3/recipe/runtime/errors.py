"""Shim error types and failure classification (torch-free).

Every exception raised out of a stage carries ``error_code`` (``phasyn_h3.host`` maps it to a component contract code) so the host never has to guess, plus a
machine ``reason_code`` that diagnostics reuse.
"""

from __future__ import annotations

from typing import Any, TypedDict, Unpack

from phasyn_h3.recipe.abi.errors import diagnostic

from ._arguments import validate_keywords


class _ErrorDetails(TypedDict, total=False):
    error_code: str | None
    field_path: str | None
    expected: Any
    actual: Any


class ShimError(Exception):
    """Base class: a failure with a contract error code and a reason code."""

    error_code = "MODEL_ERROR"

    def __init__(
        self, reason_code: str, message: str, **arguments: Unpack[_ErrorDetails]
    ) -> None:
        """Capture the native runtime failure and its diagnostic details."""
        validate_keywords(arguments, _ErrorDetails)
        error_code = arguments.get("error_code")
        field_path = arguments.get("field_path")
        expected = arguments.get("expected")
        actual = arguments.get("actual")
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message
        if error_code is not None:
            self.error_code = error_code
        self.field_path = field_path
        self.expected = expected
        self.actual = actual

    def as_diagnostic(self) -> dict[str, Any]:
        """Format the failure as a runtime diagnostic."""
        return diagnostic(
            self.error_code,
            f"[{self.reason_code}] {self.message}",
            field_paths=[self.field_path] if self.field_path else [],
            expected=None if self.expected is None else str(self.expected),
            actual=None if self.actual is None else str(self.actual),
        )


class UnsupportedCombinationError(ShimError):
    """A profile/plan asks for something the pinned runtime cannot honour."""

    error_code = "UNSUPPORTED_COMBINATION"


UnsupportedCombinationError.__name__ = "UnsupportedCombination"
UnsupportedCombinationError.__qualname__ = "UnsupportedCombination"
UnsupportedCombination = UnsupportedCombinationError


class InvalidStageInputError(ShimError):
    """A stage input is missing, malformed or fails integrity checks."""

    error_code = "INVALID_ARGUMENT"


InvalidStageInputError.__name__ = "InvalidStageInput"
InvalidStageInputError.__qualname__ = "InvalidStageInput"
InvalidStageInput = InvalidStageInputError


class IntegrityMismatchError(ShimError):
    """Report a difference from the expected artifact identity."""

    error_code = "INTEGRITY_MISMATCH"


IntegrityMismatchError.__name__ = "IntegrityMismatch"
IntegrityMismatchError.__qualname__ = "IntegrityMismatch"
IntegrityMismatch = IntegrityMismatchError


class EncoderContractMismatchError(ShimError):
    """Report conditioning incompatible with the encoder contract."""

    error_code = "ENCODER_CONTRACT_MISMATCH"


EncoderContractMismatchError.__name__ = "EncoderContractMismatch"
EncoderContractMismatchError.__qualname__ = "EncoderContractMismatch"
EncoderContractMismatch = EncoderContractMismatchError


class ModelFilesMissingError(ShimError):
    """Weights are not on disk; the runtime never downloads (offline enforcement)."""

    error_code = "MODEL_ERROR"


ModelFilesMissingError.__name__ = "ModelFilesMissing"
ModelFilesMissingError.__qualname__ = "ModelFilesMissing"
ModelFilesMissing = ModelFilesMissingError


class AdalnCacheMissError(ShimError):
    """Identify an AdaLN entry absent from the configured cache."""

    error_code = "UNSUPPORTED_COMBINATION"

    def __init__(self, message: str, **kwargs: Any) -> None:
        """Record the missing AdaLN entry."""
        super().__init__("ADALN_CACHE_MISS", message, **kwargs)


AdalnCacheMissError.__name__ = "AdalnCacheMiss"
AdalnCacheMissError.__qualname__ = "AdalnCacheMiss"
AdalnCacheMiss = AdalnCacheMissError


class ComponentBusyError(ShimError):
    """Report a resident component currently held by another operation."""

    error_code = "STATE_CONFLICT"


ComponentBusyError.__name__ = "ComponentBusy"
ComponentBusyError.__qualname__ = "ComponentBusy"
ComponentBusy = ComponentBusyError


class GpuOutOfMemoryError(ShimError):
    """Report a failed GPU allocation from the native stage."""

    error_code = "GPU_OOM"


GpuOutOfMemoryError.__name__ = "GpuOutOfMemory"
GpuOutOfMemoryError.__qualname__ = "GpuOutOfMemory"
GpuOutOfMemory = GpuOutOfMemoryError


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
    if (
        "OutOfMemoryError" in names
        or "out of memory" in text
        or "cuda_error_out_of_memory" in text
    ):
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
