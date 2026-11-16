"""Error codes and the wire ``Error`` object.

:class:`ComponentError` is the exception every layer shares: ``code`` is a stable identifier,
``message`` is the user-facing (Traditional Chinese, i18n-keyed) text and the HTTP status follows
from the code. There are no 401/403 identity errors.

``Error.details`` never carries a stack trace: :func:`exception_summary` is what goes on the wire,
while :func:`exception_details` (with the stack) is only for logs and recorder log events.

Each registered code has an HTTP status and a *kind*. The kind is a presentation hint for interfaces (what
the user can do next), not HTTP semantics: a code keeps its own status whatever its kind (see
:data:`KINDS_NOTE`, which ``contracts/error-codes.json`` carries as ``kinds_note``).
"""

from __future__ import annotations

import os
import re
import traceback
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal

from .pathscrub import mask_paths

_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
MESSAGE_LIMIT = 16384

ErrorKind = Literal["client", "conflict", "unavailable", "remote", "internal"]

KINDS_NOTE = (
    "A kind is a presentation hint for interfaces: what the user can do next. It is not HTTP semantics; "
    "every code keeps its own HTTP status, and an interface may give a code its own hint instead of its kind's."
)

ERROR_KINDS: Mapping[str, str] = MappingProxyType(
    {
        "client": "The request is wrong for this server: fix it before sending it again.",
        "conflict": "The request is valid but conflicts with the current state: resolve it, then retry.",
        "unavailable": "A dependency is temporarily unavailable: retrying later may succeed.",
        "remote": "The outcome on the other side is unknown: check before retrying.",
        "internal": "The system failed while handling a valid request: see the logs and the recording.",
    }
)


@dataclass(frozen=True)
class ErrorCode:
    """One registered wire error code."""

    status: int
    kind: ErrorKind
    description: str


def _codes(*rows: tuple[str, int, ErrorKind, str]) -> Mapping[str, ErrorCode]:
    table = {code: ErrorCode(status, kind, description) for code, status, kind, description in rows}
    if len(table) != len(rows):
        raise ValueError("duplicate error code in ERROR_CODES")
    return MappingProxyType(dict(sorted(table.items())))


# The single registry of every error code that can reach the wire. contracts/error-codes.json is
# generated from it (tools/contracts/error_codes.py); a repository test fails when product code raises
# an unregistered literal code. Media codes (phasyn_media.errors) share this namespace.
ERROR_CODES: Mapping[str, ErrorCode] = _codes(
    # -- the request itself
    ("INVALID_ARGUMENT", 422, "client", "A field is missing, malformed or out of range."),
    ("BAD_REQUEST", 400, "client", "The HTTP request is malformed."),
    ("AMBIGUOUS_STREAM", 400, "client", "The recording has several streams; name the stream_id."),
    ("METHOD_NOT_ALLOWED", 405, "client", "The HTTP method is not supported on this path."),
    ("PAYLOAD_TOO_LARGE", 413, "client", "The request body or upload exceeds the server's transport limit."),
    (
        "UNSUPPORTED_MEDIA_TYPE",
        415,
        "client",
        "The body's Content-Type is not the one the endpoint needs (application/json for JSON endpoints, "
        "application/octet-stream for a plugin package).",
    ),
    (
        "BROWSER_REQUEST_REJECTED",
        403,
        "client",
        "A Node refused a request sent by a web browser (the controller answers cross-site writes with BAD_REQUEST).",
    ),
    (
        "HOST_NOT_ALLOWED",
        400,
        "client",
        "The Host header is not one the server answers: its allowed_hosts, or without that setting IP addresses, "
        "localhost and the server's own names.",
    ),
    ("PROTOCOL_MISMATCH", 409, "client", "The peer speaks an incompatible protocol version."),
    # -- semantics of the inputs
    ("PROMPT_TOO_LONG", 422, "client", "The prompt exceeds the text encoder's limit."),
    ("CONTEXT_BUDGET_EXCEEDED", 422, "client", "The inputs exceed the model's context budget."),
    ("RUBRIC_MISMATCH", 422, "client", "The evaluation rubric does not match the study."),
    ("PORT_MISMATCH", 422, "client", "A pipeline wire connects incompatible port types."),
    ("CYCLIC_PIPELINE", 422, "client", "The pipeline graph contains a cycle."),
    ("UNSUPPORTED_SETTING", 422, "client", "The component does not support this setting or combination."),
    ("MODEL_INCOMPATIBLE", 422, "client", "The input or the weights do not match what the component expects."),
    ("INPUT_TOO_LARGE", 422, "client", "An input exceeds a semantic limit (frames, pixels, characters...)."),
    (
        "STUDIO_TIMELINE_REJECTED",
        422,
        "client",
        "A timeline command or export was refused and nothing was saved; details.reason is the stable reason.",
    ),
    ("LATENT_SOURCE_MISMATCH", 422, "client", "A latent's linked blob or source differs from its manifest."),
    ("LATENT_MISMATCH", 422, "client", "A latent's layout, shape or space is not what the consumer needs."),
    ("FILE_TRUNCATED", 422, "client", "A file is shorter than its declared size."),
    ("FILE_HASH_MISMATCH", 422, "client", "A file's SHA-256 differs from its FileRef."),
    ("MEDIA_INCOMPLETE", 422, "client", "A media asset is incomplete or failed its frame or sample verification."),
    ("UNSUPPORTED_COMBINATION", 422, "client", "Media taxonomy: the requested media combination is not supported."),
    ("INTEGRITY_MISMATCH", 422, "client", "Media taxonomy: a file changed or failed an integrity check."),
    ("RESOURCE_EXHAUSTED", 422, "client", "Media taxonomy: the work would exceed a resource limit."),
    ("CANCELLED", 500, "client", "The call was cancelled on request."),
    # -- configuration and lookup
    ("NOT_FOUND", 404, "client", "The resource does not exist."),
    ("FILE_NOT_FOUND", 404, "client", "The file does not exist."),
    ("RECORDING_NOT_FOUND", 404, "client", "The recording does not exist."),
    ("PREVIEW_NOT_FOUND", 404, "client", "No preview is available for that call or step."),
    ("TRACE_UNAVAILABLE", 404, "client", "The recording has no profiler trace."),
    ("RANGE_NOT_SATISFIABLE", 416, "client", "The requested byte range is outside the file."),
    ("PROVIDER_NOT_INSTALLED", 422, "client", "The runtime has no such provider (package missing or not enabled)."),
    ("COMPONENT_NOT_CONFIGURED", 422, "client", "A required component setting or file is missing."),
    ("RUNTIME_NOT_CONFIGURED", 422, "client", "The Node has no runtime with this id."),
    # -- Studio plugin packages
    (
        "STUDIO_PLUGIN_INVALID",
        422,
        "client",
        "The plugin package breaks a package rule (archive, paths, sizes, manifest or integrity); "
        "details.errors lists up to 20 problems.",
    ),
    (
        "STUDIO_PLUGIN_INSTALL_DISABLED",
        409,
        "conflict",
        "The Controller's configuration file turns plugin installation and removal through the API off.",
    ),
    # -- state conflicts
    ("COMPONENT_NOT_READY", 409, "conflict", "The component is not loaded."),
    ("COMPONENT_BUSY", 409, "conflict", "The component is already running a call."),
    ("DEVICE_BUSY", 409, "conflict", "Another component holds the device's resource group."),
    (
        "GPU_MEMORY_INSUFFICIENT",
        409,
        "conflict",
        "A memory pre-check found too little free GPU memory for this configuration; nothing was loaded or run.",
    ),
    (
        "HOST_MEMORY_INSUFFICIENT",
        409,
        "conflict",
        "A memory pre-check found too little free host memory for this configuration; nothing was loaded or run.",
    ),
    ("EXCLUSIVE_GROUP_BUSY", 409, "conflict", "A member of the exclusive group is loading, stopping or busy."),
    (
        "EXCLUSIVE_GROUP_CONFLICT",
        409,
        "conflict",
        "An idle member holds the exclusive group; retry with replace_exclusive.",
    ),
    ("SETTINGS_NOT_LOADED", 409, "conflict", "The saved settings differ from the loaded ones; restart to apply."),
    ("REVISION_CONFLICT", 409, "conflict", "The document changed since it was read; reload and save again."),
    ("RUN_ACTIVE", 409, "conflict", "Another run is active."),
    ("CALL_ID_CONFLICT", 409, "conflict", "The call id is already in use."),
    ("STATE_CONFLICT", 409, "conflict", "The resource's current state does not allow this operation."),
    ("TASK_RUNNING", 409, "conflict", "A study task is still marked running; stop it or mark it interrupted first."),
    ("DUPLICATE_NODE_ID", 409, "conflict", "Another live Node registered with the same node_id."),
    (
        "WEIGHTS_DESTINATION_CONFLICT",
        409,
        "conflict",
        "The destination holds files that differ from the pinned weights; they are replaced only when asked.",
    ),
    # -- availability
    ("NODE_UNREACHABLE", 503, "unavailable", "The Node could not be reached."),
    ("NODE_SHUTTING_DOWN", 503, "unavailable", "The Node is shutting down."),
    (
        "HOST_PROTECTION",
        503,
        "unavailable",
        "The Node's host protection (admission in its configuration) held a call back until its deadline or cancelled "
        "it while it ran: the chip or GPU was too hot, or free host memory fell below the floor; details.reason and "
        "the message give the reading. Retry once the host has cooled down or freed memory.",
    ),
    ("CONTROLLER_UNREACHABLE", 503, "unavailable", "The controller could not be reached."),
    ("RUNTIME_UNAVAILABLE", 422, "unavailable", "The runtime environment cannot run this provider right now."),
    (
        "WEIGHTS_SOURCE_UNAVAILABLE",
        503,
        "unavailable",
        "The weight source (Hugging Face or HF_ENDPOINT) could not be reached or refused the download.",
    ),
    (
        "INTERRUPTED",
        500,
        "remote",
        "The run was interrupted (e.g. the controller restarted); Node-side work may have continued.",
    ),
    ("PROCESS_EXIT_UNCONFIRMED", 500, "remote", "The component process may still be running; its exit is unconfirmed."),
    # -- failures inside the system
    ("PROTOCOL_ERROR", 500, "internal", "A component process received a control message it could not parse."),
    ("RUNTIME_ERROR", 500, "internal", "The component or service failed while handling the request."),
    ("NODE_INTERNAL_ERROR", 500, "internal", "The Node failed unexpectedly while handling the request."),
    ("RUNTIME_EXITED", 500, "internal", "The component process exited during the operation."),
    ("RUNTIME_START_FAILED", 500, "internal", "The component process could not be started."),
    ("CALL_TIMEOUT", 500, "internal", "The call exceeded its deadline."),
    ("LOAD_TIMEOUT", 500, "internal", "Loading the component exceeded its deadline."),
    ("MEDIA_TOOL_FAILED", 500, "internal", "FFmpeg or ffprobe failed."),
    (
        "ENCODER_CONTRACT_MISMATCH",
        500,
        "internal",
        "Media taxonomy: an encoder produced output that breaks its contract.",
    ),
    ("MODEL_OUTPUT_INVALID", 422, "internal", "The model produced output that fails validation."),
    ("GPU_OOM", 500, "internal", "The GPU ran out of memory."),
    ("HOST_OOM", 500, "internal", "The host ran out of memory."),
    ("DISK_FULL", 507, "internal", "The disk is full."),
    (
        "UPSTREAM_PATCH_SOURCE_MISMATCH",
        500,
        "internal",
        "A pinned upstream function changed; the runtime refuses to patch it.",
    ),
)

# Codes of RecorderNotice events (Recorder.notice): coverage and loss notes in a recording, not errors.
NOTICE_CODES: Mapping[str, str] = MappingProxyType(
    {
        "CANCEL_NO_ANSWER": "A cancel request got no answer from the Node in time.",
        "DETAIL_TRUNCATED": "Some detail events were not recorded (a bounded queue or limit was reached).",
        "TRACE_TRUNCATED": "The profiler trace exceeded its size limit and was not kept.",
        "TRACE_UNAVAILABLE": "The profiler trace could not be started or exported.",
    }
)

# code -> HTTP status (an unregistered code is a 500)
HTTP_STATUS: Mapping[str, int] = MappingProxyType({code: spec.status for code, spec in ERROR_CODES.items()})


def is_registered(code: str) -> bool:
    return code in ERROR_CODES


def error_registry() -> dict[str, Any]:
    """The JSON document behind ``contracts/error-codes.json`` (for clients, tools and docs)."""
    return {
        "version": 1,
        "kinds_note": KINDS_NOTE,
        "kinds": dict(ERROR_KINDS),
        "codes": {
            code: {"status": e.status, "kind": e.kind, "description": e.description} for code, e in ERROR_CODES.items()
        },
        "notices": dict(NOTICE_CODES),
    }


class ComponentError(Exception):
    """可序列化成 contract ``Error`` 的例外。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
        remote_outcome_unknown: bool = False,
        status: int | None = None,
    ) -> None:
        if not _CODE_RE.match(code) or len(code) > 160:
            raise ValueError(f"invalid error code {code!r}")
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message[:MESSAGE_LIMIT]
        self.details = dict(details or {})
        self.remote_outcome_unknown = remote_outcome_unknown
        self.status = status if status is not None else HTTP_STATUS.get(code, 500)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            out["details"] = self.details
        if self.remote_outcome_unknown:
            out["remote_outcome_unknown"] = True
        return out

    @classmethod
    def from_dict(cls, doc: Mapping[str, Any], *, status: int | None = None) -> ComponentError:
        code = str(doc.get("code") or "RUNTIME_ERROR")
        if not _CODE_RE.match(code):
            code = "RUNTIME_ERROR"
        return cls(
            code,
            str(doc.get("message") or ""),
            details=doc.get("details") if isinstance(doc.get("details"), Mapping) else None,
            remote_outcome_unknown=bool(doc.get("remote_outcome_unknown", False)),
            status=status,
        )


class Cancelled(Exception):
    """cooperative 取消：provider 在檢查點拋出，runtime host 轉成 state=cancelled。"""


def error_dict(code: str, message: str, **details: Any) -> dict[str, Any]:
    return ComponentError(code, message, details=details or None).to_dict()


def classify_exception(exc: BaseException) -> str:
    """把未知例外歸到最接近的 contract code；不猜測成功。"""
    if isinstance(exc, ComponentError):
        return exc.code
    if isinstance(exc, Cancelled):
        return "CANCELLED"
    name = type(exc).__name__
    text = str(exc)
    if (
        name == "OutOfMemoryError"
        or "CUDA out of memory" in text
        or ("out of memory" in text.lower() and "cuda" in text.lower())
    ):
        return "GPU_OOM"
    if isinstance(exc, MemoryError):
        return "HOST_OOM"
    if isinstance(exc, FileNotFoundError):
        return "FILE_NOT_FOUND"
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 28:
        return "DISK_FULL"
    return "RUNTIME_ERROR"


def exception_message(exc: BaseException) -> str:
    """``str(exc)`` without local paths: an ``OSError`` keeps only the file name, other messages go
    through :func:`phasyn_components.pathscrub.mask_paths`. Use it whenever an exception's text is
    put into a message or details that leave the process."""
    if isinstance(exc, OSError) and exc.filename is not None:
        # A call on a descriptor (os.scandir(fd), os.open(..., dir_fd=fd)) reports the descriptor's number
        named = isinstance(exc.filename, str | bytes | os.PathLike)
        name = (os.path.basename(os.fsdecode(exc.filename)) if named else "") or "?"
        errno = f"[Errno {exc.errno}] " if exc.errno is not None else ""
        return f"{errno}{exc.strerror or type(exc).__name__}: {name}"
    return mask_paths(str(exc))


def exception_summary(exc: BaseException) -> dict[str, Any]:
    """Exception type and message for ``Error.details`` (no stack, no local paths)."""
    return {
        "exception_type": f"{type(exc).__module__}.{type(exc).__qualname__}",
        "exception_message": exception_message(exc)[:4000],
    }


def exception_details(exc: BaseException, *, limit: int = 12000) -> dict[str, Any]:
    """:func:`exception_summary` plus the (tail-truncated) stack: for logs and recorder events only."""
    stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    truncated = len(stack) > limit
    if truncated:
        stack = stack[-limit:]
    return {**exception_summary(exc), "stack": stack, "stack_truncated": truncated}


_GENERIC_MESSAGES = {
    "GPU_OOM": "GPU 記憶體不足（OOM）；設定與最後計數已保留，請手動調整後重試",
    "HOST_OOM": "主記憶體不足",
    "DISK_FULL": "磁碟已滿",
    "FILE_NOT_FOUND": "找不到檔案",
    "CANCELLED": "已取消",
}


def to_component_error(exc: BaseException, *, prefix: str = "") -> ComponentError:
    """Wrap an unexpected exception; ``details`` gets :func:`exception_summary`, never the stack."""
    if isinstance(exc, ComponentError):
        return exc
    code = classify_exception(exc)
    base = _GENERIC_MESSAGES.get(code, "執行錯誤")
    msg = f"{prefix}{base}：{type(exc).__name__}: {exception_message(exc)}"
    return ComponentError(code, msg, details=exception_summary(exc))


def with_cleanup_report(error: Mapping[str, Any], report: Mapping[str, Any]) -> dict[str, Any]:
    """A wire ``Error`` with the after-failure cleanup report of a component process attached.

    The report goes to ``details.cleanup``. When it says ``reload_required`` (the process could not be shown to be
    back in a clean idle state), its ``reason`` is appended to the message: the component stays usable and nothing is
    retried, but the user has to know that only a reload frees what the failed call left behind.
    """
    out = dict(error)
    out["details"] = {**dict(error.get("details") or {}), "cleanup": dict(report)}
    reason = report.get("reason")
    if report.get("reload_required") and isinstance(reason, str) and reason:
        out["message"] = f"{error.get('message') or ''}；{reason}"[:MESSAGE_LIMIT]
    return out


# The server's fixed explanations of the two memory pre-check codes; every such message ends with one of them
# (ja/en in server.json).
GPU_MEMORY_INSUFFICIENT_TEXT = (
    "預檢：可用 GPU 記憶體不足，沒有載入或執行；同一張 GPU 上的其他程序與元件即使閒置也會佔用記憶體；"
    "調整配置（換一張 GPU、改 offload 模式、停止同卡元件）後再試"
)
HOST_MEMORY_INSUFFICIENT_TEXT = (
    "預檢：可用主記憶體不足，沒有載入或執行；同一台主機上的其他程序與元件也會佔用主記憶體；"
    "調整配置（停止同主機的其他元件或程序、改用需要較少主記憶體的 offload 或 pin 設定、換一台主機）後再試"
)


def gpu_memory_insufficient(finding: str, *, details: Mapping[str, Any]) -> ComponentError:
    """A memory pre-check refused a load or a call before anything ran (``GPU_MEMORY_INSUFFICIENT``).

    ``finding`` states what the check estimated and measured and starts the message; ``details`` carries the full
    estimate. Never ``GPU_OOM``: nothing ran out of memory, and the Controller's cost profiles count only real
    out-of-memory failures as an out-of-memory risk.
    """
    return ComponentError("GPU_MEMORY_INSUFFICIENT", f"{finding}。{GPU_MEMORY_INSUFFICIENT_TEXT}", details=details)


def host_memory_insufficient(finding: str, *, details: Mapping[str, Any]) -> ComponentError:
    """The host-memory counterpart of :func:`gpu_memory_insufficient` (``HOST_MEMORY_INSUFFICIENT``, never
    ``HOST_OOM``)."""
    return ComponentError("HOST_MEMORY_INSUFFICIENT", f"{finding}。{HOST_MEMORY_INSUFFICIENT_TEXT}", details=details)


__all__ = [
    "ERROR_CODES",
    "ERROR_KINDS",
    "GPU_MEMORY_INSUFFICIENT_TEXT",
    "HOST_MEMORY_INSUFFICIENT_TEXT",
    "HTTP_STATUS",
    "KINDS_NOTE",
    "NOTICE_CODES",
    "Cancelled",
    "ComponentError",
    "ErrorCode",
    "ErrorKind",
    "classify_exception",
    "error_dict",
    "error_registry",
    "exception_details",
    "exception_message",
    "exception_summary",
    "gpu_memory_insufficient",
    "host_memory_insufficient",
    "is_registered",
    "to_component_error",
    "with_cleanup_report",
]
