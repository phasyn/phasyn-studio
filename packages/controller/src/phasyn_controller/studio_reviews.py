"""Take reviews of a Studio project (x-phasyn-extension): what scorers found in each take, shown in the take strip.

Two kinds come from outside the editor: ``adherence`` (a VLM checks each prompt statement against the take's frames)
and ``residue`` (a gate looks for the characters the take should have replaced). They are stored per project in
``data_dir/config/studio/_reviews/<project_id>.json`` (``StudioTakeReviews``), not in the project document:

- A review write never touches the project, so it can never overwrite a person's edit or make the open editor's
  next save fail with 409 REVISION_CONFLICT. The reviews document has its own revision (+1 on every write).
- A write adds or replaces reviews by key: (take_id, kind, source, role). The take ids must be video takes of the
  project (422 INVALID_ARGUMENT lists the unknown ones; nothing is written), and reviews of takes the project no
  longer has are dropped on every write. Deleting the project deletes its reviews.

Routes: ``GET /api/studio/projects/{project_id}/reviews`` and ``POST`` (``StudioTakeReviewsWrite``, at most
``MAX_BODY_BYTES``).
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_components.timeutil import utc_now
from phasyn_server.http import json_response, read_json
from starlette.responses import JSONResponse

from .docstore import JsonDocStore

if TYPE_CHECKING:
    from .state import Controller

REVIEWS_DIR = "_reviews"  # not a local id, so it can never be a project
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_REVIEWS = 10_000
UNKNOWN_SHOWN = 20

Key = tuple[str, str, str, str]


def review_key(review: dict[str, Any]) -> Key:
    return (str(review["take_id"]), str(review["kind"]), str(review["source"]), str(review.get("role") or ""))


def _kind_problem(review: dict[str, Any]) -> str | None:
    """What a review carries that its kind does not have; None when it is consistent."""
    if review["kind"] == "adherence":
        if review.get("residue") is not None or review.get("ranges"):
            return "adherence 審查不帶 residue 與 ranges"
        return None
    if review.get("residue") is None:
        return "residue 審查需要 residue（confirmed、suspect 或 clean）"
    if review.get("statements") or review.get("role") is not None:
        return "residue 審查不帶 statements 與 role"
    if review["residue"] == "clean" and review.get("ranges"):
        return "residue 為 clean 的審查不帶 ranges"
    return None


def empty(project_id: str) -> dict[str, Any]:
    return {"project_id": project_id, "revision": 0, "updated_at": None, "reviews": []}


class TakeReviewStore:
    """One writer (the Controller process); the check of the take ids and the write happen under one lock."""

    def __init__(self, root: Path, take_ids: Callable[[str], set[str]]) -> None:
        self._docs = JsonDocStore(root, id_field="project_id", what="Studio take 審查")
        self._take_ids = take_ids
        self._lock = threading.Lock()

    def path(self, project_id: str) -> Path:
        return self._docs.path(project_id)

    def _current(self, project_id: str) -> dict[str, Any]:
        try:
            doc = self._docs.get(project_id)
        except ComponentError as exc:
            if exc.code == "NOT_FOUND":
                return empty(project_id)
            raise
        contracts.validate("StudioTakeReviews", doc, code="RUNTIME_ERROR", what=f"已保存的 take 審查 {project_id}")
        return doc

    def get(self, project_id: str) -> dict[str, Any]:
        self._take_ids(project_id)  # 404 for a project that does not exist
        return self._current(project_id)

    def write(self, project_id: str, body: Any) -> dict[str, Any]:
        """Add or replace reviews by key (``StudioTakeReviewsWriteResult``); all or nothing."""
        contracts.validate("StudioTakeReviewsWrite", body, what="take 審查")
        incoming: list[dict[str, Any]] = body["reviews"]
        seen: set[Key] = set()
        for index, review in enumerate(incoming):
            key = review_key(review)
            if key in seen:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"reviews[{index}] 與前面的審查重複（take {key[0]}、{key[1]}、來源 {key[2]}）；同一個鍵只送一次",
                    details={"index": index, "take_id": key[0], "kind": key[1], "source": key[2]},
                )
            seen.add(key)
            problem = _kind_problem(review)
            if problem is not None:
                raise ComponentError(
                    "INVALID_ARGUMENT", f"reviews[{index}]：{problem}", details={"index": index, "kind": review["kind"]}
                )
        with self._lock:
            takes = self._take_ids(project_id)
            unknown = sorted({str(review["take_id"]) for review in incoming} - takes)
            if unknown:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"{len(unknown)} 個 take_id 不是專案 {project_id} 的影片 take；沒有寫入任何審查",
                    details={"unknown_take_ids": unknown[:UNKNOWN_SHOWN], "unknown_count": len(unknown)},
                )
            current = self._current(project_id)
            now = utc_now()
            merged: dict[Key, dict[str, Any]] = {
                review_key(review): review for review in current["reviews"] if review["take_id"] in takes
            }
            replaced = sum(1 for review in incoming if review_key(review) in merged)
            for review in incoming:
                merged[review_key(review)] = {
                    **review,
                    "created_at": review.get("created_at") or now,
                    "received_at": now,
                }
            if len(merged) > MAX_REVIEWS:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"專案 {project_id} 的審查會超過 {MAX_REVIEWS} 筆；沒有寫入任何審查",
                    details={"limit": MAX_REVIEWS, "would_be": len(merged)},
                )
            doc = {
                "project_id": project_id,
                "revision": int(current["revision"]) + 1,
                "updated_at": now,
                "reviews": list(merged.values()),
            }
            contracts.validate("StudioTakeReviews", doc, code="RUNTIME_ERROR", what="寫入後的 take 審查")
            self._docs.put(project_id, doc)
        return {"reviews": doc, "written": len(incoming), "replaced": replaced}

    def delete(self, project_id: str) -> None:
        """Called after the project file is gone: a write in progress finishes first, a later one finds no project."""
        with self._lock:
            self._docs.path(project_id).unlink(missing_ok=True)


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio/projects/{project_id}/reviews")
    async def get_reviews(project_id: str) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        return json_response(await asyncio.to_thread(ctl.studio.reviews.get, pid))

    @router.post("/api/studio/projects/{project_id}/reviews")
    async def write_reviews(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        body = await read_json(request, limit=MAX_BODY_BYTES, what="take 審查")
        return json_response(await asyncio.to_thread(ctl.studio.reviews.write, pid, body))

    return router


__all__ = ["MAX_BODY_BYTES", "MAX_REVIEWS", "REVIEWS_DIR", "TakeReviewStore", "empty", "review_key", "routes"]
