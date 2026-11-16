"""元件程序入口：一個 instance 一個隔離 runtime 程序。

    python -m phasyn_components.runtime_host --provider ID --component-id X --node-id UUID \
        --process-instance-id UUID --data-dir DIR --device-json JSON [--telemetry-fd N]
    python -m phasyn_components.runtime_host --describe --provider ID [--settings-json JSON|@file]
    python -m phasyn_components.runtime_host --weights --provider ID [--settings-json JSON|@file]

stdout 只給控制協定（其他輸出都轉到 stderr，由 Node 留檔並轉成 log 事件）。stdin EOF 表示
Node 已不在：取消進行中的工作並結束自己。Linux 另設 PDEATHSIG。

中間預覽（``RunContext.publish_preview``）走 Node 以環境變數 ``PHASYN_PREVIEW_FD`` 交給的獨立 pipe，
不經控制通道（見 :mod:`phasyn_components.preview_pipe`）；沒有這個 FD → 預覽停用。
"""

from __future__ import annotations

import argparse
import contextlib
import gc
import json
import os
import signal
import sys
import threading
import time
import traceback
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION
from .canonical import digest
from .errors import (
    Cancelled,
    ComponentError,
    exception_details,
    exception_message,
    exception_summary,
    to_component_error,
    with_cleanup_report,
)
from .files import FileStore
from .ipc import ControlWriter, TelemetryPipe, decode
from .preview_pipe import PREVIEW_HEADER_MAX, PreviewForwarder
from .provider import (
    Description,
    InputValue,
    LoadContext,
    LoadResult,
    ProviderHost,
    RunContext,
    UnloadContext,
)
from .recorder import Recorder, environment_facts
from .registry import load_provider_class
from .runtime_env import RUNTIME_ID_ENV, SOURCE_REVISION_ENV
from .settings import deep_overlay, effective_context, resolve_parts, validate_part_values
from .timeutil import mono_ns
from .weights import WeightPlan

STREAM_ID = "runtime"


def _set_pdeathsig() -> None:
    if not sys.platform.startswith("linux"):
        return
    with contextlib.suppress(Exception):  # 非 glibc 平台：改由 stdin EOF 結束
        import ctypes

        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        pr_set_pdeathsig = 1
        libc.prctl(pr_set_pdeathsig, signal.SIGTERM)


def _loadavg() -> float | None:
    """The host's 1-minute load average (``None`` where the platform has none)."""
    try:
        return round(os.getloadavg()[0], 3)
    except OSError:
        return None


def _claim_stdout() -> Any:
    """保留原 stdout fd 給控制協定；之後任何 print 都寫到 stderr。"""
    ipc_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(ipc_fd, "wb", buffering=0)


def describe(provider_id: str, settings: Mapping[str, Any] | None) -> dict[str, Any]:
    cls = load_provider_class(provider_id)
    desc: Description = cls.describe(settings)
    return desc.to_dict()


def weights(provider_id: str, settings: Mapping[str, Any] | None) -> dict[str, Any]:
    """The provider's weight plan for these settings: the pinned files it needs and
    where they go under its model root. A provider without a ``weights`` classmethod needs no downloadable weights."""
    cls = load_provider_class(provider_id)
    plan_fn = getattr(cls, "weights", None)
    if plan_fn is None:
        return WeightPlan(root=None).to_dict()
    plan = plan_fn(settings)
    if not isinstance(plan, WeightPlan):
        raise ComponentError("RUNTIME_ERROR", f"provider {provider_id} 的 weights() 沒有回傳 WeightPlan")
    return plan.to_dict()


def list_providers() -> list[dict[str, Any]]:
    from .registry import known_providers

    items: list[dict[str, Any]] = []
    for provider_id in known_providers():
        try:
            desc = load_provider_class(provider_id).describe(None)
            items.append(
                {
                    "provider_id": provider_id,
                    "kind": desc.kind,
                    "label": desc.label,
                    "available": desc.available,
                    "reason": desc.unavailable_reason,
                    "synthetic": desc.synthetic,
                    "default_settings": desc.default_settings,
                }
            )
        except ComponentError as exc:
            items.append(
                {
                    "provider_id": provider_id,
                    "kind": "unknown",
                    "label": provider_id,
                    "available": False,
                    "reason": exc.message,
                    "synthetic": False,
                    "default_settings": None,
                }
            )
        except Exception as exc:
            items.append(
                {
                    "provider_id": provider_id,
                    "kind": "unknown",
                    "label": provider_id,
                    "available": False,
                    "reason": f"{type(exc).__name__}: {exception_message(exc)}"[:500],
                    "synthetic": False,
                    "default_settings": None,
                }
            )
    return items


def _input_summary(inputs: Mapping[str, InputValue], capture_prompt: bool) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, item in inputs.items():
        if item.file is not None:
            ref = item.file
            out[name] = {
                "type_id": item.type_id,
                "file": {k: ref.get(k) for k in ("node_id", "file_id", "sha256", "size_bytes", "media_type")},
                "metadata": ref.get("metadata"),
                "links": {
                    k: {"file_id": v[0].get("file_id"), "sha256": v[0].get("sha256")} for k, v in item.links.items()
                },
            }
        else:
            value = item.value
            if not capture_prompt and isinstance(value, (str, Mapping, list)):
                out[name] = {"type_id": item.type_id, "value_digest": digest(value), "captured": False}
            else:
                out[name] = {"type_id": item.type_id, "value": value}
    return out


class RuntimeHost:
    def __init__(self, args: argparse.Namespace, control: ControlWriter, telemetry: TelemetryPipe) -> None:
        self.provider_id: str = args.provider
        self.component_id: str = args.component_id
        self.node_id: str = args.node_id
        self.process_instance_id: str = args.process_instance_id
        self.data_dir = Path(args.data_dir)
        self.device: dict[str, Any] = json.loads(args.device_json)
        self.control = control
        self.telemetry = telemetry
        self.recordings_root = self.data_dir / "recordings"
        self.work_dir = self.data_dir / "work" / self.component_id / self.process_instance_id
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.store = FileStore(self.data_dir, self.node_id)
        self.provider_cls = load_provider_class(self.provider_id)
        self.provider: Any = None
        self.description: Description | None = None
        self.loaded_settings: dict[str, Any] | None = None
        self.load_result: LoadResult | None = None
        self.loaded_revision: int | None = None
        self.load_digest: str | None = None  # digest of the provider's effective load: the cost profile key
        self.invokes_since_load = 0
        self.active_call: str | None = None
        self.cancel_event = threading.Event()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self.exiting = threading.Event()
        self._resolves: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self.previews = PreviewForwarder.from_env()

    # ---------------------------------------------------------------- file resolver
    def resolve(self, ref: dict[str, Any], timeout_s: float) -> str:
        """請 Node 物化 FileRef（Node 是唯一 data root writer 與檔案下載者）。"""
        request_id = f"r-{os.getpid()}-{len(self._resolves) + 1}-{mono_ns()}"
        done = threading.Event()
        slot: dict[str, Any] = {}
        with self._lock:
            self._resolves[request_id] = (done, slot)
        self.send({"type": "resolve", "request_id": request_id, "file": ref})
        if not done.wait(timeout=max(1.0, timeout_s)):
            with self._lock:
                self._resolves.pop(request_id, None)
            raise ComponentError("CALL_TIMEOUT", "等待 Node 物化檔案逾時")
        if slot.get("error"):
            raise ComponentError.from_dict(slot["error"])
        return str(slot["path"])

    def handle_resolved(self, msg: dict[str, Any]) -> None:
        with self._lock:
            entry = self._resolves.pop(str(msg.get("request_id")), None)
        if entry is None:
            return
        done, slot = entry
        slot.update({"path": msg.get("path"), "error": msg.get("error")})
        done.set()

    # ---------------------------------------------------------------- helpers
    def recorder(
        self,
        *,
        recording_id: str,
        operation: str,
        config: Mapping[str, Any] | None,
        run_id: str | None = None,
        call_id: str | None = None,
    ) -> Recorder:
        synthetic = bool(self.description.synthetic) if self.description else False
        return Recorder(
            recordings_root=self.recordings_root,
            recording_id=recording_id,
            stream_id=STREAM_ID,
            node_id=self.node_id,
            component_id=self.component_id,
            provider_id=self.provider_id,
            process_instance_id=self.process_instance_id,
            operation=operation,
            run_id=run_id,
            call_id=call_id,
            config=config,
            publish=self.telemetry.publish,
            synthetic=synthetic,
            track_process_cpu=True,
        )

    def environment(self) -> dict[str, Any]:
        env = environment_facts()
        env["device"] = dict(self.device)
        env["source_revision"] = os.environ.get(SOURCE_REVISION_ENV)
        env["runtime_id"] = os.environ.get(RUNTIME_ID_ENV)
        env["cuda_visible_devices"] = os.environ.get("CUDA_VISIBLE_DEVICES")
        return env

    def _cost_facts(self, rec: Recorder, *, warm: bool | None, loadavg_start: float | None) -> None:
        """The generic part of the recording's ``cost`` block (providers add their stages themselves)."""
        rec.cost_facts(
            load_digest=self.load_digest,
            warm=warm,
            loadavg={"start": loadavg_start, "end": _loadavg()},
            device_id=str(self.device["id"]) if self.device.get("id") is not None else None,
            source_revision=os.environ.get(SOURCE_REVISION_ENV),
        )

    def send(self, message: dict[str, Any]) -> None:
        if not self.control.send(message):
            self.exiting.set()

    def _start_worker(self, target: Any, *args: Any) -> None:
        self._worker = threading.Thread(target=target, args=args, name="component-worker", daemon=True)
        self._worker.start()

    # ---------------------------------------------------------------- load
    def handle_load(self, msg: dict[str, Any]) -> None:
        if self.provider is not None:
            self.send({"type": "error", "code": "STATE_CONFLICT", "message": "元件已載入；restart 需先 stop"})
            return
        self._start_worker(self._do_load, msg)

    def _do_load(self, msg: dict[str, Any]) -> None:
        settings = dict(msg["settings"])
        revision = int(msg["stored_revision"])
        rec = self.recorder(recording_id=msg["recording_id"], operation="load", config=settings.get("recording"))
        requested_ctx = effective_context(
            requested=settings,
            effective=settings,
            observed={},
            stored_revision=revision,
            loaded_revision=None,
            expanded_parts={},
            model_identity={},
            runtime_identity={},
        )
        rec.write_context(settings=requested_ctx, environment=self.environment())
        loadavg_start = _loadavg()
        load_started = time.perf_counter_ns()
        try:
            with rec.span("load", phase="load", critical=True):
                self.description = self.provider_cls.describe(settings)
                if not self.description.available:
                    raise ComponentError(
                        self.description.unavailable_code or "COMPONENT_NOT_CONFIGURED",
                        self.description.unavailable_reason or "provider 目前不可用",
                    )
                parts = [p.to_dict() for p in self.description.parts]
                load = settings.get("load") or {}
                expanded = resolve_parts(parts, load.get("precision") or {}, load.get("part_overrides") or [])
                validate_part_values(parts, expanded)
                host = ProviderHost(
                    node_id=self.node_id,
                    component_id=self.component_id,
                    data_dir=self.data_dir,
                    work_dir=self.work_dir,
                    device=self.device,
                    process_instance_id=self.process_instance_id,
                )
                provider = self.provider_cls(host)
                result: LoadResult = provider.load(
                    LoadContext(
                        expanded_parts=expanded,
                        recorder=rec,
                        device=self.device,
                        work_dir=self.work_dir,
                        settings=settings,
                    )
                )
                if not result.expanded_parts:
                    result.expanded_parts = expanded
        except BaseException as exc:
            err = to_component_error(exc)
            rec.log("error", f"載入失敗：{err.message}", **exception_details(exc))
            summary = rec.finalize("failed", error=err.to_dict())
            self.send({"type": "load_done", "ok": False, "error": err.to_dict(), "summary": summary})
            self.exiting.set()
            return
        load_ms = (time.perf_counter_ns() - load_started) / 1e6
        self.provider = provider
        self.load_result = result
        self.loaded_settings = settings
        self.loaded_revision = revision
        self.load_digest = digest(result.effective_load)
        self.invokes_since_load = 0
        rec.record_cost("load", work=1, unit="call", compute_ms=load_ms)
        self._cost_facts(rec, warm=None, loadavg_start=loadavg_start)
        effective = deep_overlay(settings, {"load": result.effective_load})
        ctx = effective_context(
            requested=settings,
            effective=effective,
            observed=result.observed,
            stored_revision=revision,
            loaded_revision=revision,
            expanded_parts=result.expanded_parts,
            model_identity=result.model_identity,
            runtime_identity=result.runtime_identity,
        )
        rec.write_context(settings=ctx, environment=self.environment())
        summary = rec.finalize("succeeded")
        parts = [p.to_dict() for p in (result.parts or self.description.parts)]
        self.send(
            {
                "type": "load_done",
                "ok": True,
                "effective_load": result.effective_load,
                "observed": result.observed,
                "expanded_parts": result.expanded_parts,
                "model_identity": result.model_identity,
                "runtime_identity": result.runtime_identity,
                "parts": parts,
                "settings_context": ctx,
                "summary": summary,
            }
        )

    # ---------------------------------------------------------------- invoke
    def handle_invoke(self, msg: dict[str, Any]) -> None:
        with self._lock:
            if self.provider is None:
                self.send(
                    {
                        "type": "run_done",
                        "call_id": msg.get("call_id"),
                        "state": "failed",
                        "outputs": {},
                        "files": [],
                        "error": ComponentError("COMPONENT_NOT_READY", "元件尚未載入").to_dict(),
                        "summary": None,
                        "settings": None,
                    }
                )
                return
            if self.active_call is not None:
                self.send(
                    {
                        "type": "run_done",
                        "call_id": msg.get("call_id"),
                        "state": "failed",
                        "outputs": {},
                        "files": [],
                        "error": ComponentError("COMPONENT_BUSY", "元件已有進行中的呼叫").to_dict(),
                        "summary": None,
                        "settings": None,
                    }
                )
                return
            self.active_call = str(msg["call_id"])
            self.cancel_event = threading.Event()
        self._start_worker(self._do_invoke, msg)

    def _do_invoke(self, msg: dict[str, Any]) -> None:
        call_id = str(msg["call_id"])
        recording = dict(msg.get("recording") or {})
        rec = self.recorder(
            recording_id=msg["recording_id"],
            operation="invoke",
            config=recording,
            run_id=msg.get("run_id"),
            call_id=call_id,
        )
        inputs: dict[str, InputValue] = {}
        for name, item in (msg.get("inputs") or {}).items():
            links = {k: (dict(v["file"]), Path(v["path"])) for k, v in (item.get("links") or {}).items()}
            inputs[name] = InputValue(
                type_id=item["type_id"],
                value=item.get("value"),
                file=item.get("file"),
                path=Path(item["path"]) if item.get("path") else None,
                links=links,
            )
        # handle_invoke starts a call only after a successful load, which sets both together
        assert self.loaded_settings is not None and self.load_result is not None
        sent_defaults = msg.get("invoke_defaults")
        if isinstance(sent_defaults, dict):  # Node 送來受理當下的 stored 快照（可以是空的）
            invoke_defaults = dict(sent_defaults)
        else:
            invoke_defaults = dict(self.loaded_settings.get("invoke") or {})
        requested_params = dict(msg.get("parameters") or {})
        params = deep_overlay(invoke_defaults, requested_params)
        call_settings = {"load": self.loaded_settings.get("load"), "invoke": invoke_defaults, "recording": recording}
        requested = {**call_settings, "parameters": requested_params}
        effective = {
            "load": self.load_result.effective_load,
            "invoke": invoke_defaults,
            "recording": recording,
            "parameters": params,
        }
        ctx_settings = effective_context(
            requested=requested,
            effective=effective,
            observed=dict(self.load_result.observed),
            stored_revision=int(msg.get("stored_revision") or self.loaded_revision or 1),
            loaded_revision=self.loaded_revision,
            expanded_parts=self.load_result.expanded_parts,
            model_identity=self.load_result.model_identity,
            runtime_identity=self.load_result.runtime_identity,
        )
        rec.write_context(
            settings=ctx_settings,
            input_summary=_input_summary(inputs, bool(recording.get("capture_prompt", True))),
            environment=self.environment(),
        )
        previews = self.previews if self.previews is not None and self.previews.available else None
        if previews is not None:
            previews.begin_call(call_id, rec)
        run_ctx = RunContext(
            call_id=call_id,
            run_id=msg.get("run_id"),
            step_id=msg.get("step_id"),
            parameters=params,
            inputs=inputs,
            store=self.store,
            deadline_ns=int(msg.get("deadline_ns") or (mono_ns() + 7200 * 10**9)),
            cancel_event=self.cancel_event,
            output_types=dict(msg.get("output_types") or {}),
            recorder=rec,
            device=self.device,
            work_dir=self.work_dir,
            settings=call_settings,
            resolver=self.resolve,
            preview_sink=previews.offer if previews is not None else None,
        )
        state, error = "succeeded", None
        warm = self.invokes_since_load > 0
        self.invokes_since_load += 1
        loadavg_start = _loadavg()
        try:
            with rec.span("invoke", critical=True):
                self.provider.invoke(run_ctx)
            if self.cancel_event.is_set():
                state = "cancelled"
        except Cancelled:
            state = "cancelled"
        except BaseException as exc:
            err = to_component_error(exc)
            if err.code == "CANCELLED":
                state = "cancelled"
            else:
                state, error = "failed", err.to_dict()
                rec.log("error", f"呼叫失敗：{err.message}", **exception_details(exc))
                print(
                    "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)), file=sys.stderr, flush=True
                )
                # The exception is still live: every frame of its traceback holds the provider's locals
                # (GPU tensors). Drop those locals and collect them first; otherwise the cached GPU memory
                # stays referenced after an OOM and after_failure cannot free it.
                traceback.clear_frames(exc.__traceback__)
                gc.collect()
                cleanup = self._after_failure(rec, err.code)
                gc.collect()
                if cleanup is not None:
                    error = with_cleanup_report(error, cleanup)
        if previews is not None:  # run_done 之前：未送出的預覽丟棄，傳送中的寫完（最終輸出才是結果）
            previews.end_call(call_id)
        files = []
        for out in run_ctx.pending_files():
            if state == "succeeded" and out.finished:
                files.append(out.wire()["pending_file"])
            else:
                out.abort()
        outputs = run_ctx.outputs if state == "succeeded" else {}
        if state == "succeeded":
            declared = set(run_ctx.output_types)
            missing = sorted(declared - set(outputs))
            if missing:
                rec.note(f"未產生的輸出（本次任務不適用）：{', '.join(missing)}")
        self._cost_facts(rec, warm=warm, loadavg_start=loadavg_start)
        summary = rec.finalize(state, error=error)
        if state == "cancelled" and error is None:
            error = ComponentError("CANCELLED", "呼叫已取消").to_dict()
        with self._lock:
            self.active_call = None
        self.send(
            {
                "type": "run_done",
                "call_id": call_id,
                "state": state,
                "outputs": outputs,
                "files": files,
                "error": error,
                "summary": summary,
                "settings": ctx_settings,
            }
        )

    def _after_failure(self, rec: Recorder, code: str) -> dict[str, Any] | None:
        """Run the provider's optional ``after_failure(code)`` hook and return its cleanup report, if any.

        It runs once the failed call's frames are cleared and collected, so the provider only sees what it keeps
        itself. It may return a JSON-serializable mapping describing the cleanup; that report is logged here and the
        caller attaches it to the error (:func:`~phasyn_components.errors.with_cleanup_report`). A hook that raises
        never replaces the original failure.
        """
        after = getattr(self.provider, "after_failure", None)
        if not callable(after):
            return None
        try:
            report = after(code)
        except Exception as exc:
            rec.log("warning", "失敗後的清理出錯（原本的錯誤不變）", **exception_summary(exc))
            return None
        if not isinstance(report, Mapping):
            return None
        cleanup = dict(report)
        reload_required = bool(cleanup.get("reload_required"))
        rec.log("warning" if reload_required else "info", "失敗後的資源清理", cleanup=cleanup)
        if reload_required and isinstance(cleanup.get("reason"), str):
            rec.note(str(cleanup["reason"]))
        return cleanup

    # ---------------------------------------------------------------- cancel/unload
    def handle_cancel(self, msg: dict[str, Any]) -> None:
        call_id = msg.get("call_id")
        with self._lock:
            accepted = self.active_call is not None and call_id == self.active_call
            if accepted:
                self.cancel_event.set()
        self.send({"type": "cancel_ack", "call_id": call_id, "accepted": accepted})

    def handle_unload(self, msg: dict[str, Any]) -> None:
        rec = self.recorder(
            recording_id=msg["recording_id"], operation="unload", config=(self.loaded_settings or {}).get("recording")
        )
        rec.write_context(settings=None, environment=self.environment())
        state, error = "succeeded", None
        try:
            with rec.span("unload", critical=True):
                if self.provider is not None:
                    self.provider.unload(
                        UnloadContext(
                            recorder=rec,
                            device=self.device,
                            work_dir=self.work_dir,
                            settings=self.loaded_settings or {},
                        )
                    )
        except BaseException as exc:
            err = to_component_error(exc)
            state, error = "failed", err.to_dict()
        self.provider = None
        summary = rec.finalize(state, error=error)
        self.send({"type": "bye", "summary": summary, "error": error})
        self.exiting.set()


def serve(args: argparse.Namespace) -> int:
    _set_pdeathsig()
    ipc_out = _claim_stdout()
    control = ControlWriter(ipc_out)
    telemetry = TelemetryPipe(args.telemetry_fd)
    try:
        host = RuntimeHost(args, control, telemetry)
    except ComponentError as exc:
        control.send({"type": "error", **exc.to_dict()})
        return 3
    control.send(
        {
            "type": "hello",
            "pid": os.getpid(),
            "provider_id": host.provider_id,
            "protocol": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
        }
    )
    stdin = sys.stdin.buffer

    def reader() -> None:
        while not host.exiting.is_set():
            line = stdin.readline()
            if not line:  # Node 已離開：取消進行中的工作
                host.cancel_event.set()
                host.exiting.set()
                return
            try:
                msg = decode(line)
            except ValueError as exc:
                control.send({"type": "error", "code": "PROTOCOL_ERROR", "message": f"無法解析控制訊息：{exc}"})
                continue
            kind = msg["type"]
            if kind == "load":
                host.handle_load(msg)
            elif kind == "invoke":
                host.handle_invoke(msg)
            elif kind == "cancel":
                host.handle_cancel(msg)
            elif kind == "unload":
                host.handle_unload(msg)
                return
            elif kind == "resolved":
                host.handle_resolved(msg)
            elif kind == "ping":
                control.send({"type": "pong"})

    thread = threading.Thread(target=reader, name="control-reader", daemon=True)
    thread.start()
    host.exiting.wait()
    worker = host._worker
    if worker is not None and worker.is_alive():
        worker.join(timeout=10)
    if host.previews is not None:
        host.previews.close()
    telemetry.close()
    with contextlib.suppress(Exception):
        ipc_out.flush()
    os._exit(0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="phasyn_components.runtime_host")
    parser.add_argument("--provider")
    parser.add_argument("--describe", action="store_true")
    parser.add_argument(
        "--weights", action="store_true", help="輸出這組設定需要的固定版本權重檔清單（不下載、不載入模型）"
    )
    parser.add_argument(
        "--list", action="store_true", help="列出此 runtime 已安裝的 provider（describe 摘要，不載入模型）"
    )
    parser.add_argument("--settings-json")
    parser.add_argument("--component-id")
    parser.add_argument("--node-id")
    parser.add_argument("--process-instance-id")
    parser.add_argument("--data-dir")
    parser.add_argument("--device-json", default='{"kind":"cpu","id":"cpu","resource_group":"cpu"}')
    parser.add_argument("--telemetry-fd", type=int)
    args = parser.parse_args(argv)
    if args.list:
        out_fh = _claim_stdout()
        out_fh.write((json.dumps({"ok": True, "items": list_providers()}, ensure_ascii=False) + "\n").encode("utf-8"))
        out_fh.flush()
        return 0
    if not args.provider:
        parser.error("--provider is required")
    if args.describe or args.weights:
        settings = None
        if args.settings_json:
            text = args.settings_json
            if text.startswith("@"):
                text = Path(text[1:]).read_text(encoding="utf-8")
            settings = json.loads(text)
        out_fh = _claim_stdout()
        try:
            if args.weights:
                out = {"ok": True, "plan": weights(args.provider, settings)}
            else:
                out = {"ok": True, "description": describe(args.provider, settings)}
        except ComponentError as exc:
            out = {"ok": False, "error": exc.to_dict()}
        except Exception as exc:
            out = {"ok": False, "error": to_component_error(exc).to_dict()}
        out_fh.write((json.dumps(out, ensure_ascii=False) + "\n").encode("utf-8"))
        out_fh.flush()
        return 0
    for name in ("component_id", "node_id", "process_instance_id", "data_dir"):
        if not getattr(args, name):
            parser.error(f"--{name.replace('_', '-')} is required")
    return serve(args)


# PREVIEW_HEADER_MAX is re-exported for the Node's preview reader (defined in preview_pipe).
__all__ = ["PREVIEW_HEADER_MAX", "STREAM_ID", "RuntimeHost", "describe", "list_providers", "main", "serve", "weights"]


if __name__ == "__main__":
    sys.exit(main())
