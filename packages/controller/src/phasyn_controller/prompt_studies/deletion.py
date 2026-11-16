"""Deleting a prompt study in one request (DELETE ?mode=keep_images|all&revision=); no background deletion.

The scope is computed first (the same as ``GET …/deletion-preview``); a running task or run → 409. Then, in
order: the runs owned only by this study are purged (keep_images keeps the runs that produced images, all
deletes them too), then the uploaded source image owned only by this study, then the study document. Runs and
files that another study or a Studio project still uses are kept (shared). The first failing step stops the
deletion and reports what was done (Error.details); nothing is retried, and deleting again is safe (a run that
no longer exists counts as deleted).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Iterator, Mapping
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError

from ..purge import FileKey, file_key, produced_files, referenced_files
from ..revisions import require_revision, stored_revision
from ..runs import TERMINAL_RUN_STATES
from .checks import invalid
from .references import deep_run_ids, study_run_ids
from .store import PromptStudyStore

if TYPE_CHECKING:
    from ..state import Controller

log = logging.getLogger("phasyn_controller.prompt_studies")

DELETE_MODES = ("keep_images", "all")


class PromptStudyDeletion:
    """一次請求的刪除；計畫與 GET deletion-preview 相同。"""

    def __init__(self, ctl: Controller) -> None:
        self.ctl = ctl

    @property
    def store(self) -> PromptStudyStore:
        return self.ctl.prompt_studies

    # ------------------------------------------------------------------ plan
    def _studio_references(self) -> tuple[set[str], set[FileKey]]:
        run_ids: set[str] = set()
        files: set[FileKey] = set()
        for doc in self.ctl.studio.documents():
            run_ids |= deep_run_ids(doc)
            files |= {file_key(ref) for ref in referenced_files(doc)}
        return run_ids, files

    def _all_runs(self, skip: set[str]) -> Iterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            ids, cursor = self.ctl.runs.page(cursor, 200, archived="include")
            for run_id in ids:
                if run_id in skip:
                    continue
                with contextlib.suppress(ComponentError):
                    yield self.ctl.runs.read(run_id)
            if cursor is None:
                return

    def plan(self, doc: Mapping[str, Any], mode: str) -> dict[str, Any]:
        if mode not in DELETE_MODES:
            raise invalid(f"mode 必須是 {'、'.join(DELETE_MODES)} 之一：{mode!r}", field="mode")
        study_id = str(doc["study_id"])
        others: dict[str, list[str]] = {}
        other_files: set[FileKey] = set()
        for other in self.store.all_docs():
            if other["study_id"] == study_id:
                continue
            for run_id in study_run_ids(other):
                others.setdefault(run_id, []).append(str(other["study_id"]))
            other_files |= {file_key(ref) for ref in referenced_files(other)}
        studio_runs, studio_files = self._studio_references()
        active = {str(run_id).lower() for run_id in self.ctl.runner.executions}
        rows: list[dict[str, Any]] = []
        for run_id in study_run_ids(doc):
            row: dict[str, Any] = {"run_id": run_id, "files": 0, "status": "planned", "message": None}
            try:
                run = self.ctl.runs.read(run_id)
            except ComponentError as exc:
                if exc.code != "NOT_FOUND":
                    raise
                rows.append(
                    {**row, "role": "unknown", "action": "missing", "reason": "run 已不存在", "status": "missing"}
                )
                continue
            files = produced_files(run)
            keys = {(item["node_id"], item["file_id"]) for item in files}
            row.update(files=len(files), role="image" if files else "analysis")
            if run_id in active or run.get("state") not in TERMINAL_RUN_STATES:
                row.update(action="active", reason="run 仍在執行；先取消，結束後才能刪除")
            elif run_id in others:
                row.update(
                    action="shared", reason=f"其他研究仍引用（{', '.join(sorted(others[run_id]))}）", status="kept"
                )
            elif run_id in studio_runs or keys & studio_files:
                row.update(action="shared", reason="Studio 專案仍引用這個 run 或它產生的檔案", status="kept")
            elif keys & other_files:
                row.update(action="shared", reason="其他研究仍引用它產生的檔案", status="kept")
            elif mode == "keep_images" and files:
                row.update(action="keep", reason="keep_images：保留產生圖片的 run 與圖片", status="kept")
            else:
                row.update(action="delete", reason="此研究獨占")
            rows.append(row)
        blocking = [
            {
                "code": "TASK_RUNNING",
                "message": f"任務 {task['task_id']} 仍標記為執行中；請先停止或標記為已中斷",
                "task_id": task["task_id"],
                "run_id": None,
            }
            for task in doc["tasks"]
            if task["state"] == "running"
        ]
        blocking += [
            {
                "code": "RUN_ACTIVE",
                "message": f"run {row['run_id']} 仍在執行；先取消，結束後才能刪除",
                "task_id": None,
                "run_id": row["run_id"],
            }
            for row in rows
            if row["action"] == "active"
        ]
        deleting = {row["run_id"] for row in rows if row["action"] in ("delete", "missing")}
        source = self._source_plan(doc, deleting, other_files, studio_files)
        results = [ref for task in doc["tasks"] for ref in task["result_refs"]]
        return {
            "study_id": study_id,
            "title": doc["title"],
            "mode": mode,
            "revision": doc["revision"],
            "dry_run": True,
            "deleted": False,
            "can_delete": not blocking,
            "blocking": blocking,
            "counts": {
                "versions": len(doc["versions"]),
                "tasks": len(doc["tasks"]),
                "evaluations": sum(1 for ref in results if ref["kind"] == "evaluation"),
                "images": sum(1 for ref in results if ref["kind"] == "render" and ref.get("image") is not None),
                "runs_delete": sum(1 for row in rows if row["action"] == "delete"),
                "runs_keep": sum(1 for row in rows if row["action"] in ("keep", "shared", "active")),
            },
            "runs": rows,
            "source": source,
        }

    def _source_plan(
        self,
        doc: Mapping[str, Any],
        deleting: set[str],
        other_files: set[FileKey],
        studio_files: set[FileKey],
    ) -> dict[str, Any]:
        ref = doc["source"]["file"]
        key = file_key(ref)
        plan = {"file": ref, "action": "keep", "status": "kept", "reason": ""}
        if doc["source"]["library_item"] is not None:
            return {**plan, "reason": "來自 Studio 專案素材庫（共用）"}
        if key[0] != str(self.ctl.instance_id).lower():
            return {**plan, "reason": "不是上傳到主控的檔案（屬於產生它的 run）"}
        if key in other_files:
            return {**plan, "reason": "其他研究仍使用這張原圖"}
        if key in studio_files:
            return {**plan, "reason": "Studio 專案仍使用這張原圖"}
        for run in self._all_runs(deleting):
            if key in {file_key(item) for item in referenced_files(run)}:
                return {**plan, "reason": f"run {run.get('run_id')} 仍引用這張原圖"}
        return {**plan, "action": "delete", "status": "planned", "reason": "此研究獨占的上傳原圖"}

    # ------------------------------------------------------------------ execute
    async def preview(self, study_id: str, mode: str) -> dict[str, Any]:
        doc = await asyncio.to_thread(self.store.get, study_id)
        return await asyncio.to_thread(self.plan, doc, mode)

    async def delete(self, study_id: str, mode: str, revision: int) -> dict[str, Any]:
        # The store lock is a threading.Lock shared with saves running in threads: never hold it on the loop.
        await asyncio.to_thread(self.store.begin_delete, study_id)
        try:
            doc = await asyncio.to_thread(self.store.get, study_id)
            require_revision(stored_revision(doc), revision, what="研究", suffix="請重新預覽後再刪除")
            plan = await asyncio.to_thread(self.plan, doc, mode)
            plan["dry_run"] = False
            if not plan["can_delete"]:
                raise ComponentError("STATE_CONFLICT", plan["blocking"][0]["message"], details=plan)
            for row in plan["runs"]:
                if row["action"] == "delete":
                    await self._delete_run(plan, row, study_id)
            if plan["source"]["action"] == "delete":
                await self._delete_source(plan)
            await asyncio.to_thread(self.store.remove, study_id, revision)
            plan["deleted"] = True
        finally:
            await asyncio.to_thread(self.store.end_delete, study_id)
        log.info(
            "反推研究 %s 已刪除（%s）：run %d 個、原圖 %s",
            study_id,
            mode,
            sum(1 for row in plan["runs"] if row["status"] == "deleted"),
            plan["source"]["status"],
        )
        return plan

    def _stopped(
        self, plan: dict[str, Any], what: str, err: ComponentError, *, status: int | None = None
    ) -> ComponentError:
        return ComponentError(
            err.code,
            f"{what}失敗：{err.message}。已停止：已完成的項目見 details（status=deleted），研究文件與尚未處理的"
            "項目沒有變更；可稍後再刪除一次（已不存在的 run 視為已刪除；不自動重試）",
            details=plan,
            remote_outcome_unknown=err.remote_outcome_unknown,
            status=status or (err.status if err.status >= 400 else 500),
        )

    async def _delete_run(self, plan: dict[str, Any], row: dict[str, Any], study_id: str) -> None:
        """Purge one run owned by this study (its produced files, recordings and Studio references included)."""
        run_id = row["run_id"]
        try:
            await self.ctl.purge.purge(run_id, dry_run=False, owner_study=study_id)
        except ComponentError as err:
            if err.code == "NOT_FOUND":
                row["status"] = "missing"
                return
            row.update(status="failed", message=err.message)
            raise self._stopped(plan, f"刪除 run {run_id}", err) from err
        row["status"] = "deleted"

    async def _delete_source(self, plan: dict[str, Any]) -> None:
        source = plan["source"]
        try:
            deleted = await asyncio.to_thread(self.ctl.files.delete, str(source["file"]["file_id"]))
        except ComponentError as err:
            source["status"] = "failed"
            raise self._stopped(plan, "刪除原圖", err) from err
        source["status"] = "deleted" if deleted else "missing"


__all__ = ["DELETE_MODES", "PromptStudyDeletion"]
