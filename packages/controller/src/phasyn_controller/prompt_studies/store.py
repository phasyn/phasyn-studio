"""The prompt-study documents: ``data_dir/config/prompt-studies/<study_id>.json``.

A save (PUT) uses the revision for optimistic concurrency (0 for a new study, +1 on success; a mismatch is 409
REVISION_CONFLICT and nothing is merged). The revision check and the write happen under one lock: the single
controller process is the only writer.
"""

from __future__ import annotations

import builtins
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.timeutil import utc_now

from ..docstore import JsonDocStore
from ..revisions import require_revision, saved_form, stored_revision
from ..runs import ARCHIVE_FILTERS
from .checks import check_semantics, check_transition, conflict, invalid
from .references import study_run_ids


STORE_DIR = "prompt-studies"


def summary(doc: Mapping[str, Any]) -> dict[str, Any]:
    """Summarize study metadata and task counts."""
    tasks = doc.get("tasks") or []
    return {
        "study_id": doc["study_id"],
        "title": doc["title"],
        "revision": doc["revision"],
        "created_at": doc["created_at"],
        "updated_at": doc["updated_at"],
        "language": doc["language"],
        "archived": doc["archived"],
        "source": doc["source"]["file"],
        "source_name": doc["source"]["name"],
        "version_count": len(doc.get("versions") or []),
        "task_count": len(tasks),
        "running_task_count": sum(
            1 for task in tasks if task.get("state") == "running"
        ),
        "accepted_version_id": doc.get("accepted_version_id"),
    }


class PromptStudyStore:
    """revision 檢查與寫入在同一把鎖內完成（單一主控程序是唯一 writer）."""

    def __init__(self, root: Path) -> None:
        """Set the document store and track deletions in progress."""
        self._docs = JsonDocStore(root, id_field="study_id", what="反推研究")
        self._lock = threading.Lock()
        self.deleting: set[str] = set()

    def all_docs(self) -> list[dict[str, Any]]:
        """Return study documents that pass the current contract."""
        return [
            doc for doc in self._docs.list() if contracts.is_valid("PromptStudy", doc)
        ]

    def list(self, archived: str = "exclude") -> list[dict[str, Any]]:
        """Filter study summaries by archive state."""
        if archived not in ARCHIVE_FILTERS:
            raise invalid(
                f"archived 必須是 {'、'.join(ARCHIVE_FILTERS)} 之一：{archived!r}",
                field="archived",
            )
        items = [
            summary(doc)
            for doc in self.all_docs()
            if archived == "include" or bool(doc["archived"]) == (archived == "only")
        ]
        return sorted(items, key=lambda item: item["updated_at"], reverse=True)

    def get(self, study_id: str) -> dict[str, Any]:
        """Read a study by its validated ID."""
        doc = self._docs.get(study_id)
        contracts.validate(
            "PromptStudy",
            doc,
            code="RUNTIME_ERROR",
            what=f"已保存的反推研究 {study_id}",
        )
        return doc

    def _current(self, study_id: str) -> dict[str, Any] | None:
        try:
            return self._docs.get(study_id)
        except ComponentError as exc:
            if exc.code == "NOT_FOUND":
                return None
            raise

    def put(self, study_id: str, body: Any) -> dict[str, Any]:
        """Validate the study and save a new revision."""
        if not isinstance(body, dict):
            raise invalid("反推研究必須是 JSON object")
        contracts.validate("PromptStudy", body, what="反推研究")
        if body["study_id"] != study_id:
            raise invalid(
                f"路徑 study_id {study_id} 與本文 study_id {body['study_id']} 不同",
                path_study_id=study_id,
                body_study_id=body["study_id"],
            )
        with self._lock:
            if study_id in self.deleting:
                raise conflict("研究正在刪除中，不能保存", study_id=study_id)
            current = self._current(study_id)
            require_revision(
                stored_revision(current),
                body["revision"],
                what="研究",
                suffix="請重新載入",
            )
            if current is not None:
                contracts.validate(
                    "PromptStudy",
                    current,
                    code="RUNTIME_ERROR",
                    what=f"已保存的反推研究 {study_id}",
                )
                check_transition(
                    current, body
                )  # 先回報與已保存內容的衝突（409），再檢查文件本身（422）
            check_semantics(body)
            doc = saved_form(body, current, now=utc_now())
            self._docs.put(study_id, doc)
            return doc

    def begin_delete(self, study_id: str) -> None:
        """Mark one deletion in progress (saves of that study are refused until ``end_delete``)."""
        with self._lock:
            if study_id in self.deleting:
                raise conflict(
                    "研究已在刪除中（同一個研究同時只有一個刪除）", study_id=study_id
                )
            self.deleting.add(study_id)

    def end_delete(self, study_id: str) -> None:
        """Release the deletion guard on the study ID."""
        with self._lock:
            self.deleting.discard(study_id)

    def remove(self, study_id: str, revision: int) -> None:
        """刪除文件檔（呼叫端已完成刪除計畫的其他步驟）；revision 必須仍然相同."""
        with self._lock:
            current = self._docs.get(study_id)
            require_revision(
                stored_revision(current),
                revision,
                what="研究",
                suffix="請重新載入後再刪除",
            )
            self._docs.delete(study_id)

    def run_references(self, run_id: str) -> builtins.list[dict[str, Any]]:
        """引用這個 run 的研究（只讀；給永久刪除 run 的預覽參考）."""
        rid = run_id.lower()
        return [
            {"study_id": doc["study_id"], "title": doc["title"]}
            for doc in self.all_docs()
            if rid in study_run_ids(doc)
        ]


__all__ = ["STORE_DIR", "PromptStudyStore", "summary"]
