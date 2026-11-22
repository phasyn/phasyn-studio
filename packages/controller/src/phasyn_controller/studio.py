"""Studio 專案文件（x-phasyn-extension）：``data_dir/config/studio/<project_id>.json``.

專案只保存使用者的編輯狀態（鏡頭、prompt、生成參數、takes 的 run 參照、匯出紀錄）；渲染與匯出仍是普通
run，事實來源是 run 與 recording。保存以 revision 做樂觀並行控制：本文 revision 必須等於目前 revision
（新專案為 0），成功後 +1；不符回 409 REVISION_CONFLICT，不自動合併、不覆寫別人的變更。

永久刪除 run 時，主控在伺服器端移除引用該 run 的 takes/exports，同樣走 revision+1 的保存路徑，
開著的編輯器下次保存會收到 409 並重新載入。

The Controller is the authority of the project's timeline (``StudioProject.timeline``, the single edit state).
Every read returns the normalized view (``phasyn_components.timeline_edit.normalize_project``: the timeline in line
with the shots and their takes) without writing anything; every write (``PUT``, the timeline commands, a run purge,
an export record) saves the normalized document. The first save that takes a project over keeps the document as
it was in ``_legacy/<project_id>.json`` next to the projects: one copy per project, never overwritten.

Take reviews (scorer results per take) are kept in ``_reviews/<project_id>.json`` (``studio_reviews``), outside the
project document, so writing them never changes the project's revision.
"""

from __future__ import annotations

import asyncio
import builtins
import copy
import logging
import threading
from collections.abc import Iterator, Mapping
from contextlib import AbstractContextManager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.canonical import read_json as read_json_file
from phasyn_components.creative_library import CreativeLibrary
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.fs import atomic_write_json
from phasyn_components.ids import require_local_id
from phasyn_components.timeline import validate_timeline
from phasyn_components.timeline_edit import (
    AllocateId,
    apply_commands,
    normalize_project,
    request_error,
)
from phasyn_components.timeline_edit.legacy import has_legacy_edit
from phasyn_components.timeutil import utc_now
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from .docstore import DocProjection, JsonDocStore
from .purge import file_key, referenced_files
from .revisions import require_revision, saved_form, stored_revision
from .studio_audit import StudioAudit, client_tag
from .studio_backfill import AUDIT_PATH, apply_runs, pending_run_ids
from .studio_previs import validate_previs
from .studio_reviews import REVIEWS_DIR, TakeReviewStore
from .studio_submissions import attach_render_takes, fail_pending_takes
from .studio_take_attach import (
    TakeTarget,
    append_candidate,
    compatible,
    receipt,
    target,
)
from .studio_take_source import conflict
from .studio_work import ProjectLinks, project_links
from .studio_writes import StudioWrites


if TYPE_CHECKING:
    from .state import Controller

log = logging.getLogger("phasyn_controller.studio")

LEGACY_DIR = "_legacy"  # not a local id, so it can never be a project


def summary(doc: dict[str, Any]) -> dict[str, Any]:
    """Summarize shot and render counts for the project list."""
    shots = doc.get("shots") or []
    rendered = sum(
        1
        for shot in shots
        if any(take.get("state") == "succeeded" for take in shot.get("takes") or [])
    )
    return {
        "project_id": doc["project_id"],
        "title": doc["title"],
        "revision": doc["revision"],
        "created_at": doc["created_at"],
        "updated_at": doc["updated_at"],
        "shot_count": len(shots),
        "rendered_shot_count": rendered,
    }


def run_refs(doc: dict[str, Any], run_id: str) -> tuple[list[str], list[str]]:
    """專案中引用這個 run 的 take_id 與 export_id."""
    rid = run_id.lower()
    takes = [
        str(take["take_id"])
        for shot in [*(doc.get("shots") or []), *(doc.get("image_shots") or [])]
        for take in shot.get("takes") or []
        if str(take.get("run_id") or "").lower() == rid
    ]
    exports = [
        str(item["export_id"])
        for item in doc.get("exports") or []
        if str(item.get("run_id") or "").lower() == rid
    ]
    return takes, exports


def without_run(doc: dict[str, Any], run_id: str) -> dict[str, Any]:
    """移除引用這個 run 的 takes/exports（影片與圖片鏡頭）；被移除的 take 若是使用中 take，active_take_id 改為 null."""
    rid = run_id.lower()
    edited = copy.deepcopy(doc)
    for shot in [*(edited.get("shots") or []), *(edited.get("image_shots") or [])]:
        takes = shot.get("takes") or []
        removed = {
            take["take_id"]
            for take in takes
            if str(take.get("run_id") or "").lower() == rid
        }
        if not removed:
            continue
        shot["takes"] = [take for take in takes if take["take_id"] not in removed]
        if shot.get("active_take_id") in removed:
            shot["active_take_id"] = None
    edited["exports"] = [
        item
        for item in edited.get("exports") or []
        if str(item.get("run_id") or "").lower() != rid
    ]
    return edited


def _dicts(value: Any) -> Iterator[dict[str, Any]]:
    """The objects of a list in a document that may be malformed."""
    return (
        (item for item in value if isinstance(item, dict))
        if isinstance(value, list)
        else iter(())
    )


def _adopted_files(doc: Mapping[str, Any]) -> Iterator[Any]:
    for shot in _dicts(doc.get("shots")):
        for take in _dicts(shot.get("takes")):
            adoption = take.get("media_adoption")
            if isinstance(adoption, dict):
                yield take.get("asset")
                for source in _dicts(adoption.get("source_inputs")):
                    yield source.get("file")


def kept_files(doc: Mapping[str, Any]) -> Iterator[Any]:
    """The file references of a project's library and timeline (sources, proxies, title and caption images)."""
    for item in _dicts(doc.get("library")):
        yield item.get("file")
    yield from _adopted_files(doc)
    timeline = doc.get("timeline")
    if not isinstance(timeline, dict):
        return
    for source in _dicts(timeline.get("sources")):
        yield source.get("file")
        proxy = source.get("proxy")
        if isinstance(proxy, dict):
            yield proxy.get("file")
    for caption in _dicts(timeline.get("captions")):
        yield caption.get("image")
        if origin := caption.get("transcription"):
            yield origin.get("file")
    for clip in _dicts(timeline.get("clips")):
        effects = clip.get("effects")
        title = effects.get("title") if isinstance(effects, dict) else None
        if isinstance(title, dict):
            yield title.get("image")


TIMELINE_V2 = 2


def _check_adopted_media(
    project: dict[str, Any], current: dict[str, Any] | None, *, verified: bool
) -> None:
    """Keep the observed output and its parents intact as ordinary project edits are saved."""
    previous = {
        (s["shot_id"], t["take_id"]): t
        for s in (current or {}).get("shots", [])
        for t in s["takes"]
        if t.get("media_adoption")
    }
    for shot in project["shots"]:
        parents = {t["take_id"]: t for t in shot["takes"]}
        for take in shot["takes"]:
            old = previous.get((shot["shot_id"], take["take_id"]))
            info = take.get("media_adoption")
            if old is not None and any(
                take.get(k) != old.get(k)
                for k in (
                    "media_adoption",
                    "run_id",
                    "asset",
                    "output_key",
                    "frames",
                    "width",
                    "height",
                    "route",
                )
            ):
                raise ComponentError(
                    "STATE_CONFLICT", "採用的候選版本必須保留原始來源及成品"
                )
            if info is None:
                continue
            if old is None and not verified:
                raise ComponentError(
                    "STATE_CONFLICT", "請從已發布的執行結果採用候選版本"
                )
            parent = info["parent_take_id"]
            if parent is not None and (
                parent == take["take_id"]
                or parent not in parents
                or parents[parent]["state"] != "succeeded"
            ):
                raise ComponentError(
                    "STATE_CONFLICT", "此候選版本仍引用父 Take，請保留父版本"
                )


def pre_migration(doc: Mapping[str, Any]) -> bool:
    """A saved project the Controller has not taken over yet: shots, and no version 2 timeline or shot-level edits."""
    shots = doc.get("shots") or []
    timeline = doc.get("timeline")
    current = isinstance(timeline, dict) and timeline.get("version") == TIMELINE_V2
    return bool(shots) and (not current or any(has_legacy_edit(shot) for shot in shots))


class StudioStore:
    """檢查 revision 與寫入在同一把鎖內完成（單一主控程序是唯一 writer）."""

    def __init__(self, root: Path) -> None:
        """Open the Studio project directory and coordinate project edits."""
        self._docs = JsonDocStore(root, id_field="project_id", what="Studio 專案")
        # Per file version: listing re-validates only the projects whose file changed since the last list
        self._summaries = DocProjection(
            self._docs,
            lambda doc: (
                summary(doc) if contracts.is_valid("StudioProject", doc) else None
            ),
        )
        # Read-only views for GET and the run filter: a stored project is validated and normalized once per version
        self._views = DocProjection(self._docs, self._checked_view)
        self._legacy = Path(root) / LEGACY_DIR
        self._lock = threading.Lock()
        # Export slots taken by exports whose run is being created (project id -> count), guarded by ``_lock``.
        self._export_holds: dict[str, int] = {}
        self.writes = StudioWrites(Path(root) / "_receipts.sqlite")
        self.writes.ledger.reconcile()
        self.creative = CreativeLibrary(Path(root) / "_creative", self.get, self._lock)
        # One line per saved write (who, which path, what changed): a lost edit can be traced to its writer
        self.audit = StudioAudit(root)
        # Take reviews live next to the projects, in their own documents: a review write never changes a project
        self.reviews = TakeReviewStore(Path(root) / REVIEWS_DIR, self.video_take_ids)

    def documents(self) -> builtins.list[dict[str, Any]]:
        """Every readable project document, valid or not (reference scans must not miss a broken project)."""
        return self._docs.list()

    def _view(self, doc: dict[str, Any]) -> dict[str, Any]:
        """A valid stored project as clients see it: its timeline in line with its shots and takes.

        A read must never get worse than the stored document: when the normalized form cannot be built or is not
        valid, the stored document is returned as it is (and the next write reports the reason).
        """
        try:
            view = normalize_project(doc)
            contracts.validate("StudioProject", view, code="RUNTIME_ERROR")
            if "timeline" in view:
                validate_timeline(view["timeline"])
        except Exception:
            log.exception(
                "Studio 專案 %s 無法整理成一致的時間軸；回傳已保存的文件",
                doc.get("project_id"),
            )
            return doc
        return view

    def library_file_keys(self) -> set[tuple[str, str]]:
        """所有專案素材庫與時間軸引用的檔案（node_id, file_id，小寫）：刪除 run 時不刪這些檔案.

        The timeline counts as clients see it (the normalized view), so the media of a project that was saved
        before the Controller kept its timeline is protected like any other.
        """
        keys: set[tuple[str, str]] = set()
        for doc in self._docs.list():
            refs = builtins.list(kept_files(doc))
            if contracts.is_valid("StudioProject", doc):
                refs += kept_files(self._view(doc))
            keys.update(file_key(ref) for ref in referenced_files(refs))
        return keys | self.creative.retained_files()

    def portable_snapshot(self, project_id: str, revision: int) -> dict[str, Any]:
        """Freeze the project, all creative revisions and locally imported history together."""
        with self._lock:
            project = self.get(project_id)
            require_revision(
                project["revision"], revision, what="專案", suffix="請重新讀取專案"
            )
            return {
                "project": project,
                "creative": self.creative.archive_versions_locked(project_id),
                "reviews": self.reviews.get(project_id),
                **self.creative.archive_history_locked(project_id),
            }

    def portable_history(self, project_id: str) -> dict[str, Any]:
        """Return frozen runs and plans that may be viewed without contacting their original workers."""
        with self._lock:
            self._stored(project_id)
            return self.creative.archive_history_locked(project_id)

    def restore_portable(
        self,
        project_id: str,
        snapshot: dict[str, Any],
        publication: AbstractContextManager[None],
    ) -> dict[str, Any]:
        """Publish a new project last, after its verified media, revisions and frozen history are durable."""
        with self._lock:
            if self._current(project_id) is not None:
                raise ComponentError("STATE_CONFLICT", "目的地專案已存在")
            project = normalize_project(snapshot["project"])
            validate_previs(project)
            contracts.validate("StudioProject", project)
            if "timeline" in project:
                validate_timeline(project["timeline"])
            reviews = snapshot["reviews"]
            contracts.validate("StudioTakeReviews", reviews)
            self.writes.ledger.reconcile(project_id)
            self.creative.delete_locked(project_id)
            saved = saved_form(project, None, now=utc_now())
            try:
                with publication:
                    self.creative.restore_archive_locked(
                        project_id,
                        snapshot["creative"],
                        {k: snapshot[k] for k in ("runs", "drafts")},
                        {file_key(ref) for ref in referenced_files(snapshot)},
                    )
                    atomic_write_json(self.reviews.path(project_id), reviews)
                    try:
                        self._docs.put(project_id, saved)
                    except OSError:
                        # The rename may have succeeded before the directory fsync failed.
                        if self._current(project_id) != saved:
                            raise
            except BaseException:
                self.creative.delete_locked(project_id)
                self.reviews.delete(project_id)
                raise
            self.audit.record(
                project_id=project_id,
                path="portable-import",
                client="controller",
                before=None,
                after=saved,
            )
            return saved

    def list(self) -> list[dict[str, Any]]:
        """Return valid Studio project summaries in display order."""
        items = [dict(item) for item in self._summaries.all()]
        return sorted(items, key=lambda item: item["updated_at"], reverse=True)

    def _checked_view(self, doc: dict[str, Any]) -> dict[str, Any]:
        contracts.validate(
            "StudioProject",
            doc,
            code="RUNTIME_ERROR",
            what=f"已保存的 Studio 專案 {doc.get('project_id')}",
        )
        return self._view(doc)

    def shared_view(self, project_id: str) -> dict[str, Any]:
        """The same view as ``get``, shared per stored version: callers must not modify it (serialize or copy)."""
        view = self._views.one(project_id)
        if (
            view is None
        ):  # _checked_view never returns None; keep the type checker honest
            raise ComponentError("NOT_FOUND", f"找不到Studio 專案 {project_id}")
        return view

    def work_links(self, project_id: str) -> ProjectLinks:
        """The run destinations (takes, exports) recorded in the project, from its shared view."""
        return project_links(self.shared_view(project_id))

    def _stored(self, project_id: str) -> dict[str, Any]:
        doc = self._docs.get(project_id)
        contracts.validate(
            "StudioProject",
            doc,
            code="RUNTIME_ERROR",
            what=f"已保存的 Studio 專案 {project_id}",
        )
        return doc

    def get(self, project_id: str) -> dict[str, Any]:
        """The project as clients see it (normalized); nothing is written."""
        return self._view(self._stored(project_id))

    def video_take_ids(self, project_id: str) -> set[str]:
        """The take ids of the project's video shots (404 when there is no such project)."""
        doc = self._stored(project_id)
        return {
            str(take["take_id"])
            for shot in doc.get("shots") or []
            for take in shot.get("takes") or []
        }

    def legacy(self, project_id: str) -> dict[str, Any]:
        """The document kept from before the Controller took the project's timeline over (read-only)."""
        path = self._legacy / self._docs.path(project_id).name
        try:
            doc = read_json_file(path)
        except FileNotFoundError as exc:
            raise ComponentError(
                "NOT_FOUND",
                f"Studio 專案 {project_id} 沒有接管前的備份",
                details={"project_id": project_id},
            ) from exc
        except (OSError, ValueError) as exc:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"Studio 專案 {project_id} 的備份無法讀取：{exception_message(exc)}",
            ) from exc
        if not isinstance(doc, dict):
            raise ComponentError(
                "RUNTIME_ERROR", f"Studio 專案 {project_id} 的備份內容不是 JSON object"
            )
        return doc

    def _current(self, project_id: str) -> dict[str, Any] | None:
        try:
            return self._docs.get(project_id)
        except ComponentError as exc:
            if exc.code == "NOT_FOUND":
                return None
            raise

    def project_revision(self, project_id: str) -> int | None:
        """Report the current optimistic revision without normalizing the entire timeline."""
        with self._lock:
            current = self._current(project_id)
            return int(current["revision"]) if current else None

    def put(
        self,
        project_id: str,
        body: Any,
        client: str = "unknown",
        *,
        adopt_media: bool = False,
    ) -> dict[str, Any]:
        """Save the project after validating the expected revision."""
        if not isinstance(body, dict):
            raise ComponentError("INVALID_ARGUMENT", "Studio 專案必須是 JSON object")
        contracts.validate("StudioProject", body, what="Studio 專案")
        validate_previs(body)
        if "timeline" in body:
            validate_timeline(body["timeline"])
        if body["project_id"] != project_id:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"路徑 project_id {project_id} 與本文 project_id {body['project_id']} 不同",
                details={
                    "path_project_id": project_id,
                    "body_project_id": body["project_id"],
                },
            )
        with self._lock:
            current = self._current(project_id)
            require_revision(
                stored_revision(current),
                body["revision"],
                what="專案",
                suffix="請重新載入，或明確以本機版本覆寫",
            )
            if current is not None and "timeline" in current and "timeline" not in body:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "這個專案的時間軸由主控保存；保存專案時必須帶著 timeline，請重新載入專案後再保存",
                    details={"field": "timeline"},
                )
            _check_adopted_media(body, current, verified=adopt_media)
            if current is None:
                self.writes.ledger.reconcile(project_id)
                self.creative.delete_locked(project_id)
                self.reviews.delete(project_id)
            return self._save_locked(
                project_id, body, current, path="put", client=client
            )

    def register_render(
        self,
        project_id: str,
        intent: dict[str, Any],
        run: dict[str, Any],
        output_types: dict[str, str],
    ) -> None:
        """Commit every branch of a validated run before any Node can receive it."""
        with self._lock:
            current = self._stored(project_id)
            require_revision(
                current["revision"],
                intent["expected_revision"],
                what="專案",
                suffix="請重新載入鏡頭後再生成",
            )
            body = copy.deepcopy(current)
            attach_render_takes(body, intent, run, output_types)
            self._save_locked(
                project_id, body, current, path="render-submit", client="controller"
            )

    def interrupt_render(
        self, project_id: str, run_id: str, error: ComponentError
    ) -> None:
        """Close any prepared Take for a run that never reached durable dispatch."""
        with self._lock:
            current = self._current(project_id)
            if current is None:
                return
            body = copy.deepcopy(current)
            if fail_pending_takes(body, run_id, error):
                self._save_locked(
                    project_id,
                    body,
                    current,
                    path="render-interrupt",
                    client="controller",
                )

    def _keep_legacy_locked(
        self, project_id: str, body: dict[str, Any], current: dict[str, Any] | None
    ) -> None:
        """Before the first save that takes a project over, keep the document as it was (once, never overwritten)."""
        if current is not None and pre_migration(current):
            untouched = current
        elif any(has_legacy_edit(shot) for shot in body.get("shots") or []):
            untouched = body
        else:
            return
        path = self._legacy / self._docs.path(project_id).name
        if path.exists():
            return
        try:
            atomic_write_json(path, untouched)
        except OSError as exc:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"無法保存 Studio 專案 {project_id} 接管前的備份，這次保存沒有進行：{exception_message(exc)}",
            ) from exc

    def _save_locked(
        self,
        project_id: str,
        body: dict[str, Any],
        current: dict[str, Any] | None,
        *,
        path: str,
        client: str,
    ) -> dict[str, Any]:
        """一般保存路徑（呼叫端持有鎖）：整理時間軸、驗證、revision+1、updated_at 更新、created_at 保留."""
        doc = normalize_project(body)
        contracts.validate("StudioProject", doc, what="Studio 專案")
        if "timeline" in doc:
            validate_timeline(doc["timeline"])
        self._keep_legacy_locked(project_id, body, current)
        saved = saved_form(doc, current, now=utc_now())
        self._docs.put(project_id, saved)
        self.audit.record(
            project_id=project_id, path=path, client=client, before=current, after=saved
        )
        return saved

    def apply_commands(
        self,
        project_id: str,
        body: Any,
        allocate: AllocateId,
        client: str = "unknown",
        candidate_assets: dict[tuple[str, ...], dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Apply timeline commands in order, all or nothing (``StudioTimelineCommandsResult``).

        ``dry_run`` returns the would-be document at its current revision; a result equal to the saved document is
        not saved again.
        """
        named = request_error(body)
        if named is not None:
            raise named
        contracts.validate("StudioTimelineCommandsRequest", body, what="時間軸指令")
        with self._lock:
            current = self._stored(project_id)
            require_revision(
                stored_revision(current),
                body["revision"],
                what="專案",
                suffix="請重新讀取專案後再送出指令",
            )
            project, applied = apply_commands(
                current, body["commands"], allocate, candidate_assets
            )
            contracts.validate(
                "StudioProject", project, what="套用時間軸指令後的 Studio 專案"
            )
            if not body.get("dry_run", False) and project != current:
                self._keep_legacy_locked(project_id, current, current)
                project = saved_form(project, current, now=utc_now())
                self._docs.put(project_id, project)
                self.audit.record(
                    project_id=project_id,
                    path="commands",
                    client=client,
                    before=current,
                    after=project,
                )
        return {"project": project, "applied": applied}

    def attach_take(
        self,
        destination: TakeTarget,
        take: dict[str, Any],
        *,
        requested_frames: int,
        client: str,
    ) -> dict[str, Any]:
        """Check ownership, compare-and-swap, then save the Take and timeline together."""
        project_id, shot_id = destination.project_id, destination.shot_id
        with self._lock:
            current = self._stored(project_id)
            edited = copy.deepcopy(current)
            shot = target(edited, shot_id)
            existing = receipt(
                current, shot_id, take["run_id"], take["output_key"], take["asset"]
            )
            if existing:
                return existing
            require_revision(
                current["revision"],
                destination.expected_revision,
                what="專案",
                suffix="請重新讀取專案",
            )
            if not compatible(current, shot, take, requested_frames):
                raise conflict(
                    "shot_prompt_reference_or_generation_settings_do_not_match"
                )
            for doc in self.documents():
                for other in doc.get("shots") or []:
                    if (
                        doc.get("project_id") == project_id
                        and other.get("shot_id") == shot_id
                    ):
                        continue
                    if any(
                        t.get("run_id") == take["run_id"]
                        and t.get("output_key") == take["output_key"]
                        for t in other.get("takes") or []
                    ):
                        raise conflict("output_already_bound_elsewhere")
                    if compatible(doc, other, take, requested_frames):
                        raise conflict("ambiguous_unscoped_generation")
            append_candidate(shot, take)
            saved = self._save_locked(
                project_id, edited, current, path="attach-run-output", client=client
            )
            return {
                "project_id": project_id,
                "shot_id": shot_id,
                "revision": saved["revision"],
                "created": True,
                "take": take,
            }

    def generation_takes(self, run_id: str) -> bool:
        """Retain the Take generator and its verified refinement parent until the Take is removed."""
        archived = self.creative.archived_run_projects(run_id)
        for project in self.documents():
            if project.get("project_id") in archived:
                continue
            if any(
                (item.get("source") or {}).get("run_id") == run_id
                for item in _dicts(project.get("library"))
            ):
                return True
            if any(
                run_id
                in (take.get("generation_run_id"), take.get("parent_generation_run_id"))
                or (take.get("media_adoption") and take.get("run_id") == run_id)
                for shot in _dicts(project.get("shots"))
                for take in _dicts(shot.get("takes"))
            ):
                return True
            timeline = project.get("timeline")
            if isinstance(timeline, dict) and any(
                isinstance(origin := source.get("candidate_origin"), dict)
                and origin.get("run_id") == run_id
                for source in _dicts(timeline.get("sources"))
            ):
                return True
            if isinstance(timeline, dict) and any(
                (caption.get("transcription") or {}).get("run_id") == run_id
                for caption in _dicts(timeline.get("captions"))
            ):
                return True
        return False

    def reserve_export(self, project_id: str, limit: int) -> bool:
        """Take one export slot under the store lock; False when saved and reserved exports reach ``limit``."""
        with self._lock:
            saved = len(self._stored(project_id).get("exports") or [])
            held = self._export_holds.get(project_id, 0)
            if saved + held >= limit:
                return False
            self._export_holds[project_id] = held + 1
            return True

    def release_export(self, project_id: str) -> None:
        """Return a slot from ``reserve_export`` whose export record will not be written."""
        with self._lock:
            self._release_export_locked(project_id)

    def _release_export_locked(self, project_id: str) -> None:
        held = self._export_holds.get(project_id, 0) - 1
        if held > 0:
            self._export_holds[project_id] = held
        else:
            self._export_holds.pop(project_id, None)

    def add_export(
        self,
        project_id: str,
        record: dict[str, Any],
        client: str = "unknown",
        *,
        reserved: bool = False,
    ) -> dict[str, Any]:
        """Append an export record on the server (revision + 1, like any save); the saved project.

        ``reserved``: the record fills a slot from ``reserve_export``, which is consumed whether or not it is saved.
        """
        with self._lock:
            try:
                current = self._stored(project_id)
                edited = {
                    **self._view(current),
                    "exports": [*(current.get("exports") or []), record],
                }
                return self._save_locked(
                    project_id, edited, current, path="export", client=client
                )
            finally:
                if reserved:
                    self._release_export_locked(project_id)

    def projects_waiting_on(self) -> dict[str, set[str]]:
        """Project id -> run ids that still have ``rendering`` takes or exports there (read only, without the lock)."""
        waiting: dict[str, set[str]] = {}
        for doc in self._docs.list():
            if not contracts.is_valid("StudioProject", doc):
                continue
            ids = pending_run_ids(doc)
            if ids:
                waiting[str(doc["project_id"])] = ids
        return waiting

    def backfill(
        self,
        project_id: str,
        runs: builtins.list[dict[str, Any]],
        client: str = "controller",
    ) -> bool:
        """Read finished runs back into one project's ``rendering`` takes and exports; True when saved.

        The project is read again under the lock, so only what is still ``rendering`` changes and an edit saved
        meanwhile stays; nothing is written when nothing changes. A project that no longer exists is skipped.
        """
        with self._lock:
            current = self._current(project_id)
            if current is None or not contracts.is_valid("StudioProject", current):
                return False
            edited = copy.deepcopy(self._view(current))
            if apply_runs(edited, runs) == 0:
                return False
            self._save_locked(
                project_id, edited, current, path=AUDIT_PATH, client=client
            )
            return True

    def run_references(self, run_id: str) -> builtins.list[dict[str, Any]]:
        """Takes 或 exports 引用這個 run 的專案（只讀；revision 為 null=尚未修改）."""
        out: builtins.list[dict[str, Any]] = []
        archived = self.creative.archived_run_projects(run_id)
        for doc in self._docs.list():
            if doc.get("project_id") in archived or not contracts.is_valid(
                "StudioProject", doc
            ):
                continue
            takes, exports = run_refs(doc, run_id)
            if takes or exports:
                out.append(
                    {
                        "project_id": doc["project_id"],
                        "title": doc["title"],
                        "takes_removed": takes,
                        "exports_removed": exports,
                        "revision": None,
                    }
                )
        return out

    def remove_run_refs(self, project_id: str, run_id: str) -> dict[str, Any] | None:
        """伺服器端移除引用這個 run 的 takes/exports，走一般保存路徑（revision+1）.

        開著的編輯器下次保存會收到 409 REVISION_CONFLICT 並重新載入。沒有引用或專案已不存在 → None。
        """
        with self._lock:
            if project_id in self.creative.archived_run_projects(run_id):
                return None
            current = self._current(project_id)
            if current is None or not contracts.is_valid("StudioProject", current):
                return None
            takes, exports = run_refs(current, run_id)
            if not takes and not exports:
                return None
            # Normalize first: a source bound to a removed take keeps its media, and the purge kept that file.
            edited = without_run(self._view(current), run_id)
            contracts.validate(
                "StudioProject",
                edited,
                code="RUNTIME_ERROR",
                what=f"移除 run {run_id} 參照後的 Studio 專案 {project_id}",
            )
            saved = self._save_locked(
                project_id, edited, current, path="purge", client="controller"
            )
        return {
            "project_id": project_id,
            "title": saved["title"],
            "takes_removed": takes,
            "exports_removed": exports,
            "revision": saved["revision"],
        }

    def drop_take_latent(
        self, project_id: str, shot_id: str, take_id: str, key: tuple[str, str]
    ) -> bool:
        """The storage cleanup removes a decoded take's ``video_latent`` (revision + 1, the normal save path).

        Only when the take still holds exactly that latent and is still a succeeded, decoded take; False (nothing
        saved) otherwise or when the project is gone. Open editors get 409 on their next save and reload.
        """
        with self._lock:
            current = self._current(project_id)
            if current is None or not contracts.is_valid("StudioProject", current):
                return False
            edited = copy.deepcopy(self._view(current))
            for shot in _dicts(edited.get("shots")):
                if shot.get("shot_id") != shot_id:
                    continue
                for take in _dicts(shot.get("takes")):
                    latent = take.get("video_latent")
                    if (
                        take.get("take_id") == take_id
                        and isinstance(latent, dict)
                        and file_key(latent) == key
                        and take.get("state") == "succeeded"
                        and take.get("asset") is not None
                        and not take.get("media_adoption")
                    ):
                        take["video_latent"] = None
                        self._save_locked(
                            project_id,
                            edited,
                            current,
                            path="storage-clean",
                            client="controller",
                        )
                        return True
            return False

    def delete(self, project_id: str, revision: int, client: str = "unknown") -> None:
        """Remove the project after checking its expected revision."""
        with self._lock:
            current = self._docs.get(project_id)
            require_revision(
                stored_revision(current),
                revision,
                what="專案",
                suffix="請重新載入後再刪除",
            )
            self.writes.ledger.remove_document(project_id, self._docs.path(project_id))
            (self._legacy / self._docs.path(project_id).name).unlink(missing_ok=True)
            self.reviews.delete(project_id)
            self.creative.delete_locked(project_id)
            self.audit.record(
                project_id=project_id,
                path="delete",
                client=client,
                before=current,
                after=None,
            )


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for studio."""
    router = APIRouter()

    @router.get("/api/studio/projects")
    async def list_projects() -> JSONResponse:
        return json_response({"items": await asyncio.to_thread(ctl.studio.list)})

    @router.get("/api/studio/projects/{project_id}")
    async def get_project(project_id: str) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        return json_response(await asyncio.to_thread(ctl.studio.shared_view, pid))

    @router.put("/api/studio/projects/{project_id}")
    async def put_project(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request)
        return await ctl.studio.writes.perform(
            request,
            pid,
            body,
            lambda: asyncio.to_thread(
                ctl.studio.put, pid, body, client_tag(request.headers)
            ),
        )

    @router.delete("/api/studio/projects/{project_id}")
    async def delete_project(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        raw = request.query_params.get("revision")
        if raw is None or not raw.isdigit():
            raise ComponentError(
                "INVALID_ARGUMENT", "刪除專案需要 revision（目前看到的版本）"
            )
        async with ctl.drafts.lock, ctl.studio.writes.lock(pid):
            if await asyncio.to_thread(ctl.drafts.store.project_in_use, pid):
                raise ComponentError("STATE_CONFLICT", "請先釋放這個專案的草稿計畫")
            await asyncio.to_thread(
                ctl.studio.delete, pid, int(raw), client_tag(request.headers)
            )
        return json_response({"project_id": pid, "deleted": True})

    return router


__all__ = [
    "LEGACY_DIR",
    "StudioStore",
    "kept_files",
    "pre_migration",
    "routes",
    "run_refs",
    "summary",
    "without_run",
]
