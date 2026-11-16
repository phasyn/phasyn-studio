"""Stage execution ABI: what a runtime stage receives (:class:`StageContext`) and returns (:class:`StageResult`).

A stage runs inside the component process next to its runtime provider; it never receives a database
session, a shell runner or mutable global configuration.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from phasyn_components.errors import Cancelled


class StageCanceled(Cancelled):
    """Raised at a safe boundary after a cancel request.

    It is a :class:`phasyn_components.errors.Cancelled`, so every cooperative cancellation raised inside a
    stage (including ``phasyn_media.errors.MediaCanceled`` from the FFmpeg encoder) is handled as one kind
    of exception: catch ``Cancelled``, not this subclass.
    """


class CancelSignal(Protocol):
    """Cancellation as a stage sees it (the component host links it to the run's cancel/deadline)."""

    reason: str

    def is_set(self) -> bool: ...

    def raise_if_set(self) -> None: ...


@dataclass(frozen=True)
class StageInput:
    name: str
    path: Path | None
    artifact: Mapping[str, Any] | None


@dataclass(frozen=True)
class OutputFile:
    name: str
    path: Path
    media_type: str
    kind: str


@dataclass
class StageResult:
    status: str  # succeeded | failed | canceled
    outputs: list[OutputFile] = field(default_factory=list)
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    active_profile_digest: str | None = None
    error_code: str | None = None


@dataclass
class StageContext:
    assignment: Mapping[str, Any]
    plan: Mapping[str, Any]
    stage: Mapping[str, Any]
    inputs: Mapping[str, StageInput]
    output_dir: Path
    cancel: CancelSignal
    progress: Callable[[dict[str, Any]], None]
    log: Callable[[str, str], None]
    device: Mapping[str, Any]
    grant: Mapping[str, Any]
    runtime: Any = None  # the runtime provider that executes the stage
    memory_level: int = 0
    # artifact_id -> local path for payloads referenced by input manifests
    attachments: Mapping[str, Path] = field(default_factory=dict)


__all__ = ["CancelSignal", "OutputFile", "StageCanceled", "StageContext", "StageInput", "StageResult"]
