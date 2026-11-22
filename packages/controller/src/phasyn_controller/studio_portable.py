"""Portable Studio project export, verification, import and read-only execution history."""

from __future__ import annotations

import errno
import shutil
import tempfile
import zipfile
from contextlib import ExitStack, asynccontextmanager, contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO

from fastapi import APIRouter, Request
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_server.http import (
    declared_length,
    json_response,
    limits_of,
    payload_too_large,
)
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, StreamingResponse

from .studio_exchange import _blocks, _include
from .studio_portable_archive import (
    MAX_MEMBERS,
    MAX_ZIP,
    Doc,
    file_table,
    inspect,
    invalid,
    metadata,
    requirements,
    run_ids,
)
from .studio_portable_store import restore
from .studio_work import history_entry


if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterator

    from .state import Controller


@contextmanager
def _errors() -> Iterator[None]:
    try:
        yield
    except (
        zipfile.BadZipFile,
        EOFError,
        UnicodeError,
        ValueError,
        RecursionError,
        NotImplementedError,
    ) as exc:
        raise invalid("專案可攜包損毀或格式無效") from exc
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            raise ComponentError("DISK_FULL", "專案可攜包的暫存空間不足") from exc
        raise


def _drafts(ctl: Controller, project_id: str, existing: list[Doc]) -> list[Doc]:
    drafts = {d["plan_id"]: d for d in existing}
    after = ""
    while True:
        page = ctl.drafts.store.listing(project_id, after, 100)
        for item in page["items"]:
            drafts[item["plan_id"]] = ctl.drafts.store.get(project_id, item["plan_id"])
        if len(drafts) > MAX_MEMBERS:
            raise invalid("草稿計畫數量超出可攜包上限")
        after = page["next_cursor"]
        if not after:
            break
    return list(drafts.values())


def _snapshot(ctl: Controller, project_id: str, revision: int) -> Doc:
    doc = ctl.studio.portable_snapshot(project_id, revision)
    doc["drafts"] = _drafts(ctl, project_id, doc["drafts"])
    runs = {r["run_id"]: r for r in doc["runs"]}
    pending = run_ids(doc)
    cursor = None
    while True:
        ids, cursor = ctl.runs.page(
            cursor, 100, archived="include", work={"project_id": project_id}
        )
        pending.update(ids)
        if len(pending) > MAX_MEMBERS:
            raise invalid("歷史工作數量超出可攜包上限")
        if not cursor:
            break
    checked = set(runs)
    while pending:
        rid = pending.pop()
        if rid in checked:
            continue
        checked.add(rid)
        if len(checked) > MAX_MEMBERS:
            raise invalid("歷史工作數量超出可攜包上限")
        try:
            run = ctl.runs.read(rid)
        except ComponentError as exc:
            if exc.code != "NOT_FOUND":
                raise
        else:
            runs[rid] = run
            pending.update(run_ids(run) - checked)
    doc["runs"] = list(runs.values())
    return doc


# A copy of a file that cannot be read right now; another copy of the same content may still be included.
_UNAVAILABLE = frozenset(
    {"NOT_FOUND", "NODE_OFFLINE", "NODE_UNREACHABLE", "FILE_NOT_FOUND"}
)


async def _write(ctl: Controller, stream: BinaryIO, doc: Doc) -> None:
    raw, manifest = metadata(doc)
    table = file_table(doc)
    needed = len(raw) + sum(refs[0]["size_bytes"] for refs in table.values())
    if needed > MAX_ZIP or len(table) + 2 > MAX_MEMBERS:
        raise invalid("專案素材超出可攜包上限")
    if shutil.disk_usage(ctl.data_dir).free < needed:
        raise ComponentError("DISK_FULL", "封存專案的暫存空間不足")
    missing: list[Doc] = []
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("manifest.json", manifest)
        await run_in_threadpool(archive.writestr, "snapshot.json", raw)
        for sha, refs in table.items():
            target = f"media/{sha}"
            reason = "FILE_NOT_FOUND"
            for ref in refs:
                try:
                    if await _include(ctl, archive, target, [ref]):
                        break
                except ComponentError as exc:
                    if exc.code not in _UNAVAILABLE or target in archive.NameToInfo:
                        raise
                    reason = exc.code
            else:
                missing.append({"sha256": sha, "reason": reason})
    if missing:
        # An archive without these files would import as incomplete; refuse it instead of returning it as complete.
        raise ComponentError(
            "STATE_CONFLICT",
            "專案可攜包仍有缺件",
            details={"missing": missing},
        )


async def _download(ctl: Controller, pid: str, revision: int) -> StreamingResponse:
    async with ctl.drafts.lock:
        doc = await run_in_threadpool(_snapshot, ctl, pid, revision)
    with _errors(), ExitStack() as owner:
        stream = owner.enter_context(tempfile.TemporaryFile(dir=ctl.data_dir))
        await _write(ctl, stream, doc)
        size = stream.tell()
        stream.seek(0)
        response = StreamingResponse(
            _blocks(stream),
            media_type="application/zip",
            background=BackgroundTask(stream.close),
            headers={
                "Content-Disposition": f'attachment; filename="project-{pid}-r{revision}.zip"',
                "Content-Length": str(size),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
        owner.pop_all()
        return response


@asynccontextmanager
async def _upload(ctl: Controller, request: Request) -> AsyncIterator[BinaryIO]:
    if (
        request.headers.get("content-type", "").split(";", 1)[0].lower().strip()
        != "application/zip"
    ):
        raise ComponentError(
            "UNSUPPORTED_MEDIA_TYPE", "請以 application/zip 傳送專案可攜包"
        )
    limit = min(MAX_ZIP, limits_of(request).upload_bytes)
    expected = declared_length(request)
    if expected is not None and expected > limit:
        raise payload_too_large("專案可攜包", limit)
    with _errors(), tempfile.TemporaryFile(dir=ctl.data_dir) as stream:
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > limit:
                raise payload_too_large("專案可攜包", limit)
            await run_in_threadpool(stream.write, chunk)
        if expected is not None and expected != received:
            raise invalid("專案可攜包的長度與宣告不同")
        stream.seek(0)
        yield stream


def _availability(ctl: Controller, rows: list[Doc]) -> None:
    keys = [(item["node_id"], item["component_id"]) for item in rows]
    present = ctl.catalog.descriptors(keys)
    for item, key in zip(rows, keys, strict=True):
        descriptor = present.get(key)
        item["component_available"] = bool(
            descriptor
            and descriptor.get("state") in {"ready", "busy"}
            and ctl.catalog.state(key[0]) == "online"
        )


_TITLE_MAX = 200


def _title(request: Request) -> str | None:
    """The new project's title (?title=, for example 「原名（匯入）」); None keeps the package's own title."""
    raw = request.query_params.get("title")
    if raw is None:
        return None
    title = raw.strip()
    if not title or len(title) > _TITLE_MAX:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "匯入的專案名稱必須是 1 到 200 個字",
            details={"field": "title"},
        )
    return title


async def _import(ctl: Controller, pid: str, request: Request) -> JSONResponse:
    title = _title(request)
    async with _upload(ctl, request) as stream:
        snapshot, report = await run_in_threadpool(inspect, stream)
        if title is not None:
            snapshot["project"]["title"] = title
        _availability(ctl, report["requirements"])
        if not report["importable"]:
            raise ComponentError(
                "STATE_CONFLICT",
                "專案可攜包仍有缺件",
                details={"missing": report["missing"]},
            )
        with tempfile.TemporaryDirectory(dir=ctl.data_dir) as scratch:
            async with ctl.studio.writes.lock(pid):
                project = await run_in_threadpool(
                    restore, ctl, pid, snapshot, stream, Path(scratch)
                )
    return json_response({"project": project, "report": report})


def routes(ctl: Controller) -> APIRouter:
    """Build the raw ZIP routes without allowing a project archive to enqueue work."""
    router = APIRouter(prefix="/api/studio")

    @router.get("/projects/{project_id}/portable")
    async def download(project_id: str, revision: int) -> StreamingResponse:
        return await _download(
            ctl, require_local_id(project_id, "project_id"), revision
        )

    @router.post("/portable/inspect")
    async def check(request: Request) -> JSONResponse:
        async with _upload(ctl, request) as stream:
            _, report = await run_in_threadpool(inspect, stream)
        _availability(ctl, report["requirements"])
        return json_response(report)

    @router.post("/portable/import/{project_id}")
    async def load(project_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        return await ctl.studio.writes.protect(_import(ctl, pid, request))

    @router.get("/projects/{project_id}/portable/history")
    async def history(project_id: str) -> JSONResponse:
        data = await run_in_threadpool(
            ctl.studio.portable_history, require_local_id(project_id, "project_id")
        )
        items = requirements(data["runs"])
        _availability(ctl, items)
        runs = await run_in_threadpool(
            lambda: [history_entry(run) for run in data["runs"]]
        )
        return json_response({**data, "runs": runs, "requirements": items})

    return router
