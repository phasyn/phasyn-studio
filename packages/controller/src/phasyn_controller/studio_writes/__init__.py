"""Shared write-once Studio command boundary for document, timeline, Take and creative writes."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from http import HTTPStatus
from typing import TYPE_CHECKING, Any
from weakref import WeakValueDictionary

from fastapi import APIRouter, Request
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_server.http import json_response
from starlette.responses import JSONResponse

from .ledger import Doc, StudioLedger, key_identity


if TYPE_CHECKING:
    from pathlib import Path

    from ..state import Controller


class _Started:
    """Whether the receipt-protected command has passed its point of no return."""

    __slots__ = ("value",)

    def __init__(self) -> None:
        self.value = False


# One marker per receipt-protected command; tasks and worker threads started by the command inherit it.
_commit_point: ContextVar[_Started | None] = ContextVar(
    "studio_write_commit_point", default=None
)


def _recorded(row: Doc) -> JSONResponse:
    state = row["state"]
    if state in {"committed", "rejected"}:
        return json_response(
            row["result"],
            status_code=row["http_status"],
            headers={"X-Phasyn-Receipt-Replay": "1", "Cache-Control": "no-store"},
        )
    if state == "retired":
        raise ComponentError("STATE_CONFLICT", "此收據所屬專案已刪除")
    raise ComponentError(
        "STATE_CONFLICT",
        "Studio 寫入已保留，尚無可驗證的結果",
        remote_outcome_unknown=True,
    )


class StudioWrites:
    """Serialize project mutations and resolve interrupted writes by receipt."""

    def __init__(self, path: Path) -> None:
        """Use a persistent ledger and a lock per active project."""
        self.ledger = StudioLedger(path)
        self.locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
        self.pending: set[asyncio.Task[JSONResponse]] = set()

    def lock(self, project: str) -> asyncio.Lock:
        """Return the shared lock for a single project."""
        lock = self.locks.get(project)
        if lock is None:
            lock = asyncio.Lock()
            self.locks[project] = lock
        return lock

    @staticmethod
    def committing() -> None:
        """Mark that the command may now change durable state.

        A failure before this point has changed nothing, so the receipt is released and the same key can be sent again.
        A command that never marks the point keeps its receipt reserved after a server failure (outcome unknown).
        """
        started = _commit_point.get()
        if started is not None:
            started.value = True

    async def perform(
        self,
        request: Request,
        project: str,
        body: Doc,
        apply: Callable[[], Awaitable[Doc]],
        *,
        status_code: int = HTTPStatus.OK,
    ) -> JSONResponse:
        """Perform an edit once or replay its verified response."""
        supplied = request.headers.getlist("Idempotency-Key")
        if not supplied:
            # Without a receipt the write must still finish before shutdown releases its resources.
            return await self.protect(self._plain(apply, status_code))
        if len(supplied) != 1:
            raise ComponentError("INVALID_ARGUMENT", "Studio 寫入只接受一個收據鍵")
        identity = key_identity(supplied[0])
        operation = request.method + " " + request.url.path
        # A disconnected browser must not release the project's ordering lock while a worker
        # thread is still changing the document or the acknowledgement is being persisted.
        return await self.protect(
            self._finish(
                (identity, project, operation),
                body=body,
                apply=apply,
                status_code=status_code,
            )
        )

    @staticmethod
    async def _plain(
        apply: Callable[[], Awaitable[Doc]], status_code: int
    ) -> JSONResponse:
        return json_response(await apply(), status_code=status_code)

    async def protect(self, work: Coroutine[Any, Any, JSONResponse]) -> JSONResponse:
        """Finish accepted writes even when the request awaiting their response disconnects."""
        task = asyncio.create_task(work)
        self.pending.add(task)
        task.add_done_callback(self._done)
        return await asyncio.shield(task)

    async def drain(self) -> None:
        """Finish every accepted write before the runner releases its resources."""
        if self.pending:
            await asyncio.gather(*list(self.pending), return_exceptions=True)

    def _done(self, task: asyncio.Task[JSONResponse]) -> None:
        self.pending.discard(task)
        if not task.cancelled():
            task.exception()

    async def _finish(
        self,
        command: tuple[str, str, str],
        *,
        body: Doc,
        apply: Callable[[], Awaitable[Doc]],
        status_code: int,
    ) -> JSONResponse:
        """Run ``command`` (receipt identity, project, operation) once under the project lock."""
        identity, project, operation = command
        signature = await asyncio.to_thread(digest, [operation, body])
        async with self.lock(project):
            if not await asyncio.to_thread(
                self.ledger.reserve, identity, project, operation, signature
            ):
                return _recorded(
                    await asyncio.to_thread(self.ledger.read, identity, project)
                )
            started = _Started()
            token = _commit_point.set(started)
            try:
                result = await apply()
            except ComponentError as exc:
                # Only deterministic refusals are terminal. A server/transport failure may follow the write.
                if (
                    HTTPStatus.BAD_REQUEST
                    <= exc.status
                    < HTTPStatus.INTERNAL_SERVER_ERROR
                    and not exc.remote_outcome_unknown
                ):
                    await asyncio.to_thread(
                        self.ledger.finish,
                        identity,
                        project,
                        status=exc.status,
                        revision=None,
                        document=exc.to_dict(),
                    )
                elif not started.value:
                    await asyncio.to_thread(self.ledger.release, identity, project)
                raise
            except Exception:
                if not started.value:
                    await asyncio.to_thread(self.ledger.release, identity, project)
                raise
            finally:
                _commit_point.reset(token)
            if "project_revision" in body:
                revision = body.get("project_revision")
            elif isinstance(result.get("project"), dict):
                revision = result["project"].get("revision")
            else:
                revision = result.get("revision")
            await asyncio.to_thread(
                self.ledger.finish,
                identity,
                project,
                status=status_code,
                revision=revision,
                document=result,
            )
            return json_response(
                result, status_code=status_code, headers={"Cache-Control": "no-store"}
            )


def routes(ctl: Controller) -> APIRouter:
    """Expose project-scoped write receipt lookup."""
    router = APIRouter()

    @router.get("/api/studio/projects/{project_id}/write-receipts/{key}")
    async def get_receipt(project_id: str, key: str) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        async with ctl.studio.writes.lock(pid):
            recorded = await asyncio.to_thread(
                ctl.studio.writes.ledger.read, key_identity(key), pid
            )
            current = await asyncio.to_thread(ctl.studio.project_revision, pid)
        return json_response(
            {**recorded, "current_project_revision": current},
            headers={"Cache-Control": "no-store"},
        )

    return router
