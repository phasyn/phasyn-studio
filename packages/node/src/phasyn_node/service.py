"""NodeService: the NodeGateway of one host (component processes, files, sampling, recording upload, catalog).

The HTTP layer (``routes``) only parses and answers; all state lives here and in ``ComponentInstance``. There
is no operation service, retry queue, lease or recovery: after a Node restart every instance is stopped
(``autostart: true`` ones are started once, at start-up).

Definitions: ``data_dir/config/components/<id>.json`` (saved definitions, loaded when present). Deleting an
instance writes ``data_dir/config/deleted-components/<id>.json`` (a tombstone with the last definition, for a
manual restore): a seed of the same id in the Node configuration is no longer recreated; a PUT of that id
removes the tombstone.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Coroutine, Mapping
from pathlib import Path
from typing import Any

import httpx
from phasyn_components import PROTOCOL_VERSION, contracts
from phasyn_components.canonical import canonical_json, read_json
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.fs import atomic_write_json
from phasyn_components.ids import new_id, require_local_id
from phasyn_components.recorder import Recorder, environment_facts, merge_summaries
from phasyn_components.settings import SettingsState, effective_context
from phasyn_components.timeutil import utc_now
from phasyn_components.typed import INLINE_MAX_BYTES
from phasyn_server import DataDirLock

from .admission import AdmissionGuard
from .catalog import CatalogReporter
from .config import NodeConfig
from .describe import RuntimeCommands
from .files import Directory, FileResolver
from .invoke import cancel_call
from .locks import ResourceLocks
from .previews import PreviewNotifier
from .publisher import TelemetryPublisher
from .recordings import RecordingIndex
from .runtime import RuntimeProcess
from .sampler import SamplerHub
from .settings_check import check_settings
from .supervisor import ComponentInstance
from .sysinfo import platform_tag, source_revision
from .weights import WeightsManager

log = logging.getLogger("phasyn_node.service")

STREAM_ID = "node"
FINAL_PUSH_TIMEOUT = httpx.Timeout(1.5, connect=0.5)


class NodeService:
    def __init__(
        self,
        config: NodeConfig,
        *,
        http_transport: httpx.AsyncBaseTransport | None = None,
        data_lock: DataDirLock | None = None,
    ) -> None:
        self.config = config
        self.node_id = config.node_id
        self.process_instance_id = new_id()
        self.data_dir = Path(config.data_dir)
        self.recordings_root = self.data_dir / "recordings"
        self.components_dir = self.data_dir / "config" / "components"
        self.deleted_components_dir = self.data_dir / "config" / "deleted-components"
        self._definitions_lock = asyncio.Lock()  # PUT（建立／替換）與 DELETE 不交錯
        self._http_transport = http_transport
        self._data_lock = data_lock
        self._owns_lock = False
        self.locks = ResourceLocks()
        self.instances: dict[str, ComponentInstance] = {}
        self.active_calls: dict[str, ComponentInstance] = {}
        self.shutting_down = False
        self.started = False
        self.source_revision = "unknown"
        self._tasks: set[asyncio.Task[Any]] = set()
        self._call_tasks: set[asyncio.Task[Any]] = set()  # invokes and their shutdown cancels: awaited on stop
        self._exclusive_locks: dict[str, asyncio.Lock] = {}
        self._stopped = False
        # The opt-in host protection of heavy calls (NodeConfig.admission). None: no sampling task and no waits. It
        # opens nothing before start(), so a test may swap it for one with fake sensors before the service starts.
        self.admission: AdmissionGuard | None = (
            AdmissionGuard(config.admission) if config.admission is not None else None
        )
        # start() 之後才存在
        self.client: httpx.AsyncClient
        self.store: FileStore
        self.directory: Directory
        self.resolver: FileResolver
        self.publisher: TelemetryPublisher
        self.preview_notifier: PreviewNotifier
        self.sampler: SamplerHub
        self.index: RecordingIndex
        self.commands: RuntimeCommands
        self.weights: WeightsManager
        self.catalog: CatalogReporter | None = None

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        if self._data_lock is None:
            self._data_lock = DataDirLock(self.data_dir)
            self._data_lock.acquire()
            self._owns_lock = True
        elif not self._data_lock.held:
            self._data_lock.acquire()
            self._owns_lock = True
        try:
            await self._start_parts()
        except BaseException:
            await self._abort_start()
            raise
        self.started = True
        self.spawn_task(self._warmup(), name="warmup")
        log.info(
            "NodeGateway %s（%s）已啟動：data_dir=%s，source=%s，%d 個元件定義",
            self.config.label,
            self.node_id,
            self.data_dir,
            self.source_revision,
            len(self.instances),
        )

    async def _start_parts(self) -> None:
        await asyncio.to_thread(self._make_dirs)
        self.source_revision = await asyncio.to_thread(source_revision)
        self.client = httpx.AsyncClient(
            transport=self._http_transport,
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(10.0, connect=3.0),
        )
        self.store = FileStore(self.data_dir, self.node_id, buffer_bytes=self.config.file_buffer_bytes)
        self.directory = Directory(
            node_id=self.node_id, advertise_url=self.config.advertise_url, controller_url=self.config.controller_url
        )
        self.resolver = FileResolver(
            store=self.store,
            directory=self.directory,
            node_id=self.node_id,
            client=self.client,
            buffer_bytes=self.config.file_buffer_bytes,
            concurrency=self.config.file_transfer_concurrency,
        )
        self.publisher = TelemetryPublisher(
            node_id=self.node_id,
            controller_url=self.config.controller_url,
            client=self.client,
            recording=self.config.recording,
        )
        self.publisher.start()
        self.preview_notifier = PreviewNotifier(
            node_id=self.node_id, controller_url=self.config.controller_url, client=self.client, spawn=self.spawn_task
        )
        self.sampler = SamplerHub(hz=float(self.config.recording.get("device_sample_hz", 2) or 0))
        if self.admission is not None:
            self.admission.start()
        self.index = RecordingIndex(self.recordings_root, self.data_dir / "recording-index.sqlite")
        self.index.start()
        self.commands = RuntimeCommands(
            work_dir=self.data_dir / "work" / "_describe", source_revision=self.source_revision
        )
        self.weights = WeightsManager(self, roots=self.config.download_roots(), transport=self._http_transport)
        await self._load_definitions()
        self.catalog = CatalogReporter(
            node_id=self.node_id,
            controller_url=self.config.controller_url,
            client=self.client,
            directory=self.directory,
            interval_s=self.config.catalog_interval_seconds,
            snapshot=self.node_snapshot,
        )
        self.catalog.start()

    async def _abort_start(self) -> None:
        """``start()`` failed halfway: stop what already runs and release the data_dir lock (best effort)."""
        log.error("NodeGateway 啟動失敗；正在收回已啟動的部分")
        if self.catalog is not None:
            with contextlib.suppress(Exception):
                await self.catalog.stop()
        publisher: TelemetryPublisher | None = getattr(self, "publisher", None)
        if publisher is not None:
            with contextlib.suppress(Exception):
                await publisher.close(flush_timeout=0.1)
        if self.admission is not None:
            with contextlib.suppress(Exception):
                await self.admission.stop()
        index: RecordingIndex | None = getattr(self, "index", None)
        if index is not None:
            with contextlib.suppress(Exception):
                await index.close_store(timeout=5.0)
        client: httpx.AsyncClient | None = getattr(self, "client", None)
        if client is not None:
            with contextlib.suppress(Exception):
                await client.aclose()
        if self._owns_lock and self._data_lock is not None:
            self._data_lock.release()

    def _make_dirs(self) -> None:
        for path in (
            self.recordings_root,
            self.components_dir,
            self.data_dir / "files",
            self.data_dir / "work",
            self.data_dir / "logs" / "components",
        ):
            path.mkdir(parents=True, exist_ok=True)

    def tombstone_path(self, component_id: str) -> Path:
        return self.deleted_components_dir / f"{component_id}.json"

    async def _load_definitions(self) -> None:
        def work() -> list[tuple[dict[str, Any], int]]:
            for seed in self.config.components:
                cid = str(seed["component_id"])
                path = self.components_dir / f"{cid}.json"
                if path.exists():
                    continue
                if self.tombstone_path(cid).exists():
                    log.info("元件 %s 已被使用者刪除（%s）；不依 Node 設定的 seed 重建", cid, self.tombstone_path(cid))
                    continue
                atomic_write_json(path, {"definition": seed, "stored_revision": 1})
            found: list[tuple[dict[str, Any], int]] = []
            for path in sorted(self.components_dir.glob("*.json")):
                try:
                    doc = read_json(path)
                    definition = doc["definition"]
                    revision = int(doc.get("stored_revision") or 1)
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    log.error("無法讀取元件定義 %s（已略過）：%s", path, exc)
                    continue
                if not isinstance(definition, dict) or definition.get("component_id") != path.stem:
                    log.error("元件定義 %s 的 component_id 與檔名不符（已略過）", path)
                    continue
                found.append((definition, revision))
            return found

        for definition, revision in await asyncio.to_thread(work):
            try:
                settings = SettingsState(definition, revision)
            except ComponentError as exc:
                log.error("元件定義 %s 不符合契約（已略過）：%s", definition.get("component_id"), exc.message)
                continue
            instance = ComponentInstance(self, settings)
            self.instances[instance.component_id] = instance

    async def _warmup(self) -> None:
        instances = list(self.instances.values())
        described = await asyncio.gather(*(inst.descriptor() for inst in instances), return_exceptions=True)
        for inst, desc in zip(instances, described, strict=True):
            error = desc.get("last_error") if isinstance(desc, dict) else None
            if error and error.get("code") == "UNSUPPORTED_SETTING":  # e.g. a seed from the Node configuration
                log.warning(
                    "元件 %s 的設定不被 provider 接受（start 會被拒絕）：%s", inst.component_id, error.get("message")
                )
        # autostart 只在服務啟動時處理一次；同一 resource_group 依序啟動（等前一個載入結束），不同 group 並行。
        groups: dict[str, list[ComponentInstance]] = {}
        for inst in list(self.instances.values()):
            if inst.settings.definition.get("autostart"):
                device = inst.settings.stored["load"].get("device") or {}
                groups.setdefault(str(device.get("resource_group") or inst.component_id), []).append(inst)
        await asyncio.gather(*(self._autostart_group(members) for members in groups.values()))
        self.notify_change()

    async def _autostart_group(self, members: list[ComponentInstance]) -> None:
        """Start one resource group's autostart members one after another (each waits for the previous load)."""
        deadline_s = float(self.config.load_timeout_seconds) + 120.0
        for inst in members:
            if self.shutting_down:
                return
            try:
                await inst.start()
                log.info("autostart：已啟動元件 %s", inst.component_id)
            except ComponentError as exc:
                log.warning("autostart：元件 %s 無法啟動（不重試）：%s", inst.component_id, exc.message)
                continue
            await inst.wait_settled(deadline_s)

    def begin_shutdown(self) -> None:
        """停止接受新的 call／start，並對進行中的 call 送 cooperative 取消（在 event loop 上呼叫）。"""
        if self.shutting_down:
            return
        self.shutting_down = True
        log.info("NodeGateway 正在關閉：不再接受新的呼叫，取消進行中的呼叫")
        for inst in list(self.instances.values()):
            call = inst.active_call
            if call is not None:
                self.spawn_call_task(
                    cancel_call(inst, call.call_id, reason="shutdown"), name=f"shutdown-cancel-{call.call_id}"
                )

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self.begin_shutdown()
        grace = float(self.config.cancel_grace_seconds)
        if self.started:
            await self.weights.close()
            if self._call_tasks:
                await asyncio.wait(set(self._call_tasks), timeout=grace + 10)
            await asyncio.gather(
                *(inst.shutdown(timeout=grace) for inst in list(self.instances.values())), return_exceptions=True
            )
            if self.catalog is not None:
                await self.catalog.stop()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.catalog.push_once(timeout=FINAL_PUSH_TIMEOUT), timeout=2.0)
            await self.publisher.close(flush_timeout=2.0)
            for task in list(self._tasks):
                task.cancel()
            if self._tasks:
                await asyncio.gather(*list(self._tasks), return_exceptions=True)
            self.sampler.stop()
            if self.admission is not None:
                await self.admission.stop()
            await self.index.close_store()
            await self.client.aclose()
        if self._owns_lock and self._data_lock is not None:
            self._data_lock.release()
        log.info("NodeGateway 已關閉")

    # ------------------------------------------------------------------ helpers
    def spawn_task(self, coro: Coroutine[Any, Any, Any], *, name: str) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def spawn_call_task(self, coro: Coroutine[Any, Any, Any], *, name: str) -> asyncio.Task[Any]:
        """A task that belongs to a call (the invoke itself, its shutdown cancel): ``stop()`` waits for these."""
        task = self.spawn_task(coro, name=name)
        self._call_tasks.add(task)
        task.add_done_callback(self._call_tasks.discard)
        return task

    def exclusive_lock(self, group: str) -> asyncio.Lock:
        """The outermost lock of starts in one exclusive group (taken as a try-lock by ComponentInstance)."""
        return self._exclusive_locks.setdefault(group, asyncio.Lock())

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None and not isinstance(exc, ComponentError):
            log.error("背景工作 %s 失敗：%s", task.get_name(), exc, exc_info=exc)

    def notify_change(self) -> None:
        if self.catalog is not None:
            self.catalog.trigger()

    def ensure_accepting(self, what: str) -> None:
        if self.shutting_down:
            raise ComponentError("NODE_SHUTTING_DOWN", f"Node 正在關閉，不接受新的 {what}")

    def instance(self, component_id: str) -> ComponentInstance:
        inst = self.instances.get(component_id)
        if inst is None:
            raise ComponentError(
                "NOT_FOUND", f"這個 Node 沒有元件 {component_id}", details={"component_id": component_id}
            )
        return inst

    def new_recording_id(self) -> str:
        rid = new_id()
        self.index.touch(rid)
        return rid

    # ------------------------------------------------------------------ catalog
    async def descriptors(self) -> list[dict[str, Any]]:
        cached_only = self.shutting_down
        items = await asyncio.gather(
            *(self.instances[cid].descriptor(cached_only=cached_only) for cid in sorted(self.instances))
        )
        return list(items)

    async def node_snapshot(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "process_instance_id": self.process_instance_id,
            "label": self.config.label,
            "endpoint": self.config.advertise_url,
            "protocol_version": PROTOCOL_VERSION,
            "platform": platform_tag(),
            "components": await self.descriptors(),
            "observed_at": utc_now(),
        }

    async def put_component(self, component_id: str, body: Mapping[str, Any]) -> dict[str, Any]:
        require_local_id(component_id, "component_id")
        contracts.validate("InstanceDefinition", dict(body), what="元件定義")
        if body["component_id"] != component_id:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"路徑 component_id「{component_id}」與 body 的「{body['component_id']}」不一致",
                details={"path": component_id, "body": body["component_id"]},
            )
        if body["runtime_id"] not in self.config.runtimes:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"這個 Node 沒有 runtime_id「{body['runtime_id']}」；可用：{', '.join(sorted(self.config.runtimes)) or '（無）'}",
                details={"runtime_id": body["runtime_id"], "known": sorted(self.config.runtimes)},
            )
        # The provider checks the settings like a settings PATCH; one that cannot be described refuses them.
        runtime = self.config.runtimes[body["runtime_id"]]
        result = await self.commands.describe(
            runtime, str(body["provider_id"]), body["settings"], refresh_failures=True
        )
        if result.description is None:
            raise result.unavailable_error()
        check_settings(body, result.description)
        async with self._definitions_lock:
            inst = self.instances.get(component_id)
            if inst is None:
                inst = ComponentInstance(self, SettingsState(dict(body), 1))
                self.instances[component_id] = inst
                await inst.persist()
            else:
                await inst.replace_definition(dict(body))
            if await asyncio.to_thread(self._clear_tombstone, component_id):
                log.info("元件 %s 以 PUT 重新建立：已清除刪除記錄（seed 恢復正常）", component_id)
        self.notify_change()
        return await inst.descriptor()

    def _clear_tombstone(self, component_id: str) -> bool:
        path = self.tombstone_path(component_id)
        if not path.exists():
            return False
        path.unlink(missing_ok=True)
        return True

    async def delete_component(self, component_id: str) -> dict[str, Any]:
        """刪除 instance 定義（只允許 stopped／error；其餘 409 STATE_CONFLICT）。

        紀錄、log、已發布檔案與 work 目錄都保留；寫入刪除記錄，Node 設定檔同名 seed 之後不在重啟時重建。
        """
        async with self._definitions_lock:
            inst = self.instance(component_id)
            await inst.delete_definition(self.tombstone_path(component_id))
            if self.instances.get(component_id) is inst:
                del self.instances[component_id]
        log.info(
            "已刪除元件 %s（%s，provider %s）；紀錄與檔案保留，刪除記錄：%s",
            component_id,
            inst.label,
            inst.provider_id,
            self.tombstone_path(component_id),
        )
        self.notify_change()
        return {"component_id": component_id, "deleted": True}

    async def providers(self) -> dict[str, Any]:
        async def one(runtime_id: str) -> list[dict[str, Any]]:
            runtime = self.config.runtimes[runtime_id]
            configured = [i.provider_id for i in self.instances.values() if i.runtime_id == runtime_id]
            return await self.commands.list_providers(runtime, configured=configured)

        groups = await asyncio.gather(*(one(rid) for rid in sorted(self.config.runtimes)))
        return {"node_id": self.node_id, "items": [item for group in groups for item in group]}

    # ------------------------------------------------------------------ recorders / summaries
    async def new_recorder(
        self,
        instance: ComponentInstance,
        *,
        operation: str,
        recording_id: str,
        config: Mapping[str, Any] | None,
        run_id: str | None = None,
        call_id: str | None = None,
        synthetic: bool = False,
    ) -> Recorder:
        self.index.touch(recording_id)

        def make() -> Recorder:
            return Recorder(
                recordings_root=self.recordings_root,
                recording_id=recording_id,
                stream_id=STREAM_ID,
                node_id=self.node_id,
                component_id=instance.component_id,
                provider_id=instance.provider_id,
                process_instance_id=self.process_instance_id,
                operation=operation,
                run_id=run_id,
                call_id=call_id,
                config=config,
                publish=self._publish_node_record,
                synthetic=synthetic,
            )

        return await asyncio.to_thread(make)

    def _publish_node_record(self, record: dict[str, Any]) -> bool:
        """Node 端 Recorder 的 publish：summary 不在這裡送（Node 會與 runtime summary 合併後再發布一次）。"""
        if record.get("record") == "summary":
            return True
        return self.publisher.enqueue(record)

    def environment(
        self,
        instance: ComponentInstance,
        proc: RuntimeProcess | None,
        *,
        runtime_process_instance_id: str | None = None,
    ) -> dict[str, Any]:
        env = environment_facts()
        env.update(
            {
                "role": "node",
                "node_process_instance_id": self.process_instance_id,
                "source_revision": self.source_revision,
                "platform": platform_tag(),
                "runtime_id": instance.runtime_id,
                "device": instance.stored_device(),
                "runtime_pid": proc.pid if proc is not None else None,
                "runtime_process_instance_id": proc.process_instance_id
                if proc is not None
                else runtime_process_instance_id,
            }
        )
        return env

    def requested_context(self, settings: Mapping[str, Any], revision: int) -> dict[str, Any]:
        return effective_context(
            requested=settings,
            effective=settings,
            observed={},
            stored_revision=revision,
            loaded_revision=None,
            expanded_parts={},
            model_identity={},
            runtime_identity={},
        )

    @staticmethod
    def merge_summaries(node: Mapping[str, Any], runtime: Mapping[str, Any] | None, state: str) -> dict[str, Any]:
        """Node stream 與 runtime stream 合併。Node 只交出路徑（no-op）的 disk_read／disk_write 不輸出 0 值
        metric，以免以 0 覆蓋元件程序實際讀寫的計數（每個實際 I/O 只有一個計數 owner）。"""
        primary = {k: (dict(v) if isinstance(v, Mapping) else v) for k, v in node.items()}
        metrics = dict(primary.get("metrics") or {})
        totals = primary.get("transfer_totals") or {}
        for category, name in (("disk_read", "logical_disk_read_bytes"), ("disk_write", "logical_disk_written_bytes")):
            total = totals.get(category) if isinstance(totals, Mapping) else None
            if isinstance(total, Mapping) and not total.get("submitted_count") and total.get("no_op_count"):
                metrics.pop(name, None)
        primary["metrics"] = metrics
        if runtime is not None and not contracts.is_valid("RecordingSummary", runtime):
            primary.setdefault("notes", [])
            primary["notes"] = [*primary["notes"], "元件程序回報的 summary 不符合契約，未合併"]
            runtime = None
        return merge_summaries(primary, runtime, state=state)

    def placeholder_summary(self, recording_id: str, state: str, error: Mapping[str, Any] | None) -> dict[str, Any]:
        notes = ["Node 端紀錄器無法建立；只有最小摘要"]
        if error:
            notes.append(f"error：{error.get('code')}：{str(error.get('message'))[:500]}")
        return {
            "recording_id": recording_id,
            "state": state,
            "metrics": {},
            "transfer_totals": {},
            "part_totals": {},
            "coverage": "none",
            "dropped_events": 0,
            "dropped_bytes": 0,
            "detail_truncated": False,
            "notes": notes,
            "context_available": False,
        }

    async def publish_final_summary(self, recording_id: str, summary: dict[str, Any]) -> None:
        """合併後的 summary 原子替換 summary.json，並送 publisher（元件程序自己的 summary 不轉送）。"""

        def work() -> None:
            atomic_write_json(self.recordings_root / recording_id / "summary.json", summary)

        try:
            await asyncio.to_thread(work)
        except OSError as exc:
            log.warning("寫入 recording %s 的 summary 失敗：%s", recording_id, exc)
        self.publisher.enqueue({"record": "summary", "data": summary})
        self.index.close(recording_id)

    async def inline_or_fileref_summary(self, recording_id: str, summary: dict[str, Any]) -> dict[str, Any]:
        data = canonical_json(summary)
        if len(data) <= INLINE_MAX_BYTES:
            return summary

        def work() -> dict[str, Any]:
            writer = self.store.new_writer(
                "application/json", {"role": "recording_summary", "recording_id": recording_id}
            )
            writer.write(data)
            return writer.commit()

        return await asyncio.to_thread(work)

    def on_telemetry(self, proc: RuntimeProcess, record: dict[str, Any]) -> None:
        """元件程序 telemetry pipe 的 record（背景執行緒呼叫）。summary 由 Node 合併後再發布，這裡不轉送。"""
        kind = record.get("record")
        if kind in ("context", "event"):
            self.publisher.enqueue(record)


__all__ = ["NodeService"]
