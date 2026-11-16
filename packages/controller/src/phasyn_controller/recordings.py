"""紀錄查詢／匯出／比較（Controller 與 Node 共用路由）與明確的「補抓 Node 歷史紀錄」。

查詢只讀主控自己的磁碟副本：離線 Node 已上報的紀錄照樣可查。``fetch-history`` 只對指定 Node
發 GET（recording 與 events 分頁），把缺的事件經 ingest_batch 去重補進來；不呼叫 invoke、start、
control 或 run，也不改任何 run 狀態。

``DELETE /api/recordings/{id}``（x-phasyn-extension）只刪主控副本（索引列與檔案）；Node 本機
紀錄不動，Node 之後再上報同一 recording 的事件時它會重新出現，也可用 fetch-history 補回。所屬 run
仍在執行時拒絕（409），避免主控自己的 recorder 寫進已刪除的目錄。

``GET /api/recordings/{id}`` 另附 ``streams``（x-phasyn-extension：已收到的 event stream、last_seq、
event_count），前端不必為了知道 stream 名稱而對 events 送出會被 400 AMBIGUOUS_STREAM 拒絕的請求。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import httpx
from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import is_local_id, require_uuid
from phasyn_components.records import compare
from phasyn_components.records.store import MAX_EVENTS, is_placeholder_summary
from phasyn_server.http import compressed_json_response, json_response, parse_json_bytes, read_json
from phasyn_server.recordings import events_page, export_response, list_page
from starlette.responses import JSONResponse, Response

from .nodeclient import READ_TIMEOUT, error_from_response, transport_error

if TYPE_CHECKING:
    from .state import Controller

FETCH_PAGE = MAX_EVENTS
FETCH_MAX_PAGES = 100_000


def _is_placeholder_summary(summary: Any) -> bool:
    """Node 端尚未有 summary 時的 placeholder 不可當成真的 summary 匯入。"""
    return not isinstance(summary, dict) or is_placeholder_summary(summary)


class _Fetch:
    """一次 fetch-history 的狀態（只讀 Node，不改 run）。"""

    def __init__(self, ctl: Controller, rid: str, node_id: str, endpoint: str) -> None:
        self.ctl = ctl
        self.rid = rid
        self.node_id = node_id
        self.endpoint = endpoint
        self.base = f"{endpoint}/api/recordings/{rid}"
        self.imported = 0
        self.problems: list[str] = []
        self.unreachable = False
        self.node_missing = False
        self.node_last_seq: dict[str, int] = {}

    async def get(self, url: str, params: dict[str, Any] | None = None) -> httpx.Response | None:
        try:
            return await self.ctl.http.get(url, params=params, timeout=READ_TIMEOUT)
        except httpx.HTTPError as exc:
            err = transport_error(
                exc,
                node_label=self.ctl.catalog.label(self.node_id),
                endpoint=self.endpoint,
                what="讀取紀錄",
                side_effect=False,
                read_timeout=READ_TIMEOUT.read,
            )
            self.unreachable = True
            self.problems.append(err.message)
            return None

    async def ingest(self, contexts: list[Any], events: list[Any], summaries: list[Any]) -> None:
        def run() -> int:
            ok_contexts = [
                c for c in contexts if contracts.is_valid("RecordingContext", c) and c.get("recording_id") == self.rid
            ]
            ok_summaries = [
                s for s in summaries if contracts.is_valid("RecordingSummary", s) and s.get("recording_id") == self.rid
            ]
            ok_events = [
                e
                for e in events
                if isinstance(e, dict) and e.get("recording_id") == self.rid and contracts.is_valid("Event", e)
            ]
            skipped = len(events) - len(ok_events)
            if skipped:
                self.problems.append(f"略過 {skipped} 筆不符合契約的事件")
            ack = self.ctl.store.ingest_batch(
                {"node_id": self.node_id, "contexts": ok_contexts, "events": ok_events, "summaries": ok_summaries}
            )
            if ack.get("rejected_events"):
                self.problems.append(f"{ack['rejected_events']} 筆事件被拒（{ack.get('message')}）")
            return int(ack.get("accepted_events") or 0)

        self.imported += await asyncio.to_thread(run)

    async def recording(self) -> None:
        resp = await self.get(self.base)
        if resp is None:
            return
        if resp.status_code != 200:
            err = error_from_response(resp, what="Node 的 recording 查詢")
            if err.code == "RECORDING_NOT_FOUND":
                self.node_missing = True
            self.problems.append(f"Node 回覆 {err.code}：{err.message}")
            return
        try:
            doc = parse_json_bytes(resp.content, what="Recording")
        except ComponentError as err:
            self.problems.append(err.message)
            return
        if not isinstance(doc, dict):
            self.problems.append("Node 的 Recording 不是 JSON object")
            return
        summary = doc.get("summary")
        context = doc.get("context")
        contexts = (
            [context]
            if isinstance(summary, dict) and summary.get("context_available") and isinstance(context, dict)
            else []
        )
        summaries = [] if _is_placeholder_summary(summary) else [summary]
        if contexts or summaries:
            await self.ingest(contexts, [], summaries)

    async def streams(self, stream_id: str | None) -> list[str]:
        if stream_id is not None:
            return [stream_id]
        resp = await self.get(f"{self.base}/events", {"after_seq": 0, "limit": 1})
        if resp is None:
            return []
        try:
            doc = parse_json_bytes(resp.content, what="EventPage")
        except ComponentError:
            doc = None
        if resp.status_code == 200 and isinstance(doc, dict):
            return [str(doc["stream_id"])] if doc.get("events") and is_local_id(doc.get("stream_id")) else []
        err = error_from_response(resp, what="Node 的 events 查詢")
        if err.code == "AMBIGUOUS_STREAM":
            found = [s.get("stream_id") for s in err.details.get("streams") or [] if isinstance(s, dict)]
            return [str(s) for s in found if is_local_id(s)]
        if err.code == "RECORDING_NOT_FOUND":
            self.node_missing = True
        self.problems.append(f"Node 回覆 {err.code}：{err.message}")
        return []

    async def stream(self, stream_id: str, after_seq: int) -> None:
        after = after_seq
        for _ in range(FETCH_MAX_PAGES):
            resp = await self.get(
                f"{self.base}/events", {"stream_id": stream_id, "after_seq": after, "limit": FETCH_PAGE}
            )
            if resp is None:
                return
            if resp.status_code != 200:
                err = error_from_response(resp, what="Node 的 events 查詢")
                self.problems.append(f"stream {stream_id}：Node 回覆 {err.code}：{err.message}")
                return
            try:
                page = parse_json_bytes(resp.content, what="EventPage")
            except ComponentError as err:
                self.problems.append(err.message)
                return
            if not isinstance(page, dict):
                self.problems.append("Node 的 EventPage 不是 JSON object")
                return
            events = [e for e in page.get("events") or [] if isinstance(e, dict)]
            if events:
                last = max(int(e.get("seq") or 0) for e in events)
                self.node_last_seq[stream_id] = max(self.node_last_seq.get(stream_id, 0), last)
                await self.ingest([], events, [])
            next_seq = page.get("next_seq")
            if not page.get("has_more") or not isinstance(next_seq, int) or next_seq <= after:
                return
            after = next_seq

    def local_state(self) -> tuple[list[str], bool, bool]:
        """(仍有缺段的 stream, 本機有 context, 本機存在)。"""
        store = self.ctl.store
        try:
            rec = store.get(self.rid)
        except ComponentError:
            return [], False, False
        gaps = []
        for item in store.streams(self.rid):
            sid = str(item["stream_id"])
            last = int(item["last_seq"] or 0)
            if int(item["event_count"]) < last or self.node_last_seq.get(sid, 0) > last:
                gaps.append(sid)
        return gaps, bool(rec["summary"].get("context_available")), True


async def active_owner(ctl: Controller, recording_id: str) -> str | None:
    """recording 屬於 runner 仍在執行的 run → 該 run_id；否則 None。"""
    known = {run_id: set(ex.run.get("recording_ids") or []) for run_id, ex in ctl.runner.executions.items()}
    if not known:
        return None

    def lookup() -> str | None:
        for run_id, ids in known.items():
            if recording_id in ids or recording_id in ctl.store.ids_for_run(run_id):
                return run_id
        return None

    return await asyncio.to_thread(lookup)


async def fetch_history(ctl: Controller, recording_id: str, body: Any) -> dict[str, Any]:
    rid = require_uuid(recording_id, "recording_id")
    contracts.validate("FetchHistoryRequest", body, what="FetchHistoryRequest")
    node_id = require_uuid(body["node_id"], "node_id")
    endpoint = ctl.catalog.endpoint_for_read(node_id)
    job = _Fetch(ctl, rid, node_id, endpoint)
    await job.recording()
    stream_ids: list[str] = []
    if not job.unreachable and not job.node_missing:
        stream_ids = await job.streams(body.get("stream_id"))
        for sid in stream_ids:
            if job.unreachable:
                break
            await job.stream(sid, int(body.get("after_seq") or 0))
    gaps, has_context, exists = await asyncio.to_thread(job.local_state)
    if not exists and job.node_missing:
        raise ComponentError("RECORDING_NOT_FOUND", f"Node 與主控都沒有 recording {rid}", details={"node_id": node_id})
    still_partial = job.unreachable or job.node_missing or bool(gaps) or not has_context or bool(job.problems)
    parts = [f"從 Node 補抓 {job.imported} 筆新事件（{len(stream_ids)} 個 stream；已有的事件以 seq 去重）"]
    if job.node_missing:
        parts.append("Node 沒有這個 recording")
    if gaps:
        parts.append(f"本機副本仍有缺段：{', '.join(gaps)}")
    if not has_context:
        parts.append("仍缺 context（只有 placeholder）")
    parts.extend(job.problems[:10])
    parts.append("只讀取紀錄，沒有呼叫任何執行或改變 run 狀態")
    return {
        "recording_id": rid,
        "imported_events": job.imported,
        "still_partial": still_partial,
        "message": "；".join(parts)[:16384],
    }


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.get("/api/recordings")
    async def list_recordings(request: Request) -> JSONResponse:
        return json_response(await list_page(ctl.store, request.query_params))

    @router.get("/api/recordings/{recording_id}")
    async def get_recording(recording_id: str, request: Request) -> Response:
        rid = require_uuid(recording_id, "recording_id")

        def load() -> dict[str, Any]:
            doc = ctl.store.get(rid)
            doc["streams"] = [
                {"stream_id": str(s["stream_id"]), "last_seq": int(s["last_seq"]), "event_count": int(s["event_count"])}
                for s in ctl.store.streams(rid)
            ]
            return doc

        # Large recordings (part totals, probes) run to tens of KB: gzip when accepted.
        return await compressed_json_response(request, await asyncio.to_thread(load))

    @router.delete("/api/recordings/{recording_id}")
    async def delete_recording(recording_id: str) -> JSONResponse:
        rid = require_uuid(recording_id, "recording_id")
        owner = await active_owner(ctl, rid)
        if owner is not None:
            raise ComponentError(
                "STATE_CONFLICT",
                f"recording {rid} 所屬的 run {owner} 仍在執行：先取消，結束後才能刪除",
                details={"recording_id": rid, "run_id": owner},
            )
        if not await asyncio.to_thread(ctl.store.delete, rid):
            raise ComponentError("RECORDING_NOT_FOUND", f"找不到 recording {rid}", details={"recording_id": rid})
        return json_response({"recording_id": rid, "deleted": True})

    @router.get("/api/recordings/{recording_id}/events")
    async def get_events(recording_id: str, request: Request) -> JSONResponse:
        rid = require_uuid(recording_id, "recording_id")
        return json_response(await events_page(ctl.store, rid, request.query_params))

    @router.get("/api/recordings/{recording_id}/export")
    async def export_recording(recording_id: str, request: Request) -> Response:
        """Streamed export; ``redact`` (repeatable: hostname, device_ids, prompts, paths, all) masks the copy."""
        rid = require_uuid(recording_id, "recording_id")
        return await export_response(ctl.store, rid, request.query_params)

    @router.get("/api/comparisons")
    async def comparisons(request: Request) -> JSONResponse:
        raw = ",".join(request.query_params.getlist("recording_ids"))
        ids = [part.strip() for part in raw.split(",") if part.strip()]
        if len(ids) < 2 or len(ids) > 8:
            raise ComponentError(
                "INVALID_ARGUMENT", "比較需要 2 到 8 個 recording_ids（逗號分隔）", details={"count": len(ids)}
            )
        return json_response(await asyncio.to_thread(compare, ctl.store, ids))

    @router.post("/api/recordings/{recording_id}/fetch-history")
    async def post_fetch_history(recording_id: str, request: Request) -> JSONResponse:
        body = await read_json(request)
        return json_response(await fetch_history(ctl, recording_id, body))

    return router


__all__ = ["active_owner", "fetch_history", "routes"]
