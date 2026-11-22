"""Call contexts handed to providers: inputs, outputs, cancellation, deadlines and previews.

Each call gets its own :class:`RunContext` and Recorder (no shared global logger); ``load`` gets a
:class:`LoadContext` and ``unload`` an :class:`UnloadContext`.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import Cancelled, ComponentError
from .files import FileStore
from .outputs import OutputFile
from .preview import (
    PREVIEW_MAX_BYTES,
    PREVIEW_NOTE_MAX,
    PreviewFrame,
    PreviewSink,
    checked_preview,
)
from .recorder import Recorder
from .timeutil import mono_ns


@dataclass
class InputValue:
    """A typed value or a local file delivered to a provider."""

    type_id: str
    value: Any = None
    file: dict[str, Any] | None = None
    path: Path | None = None
    links: dict[str, tuple[dict[str, Any], Path]] = field(default_factory=dict)

    @property
    def is_file(self) -> bool:
        """Report whether the input is backed by a file."""
        return self.file is not None

    def require_path(self, port: str) -> Path:
        """Return the required local input path."""
        if self.path is None:
            raise ComponentError("INVALID_ARGUMENT", f"輸入 {port} 需要 FileRef")
        return self.path


class CancelToken:
    """``is_set()`` view for tools that poll (phasyn_media, the vendored H3 recipe): cancel or deadline both count."""

    def __init__(self, ctx: RunContext) -> None:
        """Initialize cancel token with its configuration."""
        self._ctx = ctx

    def is_set(self) -> bool:
        """Report whether cancellation has been signalled."""
        return self._ctx.cancelled()

    @property
    def reason(self) -> str:
        """Return the reason for the cancellation request."""
        return "超過呼叫期限" if mono_ns() >= self._ctx.deadline_ns else "使用者取消"


class _BaseContext:
    def __init__(
        self,
        *,
        recorder: Recorder,
        device: Mapping[str, Any],
        work_dir: Path,
        settings: Mapping[str, Any],
    ) -> None:
        self.recorder = recorder
        self.device = dict(device)
        self.work_dir = work_dir
        self.settings = dict(settings)

    def log(self, level: str, message: str, **fields: Any) -> None:
        self.recorder.log(level, message, **fields)


class LoadContext(_BaseContext):
    """Settings and instrumentation for loading a provider."""

    def __init__(
        self, *, expanded_parts: Mapping[str, Mapping[str, Any]], **kw: Any
    ) -> None:
        """Initialize load context with its configuration."""
        super().__init__(**kw)
        self.expanded_parts = {k: dict(v) for k, v in expanded_parts.items()}

    @property
    def load(self) -> dict[str, Any]:
        """Access the load settings for this operation."""
        return dict(self.settings.get("load") or {})


class RunContext(_BaseContext):
    """Typed inputs, outputs and lifecycle services for one provider invocation."""

    def __init__(  # noqa: PLR0913 - Providers construct this context with the published keyword arguments.
        self,
        *,
        call_id: str,
        run_id: str | None,
        step_id: str | None,
        parameters: Mapping[str, Any],
        inputs: Mapping[str, InputValue],
        store: FileStore,
        deadline_ns: int,
        cancel_event: threading.Event,
        output_types: Mapping[str, str],
        resolver: Any = None,
        preview_sink: PreviewSink | None = None,
        **kw: Any,
    ) -> None:
        """Initialize run context with its configuration."""
        super().__init__(**kw)
        self._resolver = resolver
        self.call_id = call_id
        self.run_id = run_id
        self.step_id = step_id
        self.parameters = dict(parameters)
        self.inputs = dict(inputs)
        self._store = store
        self.deadline_ns = deadline_ns
        self._cancel = cancel_event
        self._output_types = dict(output_types)
        self.outputs: dict[str, dict[str, Any]] = {}
        self._files: list[OutputFile] = []
        self._preview_sink = preview_sink
        self._preview_lock = threading.Lock()
        self._preview_drop_reasons: set[str] = set()

    # cancel／deadline ---------------------------------------------------------
    def cancelled(self) -> bool:
        """Check whether the invocation has been cancelled."""
        return self._cancel.is_set() or mono_ns() >= self.deadline_ns

    def check_cancelled(self) -> None:
        """Raise the provider cancellation exception when signalled."""
        if self._cancel.is_set():
            raise Cancelled("取消要求")
        if mono_ns() >= self.deadline_ns:
            raise ComponentError("CALL_TIMEOUT", "超過本次呼叫期限")

    def remaining_seconds(self) -> float:
        """Return the remaining invoke budget in seconds."""
        return max(0.0, (self.deadline_ns - mono_ns()) / 1e9)

    @property
    def cancel_token(self) -> CancelToken:
        """Return the cancellation protocol for this invoke."""
        return CancelToken(self)

    # inputs -------------------------------------------------------------------
    def input(self, name: str) -> InputValue:
        """Look up a required input port."""
        if name not in self.inputs:
            raise ComponentError("INVALID_ARGUMENT", f"缺少輸入 {name}")
        return self.inputs[name]

    def optional_input(self, name: str) -> InputValue | None:
        """Look up an optional input port."""
        return self.inputs.get(name)

    def resolve_file(self, ref: Mapping[str, Any]) -> Path:
        """把任意 FileRef 物化成本機完整檔（同 Node 直接路徑、跨 Node 由 Node 直接下載並驗 size/SHA）."""
        if self._resolver is None:
            raise ComponentError("RUNTIME_ERROR", "此執行環境沒有檔案 resolver")
        return Path(self._resolver(dict(ref), self.remaining_seconds()))

    # outputs ------------------------------------------------------------------
    def _type_for(self, port: str, type_id: str | None) -> str:
        declared = self._output_types.get(port)
        if declared is None:
            raise ComponentError(
                "RUNTIME_ERROR", f"provider 嘗試寫入未宣告的輸出 {port}"
            )
        if type_id is not None and type_id != declared:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"輸出 {port} 宣告為 {declared}，provider 寫入 {type_id}",
            )
        return declared

    @property
    def output_types(self) -> dict[str, str]:
        """The output ports the caller expects, with their declared type ids (a copy)."""
        return dict(self._output_types)

    def output_type(self, port: str) -> str | None:
        """The type id the caller declared for output ``port`` (``None`` when it is not expected)."""
        return self._output_types.get(port)

    def file_ref(self, out: OutputFile) -> dict[str, Any]:
        """The FileRef of a finished output file (for a primary file's ``metadata.links`` or an inline asset)."""
        if not out.finished or out.sha256 is None:
            raise ComponentError("RUNTIME_ERROR", "檔案尚未完成，不能引用")
        return {
            "node_id": str(self.recorder.node_id),
            "file_id": out.file_id,
            "size_bytes": out.size,
            "sha256": out.sha256,
            "media_type": out.media_type,
            "metadata": dict(out.metadata),
        }

    def set_output(self, port: str, value: Any, *, type_id: str | None = None) -> None:
        """Publish an inline value on an output port."""
        self.outputs[port] = {"type_id": self._type_for(port, type_id), "value": value}

    def new_file(
        self,
        port: str | None,
        media_type: str,
        metadata: Mapping[str, Any] | None = None,
        *,
        type_id: str | None = None,
    ) -> OutputFile:
        """port=None 時是附屬檔（例如 latent blob），之後放進主檔 metadata.links."""
        tid = (
            self._type_for(port, type_id)
            if port is not None
            else (type_id or "file.attachment.v1")
        )
        out = OutputFile(
            self._store,
            port=port or "",
            type_id=tid,
            media_type=media_type,
            metadata=metadata,
            recorder=self.recorder,
        )
        self._files.append(out)
        return out

    def set_file_output(self, port: str, out: OutputFile) -> None:
        """Publish a file on an output port."""
        if not out.finished:
            out.finish()
        self.outputs[port] = out.wire()

    def pending_files(self) -> list[OutputFile]:
        """Return the file outputs awaiting publication."""
        return list(self._files)

    # intermediate previews ----------------------------------------------------
    @property
    def preview_enabled(self) -> bool:
        """這次呼叫有預覽通道（runtime host 與 Node 都支援）且尚未取消。False 時 provider 可以不產生預覽."""
        return self._preview_sink is not None and not self.cancelled()

    def publish_preview(  # noqa: PLR0913 - Keep the published positional and keyword API.
        self,
        *,
        step: int,
        total: int,
        data: bytes | bytearray | memoryview,
        media_type: str,
        width: int,
        height: int,
        note: str | None = None,
    ) -> bool:
        """交出一張中間預覽（非最終結果；best-effort，不阻塞）.

        True=已交給 runtime host 轉送（之後仍可能被更新的預覽取代而不送出）；False=這張被丟棄：
        沒有預覽通道、呼叫已取消或超過期限、超過 2 MiB。背壓時只保留最新的一張待送，絕不因背壓拋例外。
        參數錯誤（型別、範圍、media_type 與內容不符、width×height 與影像標頭不同）是 provider 的
        程式錯誤 → ComponentError(RUNTIME_ERROR)。``step``／``total``：provider 的進度（例如已完成的
        去噪步數／總步數，0 ≤ step ≤ total）。不壓縮、不縮圖、不改寫影像內容。
        """
        payload, step, total, width, height = checked_preview(
            step=step,
            total=total,
            data=data,
            media_type=media_type,
            width=width,
            height=height,
            note=note,
        )
        if self._preview_sink is None or self.cancelled():
            return False  # 沒有預覽通道（provider 可先看 preview_enabled）或呼叫正在結束：不計入丟棄
        if len(payload) > PREVIEW_MAX_BYTES:
            self._preview_dropped(
                "too_large",
                f"中間預覽 {len(payload)} bytes 超過上限 {PREVIEW_MAX_BYTES} bytes：已丟棄（不壓縮、不縮圖）",
            )
            return False
        frame = PreviewFrame(
            call_id=self.call_id,
            step=step,
            total=total,
            data=payload,
            media_type=media_type,
            width=width,
            height=height,
            note=note[:PREVIEW_NOTE_MAX] if note is not None else None,
            published_ns=mono_ns(),
        )
        try:
            accepted = bool(self._preview_sink(frame))
        except Exception as exc:  # noqa: BLE001 - A preview sink failure must not stop inference.
            self._preview_dropped(
                "sink_error", f"中間預覽轉送失敗（已丟棄）：{type(exc).__name__}: {exc}"
            )
            return False
        if not accepted:
            self._preview_dropped(
                "not_accepted", "中間預覽通道已關閉或呼叫已結束：之後的預覽都會被丟棄"
            )
        return accepted

    def _preview_dropped(self, reason: str, message: str) -> None:
        self.recorder.count("preview.dropped_count")
        with self._preview_lock:
            first = reason not in self._preview_drop_reasons
            self._preview_drop_reasons.add(reason)
        if first:  # 同一原因每次呼叫只記一次 log／note，計數照常累加
            self.recorder.log("warning", message, preview_drop_reason=reason)
            self.recorder.note(message)


class UnloadContext(_BaseContext):
    """Lifecycle context for unloading a provider."""


__all__ = ["CancelToken", "InputValue", "LoadContext", "RunContext", "UnloadContext"]
