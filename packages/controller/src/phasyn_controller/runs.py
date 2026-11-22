"""run.json 的保存、列表與重啟時標記 interrupted.

``runs/<run_id>/run.json`` 是這次執行的快照與結果，不是待恢復佇列：主控重啟時所有非終態
run 一律改為 interrupted（非終態步驟也改為 interrupted），不重新連回工作、不推進 DAG、不重送。

封存（x-phasyn-extension）只是 run.json 的 ``archived_at`` 標記，影響列表預設篩選；
刪除是使用者明確要求的永久移除（目錄先原子改名再清除）。兩者都只接受已結束的 run。
"""

from __future__ import annotations

import bisect
import json
import logging
import shutil
import threading
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.canonical import read_json
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.fs import atomic_write_bytes
from phasyn_components.ids import is_uuid, new_id, require_uuid
from phasyn_components.records import decode_cursor, encode_cursor
from phasyn_components.timeutil import utc_now

from .studio_work import (
    ProjectScope,
    indexed_origin,
    origin_project,
    project_match,
    projected_work,
)


log = logging.getLogger("phasyn_controller.runs")

TERMINAL_RUN_STATES = frozenset({"succeeded", "failed", "cancelled", "interrupted"})
TERMINAL_STEP_STATES = frozenset(
    {"succeeded", "failed", "cancelled", "interrupted", "skipped"}
)
RESTART_MESSAGE = "Controller 重啟；不恢復、不重送"
STOP_MESSAGE = "Controller 停止；不恢復、不重送"
DEFAULT_PAGE = 50
MAX_PAGE = 200
ARCHIVE_FILTERS = (
    "exclude",
    "include",
    "only",
)  # GET /api/runs?archived=（預設 exclude）


def interrupted_error(message: str) -> dict[str, Any]:
    """Build the error stored for an interrupted run."""
    return {"code": "INTERRUPTED", "message": message}


def mark_interrupted(run: dict[str, Any], message: str) -> dict[str, Any]:
    """非終態 run → interrupted；非終態步驟 → interrupted。只改紀錄，不做任何遠端動作."""
    now = utc_now()
    run["state"] = "interrupted"
    run["finished_at"] = now
    run["error"] = interrupted_error(message)
    for entry in (run.get("steps") or {}).values():
        if isinstance(entry, dict) and entry.get("state") not in TERMINAL_STEP_STATES:
            if entry.get("call_id"):
                entry["remote_outcome_unknown"] = True
            entry["state"] = "interrupted"
            entry["finished_at"] = now
    return run


def encode_run(run: dict[str, Any]) -> bytes:
    """Serialize a run to UTF-8 JSON while rejecting non-finite numbers."""
    return json.dumps(run, ensure_ascii=False, allow_nan=False, indent=2).encode(
        "utf-8"
    )


class RunStore:
    """run.json 檔案與列表索引.

    ``_keys``（(created_at, run_id) 升冪）與 ``_archived`` 由 ``_index_lock`` 保護，持有時間很短（事件迴圈上的
    列表分頁也會取它）；封存與刪除的檔案操作另由 ``_write_lock`` 串行，避免刪除後又被封存寫回。
    執行中的 run 只由 runner 寫入；封存與刪除只接受不在 runner 裡、已結束的 run（由呼叫端檢查 runner）。
    """

    def __init__(self, data_dir: Path) -> None:
        """Set the run directory and initialize the ordered run index."""
        self.root = Path(data_dir) / "runs"
        self.root.mkdir(parents=True, exist_ok=True)
        self._keys: list[tuple[str, str]] = []  # (created_at, run_id) 升冪
        self._work: dict[str, dict[str, str]] = {}
        # run_id → the project its origin names (project work or a tool run started from a project)
        self._projects: dict[str, str] = {}
        self._archived: set[str] = set()
        self._index_lock = threading.Lock()
        self._write_lock = threading.Lock()

    def path(self, run_id: str) -> Path:
        """Return the local path for the validated document identity."""
        return self.root / require_uuid(run_id, "run_id") / "run.json"

    def write(self, run_id: str, data: bytes) -> None:
        """Atomically replace the saved run document."""
        atomic_write_bytes(self.path(run_id), data)

    def read(self, run_id: str) -> dict[str, Any]:
        """Load the run by its validated UUID."""
        path = self.path(run_id)
        try:
            doc = read_json(path)
        except FileNotFoundError as exc:
            raise ComponentError(
                "NOT_FOUND", f"找不到 run {run_id}", details={"run_id": run_id}
            ) from exc
        except (OSError, ValueError) as exc:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"run {run_id} 的 run.json 無法讀取：{exception_message(exc)}",
            ) from exc
        if not isinstance(doc, dict):
            raise ComponentError(
                "RUNTIME_ERROR", f"run {run_id} 的 run.json 不是 JSON object"
            )
        return doc

    @staticmethod
    def _index_work(
        index: dict[str, dict[str, str]],
        projects: dict[str, str],
        run_id: str,
        request: Any,
    ) -> None:
        work = indexed_origin(request)
        if work:
            index[run_id] = work
        if (project := origin_project(request)) is not None:
            projects[run_id] = project

    def add(
        self, created_at: str, run_id: str, request: dict[str, Any] | None = None
    ) -> None:
        """Insert the run into the creation-time index."""
        with self._index_lock:
            self._index_work(self._work, self._projects, run_id, request)
            bisect.insort(self._keys, (created_at, run_id))

    def scan(self, *, interrupt_message: str = RESTART_MESSAGE) -> list[dict[str, Any]]:
        """建立列表索引；把非終態 run 改為 interrupted 並寫回。回傳被改的 run."""
        keys: list[tuple[str, str]] = []
        archived: set[str] = set()
        work_index: dict[str, dict[str, str]] = {}
        projects: dict[str, str] = {}
        swept: list[dict[str, Any]] = []
        for entry in self.root.iterdir() if self.root.is_dir() else []:
            if not entry.is_dir() or not is_uuid(entry.name):
                continue
            path = entry / "run.json"
            try:
                run = read_json(path)
            except FileNotFoundError:
                continue
            except (OSError, ValueError) as exc:
                log.warning("略過無法讀取的 run.json %s：%s", path, exc)
                continue
            if not isinstance(run, dict) or run.get("run_id") != entry.name:
                log.warning("略過內容不符的 run.json %s", path)
                continue
            self._index_work(work_index, projects, entry.name, run.get("request"))
            if run.get("state") not in TERMINAL_RUN_STATES:
                if (
                    run.get("recovery_version") == 1
                    and contracts.is_valid("Run", run)
                    and set(run["steps"])
                    == {step["step_id"] for step in run["request"]["pipeline"]["steps"]}
                ):
                    swept.append(run)
                    keys.append((str(run.get("created_at") or ""), entry.name))
                    continue
                mark_interrupted(run, interrupt_message)
                try:
                    atomic_write_bytes(path, encode_run(run))
                except (OSError, ValueError) as exc:
                    log.error(  # noqa: TRY400 — keep external failures out of tracebacks.
                        "run %s 無法標記為 interrupted：%s",
                        entry.name,
                        exc,
                    )
                swept.append(run)
            keys.append((str(run.get("created_at") or ""), entry.name))
            if run.get("archived_at"):
                archived.add(entry.name)
        keys.sort()
        with self._index_lock:
            self._work = work_index
            self._projects = projects
            self._keys = keys
            self._archived = archived
        return swept

    def page(
        self,
        cursor: str | None,
        limit: int,
        *,
        archived: str = "exclude",
        work: dict[str, str] | None = None,
    ) -> tuple[list[str], str | None]:
        """List Run IDs for existing store callers."""
        rows, after = self.history_page(cursor, limit, archived=archived, work=work)
        return [rid for rid, _ in rows], after

    def history_page(
        self,
        cursor: str | None,
        limit: int,
        *,
        archived: str = "exclude",
        work: dict[str, str] | None = None,
        scope: ProjectScope | None = None,
    ) -> tuple[list[tuple[str, dict[str, str]]], str | None]:
        """新到舊；cursor 是 base64url 位置資料（不簽名、不是 token）.

        ``archived``：exclude（預設，不列已封存）、include（全部）、only（只列已封存）。篩選在走訪排序鍵時
        進行，cursor 仍是上一頁最後一筆的位置，所以分頁是「篩選後集合」的新到舊、不重複也不漏。
        ``scope``：``work`` 專案記錄的 take／匯出連結；``scope.related`` 時 ``work`` 只有 project_id，另外也列出
        origin 指名這個專案的工具 run（例如影片檢查、轉錄）。
        """
        if archived not in ARCHIVE_FILTERS:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"archived 必須是 {'、'.join(ARCHIVE_FILTERS)} 之一：{archived!r}",
                details={"field": "archived", "value": archived},
            )
        position = decode_cursor(cursor) if cursor else None
        found: list[tuple[tuple[str, str], dict[str, str]]] = []
        query = work or {}
        attached = scope.links if scope else {}
        related = query.get("project_id") if scope and scope.related else None
        with self._index_lock:
            index = (
                bisect.bisect_left(self._keys, position)
                if position is not None
                else len(self._keys)
            )
            while index > 0 and len(found) <= limit:
                index -= 1
                key = self._keys[index]
                if archived == "include" or (key[1] in self._archived) == (
                    archived == "only"
                ):
                    match = (
                        project_match(
                            self._work.get(key[1], {}),
                            self._projects.get(key[1]),
                            related,
                            attached.get(key[1]),
                        )
                        if related is not None
                        else projected_work(
                            self._work.get(key[1], {}), query, attached.get(key[1])
                        )
                    )
                    if match is not None:
                        found.append((key, match))
        items = found[:limit]
        next_cursor = (
            encode_cursor(*items[-1][0]) if len(found) > limit and items else None
        )
        return [(key[1], match) for key, match in items], next_cursor

    # Keep the store API compatible with callers that pass the archive flag positionally.
    def set_archived(self, run_id: str, archived: bool) -> dict[str, Any]:  # noqa: FBT001
        """設定或移除 run.json 的 ``archived_at``（x-phasyn-extension）。只接受已結束的 run.

        已封存再封存保留原本時間；未封存再取消封存不寫檔。回傳更新後的 run。
        """
        rid = require_uuid(run_id, "run_id")
        with self._write_lock:
            run = self.read(rid)
            state = run.get("state")
            if state not in TERMINAL_RUN_STATES:
                raise ComponentError(
                    "STATE_CONFLICT",
                    f"run {rid} 尚未結束（{state}），不能{'封存' if archived else '取消封存'}",
                    details={"run_id": rid, "state": state},
                )
            changed = False
            if archived and not run.get("archived_at"):
                run["archived_at"] = utc_now()
                changed = True
            elif not archived and "archived_at" in run:
                del run["archived_at"]
                changed = True
            if changed:
                try:
                    self.write(rid, encode_run(run))
                except (OSError, ValueError) as exc:
                    raise ComponentError(
                        "RUNTIME_ERROR",
                        f"run {rid} 的 run.json 寫入失敗：{exception_message(exc)}",
                    ) from exc
            with self._index_lock:
                if archived:
                    self._archived.add(rid)
                else:
                    self._archived.discard(rid)
        return run

    def delete(self, run_id: str) -> bool:
        """永久刪除 ``runs/<run_id>/`` 與列表鍵；目錄先原子改名（GET 立刻 404）再清除。兩者都不存在 → False."""
        rid = require_uuid(run_id, "run_id")
        directory = self.root / rid
        trash = self.root / f".deleted-{rid}-{new_id()[:8]}"
        with self._write_lock:
            try:
                directory.rename(trash)
                moved = True
            except FileNotFoundError:
                moved = False
            except OSError as exc:
                raise ComponentError(
                    "RUNTIME_ERROR",
                    f"run {rid} 無法刪除：{exception_message(exc)}；run 紀錄未變更",
                    details={"run_id": rid},
                ) from exc
            with self._index_lock:
                before = len(self._keys)
                self._keys = [
                    key for key in self._keys if key[1] != rid
                ]  # 刪除不改變其餘順序
                self._work.pop(rid, None)
                self._projects.pop(rid, None)
                listed = len(self._keys) != before
                self._archived.discard(rid)
        if moved:
            try:
                shutil.rmtree(trash)
            except OSError as exc:
                log.warning(
                    "已刪除 run 的目錄 %s 無法完全清除（已不在列表與查詢中，需手動清理）：%s",
                    trash,
                    exc,
                )
        return moved or listed


__all__ = [
    "ARCHIVE_FILTERS",
    "DEFAULT_PAGE",
    "MAX_PAGE",
    "RESTART_MESSAGE",
    "STOP_MESSAGE",
    "TERMINAL_RUN_STATES",
    "TERMINAL_STEP_STATES",
    "RunStore",
    "encode_run",
    "interrupted_error",
    "mark_interrupted",
]
