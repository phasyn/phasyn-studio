"""The controller's composition root: configuration, catalog, every store and service, the HTTP client to Nodes and the runner are created here, and routes only use ``ctl.<service>``.

Startup locks the data directory and opens the stores. Runs with a frozen plan reconnect to Node receipts.
Unfinished legacy runs are marked interrupted. Nodes retain accepted calls when the Controller stops.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

import httpx
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.fs import atomic_write_json
from phasyn_components.ids import is_uuid, new_id
from phasyn_components.records import RecordingStore
from phasyn_components.timeutil import utc_now
from phasyn_server import DataDirLock

from . import VERSION, run_submissions, studio_submissions
from .catalog import Catalog
from .config import ControllerConfig
from .cost_profiles import CostProfileService
from .docstore import JsonDocStore
from .draft_plans import DraftPlans
from .lora_training import LoraTrainings
from .nodeclient import FORWARD_TIMEOUT, KEEPALIVE_CLIENT_S
from .pipeline_layout import PipelineLayoutStore
from .plugins import STORE_DIR as PLUGINS_DIR, PluginStore
from .prompt_library import PromptLibraryStore
from .prompt_studies import (
    STORE_DIR as PROMPT_STUDIES_DIR,
    PromptStudyDeletion,
    PromptStudyStore,
)
from .purge import RunPurge
from .runner import RunManager
from .runs import RESTART_MESSAGE, RunStore
from .storage import StorageService
from .studio import StudioStore
from .studio_backfill import BACKFILL_DELAY_S, TERMINAL_RUN_STATES


log = logging.getLogger("phasyn_controller")

CATALOG_CACHE = "catalog-cache.json"
BACKGROUND_STOP_S = 10.0


def _started[T](value: T | None, name: str) -> T:
    if value is None:
        raise RuntimeError(f"controller 尚未啟動：{name} 只在 startup() 之後可用")
    return value


def interrupted_summary(recording_id: str, note: str) -> dict[str, Any]:
    """主控程序中斷而沒寫出 summary 的主控 recording：只標終態與原因，不補任何量測."""
    return {
        "recording_id": recording_id,
        "state": "interrupted",
        "metrics": {},
        "transfer_totals": {},
        "part_totals": {},
        "coverage": "partial",
        "dropped_events": 0,
        "dropped_bytes": 0,
        "detail_truncated": False,
        "notes": [
            note,
            "主控程序在此 recording 結束前中斷；summary 由重啟時補記終態，沒有量測值",
        ],
        "context_available": True,
    }


class Controller:
    """Manage local stores, Node connections and application lifecycle."""

    def __init__(
        self,
        config: ControllerConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] | None = None,
        lock: DataDirLock | None = None,
    ) -> None:
        """Configure the local data directory, dependencies and background task set."""
        self.config = config
        self.instance_id = config.instance_id
        self.data_dir = config.data_dir
        self.process_instance_id = new_id()
        self.started_at = utc_now()
        self.catalog = Catalog(
            stale_seconds=config.node_stale_seconds,
            controller_id=config.instance_id,
            controller_endpoint=config.advertise_url,
            clock=clock or time.monotonic,
            cache_path=config.data_dir / "config" / CATALOG_CACHE,
        )
        self._transport = transport
        self._external_lock = lock
        self._own_lock: DataDirLock | None = None
        self._store: RecordingStore | None = None
        self._files: FileStore | None = None
        self._pipelines: JsonDocStore | None = None
        self._pipeline_layout: PipelineLayoutStore | None = None
        self._presets: JsonDocStore | None = None
        self._studio: StudioStore | None = None
        self._prompt_library: PromptLibraryStore | None = None
        self._prompt_studies: PromptStudyStore | None = None
        self._plugins: PluginStore | None = None
        self._cost_profiles: CostProfileService | None = None
        self._runs: RunStore | None = None
        self._http: httpx.AsyncClient | None = None
        self._runner: RunManager | None = None
        self._background: set[asyncio.Task[Any]] = set()
        self._stop_event = asyncio.Event()
        self.started = False
        # One purge for DELETE /api/runs and prompt-study deletion: a run is never deleted twice at once.
        self.drafts = DraftPlans(self)
        self.trainings = LoraTrainings(self)
        self.purge = RunPurge(self)
        self.prompt_study_deletion = PromptStudyDeletion(self)
        # One storage cleanup at a time; it purges runs through ``self.purge``
        self.storage = StorageService(self)

    # ------------------------------------------------------------------ accessors
    @property
    def store(self) -> RecordingStore:
        """Return the active RecordingStore after Controller startup."""
        return _started(self._store, "store")

    @property
    def files(self) -> FileStore:
        """Return the active FileStore after Controller startup."""
        return _started(self._files, "files")

    @property
    def pipelines(self) -> JsonDocStore:
        """Return the active JsonDocStore after Controller startup."""
        return _started(self._pipelines, "pipelines")

    @property
    def pipeline_layout(self) -> PipelineLayoutStore:
        """Return the active PipelineLayoutStore after Controller startup."""
        return _started(self._pipeline_layout, "pipeline_layout")

    @property
    def presets(self) -> JsonDocStore:
        """Return the active JsonDocStore after Controller startup."""
        return _started(self._presets, "presets")

    @property
    def studio(self) -> StudioStore:
        """Return the active StudioStore after Controller startup."""
        return _started(self._studio, "studio")

    @property
    def prompt_library(self) -> PromptLibraryStore:
        """Return the active PromptLibraryStore after Controller startup."""
        return _started(self._prompt_library, "prompt_library")

    @property
    def prompt_studies(self) -> PromptStudyStore:
        """Return the active PromptStudyStore after Controller startup."""
        return _started(self._prompt_studies, "prompt_studies")

    @property
    def plugins(self) -> PluginStore:
        """Return the active PluginStore after Controller startup."""
        return _started(self._plugins, "plugins")

    @property
    def cost_profiles(self) -> CostProfileService:
        """Return the active CostProfileService after Controller startup."""
        return _started(self._cost_profiles, "cost_profiles")

    @property
    def runs(self) -> RunStore:
        """Return the active RunStore after Controller startup."""
        return _started(self._runs, "runs")

    @property
    def http(self) -> httpx.AsyncClient:
        """Return the active httpx.AsyncClient after Controller startup."""
        return _started(self._http, "http")

    @property
    def runner(self) -> RunManager:
        """Return the active RunManager after Controller startup."""
        return _started(self._runner, "runner")

    @property
    def recordings_root(self) -> Path:
        """Return the active Path after Controller startup."""
        return self.data_dir / "recordings"

    # ------------------------------------------------------------------ lifecycle
    def _open(self) -> list[dict[str, Any]]:
        for sub in ("config", "runs", "recordings", "files"):
            (self.data_dir / sub).mkdir(parents=True, exist_ok=True)
        run_submissions.initialize(self.data_dir)
        self._store = RecordingStore(
            self.data_dir / "recordings", self.data_dir / "recording-index.sqlite"
        )
        self._cost_profiles = CostProfileService(self._store)
        self._files = FileStore(self.data_dir, self.instance_id)
        self._pipelines = JsonDocStore(
            self.data_dir / "config" / "pipelines", id_field="pipeline_id", what="接線"
        )
        self._pipeline_layout = PipelineLayoutStore(
            self.data_dir / "config", self._pipelines
        )
        self._presets = JsonDocStore(
            self.data_dir / "config" / "presets", id_field="preset_id", what="preset"
        )
        self._studio = StudioStore(self.data_dir / "config" / "studio")
        self._prompt_library = PromptLibraryStore(self.data_dir / "config" / "studio")
        self._prompt_studies = PromptStudyStore(
            self.data_dir / "config" / PROMPT_STUDIES_DIR
        )
        self._plugins = PluginStore(
            self.data_dir / PLUGINS_DIR,
            self.config.plugins,
            host_version=VERSION,
            contracts_dir=contracts.contracts_dir(),
            projects=self.studio.documents,
        )
        self._plugins.open()
        self._runs = RunStore(self.data_dir)
        studio_submissions.recover(self)
        swept = self._runs.scan(interrupt_message=RESTART_MESSAGE)
        self._stop_event.clear()
        for run in swept:
            self.close_controller_recordings(run, RESTART_MESSAGE)
        loaded = self.catalog.load_cache()
        if loaded:
            log.info(
                "讀到 %d 個 Node 的目錄快取（顯示為 offline，等待重新登記）", loaded
            )
        return swept

    def close_controller_recordings(self, run: dict[str, Any], note: str) -> None:
        """Finalize unfinished Controller-owned recordings for the specified run."""
        store = self.store
        for rid in run.get("recording_ids") or []:
            if not is_uuid(rid):
                continue
            try:
                ctx = store.read_context(rid)
                if ctx is None or ctx.get("operation") != "controller":
                    continue
                if store.read_summary(rid) is None:
                    atomic_write_json(
                        store.directory(rid) / "summary.json",
                        interrupted_summary(rid, note),
                    )
                store.index_recording(rid)
            except Exception:  # 紀錄補記失敗不影響啟動
                log.exception(
                    "run %s 的主控 recording %s 無法補記終態", run.get("run_id"), rid
                )

    async def startup(self) -> None:
        """Lock the data directory and start the Controller services."""
        if self._external_lock is None:
            lock = DataDirLock(self.data_dir)
            lock.acquire()  # DataDirBusy → 啟動失敗
            self._own_lock = lock
        try:
            swept = await asyncio.to_thread(self._open)
        except BaseException:
            self._release_lock()
            raise
        self._stop_event.clear()
        for run in swept:
            if run.get("recovery_version") == 1 and run["state"] == "running":
                continue
            log.warning(
                "run %s 在主控停止前未結束，已標記為 interrupted（不恢復、不重送）",
                run.get("run_id"),
            )
        # Idle connections expire well before the servers close them (phasyn_server KEEPALIVE_SERVER_S): with equal 5 s limits a
        # call could go out on a connection the Node was closing and fail as a ReadError with an unknown outcome
        # (runs fc884c4e, 5cd556fb: the previous call on the connection had ended 4.3-4.9 s before)
        self._http = httpx.AsyncClient(
            transport=self._transport,
            timeout=FORWARD_TIMEOUT,
            trust_env=False,
            follow_redirects=False,
            limits=httpx.Limits(keepalive_expiry=KEEPALIVE_CLIENT_S),
        )

        self._runner = RunManager(self)
        for run in swept:
            if run.get("recovery_version") == 1 and run["state"] == "running":
                self._runner.restore(run)
        _ = self.spawn(self._runner.on_demand.idle_loop(self._stop_event))
        _ = self.spawn(self._index_local())
        _ = self.spawn(self.backfill_studio_pending())
        _ = self.spawn(self._warm_studio_list())
        await self.drafts.startup()
        await self.trainings.startup()
        self.started = True
        log.info(
            "主控已啟動：controller_id=%s endpoint=%s data_dir=%s",
            self.instance_id,
            self.config.advertise_url,
            self.data_dir,
        )

    async def shutdown(self) -> None:
        """Stop outstanding work and release owned resources."""
        self._stop_event.set()
        await self.drafts.shutdown()
        await self.trainings.shutdown()
        if self._studio is not None:
            await self._studio.writes.drain()
        if self._runner is not None:
            await self._runner.shutdown()
        if self._background:
            # 背景索引在每個 recording 之間檢查 _stopping；給它們有限時間收尾，再關 SQLite
            _, leftover = await asyncio.wait(
                set(self._background), timeout=BACKGROUND_STOP_S
            )
            for task in leftover:
                task.cancel()
            if leftover:
                await asyncio.gather(*leftover, return_exceptions=True)
        if self._http is not None:
            await self._http.aclose()
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self.catalog.save_cache, force=True)
        if self._store is not None:
            self._store.close()
        self._release_lock()
        self.started = False

    def _release_lock(self) -> None:
        if self._own_lock is not None:
            self._own_lock.release()
            self._own_lock = None

    async def backfill_studio_later(self, run: dict[str, Any]) -> None:
        """A finished run is read back into the Studio projects still waiting on it, after a delay that lets an open Studio tab do it first. A stop during the delay leaves it to the next start-up sweep."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._stop_event.wait(), timeout=BACKFILL_DELAY_S)
        if self._stop_event.is_set():
            return
        await self._backfill_runs({str(run.get("run_id") or "").lower(): run})

    async def backfill_studio_pending(self) -> None:
        """Start-up sweep: every ``rendering`` take or export whose run is no longer live is read back once."""
        try:
            waiting = await asyncio.to_thread(self.studio.projects_waiting_on)
        except Exception:
            log.exception("Studio 回填：無法讀取專案清單")
            return
        runs: dict[str, dict[str, Any]] = {}
        for run_id in sorted({rid for ids in waiting.values() for rid in ids}):
            if self._stop_event.is_set():
                return
            if self.runner.snapshot(run_id) is not None:
                continue  # still live: its own read-back follows when it ends
            try:
                runs[run_id] = await asyncio.to_thread(self.runs.read, run_id)
            except ComponentError as exc:
                log.warning(
                    "Studio 回填：run %s 讀不到（%s），對應的 take 保持原狀",
                    run_id,
                    exc.code,
                )
        await self._backfill_runs(runs)

    async def _backfill_runs(self, runs: dict[str, dict[str, Any]]) -> None:
        finished = {
            rid: run
            for rid, run in runs.items()
            if run.get("state") in TERMINAL_RUN_STATES
        }
        if not finished:
            return
        try:
            waiting = await asyncio.to_thread(self.studio.projects_waiting_on)
        except Exception:
            log.exception("Studio 回填：無法讀取專案清單")
            return
        for project_id, ids in waiting.items():
            mine = [finished[rid] for rid in sorted(ids) if rid in finished]
            if not mine or self._stop_event.is_set():
                continue
            try:
                saved = await asyncio.to_thread(self.studio.backfill, project_id, mine)
            except Exception:
                log.exception(
                    "Studio 回填：專案 %s 寫入失敗（下次啟動會再試）", project_id
                )
                continue
            if saved:
                log.info(
                    "Studio 回填：專案 %s 讀回 %d 個已結束的 run", project_id, len(mine)
                )

    def spawn(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        """Launch a background coroutine tracked for shutdown."""
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    async def _warm_studio_list(self) -> None:
        """Project summaries are cached per file version: build them once at start, not on the first page load."""
        try:
            await asyncio.to_thread(self.studio.list)
        except (ComponentError, OSError):
            log.exception("Studio 專案列表預先整理失敗；第一次列表時再整理")

    async def _index_local(self) -> None:
        """背景補索引本機紀錄檔（崩潰後的檔案/索引落差）；索引只是查詢用，可重建."""
        root = self.recordings_root
        try:
            ids = await asyncio.to_thread(
                lambda: [
                    p.name for p in root.iterdir() if p.is_dir() and is_uuid(p.name)
                ]
            )
        except OSError:
            return
        added = 0
        for rid in ids:
            if self._stop_event.is_set():
                return
            try:
                added += await asyncio.to_thread(self.store.index_recording, rid)
            except Exception:
                log.warning("recording %s 索引失敗（略過）", rid, exc_info=True)
        if added:
            log.info("背景索引補上 %d 筆事件", added)

    def save_catalog_cache_soon(self) -> None:
        """Schedule the catalog cache write while the Controller is active."""
        if not self._stop_event.is_set():
            _ = self.spawn(asyncio.to_thread(self.catalog.save_cache))


__all__ = ["Controller", "interrupted_summary"]
