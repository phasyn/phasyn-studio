"""ComponentInstance: the component process of one ``node_id + component_id``.

States: stopped → loading → ready ⇄ busy, or error; a stop goes stopping → stopped. ``_set_state`` is the only
place that writes the state, and every change is reported to the catalog.

- start is a no-op while loading/ready/busy and a 409 while stopping. Once the spawn is accepted the HTTP
  answer is 200 (loading); the model loads in the background: hello (≤ 60 s) → load → load_done
  (≤ ``load_timeout_seconds``).
- load and invoke take the ``resource_group`` try-lock (check and take in one synchronous step): busy →
  DEVICE_BUSY. A member of an ``exclusive_group`` also needs its group free (see :mod:`phasyn_node.exclusive`).
- A failed load → error (nothing loaded), the own process group is terminated; never restarted or reloaded.
- stop: busy → 409; loading → terminate; ready/error → unload → bye + exit (≤ 60 s) → SIGTERM → SIGKILL after
  ``cancel_grace_seconds`` → confirmed by waitpid. HTTP answers "stopping" first; an exit that cannot be
  confirmed ends in error (PROCESS_EXIT_UNCONFIRMED).
- restart only when idle (ready/error/stopped): stop, then start with the *stored* settings; a failure stays in
  error (no rollback to the old settings).
- An unexpected exit → error (RUNTIME_EXITED), nothing loaded; a running call ends with RUNTIME_ERROR.
- label/folder/autostart/limits change in any state: only the definition is saved (no reload, no revision).
- A definition is deleted only when stopped/error with no process, call or pending restart; afterwards every
  start/stop/save through an old reference is NOT_FOUND.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import copy
import json
import logging
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from phasyn_components import PROTOCOL_VERSION, contracts
from phasyn_components.errors import ComponentError, exception_summary
from phasyn_components.fs import atomic_write_json
from phasyn_components.ids import new_id
from phasyn_components.recorder import Recorder
from phasyn_components.settings import SettingsState
from phasyn_components.timeutil import utc_now
from phasyn_components.typed import check_typed_value

from . import exclusive
from .call import ActiveCall, check_inputs
from .describe import DescribeResult
from .descriptor import ComponentState, RecorderState, facts, normalize_error, parts, ports, recorder_state_of
from .previews import NodePreview
from .runtime import Aborted, RuntimeGone, RuntimeProcess, describe_returncode
from .settings_check import check_settings
from .sysinfo import runtime_env

if TYPE_CHECKING:
    from .config import RuntimeEntry
    from .service import NodeService

log = logging.getLogger("phasyn_node.supervisor")

HELLO_TIMEOUT_S = 60.0
UNLOAD_TIMEOUT_S = 60.0
EXIT_AFTER_LOAD_FAILURE_S = 15.0
RECENT_CALLS = 128
TRANSITIONAL_STATES = frozenset({"loading", "stopping"})
_ERROR_HINTS = ("traceback", "error", "exception", "warning", "fatal", "killed")


class _Unchanged:
    pass


UNCHANGED: Final = _Unchanged()


class ComponentInstance:
    def __init__(self, service: NodeService, settings: SettingsState) -> None:
        self.service = service
        self.settings = settings
        self.state: ComponentState = "stopped"  # written only by _set_state()
        self.last_error: dict[str, Any] | None = None
        self.process: RuntimeProcess | None = None
        self.active_call: ActiveCall | None = None
        self.loaded_description: dict[str, Any] | None = None
        # ((stored_revision, describe time), problem): the provider's verdict on the stored settings
        self._settings_checked: tuple[tuple[int, float], dict[str, Any] | None] | None = None
        self.loaded_parts: list[dict[str, Any]] | None = None
        self.load_context: dict[str, Any] | None = None
        self.recorder_state: RecorderState = "unknown"
        self.spawn_count = 0
        self.deleted = False
        self._control_lock = asyncio.Lock()
        self._settings_lock = asyncio.Lock()
        self._settled = asyncio.Event()
        self._settled.set()
        self._task: asyncio.Task[None] | None = None
        self._load_abort: asyncio.Event | None = None
        self._restart_pending = False
        self._active: tuple[Recorder, RuntimeProcess | None] | None = None
        self._recent_calls: collections.OrderedDict[str, str] = collections.OrderedDict()

    # ------------------------------------------------------------------ identity
    @property
    def component_id(self) -> str:
        return str(self.settings.definition["component_id"])

    @property
    def provider_id(self) -> str:
        return str(self.settings.definition["provider_id"])

    @property
    def runtime_id(self) -> str:
        return str(self.settings.definition["runtime_id"])

    @property
    def label(self) -> str:
        return str(self.settings.definition.get("label") or self.component_id)

    @property
    def folder(self) -> str | None:
        """Interface folder (ComponentFolder); None when unset."""
        value = self.settings.definition.get("folder")
        return str(value) if value else None

    @property
    def autostart(self) -> bool:
        return bool(self.settings.definition.get("autostart", False))

    @property
    def exclusive_group(self) -> str | None:
        """InstanceDefinition.exclusive_group (members of one group are never loaded together on a Node)."""
        value = self.settings.definition.get("exclusive_group")
        return str(value) if value else None

    @property
    def restart_pending(self) -> bool:
        return self._restart_pending

    @property
    def config_path(self) -> Path:
        return self.service.components_dir / f"{self.component_id}.json"

    def _ensure_not_deleted(self) -> None:
        if self.deleted:
            raise ComponentError(
                "NOT_FOUND",
                f"這個 Node 沒有元件 {self.component_id}（已刪除）",
                details={"component_id": self.component_id},
            )

    def stored_device(self) -> dict[str, Any]:
        return dict(self.settings.stored["load"]["device"])

    def loaded_device(self) -> dict[str, Any]:
        loaded = self.settings.loaded
        if loaded and isinstance(loaded.get("device"), Mapping):
            return dict(loaded["device"])
        return self.stored_device()

    # ------------------------------------------------------------------ state
    def _set_state(self, state: ComponentState, *, error: dict[str, Any] | _Unchanged | None = UNCHANGED) -> None:
        """The only writer of ``state`` (and, when given, ``last_error``); every change is reported."""
        self.state = state
        if not isinstance(error, _Unchanged):
            self.last_error = error
        if state in TRANSITIONAL_STATES:
            self._settled.clear()
        else:
            self._settled.set()
        self.service.notify_change()

    async def wait_settled(self, timeout: float) -> bool:
        """Wait until the instance is neither loading nor stopping; False on timeout."""
        try:
            await asyncio.wait_for(self._settled.wait(), timeout=timeout)
        except TimeoutError:
            return False
        return True

    def _reset_loaded(self) -> None:
        """Forget everything that described the loaded model (before a load, and when a process ends)."""
        self.settings.mark_unloaded()
        self.loaded_parts = None
        self.load_context = None

    def _drop_process(self, proc: RuntimeProcess | None, *, exited: bool) -> None:
        """After an unload, kill, exit or failed load: the model is no longer loaded. The process (and the
        description of what it loaded) is forgotten only once its exit is confirmed: an unconfirmed process may
        still hold the device, so it stays visible (state error) instead of silently disappearing."""
        self._reset_loaded()
        if exited and self.process is proc:
            self.process = None
            self.loaded_description = None

    def remember_call(self, call_id: str, state: str) -> None:
        self._recent_calls[call_id] = state
        self._recent_calls.move_to_end(call_id)
        while len(self._recent_calls) > RECENT_CALLS:
            self._recent_calls.popitem(last=False)

    def recent_call_state(self, call_id: str) -> str | None:
        return self._recent_calls.get(call_id)

    def set_active_recorder(self, recorder: Recorder | None, proc: RuntimeProcess | None = None) -> None:
        """The Node-side recording of the current load/invoke/unload; that process's stderr becomes its log."""
        self._active = (recorder, proc) if recorder is not None else None

    def clear_active_recorder(self, recorder: Recorder) -> None:
        active = self._active
        if active is not None and active[0] is recorder:
            self._active = None

    @property
    def active_recorder(self) -> Recorder | None:
        active = self._active
        return active[0] if active is not None else None

    # ------------------------------------------------------------------ describe / descriptor
    async def describe_stored(self, *, refresh_failures: bool = False) -> DescribeResult:
        runtime = self.service.config.runtimes.get(self.runtime_id)
        if runtime is None:
            err = self._runtime_missing()
            return DescribeResult(None, err.to_dict(), 0.0)
        settings, _ = self.settings.snapshot()
        return await self.service.commands.describe(
            runtime, self.provider_id, settings, refresh_failures=refresh_failures
        )

    def runtime_entry(self) -> RuntimeEntry:
        """This instance's runtime from the Node configuration; RUNTIME_NOT_CONFIGURED when the config lacks it."""
        runtime = self.service.config.runtimes.get(self.runtime_id)
        if runtime is None:
            raise self._runtime_missing()
        return runtime

    def forget_configuration_error(self) -> None:
        """After weights were downloaded: a stopped instance no longer shows the COMPONENT_NOT_CONFIGURED of an
        earlier refused start (the next describe says whether anything is still missing)."""
        error = self.last_error or {}
        if self.state == "stopped" and error.get("code") == "COMPONENT_NOT_CONFIGURED":
            self._set_state("stopped", error=None)

    def _runtime_missing(self) -> ComponentError:
        return ComponentError(
            "RUNTIME_NOT_CONFIGURED",
            f"Node 設定沒有 runtime_id「{self.runtime_id}」；請在 node 設定檔的 runtimes 加上它或修改元件定義",
            details={"runtime_id": self.runtime_id, "known": sorted(self.service.config.runtimes)},
        )

    async def _view_description(
        self, *, cached_only: bool = False
    ) -> tuple[dict[str, Any] | None, DescribeResult | None]:
        if self.process is not None and self.loaded_description is not None:
            return self.loaded_description, None
        if cached_only:
            settings, _ = self.settings.snapshot()
            cached = self.service.commands.cached(self.runtime_id, self.provider_id, settings)
            return (cached.description if cached else None), cached
        result = await self.describe_stored()
        return result.description, result

    async def descriptor(self, *, cached_only: bool = False) -> dict[str, Any]:
        """``cached_only``: use cached describe results only (the last catalog push of a stopping Node)."""
        description, result = await self._view_description(cached_only=cached_only)
        return self.build_descriptor(description, result)

    def build_descriptor(self, description: Mapping[str, Any] | None, result: DescribeResult | None) -> dict[str, Any]:
        d = description or {}
        last_error = self.last_error
        if last_error is None and self.state == "stopped" and result is not None:
            last_error = self._settings_problem(result) if result.available else result.unavailable_error().to_dict()
        loaded = self.loaded_parts if self.loaded_parts is not None and self.state in ("ready", "busy") else None
        call = self.active_call
        return {
            "component_id": self.component_id,
            "label": self.label,
            "provider_id": self.provider_id,
            "runtime_id": self.runtime_id,
            "node_id": self.service.node_id,
            "state": self.state,
            "device": self.stored_device(),
            "api_path": f"/api/components/{self.component_id}",
            "inputs": ports(d.get("inputs")),
            "outputs": ports(d.get("outputs")),
            "parts": parts(loaded if loaded is not None else d.get("parts")),
            "settings": self.settings.view(
                dict(d.get("settings_schema") or {}), dict(d.get("parameters_schema") or {})
            ),
            "active_call_id": call.call_id if call is not None else None,
            "last_error": last_error,
            "recorder_state": self.recorder_state,
            "folder": self.folder,
            "autostart": self.autostart,
            "exclusive_group": self.exclusive_group,
            "limits": copy.deepcopy(self.settings.definition.get("limits")),
            "facts": facts(d.get("facts")),
        }

    def _settings_problem(self, result: DescribeResult) -> dict[str, Any] | None:
        """Why the provider refuses the stored settings (None when it accepts them); cached per revision and describe.

        The message says how to repair a stored definition: a settings PATCH cannot remove a field (null is a value),
        so a field the provider no longer knows goes only with a full replacement (PUT) or by recreating the instance.
        """
        key = (self.settings.stored_revision, result.at)
        if self._settings_checked is None or self._settings_checked[0] != key:
            try:
                check_settings(self.settings.definition, result.description or {})
                problem = None
            except ComponentError as err:
                problem = err.to_dict()
                problem["message"] = (
                    f"{err.message}。已保存的定義要修正後才能啟動：值可在設定中修改；provider 不認得的欄位"
                    "無法用設定 PATCH 移除，請以 PUT 送出整份修正後的定義，或刪除後重建"
                )
            self._settings_checked = (key, problem)
        return self._settings_checked[1]

    async def settings_view(self) -> dict[str, Any]:
        description, _ = await self._view_description()
        d = description or {}
        return self.settings.view(dict(d.get("settings_schema") or {}), dict(d.get("parameters_schema") or {}))

    # ------------------------------------------------------------------ definition / settings
    async def persist(self) -> None:
        async with self._settings_lock:
            self._ensure_not_deleted()
            record = self.settings.to_record()
            await asyncio.to_thread(atomic_write_json, self.config_path, record)

    async def replace_definition(self, definition: Mapping[str, Any]) -> None:
        async with self._control_lock:
            self._ensure_not_deleted()
            if self.state != "stopped":
                raise ComponentError(
                    "STATE_CONFLICT",
                    f"元件目前是 {self.state}，不能替換整份定義；執行中要改設定請使用 PATCH /api/components/{self.component_id}/settings",
                    details={"state": self.state},
                )
            self.settings.replace_definition(definition)
            self.last_error = None
            self.loaded_description = None
            await self.persist()

    async def patch_settings(self, body: Mapping[str, Any]) -> dict[str, Any]:
        """Save to ``stored`` only; the loaded model is untouched (allowed while busy)."""
        async with self._settings_lock:
            self._ensure_not_deleted()
            result = await self.describe_stored()
            d = result.description or {}
            self.settings.apply_patch(
                body["patch"],
                expected_revision=body.get("expected_revision"),
                settings_schema=d.get("settings_schema") or None,
                parts=list(d.get("parts") or []),
                lock_identity=self.state != "stopped",
            )
            record = self.settings.to_record()
            await asyncio.to_thread(atomic_write_json, self.config_path, record)
        self.service.notify_change()
        return await self.settings_view()

    async def patch_meta(self, body: Mapping[str, Any]) -> dict[str, Any]:
        """ComponentMetaPatch: label/folder/autostart/limits in any state.

        The definition file is written atomically before memory changes (a failed write changes neither); the
        process is untouched and ``stored_revision`` stays. ``autostart`` applies at the next Node start.
        """
        async with self._settings_lock:
            self._ensure_not_deleted()
            record = self.settings.meta_record(body)
            await asyncio.to_thread(atomic_write_json, self.config_path, record)
            self.settings.apply_meta(body)
        self.service.notify_change()
        return await self.descriptor()

    def _check_deletable(self) -> None:
        state = self.state
        if state not in ("stopped", "error"):
            raise ComponentError("STATE_CONFLICT", f"元件目前是 {state}：先停止才能刪除", details={"state": state})
        call = self.active_call  # e.g. a cancel timeout killed the process (stopped) but the call still finishes
        if call is not None:
            raise ComponentError(
                "STATE_CONFLICT",
                f"元件目前是 {state}，但呼叫 {call.call_id} 仍在收尾：等呼叫結束後才能刪除",
                details={"state": state, "active_call_id": call.call_id},
            )
        proc = self.process
        if proc is not None:
            raise ComponentError(
                "STATE_CONFLICT",
                f"元件目前是 {state}，但自有元件程序（PID {proc.pid}）尚未確認退出（GPU 是否釋放未知）：先停止並確認程序結束才能刪除",
                details={"state": state, "pid": proc.pid, "process_instance_id": proc.process_instance_id},
            )
        if self._restart_pending:
            raise ComponentError(
                "STATE_CONFLICT",
                f"元件目前是 {state}，但 restart 仍在進行（停止後會再載入）：等它完成並停止後才能刪除",
                details={"state": state, "restart_pending": True},
            )

    async def delete_definition(self, tombstone_path: Path) -> None:
        """Write the tombstone (with the last definition) and remove the definition file (see ``_check_deletable``).

        Check and file operations run under the control and settings locks, so they never interleave with a
        start or a save. Background flows that only finish their load/unload recordings complete normally; after
        that no process can be started and no definition written back (``deleted``). Recordings, logs and files stay.
        """
        async with self._control_lock:
            self._ensure_not_deleted()
            self._check_deletable()
            async with self._settings_lock:
                record = self.settings.to_record()
                tombstone = {
                    "component_id": self.component_id,
                    "deleted_at": utc_now(),
                    "definition": record["definition"],
                    "stored_revision": record["stored_revision"],
                }

                def work() -> None:
                    atomic_write_json(tombstone_path, tombstone)
                    self.config_path.unlink(missing_ok=True)

                await asyncio.to_thread(work)
                self.deleted = True

    # ------------------------------------------------------------------ control
    @contextlib.asynccontextmanager
    async def _group_scope(self, *, background: bool = False) -> AsyncIterator[None]:
        """The outermost lock of a start/restart: the exclusive group's, taken as a try-lock (never queued).

        Busy members refuse here, before the lock is taken: the check and the acquire happen in one step (no
        await in between), so a start can never hold the group through a slow describe while another member
        is loading, stopping, busy or between a restart's unload and its start (that restart would then fail).
        A ``background`` start (restart) records the refusal, since nobody receives the HTTP error.
        """
        group = self.exclusive_group
        if group is None:
            yield
            return
        lock = self.service.exclusive_lock(group)
        members = exclusive.holders(self.service.instances.values(), group, exclude=self)
        busy = any(map(exclusive.is_busy, members))
        if busy or lock.locked():
            err = exclusive.busy_error(group, members, switching=not busy)
            raise self._fail_start(err, "error") if background else err
        async with lock:
            yield

    async def start(self, *, replace_exclusive: bool = False) -> dict[str, Any]:
        async with self._group_scope(), self._control_lock:
            return await self._start_locked(failure_state="stopped", replace_exclusive=replace_exclusive)

    async def stop(self) -> dict[str, Any]:
        async with self._control_lock:
            self._ensure_not_deleted()
            if self.state == "busy":
                call = self.active_call
                raise ComponentError(
                    "COMPONENT_BUSY",
                    "元件正在執行呼叫；請先取消進行中的呼叫再停止",
                    details={"active_call_id": call.call_id if call else None},
                )
            if self.state in ("stopped", "stopping"):
                self._restart_pending = False  # stop during a restart's stop phase: do not start again
                return await self.descriptor()
            if self.state == "loading":
                if self._load_abort is not None:
                    self._load_abort.set()
                self._set_state("stopping")
                return await self.descriptor()
            self._begin_stop(restart=False)
            return await self.descriptor()

    def _begin_stop(self, *, restart: bool, note: str | None = None, restart_notes: tuple[str, ...] = ()) -> None:
        """(control lock held) → stopping; the unload runs in its own task."""
        self._restart_pending = restart
        self._set_state("stopping")
        name = f"{'restart' if restart else 'stop'}-{self.component_id}"
        self._task = self.service.spawn_task(
            self._stop_flow(restart=restart, note=note, restart_notes=restart_notes), name=name
        )

    async def restart(self, *, replace_exclusive: bool = False) -> dict[str, Any]:
        async with self._group_scope(), self._control_lock:
            self._ensure_not_deleted()
            self.service.ensure_accepting("restart")
            if self.state == "busy":
                raise ComponentError("COMPONENT_BUSY", "元件正在執行呼叫；restart 只允許在 idle 時進行")
            if self.state in TRANSITIONAL_STATES:
                raise ComponentError(
                    "STATE_CONFLICT", f"元件目前是 {self.state}；restart 只允許在 ready／error／stopped 時進行"
                )
            if self.process is not None:
                # Make room (or refuse) before unloading ourselves: the start phase runs in the background.
                notes = await self._claim_exclusive(replace=replace_exclusive)
                self._begin_stop(restart=True, restart_notes=notes)
                return await self.descriptor()
            return await self._start_locked(failure_state="error", replace_exclusive=replace_exclusive)

    async def _claim_exclusive(self, *, replace: bool) -> tuple[str, ...]:
        """(group and control locks held) No other member may hold a model; ``replace`` stops the idle ones.

        Busy members always refuse. Returns notes for the load recording.
        """
        group = self.exclusive_group
        if group is None:
            return ()
        members = exclusive.holders(self.service.instances.values(), group, exclude=self)
        if not members:
            return ()
        if any(map(exclusive.is_busy, members)):
            raise exclusive.busy_error(group, members)
        if not replace:
            raise exclusive.conflict_error(group, members)
        for member in members:
            await member.stop_for_exclusive(group=group, successor=self.component_id)
        stopped = "、".join(member.component_id for member in members)
        log.info("互斥群組 %s：為了載入 %s 已停止 %s（replace_exclusive）", group, self.component_id, stopped)
        return (f"replace_exclusive：載入前已依序停止互斥群組 {group} 的 {stopped}",)

    async def stop_for_exclusive(self, *, group: str, successor: str) -> None:
        """Unload this idle member so ``successor`` can load; raises when the stop is not confirmed."""
        async with self._control_lock:
            if exclusive.is_busy(self):
                raise exclusive.busy_error(group, [self])
            if not exclusive.is_holder(self):
                return  # already gone (e.g. stopped by the user meanwhile)
            self._begin_stop(
                restart=False, note=f"replace_exclusive：互斥群組 {group} 改由 {successor} 載入，先停止此元件"
            )
            task = self._task
        if task is not None:
            await asyncio.wait({task})
        if self.state != "stopped" or self.process is not None:
            raise ComponentError(
                "STATE_CONFLICT",
                f"無法確認停止互斥群組 {group} 的 {self.component_id}（目前 {self.state}）；沒有載入 {successor}",
                details={
                    "group": group,
                    "component_id": self.component_id,
                    "state": self.state,
                    "cause": self.last_error,
                },
            )

    def _fail_start(self, err: ComponentError, failure_state: ComponentState) -> ComponentError:
        """Record a refused start; ``failure_state=error`` (restart) moves the instance to error."""
        state: ComponentState = "error" if failure_state == "error" or self.state == "error" else self.state
        self._set_state(state, error=err.to_dict())
        return err

    async def _start_locked(
        self,
        *,
        failure_state: ComponentState,
        replace_exclusive: bool = False,
        background: bool = False,
        notes: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        """Start under the group and control locks; a ``background`` start (restart) records refusals."""
        svc = self.service
        self._ensure_not_deleted()
        svc.ensure_accepting("start")
        if self.state in ("loading", "ready", "busy"):
            return await self.descriptor()
        if self.state == "stopping":
            raise ComponentError("STATE_CONFLICT", "元件正在停止；請等到 stopped 後再 start")
        if self.process is not None:
            raise ComponentError(
                "STATE_CONFLICT",
                "前一個元件程序尚未確認退出（GPU 是否釋放未知）；請先 stop，必要時人工確認程序",
                details={"pid": self.process.pid},
            )
        runtime = svc.config.runtimes.get(self.runtime_id)
        if runtime is None:
            raise self._fail_start(self._runtime_missing(), failure_state)
        settings, revision = self.settings.snapshot()
        result = await svc.commands.describe(runtime, self.provider_id, settings, refresh_failures=True)
        if self.state in ("loading", "ready", "busy"):
            return await self.descriptor()
        if not result.available:
            raise self._fail_start(result.unavailable_error(), failure_state)
        problem = self._settings_problem(result)  # a seed or an older definition the provider does not accept
        if problem is not None:
            err = ComponentError.from_dict(problem, status=422)
            raise self._fail_start(err, failure_state) if background else err
        try:
            notes += await self._claim_exclusive(replace=replace_exclusive)
        except ComponentError as err:
            if background:
                self._fail_start(err, failure_state)
            raise
        # Final checks and the state change happen in one synchronous step (no await in between).
        refusal = exclusive.refusal(self, self.service.instances.values())
        if refusal is not None:
            raise self._fail_start(refusal, failure_state) if background else refusal
        device = dict(settings["load"]["device"])
        group = str(device["resource_group"])
        holder_name = f"{self.component_id}:load"
        holder = svc.locks.try_acquire(group, holder_name)
        if holder is not None:
            raise self._fail_start(
                ComponentError(
                    "DEVICE_BUSY",
                    f"resource_group {group} 正由 {holder} 使用；Node 不排隊、不自動重試，請稍後手動再試",
                    details={"resource_group": group, "holder": holder},
                ),
                failure_state,
            )
        # The lock is held: loading from here on; the spawn finishes in its own task (a dropped HTTP
        # connection cannot leave a half-started instance).
        self.loaded_description = result.description
        self._reset_loaded()
        abort = asyncio.Event()
        self._load_abort = abort
        self._set_state("loading", error=None)
        begin = svc.spawn_task(
            self._begin_load(runtime, settings, revision, result, group, holder_name, abort, notes),
            name=f"spawn-{self.component_id}",
        )
        await asyncio.shield(begin)
        return await self.descriptor()

    async def _begin_load(
        self,
        runtime: RuntimeEntry,
        settings: dict[str, Any],
        revision: int,
        result: DescribeResult,
        group: str,
        holder_name: str,
        abort: asyncio.Event,
        notes: tuple[str, ...] = (),
    ) -> None:
        svc = self.service
        process_instance_id = new_id()
        recorder: Recorder | None = None
        try:
            recorder = await svc.new_recorder(
                self,
                operation="load",
                recording_id=new_id(),
                config=settings.get("recording"),
                synthetic=bool((result.description or {}).get("synthetic")),
            )
            for note in notes:
                recorder.note(note)
            await asyncio.to_thread(
                recorder.write_context,
                settings=svc.requested_context(settings, revision),
                environment=svc.environment(self, None, runtime_process_instance_id=process_instance_id),
            )
            proc = await self._spawn(runtime, settings, process_instance_id)
        except Exception as exc:
            svc.locks.release(group, holder_name)
            self._load_abort = None
            log.error("元件 %s 的元件程序無法啟動", self.component_id, exc_info=exc)
            err = ComponentError(
                "RUNTIME_START_FAILED",
                f"無法啟動元件程序：{type(exc).__name__}",
                details=exception_summary(exc),
            )
            self._set_state("error", error=err.to_dict())
            if recorder is not None:
                summary = await asyncio.to_thread(recorder.finalize, "failed", error=err.to_dict(), write=False)
                await svc.publish_final_summary(recorder.recording_id, summary)
            raise err from exc
        self.process = proc
        self.spawn_count += 1
        self._task = svc.spawn_task(
            self._load_flow(proc, settings, revision, recorder, group, holder_name, abort),
            name=f"load-{self.component_id}",
        )

    async def _spawn(
        self, runtime: RuntimeEntry, settings: Mapping[str, Any], process_instance_id: str
    ) -> RuntimeProcess:
        svc = self.service
        device = dict(settings["load"]["device"])
        work_dir = svc.data_dir / "work" / self.component_id / process_instance_id
        await asyncio.to_thread(work_dir.mkdir, parents=True, exist_ok=True)
        stderr_path = svc.data_dir / "logs" / "components" / self.component_id / f"{process_instance_id}.stderr.log"
        argv = [
            runtime.python,
            "-m",
            runtime.module,
            "--provider",
            self.provider_id,
            "--component-id",
            self.component_id,
            "--node-id",
            svc.node_id,
            "--process-instance-id",
            process_instance_id,
            "--data-dir",
            str(svc.data_dir),
            "--device-json",
            json.dumps(device, ensure_ascii=False),
        ]
        env = runtime_env(runtime, device=device, source_rev=svc.source_revision)
        return await RuntimeProcess.spawn(
            argv=argv,
            env=env,
            cwd=work_dir,
            component_id=self.component_id,
            process_instance_id=process_instance_id,
            stderr_path=stderr_path,
            stderr_sink=self._on_stderr,
            telemetry_sink=svc.on_telemetry,
            on_message=self._on_runtime_message,
            on_exit=self._on_runtime_exit,
            preview_sink=self._on_preview,
            stderr_ref=str(stderr_path.relative_to(svc.data_dir)),
        )

    def _start_error(self, proc: RuntimeProcess, *, stage: str) -> dict[str, Any]:
        if proc.early_error is not None:
            err = ComponentError.from_dict(proc.early_error)
            details = {**err.details, **proc.exit_details()}
            return ComponentError(err.code, err.message, details=details).to_dict()
        return ComponentError(
            "RUNTIME_START_FAILED" if stage == "hello" else "RUNTIME_EXITED",
            f"元件程序在{'回報 hello 前' if stage == 'hello' else '載入期間'}結束（{describe_returncode(proc.returncode)}）；請查看 stderr 記錄",
            details=proc.exit_details(),
        ).to_dict()

    async def _load_flow(
        self,
        proc: RuntimeProcess,
        settings: dict[str, Any],
        revision: int,
        recorder: Recorder,
        group: str,
        holder_name: str,
        abort: asyncio.Event,
    ) -> None:
        try:
            await self._load_flow_inner(proc, settings, revision, recorder, group, holder_name, abort)
        except Exception as exc:
            self.service.locks.release(group, holder_name)
            await self._flow_crashed(proc, exc, "載入")

    async def _flow_crashed(self, proc: RuntimeProcess | None, exc: BaseException, operation: str) -> None:
        """An unexpected error in a background flow: terminate the own process and end in error (never stuck)."""
        log.error("元件 %s 的%s流程發生未預期錯誤", self.component_id, operation, exc_info=exc)
        exited = True
        if proc is not None:
            proc.expected_exit = True
            exited = await proc.terminate(float(self.service.config.cancel_grace_seconds))
        self._drop_process(proc, exited=exited)
        self._load_abort = None
        self._active = None
        self._set_state(
            "error",
            error=ComponentError(
                "NODE_INTERNAL_ERROR",
                f"Node 在{operation}流程發生未預期錯誤：{type(exc).__name__}；已終止自有程序，請查看 Node log",
                details=exception_summary(exc),
            ).to_dict(),
        )

    async def _await_load(
        self, proc: RuntimeProcess, settings: dict[str, Any], revision: int, recorder: Recorder, abort: asyncio.Event
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, bool]:
        """hello → protocol check → load → load_done; returns (load_done message, error, aborted)."""
        stage = "hello"
        try:
            with recorder.span("spawn_to_hello", critical=True):
                hello = await proc.wait(proc.hello, timeout=HELLO_TIMEOUT_S, abort=abort)
            protocol = str(hello.get("protocol") or "")
            if protocol.split(".", maxsplit=1)[0] != PROTOCOL_VERSION.split(".", maxsplit=1)[0]:
                raise ComponentError(
                    "PROTOCOL_MISMATCH",
                    f"元件程序協定版本 {protocol} 與 Node 的 {PROTOCOL_VERSION} 不相容；請使用相容版本的 runtime",
                    details={"runtime_protocol": protocol, "node_protocol": PROTOCOL_VERSION},
                )
            stage = "load"
            fut = proc.expect("load_done")
            await proc.send(
                {
                    "type": "load",
                    "recording_id": recorder.recording_id,
                    "settings": settings,
                    "stored_revision": revision,
                }
            )
            with recorder.span("await_load_done", critical=True):
                done = await proc.wait(fut, timeout=float(self.service.config.load_timeout_seconds), abort=abort)
        except Aborted:
            return None, None, True
        except RuntimeGone:
            return None, self._start_error(proc, stage=stage), False
        except TimeoutError:
            if stage == "hello":
                return (
                    None,
                    ComponentError(
                        "RUNTIME_START_FAILED",
                        f"元件程序 {HELLO_TIMEOUT_S:.0f} 秒內未回報 hello；已終止自有 process group",
                        details=proc.exit_details(),
                    ).to_dict(),
                    False,
                )
            timeout = self.service.config.load_timeout_seconds
            return (
                None,
                ComponentError(
                    "LOAD_TIMEOUT",
                    f"載入超過 load_timeout_seconds（{timeout} 秒）；已終止自有 process group",
                    details={"load_timeout_seconds": timeout},
                ).to_dict(),
                False,
            )
        except ComponentError as exc:
            return None, exc.to_dict(), False
        if done.get("ok"):
            return done, None, False
        return (
            done,
            normalize_error(done.get("error"), default_code="RUNTIME_ERROR", default_message="元件載入失敗"),
            False,
        )

    async def _load_flow_inner(
        self,
        proc: RuntimeProcess,
        settings: dict[str, Any],
        revision: int,
        recorder: Recorder,
        group: str,
        holder_name: str,
        abort: asyncio.Event,
    ) -> None:
        svc = self.service
        self.set_active_recorder(recorder, proc)
        token = svc.sampler.subscribe(settings["load"]["device"], recorder, proc.pid)
        try:
            done, error, aborted = await self._await_load(proc, settings, revision, recorder, abort)
        finally:
            svc.sampler.unsubscribe(token)
            svc.locks.release(group, holder_name)
        ok = done is not None and error is None
        aborted = aborted or (ok and abort.is_set())
        exited = True
        if done is not None and error is None and not aborted and proc.alive:
            self.settings.mark_loaded(settings["load"], revision)
            raw_parts = done.get("parts")
            self.loaded_parts = list(raw_parts) if isinstance(raw_parts, list) else None
            ctx = done.get("settings_context")
            self.load_context = dict(ctx) if isinstance(ctx, Mapping) else None
            self.recorder_state = recorder.recorder_state()  # live Node-side state; refined after the merge below
            self._set_state("ready", error=None)
            outcome = "succeeded"
        else:
            if ok and not proc.alive:
                error = self._start_error(proc, stage="load")
            proc.expected_exit = True
            if aborted:
                exited = await proc.terminate(float(svc.config.cancel_grace_seconds))
            else:
                exited = await proc.wait_exit(EXIT_AFTER_LOAD_FAILURE_S)
                if not exited:
                    exited = await proc.terminate(float(svc.config.cancel_grace_seconds))
            self._drop_process(proc, exited=exited)
            if aborted:
                self._set_state(
                    "stopped" if exited else "error", error=None if exited else self._unconfirmed_error(proc)
                )
                outcome = "cancelled"
            else:
                self._set_state("error", error=error if exited else self._unconfirmed_error(proc, cause=error))
                outcome = "failed"
        self._load_abort = None
        runtime_summary = done.get("summary") if isinstance(done, Mapping) else None
        await self._finish_recording(
            recorder, outcome, error if outcome == "failed" else None, runtime_summary, proc=proc
        )
        if not exited:
            log.error("元件 %s（PID %s）未確認退出；不標 ready，需人工確認", self.component_id, proc.pid)
        elif outcome == "failed":
            log.warning("元件 %s 載入失敗（不自動重啟）：%s", self.component_id, (error or {}).get("message"))
        svc.notify_change()

    def _unconfirmed_error(self, proc: RuntimeProcess, *, cause: Mapping[str, Any] | None = None) -> dict[str, Any]:
        details: dict[str, Any] = {"pid": proc.pid, "process_instance_id": proc.process_instance_id}
        if cause:
            details["cause"] = dict(cause)
        return ComponentError(
            "PROCESS_EXIT_UNCONFIRMED",
            "程序未確認退出：已對自有 process group 送 SIGTERM／SIGKILL 但仍無法以 waitpid 確認；GPU 是否釋放未知，請人工處理",
            details=details,
        ).to_dict()

    async def _finish_recording(
        self,
        recorder: Recorder,
        state: str,
        error: Mapping[str, Any] | None,
        runtime_summary: Any,
        *,
        proc: RuntimeProcess | None,
    ) -> dict[str, Any]:
        svc = self.service
        if proc is not None:
            await proc.drain_stderr()
        self.clear_active_recorder(recorder)
        node_summary = await asyncio.to_thread(
            recorder.finalize, state, error=dict(error) if error else None, write=False
        )
        merged = svc.merge_summaries(
            node_summary, runtime_summary if isinstance(runtime_summary, Mapping) else None, state
        )
        await svc.publish_final_summary(recorder.recording_id, merged)
        self.recorder_state = recorder_state_of(recorder.mode, merged)
        return merged

    async def _stop_flow(
        self,
        *,
        restart: bool,
        unload_timeout: float = UNLOAD_TIMEOUT_S,
        note: str | None = None,
        restart_notes: tuple[str, ...] = (),
    ) -> None:
        """Unload (and for a restart, load again). ``note`` explains the stop in the unload recording."""
        proc = self.process
        try:
            await self._stop_flow_inner(unload_timeout=unload_timeout, note=note)
            if restart and self._restart_pending and self.state == "stopped":
                await self._restart_start(restart_notes)
        except Exception as exc:
            self._restart_pending = False
            await self._flow_crashed(proc, exc, "停止")

    async def _restart_start(self, notes: tuple[str, ...]) -> None:
        """The start phase of a restart: same lock order as ``start`` (group, then control)."""
        self._restart_pending = False
        try:
            async with self._group_scope(background=True), self._control_lock:
                await self._start_locked(failure_state="error", background=True, notes=notes)
        except ComponentError as exc:
            log.warning(
                "元件 %s restart 的啟動階段失敗（停在 %s，不回退舊設定）：%s",
                self.component_id,
                self.state,
                exc.message,
            )

    async def _stop_flow_inner(self, *, unload_timeout: float, note: str | None) -> None:
        svc = self.service
        proc = self.process
        recorder = await svc.new_recorder(
            self, operation="unload", recording_id=new_id(), config=self.settings.stored.get("recording")
        )
        if note:
            recorder.note(note)
        self.set_active_recorder(recorder, proc)
        await asyncio.to_thread(recorder.write_context, settings=None, environment=svc.environment(self, proc))
        runtime_summary: Any = None
        unload_error: dict[str, Any] | None = None
        exited = True
        if proc is not None:
            proc.expected_exit = True
            loop = asyncio.get_running_loop()
            deadline = loop.time() + unload_timeout
            if proc.alive:
                fut = proc.expect("bye")
                try:
                    await proc.send({"type": "unload", "recording_id": recorder.recording_id})
                    with recorder.span("await_bye", critical=True):
                        bye = await proc.wait(fut, timeout=unload_timeout)
                    runtime_summary = bye.get("summary")
                    if bye.get("error"):
                        unload_error = normalize_error(
                            bye.get("error"), default_code="RUNTIME_ERROR", default_message="卸載失敗"
                        )
                except RuntimeGone:
                    recorder.note("元件程序在回覆 bye 前已結束")
                except TimeoutError:
                    recorder.note(f"元件程序 {unload_timeout:.0f} 秒內沒有回覆 bye；改以訊號終止自有 process group")
                    proc.discard("bye", fut)
            exited = await proc.wait_exit(max(0.0, deadline - loop.time()))
            if not exited:
                exited = await proc.terminate(float(svc.config.cancel_grace_seconds))
        else:
            recorder.note("沒有執行中的元件程序；不需要卸載")
        self._drop_process(proc, exited=exited)
        if exited or proc is None:
            self._set_state("stopped", error=None)
        else:
            self._set_state("error", error=self._unconfirmed_error(proc))
        await self._finish_recording(
            recorder,
            "succeeded" if exited and unload_error is None else "failed",
            unload_error if exited else self.last_error,
            runtime_summary,
            proc=proc,
        )
        svc.notify_change()

    async def shutdown(self, *, timeout: float) -> None:
        """Node shutdown: abort a load, unload an idle process, finally signal only the own process group."""
        if self._load_abort is not None:
            self._load_abort.set()
        task = self._task
        if task is not None and not task.done():
            await asyncio.wait({task}, timeout=timeout + 15)
        proc = self.process
        if proc is not None and proc.alive and self.state in ("ready", "error", "stopping"):
            self._set_state("stopping")
            with contextlib.suppress(Exception):  # best effort: the process is terminated below anyway
                await self._stop_flow(restart=False, unload_timeout=timeout)
        proc = self.process
        if proc is not None and proc.alive:
            await proc.terminate(min(timeout, 5.0))

    # ------------------------------------------------------------------ calls
    def accept_call(self, body: Mapping[str, Any]) -> ActiveCall:
        """Accept an InvokeRequest: every check and state change happens here, synchronously (no await)."""
        svc = self.service
        for name, value in (body.get("inputs") or {}).items():
            check_typed_value(value, where=f"inputs.{name}")
        svc.ensure_accepting("invoke")
        call_id = str(body["call_id"])
        other = svc.active_calls.get(call_id)
        if other is not None:
            raise ComponentError(
                "CALL_ID_CONFLICT",
                f"call_id {call_id} 已在進行中（元件 {other.component_id}）；不重複執行同一個 call",
                details={"call_id": call_id, "component_id": other.component_id},
            )
        if self.state == "busy":
            active = self.active_call
            raise ComponentError(
                "COMPONENT_BUSY",
                "元件已有進行中的呼叫（每個 instance 一次一個 call）；Node 不排隊",
                details={"active_call_id": active.call_id if active else None},
            )
        proc = self.process
        if self.state != "ready" or proc is None or not proc.alive:
            raise ComponentError(
                "COMPONENT_NOT_READY",
                f"元件目前是 {self.state}，不能呼叫；請先 start 並等到 ready",
                details={"state": self.state},
            )
        loaded_revision = self.settings.loaded_revision
        required = body.get("required_loaded_revision")
        if required is not None and required != loaded_revision:
            raise ComponentError(
                "SETTINGS_NOT_LOADED",
                f"呼叫要求 loaded_revision {required}，但目前載入的是 {loaded_revision}；請明確 restart 載入新設定（不暗中換模型）",
                details={"required_loaded_revision": required, "loaded_revision": loaded_revision},
            )
        description = self.loaded_description or {}
        check_inputs(description, body.get("inputs") or {})
        params_schema = description.get("parameters_schema")
        if isinstance(params_schema, Mapping) and params_schema:
            contracts.validate_with_schema(
                params_schema,
                dict(body.get("parameters") or {}),
                code="INVALID_ARGUMENT",
                what="parameters 不符合元件的 parameters_schema",
            )
        group = str(self.loaded_device()["resource_group"])
        holder_name = f"{self.component_id}:call:{call_id}"
        holder = svc.locks.try_acquire(group, holder_name)
        if holder is not None:
            raise ComponentError(
                "DEVICE_BUSY",
                f"resource_group {group} 正由 {holder} 使用；Node 不排隊、不自動重試",
                details={"resource_group": group, "holder": holder},
            )
        stored, stored_revision = self.settings.snapshot()
        output_types = {
            str(p["name"]): str(p["type_id"])
            for p in description.get("outputs") or []
            if isinstance(p, Mapping) and p.get("name") and p.get("type_id")
        }
        call = ActiveCall(
            body=body,
            recording_id=svc.new_recording_id(),
            stored_revision=stored_revision,
            invoke_defaults=dict(stored.get("invoke") or {}),
            output_types=output_types,
            group=group,
            holder=holder_name,
            proc=proc,
            synthetic=bool(description.get("synthetic")),
        )
        self.active_call = call
        svc.active_calls[call_id] = self
        self._set_state("busy")
        return call

    def end_call(self, call: ActiveCall) -> None:
        """Release everything ``accept_call`` took; back to ready unless the process went away meanwhile."""
        svc = self.service
        if self.active_call is call:
            self.active_call = None
        svc.active_calls.pop(call.call_id, None)
        svc.locks.release(call.group, call.holder)
        if self.state == "busy":
            proc = call.proc
            if self.process is proc and proc.alive:
                self._set_state("ready")
            else:
                self._set_state(
                    "error",
                    error=self.last_error
                    or ComponentError(
                        "RUNTIME_EXITED",
                        f"元件程序已結束（{describe_returncode(proc.returncode)}）",
                        details=proc.exit_details(),
                    ).to_dict(),
                )
        self.remember_call(call.call_id, call.final_state or "failed")
        svc.notify_change()

    async def kill_for_call(self, call: ActiveCall, *, reason: str) -> bool | None:
        """Cooperative cancel took longer than the grace: terminate only this instance's process group.

        Returns True when the exit is confirmed, None when unknown.
        """
        async with call.kill_lock:
            if call.process_exited is not None:
                return call.process_exited or None
            proc = call.proc
            call.kill_reason = call.kill_reason or reason
            proc.expected_exit = True
            log.warning(
                "元件 %s 的呼叫 %s 在 cooperative 取消後未結束（%s）；終止自有 process group",
                self.component_id,
                call.call_id,
                reason,
            )
            exited = await proc.kill()
            call.process_exited = exited
            self._drop_process(proc, exited=exited)
            if exited:
                code = "CALL_TIMEOUT" if reason == "deadline" else "CANCELLED"
                self._set_state(
                    "stopped",
                    error=ComponentError(
                        code,
                        "cooperative 取消逾時，已終止自有元件程序（模型已卸載，需要時請手動 start）；HTTP 回覆不代表 GPU 已釋放，請以裝置樣本確認",
                        details={"call_id": call.call_id, "process_killed": True, "reason": reason},
                    ).to_dict(),
                )
            else:
                self._set_state("error", error=self._unconfirmed_error(proc))
            return True if exited else None

    # ------------------------------------------------------------------ runtime callbacks
    def _on_runtime_message(self, proc: RuntimeProcess, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "run_done":
            call = self.active_call
            if call is not None and call.proc is proc and call.call_id == message.get("call_id"):
                call.on_runtime_done(message)
        elif kind == "resolve":
            self.service.spawn_task(self._handle_resolve(proc, message), name=f"resolve-{self.component_id}")
        elif kind == "error":
            log.warning("元件 %s 回報錯誤：%s %s", self.component_id, message.get("code"), message.get("message"))

    async def _handle_resolve(self, proc: RuntimeProcess, message: Mapping[str, Any]) -> None:
        request_id = message.get("request_id")
        call = self.active_call
        recorder = call.recorder if call is not None else self.active_recorder
        reply: dict[str, Any] = {"type": "resolved", "request_id": request_id}
        try:
            ref = message.get("file")
            if not isinstance(ref, Mapping):
                raise ComponentError("INVALID_ARGUMENT", "resolve 需要 FileRef")
            materialized = await self.service.resolver.materialize(ref, recorder=recorder)
            if call is not None:
                call.note_materialized(materialized)
            reply["path"] = str(materialized.path)
        except ComponentError as exc:
            reply["error"] = exc.to_dict()
        except Exception as exc:
            log.error("元件 %s 的檔案物化發生未預期錯誤", self.component_id, exc_info=exc)
            reply["error"] = ComponentError(
                "RUNTIME_ERROR", f"Node 物化檔案失敗：{type(exc).__name__}", details=exception_summary(exc)
            ).to_dict()
        with contextlib.suppress(RuntimeGone):
            await proc.send(reply)

    def _on_preview(self, proc: RuntimeProcess, preview: NodePreview) -> None:
        """(event loop) Keep only the newest preview of the active call; drop it once the call has a result."""
        call = self.active_call
        if call is None or call.proc is not proc or call.call_id != preview.call_id or call.final_state is not None:
            return
        if call.preview is not None and preview.seq <= call.preview.seq:
            return
        call.preview = preview
        self.service.preview_notifier.published(self.component_id, call)

    def _on_runtime_exit(self, proc: RuntimeProcess) -> None:
        if proc is not self.process or proc.expected_exit or self.state in TRANSITIONAL_STATES:
            return
        err = ComponentError(
            "RUNTIME_EXITED",
            f"元件程序意外結束（{describe_returncode(proc.returncode)}）；不自動重啟，請查看 stderr 後手動 start",
            details=proc.exit_details(),
        )
        log.error("元件 %s 的程序意外結束（%s）", self.component_id, describe_returncode(proc.returncode))
        self._drop_process(proc, exited=True)
        self._set_state("error", error=err.to_dict())

    def _on_stderr(self, proc: RuntimeProcess, text: str, offset: int, truncated: bool) -> None:
        active = self._active
        if active is not None and active[1] is proc:
            recorder = active[0]
            lowered = text.lower()
            level = "warning" if any(h in lowered for h in _ERROR_HINTS) else "info"
            recorder.log(
                level,
                text,
                source="stderr",
                stderr_log=proc.stderr_ref,
                offset=offset,
                line_truncated=truncated,
                runtime_process_instance_id=proc.process_instance_id,
            )
        log.debug("[%s stderr] %s", self.component_id, text[:2000])


__all__ = ["UNCHANGED", "ComponentInstance"]
