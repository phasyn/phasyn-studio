"""Permanently deleting a run (x-phasyn-extension): ``DELETE /api/runs/{run_id}[?dry_run=true]``.

Only on the user's explicit request. The plan:

1. files: the files this run produced — the ``file`` of every step output TypedValue and of ``media.asset.v1``
   inline values, plus their ``metadata.links`` attachments (e.g. a latent manifest's blob), deduplicated by
   (node_id, file_id). Files the run request itself refers to (inputs, literals, FileRefs in parameters) are
   always excluded: they belong to the run that produced them or to the uploader.
2. recordings: the controller's copies of recordings with this run_id (plus those run.json lists that are still
   on the controller).
3. projects: Studio projects whose takes or exports refer to this run.

A run that a prompt study refers to cannot be deleted (dry_run too): 409 STATE_CONFLICT with the studies in
``details.prompt_studies``; a study's own deletion purges the runs it owns with ``owner_study`` excluding itself.

``dry_run=true`` only returns the plan. A real deletion, in order: (1) ask each source Node to
``DELETE /api/files/{id}`` (FILE_NOT_FOUND = already gone, counts as done); the first failure stops with 502
and Error.details is the same plan (deleted items marked), recordings, projects and the run record are left
untouched, and the user may delete again later (never retried automatically). (2) Delete the controller's
recording copies. (3) Remove the references from Studio projects (the normal save path, revision + 1).
(4) Delete the run record. ``deleted: true`` only when all four steps finished.

Out of scope: copies other Nodes downloaded to run it (``files/remote/…``), Node-local recording files, and files
a step with an unknown outcome (remote_outcome_unknown) may have produced on a Node without the run knowing; the
storage cleanup (:mod:`phasyn_controller.storage`) reclaims those, and passes ``keep`` for files something else names.
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

import httpx
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.ids import is_uuid, require_uuid
from phasyn_components.typed import file_links, is_fileref
from phasyn_server.http import parse_json_bytes

from .media_file_holds import pending_media_files
from .nodeclient import FORWARD_TIMEOUT, error_from_response, transport_error
from .runs import TERMINAL_RUN_STATES


if TYPE_CHECKING:
    from .state import Controller

MAX_ERROR_ITEMS = 5

log = logging.getLogger("phasyn_controller.purge")

FileKey = tuple[str, str]


def file_key(ref: Mapping[str, Any]) -> FileKey:
    """(node_id, file_id) in lowercase: the identity of a FileRef."""
    return str(ref.get("node_id") or "").lower(), str(ref.get("file_id") or "").lower()


def referenced_files(obj: Any) -> Iterator[Mapping[str, Any]]:
    """深度走訪任意 JSON，列出所有 FileRef 形狀的物件（包含 metadata.links 內的）."""
    stack = [obj]
    while stack:
        current = stack.pop()
        if isinstance(current, Mapping):
            if is_fileref(current):
                yield current
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def _with_links(ref: Mapping[str, Any]) -> Iterator[Mapping[str, Any]]:
    """FileRef 本身，接著依宣告順序列出 metadata.links 的附件（附件的附件也算）."""
    stack: list[Mapping[str, Any]] = [ref]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(list(file_links(current).values())))


def _output_files(run: Mapping[str, Any]) -> Iterator[Mapping[str, Any]]:
    for step in (run.get("steps") or {}).values():
        outputs = step.get("outputs") if isinstance(step, Mapping) else None
        if not isinstance(outputs, Mapping):
            continue
        for value in outputs.values():
            if not isinstance(value, Mapping):
                continue
            ref = value.get("file")
            if isinstance(ref, Mapping) and is_fileref(ref):
                yield from _with_links(ref)
            # inline 值裡內嵌的檔案（media.asset.v1、image.asset.v1 與其他帶 FileRef 的 inline 輸出）
            inline = value.get("value")
            if isinstance(inline, Mapping | list):
                for nested in referenced_files(inline):
                    yield from _with_links(nested)


def produced_files(run: Mapping[str, Any]) -> list[dict[str, Any]]:
    """這個 run 產生、要刪除的檔案（計畫順序=步驟與輸出順序；去重；排除 run 請求引用的檔案）."""
    excluded = {file_key(ref) for ref in referenced_files(run.get("request"))}
    seen: set[FileKey] = set()
    out: list[dict[str, Any]] = []
    for ref in _output_files(run):
        key = file_key(ref)
        if key in seen or key in excluded or not (is_uuid(key[0]) and is_uuid(key[1])):
            continue
        seen.add(key)
        size = ref.get("size_bytes")
        known = isinstance(size, int) and not isinstance(size, bool) and size >= 0
        out.append(
            {
                "node_id": key[0],
                "file_id": key[1],
                "size_bytes": size if known else None,
                "status": "planned",
            }
        )
    return out


class RunPurge:
    """永久刪除與封存共用的 run 狀態檢查；同一個 run 同時只有一個刪除作業（重複請求回 409，不排隊）."""

    def __init__(self, ctl: Controller) -> None:
        """Use the Controller to plan and perform run deletions."""
        self.ctl = ctl
        self.busy: set[str] = set()

        self.attachments: Counter[str] = Counter()

    @contextmanager
    def hold_for_attach(self, run_id: str) -> Iterator[None]:
        """Event-loop-owned shared reader exclusion with permanent purge."""
        self.ensure_idle(run_id, action="附加")
        self.attachments[run_id] += 1
        try:
            yield
        finally:
            self.attachments[run_id] -= 1
            if not self.attachments[run_id]:
                del self.attachments[run_id]

    def ensure_idle(self, run_id: str, *, action: str) -> None:
        """Refuse the operation while the run is still active."""
        execution = self.ctl.runner.executions.get(run_id)
        if execution is not None:
            raise ComponentError(
                "STATE_CONFLICT",
                f"run 仍在執行：先取消，結束後才能{action}",
                details={"run_id": run_id, "state": execution.run.get("state")},
            )
        if run_id in self.busy:
            raise ComponentError(
                "STATE_CONFLICT",
                f"run {run_id} 正在刪除中，不能{action}",
                details={"run_id": run_id},
            )

    async def purge(
        self,
        run_id: str,
        *,
        dry_run: bool,
        owner_study: str | None = None,
        keep: Mapping[FileKey, str] | None = None,
    ) -> dict[str, Any]:
        """Plan (``dry_run``) or permanently delete one finished run.

        ``owner_study`` is the prompt study whose own deletion removes this run: its reference does not block.
        ``keep`` (the storage cleanup) maps files that something else still needs to the reason they are kept.
        """
        rid = require_uuid(run_id, "run_id")
        self.ensure_idle(rid, action="刪除")
        if self.attachments[rid]:
            raise ComponentError(
                "STATE_CONFLICT", "正在附加這個執行結果", details={"run_id": rid}
            )
        if dry_run:
            run = await self._load(rid)
            await self._ensure_unreferenced(rid, owner_study)
            return await asyncio.to_thread(
                self._plan, rid, run, dry_run=True, keep=keep
            )
        self.busy.add(rid)
        try:
            run = await self._load(rid)
            await self._ensure_unreferenced(rid, owner_study)
            result = await asyncio.to_thread(
                self._plan, rid, run, dry_run=False, keep=keep
            )
            self._ensure_files_unused(rid, result["files"])
            await self._execute(rid, run, result)
        finally:
            self.busy.discard(rid)
        log.info(
            "run %s 已永久刪除：檔案 %d 個（%d 個已不存在）、紀錄副本 %d 份、Studio 專案 %d 個",
            rid,
            len(result["files"]),
            sum(1 for item in result["files"] if item["status"] == "missing"),
            result["recordings"]["deleted"],
            len(result["projects"]),
        )
        return result

    # ------------------------------------------------------------------ plan
    async def _load(self, rid: str) -> dict[str, Any]:
        run = await asyncio.to_thread(self.ctl.runs.read, rid)
        state = run.get("state")
        if state not in TERMINAL_RUN_STATES:
            raise ComponentError(
                "STATE_CONFLICT",
                f"run {rid} 的狀態是 {state}（未結束），不能刪除；主控重啟時未結束的 run 會改為 interrupted",
                details={"run_id": rid, "state": state},
            )
        return run

    async def _ensure_unreferenced(self, rid: str, owner_study: str | None) -> None:
        """A run that a prompt study still cites cannot be purged (the study would lose its evidence)."""
        if await asyncio.to_thread(self.ctl.studio.generation_takes, rid):
            raise ComponentError(
                "STATE_CONFLICT",
                "鏡頭 Take 仍引用這次生成的 latent",
                details={"run_id": rid},
            )
        if await asyncio.to_thread(self.ctl.drafts.store.references, rid):
            raise ComponentError(
                "STATE_CONFLICT", "草稿計畫仍引用這個執行結果", details={"run_id": rid}
            )
        studies = await asyncio.to_thread(self.ctl.prompt_studies.run_references, rid)
        blocking = [item for item in studies if item["study_id"] != owner_study]
        if blocking:
            titles = "、".join(
                str(item["title"]) for item in blocking[:MAX_ERROR_ITEMS]
            )
            raise ComponentError(
                "STATE_CONFLICT",
                f"run {rid} 仍被反推研究引用（{titles}{'…' if len(blocking) > MAX_ERROR_ITEMS else ''}）；"
                "請先在研究中移除它，或刪除研究時一併處理",
                details={"run_id": rid, "prompt_studies": blocking[:50]},
            )

    def _recording_ids(self, rid: str, run: Mapping[str, Any]) -> list[str]:
        store = self.ctl.store
        ids = store.ids_for_run(rid)
        for extra in run.get("recording_ids") or []:
            if is_uuid(extra) and extra not in ids and store.exists(extra):
                ids.append(extra)
        return ids

    def _plan(
        self,
        rid: str,
        run: Mapping[str, Any],
        *,
        dry_run: bool,
        keep: Mapping[FileKey, str] | None = None,
    ) -> dict[str, Any]:
        files = produced_files(run)
        library = self.ctl.studio.library_file_keys()
        for item in files:
            key = (item["node_id"], item["file_id"])
            if key in library:
                item.update(
                    status="kept",
                    message="已加入 Studio 專案素材庫，保留檔案（只移除 run 與 take）",
                )
            elif keep is not None and key in keep:
                item.update(status="kept", message=keep[key])
        return {
            "run_id": rid,
            "dry_run": dry_run,
            "deleted": False,
            "files": files,
            "recordings": {"planned": len(self._recording_ids(rid, run)), "deleted": 0},
            "projects": self.ctl.studio.run_references(rid),
        }

    def _ensure_files_unused(self, rid: str, files: list[dict[str, Any]]) -> None:
        """執行中的 run 正以這些檔案當輸入 → 409（刪了會讓它的步驟讀不到檔案）."""
        held = pending_media_files(self.ctl)
        planned = {(item["node_id"], item["file_id"]) for item in files}
        if any(
            file_key(item) in held for item in files if item.get("status") != "kept"
        ):
            raise ComponentError(
                "STATE_CONFLICT", "正將來源影片加入 Studio，請在保存完成後重試"
            )
        for other_id, execution in self.ctl.runner.executions.items():
            used = sorted(
                planned
                & {
                    file_key(ref)
                    for ref in referenced_files(execution.run.get("request"))
                }
            )
            if used:
                raise ComponentError(
                    "STATE_CONFLICT",
                    # A fixed sentence the UI can translate; which run holds the files is in the details
                    "這個 run 產生的檔案正被另一個執行中的工作使用；等它結束後再刪除",
                    details={
                        "run_id": rid,
                        "active_run_id": other_id,
                        "files": [
                            {"node_id": node, "file_id": fid} for node, fid in used[:50]
                        ],
                    },
                )

    # ------------------------------------------------------------------ execute
    async def _execute(
        self, rid: str, run: Mapping[str, Any], result: dict[str, Any]
    ) -> None:
        for item in result["files"]:
            if item["status"] == "kept":
                continue
            try:
                item["status"] = await self.delete_file(
                    item["node_id"], item["file_id"]
                )
            except ComponentError as err:
                item.update(status="failed", code=err.code, message=err.message)
                label = self.ctl.catalog.label(item["node_id"])
                deleted = sum(
                    1 for other in result["files"] if other["status"] == "deleted"
                )
                log.warning(
                    "run %s 刪除中止：Node %s 的檔案 %s 刪除失敗：%s",
                    rid,
                    label,
                    item["file_id"],
                    err,
                )
                raise ComponentError(
                    err.code,
                    f"刪除 Node {label} 上的檔案 {item['file_id']} 失敗：{err.message}。已停止：紀錄、Studio 專案與"
                    f" run 紀錄都沒有變更（這次已刪除 {deleted} 個檔案）；可稍後再刪除一次，不自動重試",
                    details=result,
                    remote_outcome_unknown=err.remote_outcome_unknown,
                    status=502,
                ) from err
        await self._phase(
            "刪除主控紀錄副本", result, self._delete_recordings, rid, run, result
        )
        await self._phase(
            "移除 Studio 專案參照", result, self._remove_project_refs, rid, result
        )
        await self._phase("刪除 run 紀錄", result, self.ctl.runs.delete, rid)
        result["deleted"] = True

    async def _phase(
        self, what: str, result: dict[str, Any], fn: Callable[..., Any], *args: Any
    ) -> None:
        try:
            await asyncio.to_thread(fn, *args)
        except Exception as exc:
            err = (
                exc
                if isinstance(exc, ComponentError)
                else ComponentError(
                    "RUNTIME_ERROR", f"{type(exc).__name__}: {exception_message(exc)}"
                )
            )
            log.error(  # noqa: TRY400 — keep external failures out of tracebacks.
                "run %s 刪除中止：%s失敗：%s",
                result["run_id"],
                what,
                err,
            )
            raise ComponentError(
                err.code,
                f"{what}失敗：{err.message}。已停止，run 紀錄尚未刪除（Node 上的檔案已刪除）；可稍後再刪除一次",
                details=result,
                status=max(err.status, 500),
            ) from exc

    async def delete_file(self, node_id: str, file_id: str) -> str:
        """Delete one produced file at its source: ``deleted`` or ``missing``; anything else raises ComponentError (transport errors → NODE_UNREACHABLE). Never retried."""
        ctl = self.ctl
        if (
            node_id == ctl.instance_id
        ):  # 主控自己的 FileStore（通常只有使用者上傳的輸入，不會在計畫中）
            return (
                "deleted"
                if await asyncio.to_thread(ctl.files.delete, file_id)
                else "missing"
            )
        endpoint = ctl.catalog.endpoint_for_call(
            node_id
        )  # offline/未登記/node_id 重複 → 沒有送出
        label = ctl.catalog.label(node_id)
        try:
            resp = await ctl.http.delete(
                f"{endpoint}/api/files/{file_id}", timeout=FORWARD_TIMEOUT
            )
        except httpx.HTTPError as exc:
            raise transport_error(
                exc,
                node_label=label,
                endpoint=endpoint,
                what="檔案刪除",
                side_effect=True,
                read_timeout=FORWARD_TIMEOUT.read,
            ) from exc
        if resp.status_code == HTTPStatus.OK:
            try:
                doc = parse_json_bytes(resp.content, what="檔案刪除結果")
            except ComponentError:
                doc = None
            if (
                isinstance(doc, dict)
                and doc.get("deleted") is True
                and str(doc.get("file_id")).lower() == file_id
            ):
                return "deleted"
            raise ComponentError(
                "RUNTIME_ERROR",
                f"Node {label} 的檔案刪除回覆無法解讀（HTTP 200）；遠端結果未知",
                details={"endpoint": endpoint, "body_head": resp.text[:500]},
                remote_outcome_unknown=True,
            )
        err = error_from_response(resp, what=f"Node {label} 的檔案刪除")
        if resp.status_code == HTTPStatus.NOT_FOUND and err.code == "FILE_NOT_FOUND":
            return "missing"
        raise err

    def _delete_recordings(
        self, rid: str, run: Mapping[str, Any], result: dict[str, Any]
    ) -> None:
        ids = self._recording_ids(rid, run)  # 執行當下重新查（可能有晚到的上報）
        counts = result["recordings"]
        counts["planned"] = len(ids)
        failed: list[str] = []
        for recording_id in ids:
            try:
                if self.ctl.store.delete(recording_id):
                    counts["deleted"] += 1
            except Exception:
                log.exception("run %s 的紀錄副本 %s 無法刪除", rid, recording_id)
                failed.append(recording_id)
        if failed:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"{len(failed)} 份紀錄副本無法刪除（{', '.join(failed[:MAX_ERROR_ITEMS])}{'…' if len(failed) > MAX_ERROR_ITEMS else ''}）",
            )

    def _remove_project_refs(self, rid: str, result: dict[str, Any]) -> None:
        pending = self.ctl.studio.run_references(rid)  # 執行當下重新掃描
        done: list[dict[str, Any]] = []
        result["projects"] = done + pending
        while pending:
            changed = self.ctl.studio.remove_run_refs(pending[0]["project_id"], rid)
            pending.pop(0)
            if changed is not None:
                done.append(changed)
            result["projects"] = done + pending


__all__ = ["FileKey", "RunPurge", "file_key", "produced_files", "referenced_files"]
