"""The storage cleanup service: usage report, dry-run plans, the guarded deletion and the pins.

A real cleanup runs one at a time (another one → 409). While it runs, the run purge's busy set carries a marker,
so Studio adoptions of source media refuse (as during a run purge) instead of pinning a file the cleanup is about to
delete. Each phase recomputes its plan just before it deletes anything, and only the items the caller listed that
are still eligible at that moment are touched:

1. latents: the take's ``video_latent`` is removed from the project first (the normal save path, revision + 1), and
   the files are deleted after that, so a project never names a deleted latent;
2. runs: each run goes through :meth:`RunPurge.purge` (the same refusals, locks and commit points as
   ``DELETE /api/runs/{id}``), newest first, with the files something else still names kept;
3. files, remote copies and recordings, from a plan computed after the runs are gone; the active runs' files are
   checked once more right before each request, and a node keeps whatever its running calls use.

Every request is sent once and never retried; an item that fails is reported and the rest go on. Each real cleanup
appends one line to ``config/storage/audit.jsonl``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from phasyn_components import contracts, storage
from phasyn_components.canonical import read_json
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.fs import atomic_write_json
from phasyn_components.timeutil import utc_now
from phasyn_server.http import parse_json_bytes

from ..media_file_holds import pending_media_files
from ..nodeclient import CONNECT_TIMEOUT_S, error_from_response, transport_error
from . import graph as graph_mod
from .plan import (
    CATEGORIES,
    DEFAULT_MIN_AGE_HOURS,
    DEFAULT_RECORDINGS_DAYS,
    MAX_LISTED,
    Context,
    NodeView,
    Options,
    Planned,
    Scope,
    collectable_runs,
    plan,
    totals,
)
from .usage import usage


if TYPE_CHECKING:
    from ..state import Controller

log = logging.getLogger("phasyn_controller.storage")

STORE_DIR = "storage"
BUSY_MARKER = "storage-clean"
INVENTORY_TIMEOUT = httpx.Timeout(
    connect=CONNECT_TIMEOUT_S, read=180.0, write=30.0, pool=5.0
)
CLEAN_TIMEOUT = httpx.Timeout(
    connect=CONNECT_TIMEOUT_S, read=300.0, write=60.0, pool=5.0
)
NODE_BATCH = 500
MAX_PINS = 20000
AUDIT_ITEMS = 5000
PREFIX = {
    "run": "runs",
    "file": "files",
    "remote": "remote_cache",
    "latent": "latents",
    "recording": "recordings",
}


def category_of(item_id: str) -> str | None:
    """The category an item id belongs to (by its prefix)."""
    return PREFIX.get(item_id.split(":", 1)[0])


def pin_identity(pin: Mapping[str, Any]) -> tuple[str, ...]:
    """("run", run_id) or ("file", node_id, file_id), lowercased."""
    if pin.get("kind") == "run":
        return ("run", str(pin["run_id"]).lower())
    return ("file", str(pin["node_id"]).lower(), str(pin["file_id"]).lower())


class PinStore:
    """``config/storage/pins.json``: the runs and files the cleanup never collects (StoragePins)."""

    def __init__(self, root: Path) -> None:
        """Use ``root`` (``config/storage``) for the pins document."""
        self.path = root / "pins.json"
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, Any]]:
        """Every pin, oldest first."""
        try:
            doc = read_json(self.path)
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as exc:
            raise ComponentError(
                "RUNTIME_ERROR", f"固定清單無法讀取：{exception_message(exc)}"
            ) from exc
        contracts.validate("StoragePins", doc, code="RUNTIME_ERROR", what="固定清單")
        return list(doc["items"])

    def update(self, body: Any) -> dict[str, Any]:
        """Add (or re-note) and remove pins; idempotent."""
        contracts.validate("StoragePinsRequest", body, what="固定請求")
        with self._lock:
            pins = {pin_identity(pin): pin for pin in self.list()}
            for pin in body.get("remove") or []:
                pins.pop(pin_identity(pin), None)
            for pin in body.get("add") or []:
                identity = pin_identity(pin)
                previous = pins.get(identity)
                entry: dict[str, Any] = {"kind": pin["kind"]}
                if pin["kind"] == "run":
                    entry["run_id"] = identity[1]
                else:
                    entry["node_id"], entry["file_id"] = identity[1], identity[2]
                entry["note"] = str(
                    pin.get("note") or (previous or {}).get("note") or ""
                )
                entry["pinned_at"] = (previous or {}).get("pinned_at") or utc_now()
                pins[identity] = entry
            if len(pins) > MAX_PINS:
                raise ComponentError(
                    "INVALID_ARGUMENT", f"固定的項目不能超過 {MAX_PINS} 個"
                )
            doc = {
                "items": sorted(
                    pins.values(),
                    key=lambda p: (p.get("pinned_at") or "", pin_identity(p)),
                )
            }
            self.path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(self.path, doc)
            return doc


class KeepMap(Mapping[storage.FileKey, str]):
    """The purge's ``keep``: the plan's kept files plus every file a run whose purge failed still names."""

    def __init__(self, base: Mapping[storage.FileKey, str]) -> None:
        """Start from the plan's kept files."""
        self.base = dict(base)
        self.held: set[str] = set()

    def __getitem__(self, key: storage.FileKey) -> str:
        """The reason a file is kept."""
        if key in self.base:
            return self.base[key]
        if key[1] in self.held:
            return "仍被沒有刪除成功的 run 引用，保留檔案"
        raise KeyError(key)

    def __contains__(self, key: object) -> bool:
        """Whether the file is kept."""
        if key in self.base:
            return True
        return isinstance(key, tuple) and bool(key) and key[-1] in self.held

    def __iter__(self) -> Iterator[storage.FileKey]:
        """The plan's kept files (the held ids have no node of their own)."""
        return iter(self.base)

    def __len__(self) -> int:
        """Number of the plan's kept files."""
        return len(self.base)


@dataclass(frozen=True)
class CleanRequest:
    """A resolved StorageCleanRequest and when it started."""

    categories: list[str]
    opts: Options
    scope: Scope | None
    started: str
    dry_run: bool

    def result(
        self,
        items: list[dict[str, Any]],
        sums: dict[str, dict[str, int]],
        nodes: list[NodeView],
    ) -> dict[str, Any]:
        """The StorageCleanResult (``truncated`` false; a listing sets it)."""
        return {
            "dry_run": self.dry_run,
            "categories": self.categories,
            "options": self.opts.wire(),
            "scope": self.scope.wire() if self.scope is not None else None,
            "items": items,
            "totals": sums,
            "truncated": False,
            "nodes": [node.wire() for node in nodes],
            "started_at": self.started,
            "finished_at": utc_now(),
        }


def resolve(body: Mapping[str, Any]) -> tuple[list[str], Options, Scope | None]:
    """The categories (in execution order), options and scope of a StorageCleanRequest."""
    raw = body.get("options") or {}
    opts = Options(
        min_age_hours=float(raw.get("min_age_hours", DEFAULT_MIN_AGE_HOURS)),
        recordings_older_than_days=int(
            raw.get("recordings_older_than_days", DEFAULT_RECORDINGS_DAYS)
        ),
        include_standalone_runs=bool(raw.get("include_standalone_runs", False)),
    )
    found = body.get("scope")
    scope = (
        Scope(
            project_ids=frozenset(found.get("project_ids") or []),
            run_ids=frozenset(str(r).lower() for r in found.get("run_ids") or []),
            files=frozenset(storage.key_of(ref) for ref in found.get("files") or []),
        )
        if isinstance(found, Mapping)
        else None
    )
    if scope is None and opts.min_age_hours < 1:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "沒有指定範圍時 min_age_hours 至少要 1（保護剛上傳、還沒存進專案的檔案）",
            details={"field": "options.min_age_hours"},
        )
    wanted = set(body["categories"])
    return [c for c in CATEGORIES if c in wanted], opts, scope


class StorageService:
    """Usage, plans and the one-at-a-time cleanup of the Controller and its nodes."""

    def __init__(self, ctl: Controller) -> None:
        """Keep the pins and the audit next to the Controller's configuration."""
        self.ctl = ctl
        self.root = ctl.data_dir / "config" / STORE_DIR
        self.pins = PinStore(self.root)
        self.audit_path = self.root / "audit.jsonl"
        self.lock = asyncio.Lock()

    # ------------------------------------------------------------------ gathering
    async def _node_views(self) -> list[NodeView]:
        seen: dict[str, dict[str, Any]] = {}
        for entry in self.ctl.catalog.directory():
            seen.setdefault(str(entry["node_id"]).lower(), entry)
        return list(
            await asyncio.gather(*(self._inventory(entry) for entry in seen.values()))
        )

    async def _inventory(self, entry: Mapping[str, Any]) -> NodeView:
        node_id = str(entry["node_id"]).lower()
        label = str(entry.get("label") or node_id)
        view = NodeView(node_id=node_id, label=label, state="unreachable")
        try:
            endpoint = self.ctl.catalog.endpoint_for_call(node_id)
        except ComponentError as err:
            view.message = err.message
            return view
        try:
            resp = await self.ctl.http.get(
                f"{endpoint}/api/node/storage", timeout=INVENTORY_TIMEOUT
            )
        except httpx.HTTPError as exc:
            view.message = transport_error(
                exc,
                node_label=label,
                endpoint=endpoint,
                what="儲存清單",
                side_effect=False,
            ).message
            return view
        if resp.status_code != HTTPStatus.OK:
            refused = error_from_response(resp, what=f"Node {label} 的儲存清單")
            view.state = "unsupported" if resp.status_code in {404, 405} else "failed"
            view.message = (
                "這個 Node 的版本沒有儲存清單 API；更新 Node 後才能清理它的檔案"
                if view.state == "unsupported"
                else refused.message
            )
            return view
        try:
            doc = parse_json_bytes(resp.content, what="儲存清單")
            contracts.validate("NodeStorageInventory", doc, what="Node 的儲存清單")
        except ComponentError as err:
            view.state, view.message = "failed", err.message
            return view
        if str(doc["node_id"]).lower() != node_id:
            view.state, view.message = "failed", "Node 回報的 node_id 與目錄不符"
            return view
        view.state, view.inventory = "ok", doc
        return view

    def busy_ids(self) -> set[str]:
        """File ids the active runs name and the pending Studio adoptions hold (checked again before each request)."""
        ids: set[str] = set()
        for execution in list(self.ctl.runner.executions.values()):
            ids |= graph_mod.uuids(json.dumps(execution.run, default=str).encode())
        ids |= {fid for _, fid in pending_media_files(self.ctl)}
        return ids

    async def context(self) -> Context:
        """Scan every root and read every inventory (the inventories in parallel, the scan in a thread)."""
        nodes = await self._node_views()
        active = frozenset(str(rid).lower() for rid in self.ctl.runner.executions)
        busy = self.busy_ids()
        for node in nodes:
            if node.inventory is not None:
                busy |= {
                    storage.key_of(ref)[1]
                    for ref in node.inventory.get("busy_files") or []
                }
        pins = await asyncio.to_thread(self.pins.list)

        def scan() -> Context:
            return Context(
                controller_id=self.ctl.instance_id.lower(),
                graph=graph_mod.build(self.ctl.data_dir),
                controller_files=storage.local_files(self.ctl.files),
                controller_recordings=self.ctl.store.retention_rows(),
                recordings_root=self.ctl.recordings_root,
                recording_ids_for_run=self.ctl.store.ids_for_run,
                nodes=nodes,
                active_runs=active,
                busy_ids=frozenset(busy),
                pinned_runs=frozenset(
                    p["run_id"].lower() for p in pins if p["kind"] == "run"
                ),
                pinned_files=frozenset(
                    (p["node_id"].lower(), p["file_id"].lower())
                    for p in pins
                    if p["kind"] == "file"
                ),
                projects=self.ctl.studio.documents(),
            )

        return await asyncio.to_thread(scan)

    # ------------------------------------------------------------------ report and plan
    async def usage(self) -> dict[str, Any]:
        """StorageUsage."""
        ctx = await self.context()
        pins = await asyncio.to_thread(self.pins.list)
        return await asyncio.to_thread(usage, ctx, self.ctl, len(pins))

    async def clean(self, body: Any, *, client: str) -> dict[str, Any]:
        """StorageCleanRequest → StorageCleanResult (a plan for dry_run, otherwise the guarded deletion)."""
        contracts.validate("StorageCleanRequest", body, what="儲存清理請求")
        categories, opts, scope = resolve(body)
        started = utc_now()
        if body["dry_run"]:
            ctx = await self.context()
            found = await asyncio.to_thread(plan, ctx, categories, opts, scope)
            listed: list[dict[str, Any]] = []
            truncated = False
            for category in categories:
                rows = found.items.get(category) or []
                truncated = truncated or len(rows) > MAX_LISTED
                listed += [p.item for p in rows[:MAX_LISTED]]
            request = CleanRequest(categories, opts, scope, started, dry_run=True)
            result = request.result(listed, totals(found.items), ctx.nodes)
            result["truncated"] = truncated
            return result
        if self.lock.locked():
            raise ComponentError("STATE_CONFLICT", "另一個儲存清理正在進行，請等它結束")
        async with self.lock:
            self.ctl.purge.busy.add(BUSY_MARKER)
            try:
                results, nodes = await self._apply(
                    categories, opts, scope, list(body["items"])
                )
            finally:
                self.ctl.purge.busy.discard(BUSY_MARKER)
        done = {
            category: [
                Planned(item)
                for item in results
                if item["category"] == category and item["status"] == "deleted"
            ]
            for category in categories
        }
        request = CleanRequest(categories, opts, scope, started, dry_run=False)
        result = request.result(results, totals(done), nodes)
        await asyncio.to_thread(self._audit, result, client)
        return result

    # ------------------------------------------------------------------ apply
    async def _apply(
        self,
        categories: list[str],
        opts: Options,
        scope: Scope | None,
        requested: list[str],
    ) -> tuple[list[dict[str, Any]], list[NodeView]]:
        wanted = {
            item_id
            for item_id in dict.fromkeys(requested)
            if category_of(item_id) in categories
        }
        out: dict[str, dict[str, Any]] = {}
        nodes: list[NodeView] = []
        if "latents" in categories:
            ctx = await self.context()
            nodes = ctx.nodes
            found = await asyncio.to_thread(plan, ctx, ["latents"], opts, scope)
            for planned in found.items["latents"]:
                if planned.item["item_id"] in wanted:
                    out[planned.item["item_id"]] = await self._drop_latent(planned, ctx)
        if "runs" in categories:
            ctx = await self.context()
            nodes = ctx.nodes
            within = frozenset(
                i.split(":", 1)[1] for i in wanted if i.startswith("run:")
            )
            found = await asyncio.to_thread(
                plan, ctx, ["runs"], opts, scope, runs_within=within
            )
            keep = KeepMap(found.keep)
            order = sorted(
                found.items["runs"],
                key=lambda p: p.item["created_at"] or "",
                reverse=True,
            )
            for planned in order:
                out[planned.item["item_id"]] = await self._purge_run(planned, keep, ctx)
        rest = [c for c in categories if c in {"files", "remote_cache", "recordings"}]
        if rest:
            ctx = await self.context()
            nodes = ctx.nodes
            found = await asyncio.to_thread(plan, ctx, rest, opts, scope)
            chosen = [
                p for c in rest for p in found.items[c] if p.item["item_id"] in wanted
            ]
            for item in await self._delete_listed(chosen, ctx):
                out[item["item_id"]] = item
        results: list[dict[str, Any]] = []
        for item_id in dict.fromkeys(requested):
            if item_id in out:
                results.append(out[item_id])
                continue
            category = category_of(item_id)
            results.append(
                {
                    "item_id": item_id[:400],
                    "category": category
                    if category in categories
                    else (category or "files"),
                    "status": "skipped",
                    "label": item_id[:400],
                    "node_id": None,
                    "size_bytes": None,
                    "created_at": None,
                    "reason": "已不存在、不在這次的類別中，或重新計算時已不符合條件；沒有變更",
                }
            )
        return results, nodes

    async def _drop_latent(self, planned: Planned, ctx: Context) -> dict[str, Any]:
        assert planned.take is not None  # noqa: S101 — latents always carry their take
        project_id, shot_id, take_id, key = planned.take
        saved = await asyncio.to_thread(
            self.ctl.studio.drop_take_latent, project_id, shot_id, take_id, key
        )
        if not saved:
            return {
                **planned.item,
                "status": "skipped",
                "reason": "take 已變更或不存在；沒有變更",
            }
        statuses = await self._delete_files(planned.files, ctx)
        return self._merge(planned.item, [statuses[k] for k in planned.files])

    async def _purge_run(
        self, planned: Planned, keep: KeepMap, ctx: Context
    ) -> dict[str, Any]:
        rid = str(planned.item["run_id"])
        try:
            result = await self.ctl.purge.purge(rid, dry_run=False, keep=keep)
        except ComponentError as err:
            if err.code == "NOT_FOUND":
                return {**planned.item, "status": "missing"}
            keep.held |= {
                value
                for value, sources in ctx.graph.mentions.items()
                if f"r:{rid}" in sources
            }
            return {
                **planned.item,
                "status": "failed",
                "code": err.code,
                "message": err.message,
            }
        freed = sum(
            int(f["size_bytes"] or 0)
            for f in result["files"]
            if f["status"] == "deleted"
        )
        return {
            **planned.item,
            "status": "deleted",
            "size_bytes": max(int(planned.item["size_bytes"] or 0), freed),
        }

    async def _delete_listed(
        self, chosen: list[Planned], ctx: Context
    ) -> list[dict[str, Any]]:
        files = [p for p in chosen if p.item["category"] == "files"]
        statuses = await self._delete_files([k for p in files for k in p.files], ctx)
        out = [self._merge(p.item, [statuses[k] for k in p.files]) for p in files]
        by_node: dict[str, list[Planned]] = {}
        for p in chosen:
            if p.remote is not None:
                by_node.setdefault(p.remote[0], []).append(p)
            elif p.recording is not None and p.recording[0] != ctx.controller_id:
                by_node.setdefault(p.recording[0], []).append(p)
        controller_recordings = [
            p
            for p in chosen
            if p.recording is not None and p.recording[0] == ctx.controller_id
        ]
        active = {str(rid).lower() for rid in self.ctl.runner.executions}
        out += await asyncio.to_thread(
            self._delete_controller_recordings, controller_recordings, active
        )
        for node_id, rows in by_node.items():
            out += await self._node_items(node_id, rows)
        return out

    def _delete_controller_recordings(
        self, rows: list[Planned], active: set[str]
    ) -> list[dict[str, Any]]:
        """Delete the Controller's recording copies (blocking); ``active`` is read on the event loop."""
        out: list[dict[str, Any]] = []
        for planned in rows:
            assert planned.recording is not None  # noqa: S101
            if planned.item.get("run_id") in active:
                out.append(
                    {
                        **planned.item,
                        "status": "kept",
                        "reason": "這個紀錄的 run 正在執行",
                    }
                )
                continue
            try:
                gone = self.ctl.store.delete(planned.recording[1])
            except ComponentError as err:
                out.append(
                    {
                        **planned.item,
                        "status": "failed",
                        "code": err.code,
                        "message": err.message,
                    }
                )
                continue
            out.append({**planned.item, "status": "deleted" if gone else "missing"})
        return out

    async def _delete_files(
        self, keys: Iterable[storage.FileKey], ctx: Context
    ) -> dict[storage.FileKey, tuple[str, str | None, str | None]]:
        """Delete files where they live: (status, code, message) per file; active runs' files are kept."""
        busy = self.busy_ids()
        out: dict[storage.FileKey, tuple[str, str | None, str | None]] = {}
        remote: dict[str, list[str]] = {}
        for key in dict.fromkeys(keys):
            if key[1] in busy:
                out[key] = ("kept", None, "執行中的 run 正在使用")
            elif key[0] == ctx.controller_id:
                try:
                    gone = await asyncio.to_thread(self.ctl.files.delete, key[1])
                    out[key] = ("deleted" if gone else "missing", None, None)
                except ComponentError as err:
                    out[key] = ("failed", err.code, err.message)
            else:
                remote.setdefault(key[0], []).append(key[1])
        for node_id, ids in remote.items():
            for start in range(0, len(ids), NODE_BATCH):
                batch = ids[start : start + NODE_BATCH]
                answers = await self._node_clean(node_id, {"files": batch})
                for fid in batch:
                    out[(node_id, fid)] = answers.get(
                        ("file", fid),
                        ("failed", "NODE_UNREACHABLE", "Node 沒有回報這一項"),
                    )
        return out

    async def _node_items(
        self, node_id: str, rows: list[Planned]
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for start in range(0, len(rows), NODE_BATCH):
            batch = rows[start : start + NODE_BATCH]
            body: dict[str, Any] = {
                "remote": [
                    {"node_id": p.remote[1][0], "file_id": p.remote[1][1]}
                    for p in batch
                    if p.remote is not None
                ],
                "recordings": [
                    p.recording[1] for p in batch if p.recording is not None
                ],
            }
            busy = self.busy_ids()
            answers = await self._node_clean(node_id, body)
            for p in batch:
                if p.remote is not None:
                    status = (
                        ("kept", None, "執行中的 run 正在使用")
                        if p.remote[1][1] in busy
                        else answers.get(
                            ("remote", p.remote[1][1]),
                            ("failed", "NODE_UNREACHABLE", "Node 沒有回報這一項"),
                        )
                    )
                else:
                    assert p.recording is not None  # noqa: S101
                    status = answers.get(
                        ("recording", p.recording[1]),
                        ("failed", "NODE_UNREACHABLE", "Node 沒有回報這一項"),
                    )
                out.append(self._merge(p.item, [status]))
        return out

    async def _node_clean(
        self, node_id: str, body: dict[str, Any]
    ) -> dict[tuple[str, str], tuple[str, str | None, str | None]]:
        """POST /api/node/storage/clean once; every item of a failed request is reported failed."""
        label = self.ctl.catalog.label(node_id)
        ids = [("file", f) for f in body.get("files") or []]
        ids += [("remote", r["file_id"]) for r in body.get("remote") or []]
        ids += [("recording", r) for r in body.get("recordings") or []]

        def all_failed(
            code: str, message: str
        ) -> dict[tuple[str, str], tuple[str, str | None, str | None]]:
            return dict.fromkeys(ids, ("failed", code, message))

        try:
            endpoint = self.ctl.catalog.endpoint_for_call(node_id)
        except ComponentError as err:
            return all_failed(err.code, err.message)
        try:
            resp = await self.ctl.http.post(
                f"{endpoint}/api/node/storage/clean", json=body, timeout=CLEAN_TIMEOUT
            )
        except httpx.HTTPError as exc:
            lost = transport_error(
                exc,
                node_label=label,
                endpoint=endpoint,
                what="儲存清理",
                side_effect=True,
            )
            return all_failed(lost.code, lost.message)
        if resp.status_code != HTTPStatus.OK:
            refused = error_from_response(resp, what=f"Node {label} 的儲存清理")
            return all_failed(refused.code, refused.message)
        try:
            doc = parse_json_bytes(resp.content, what="儲存清理結果")
            contracts.validate(
                "NodeStorageCleanResult", doc, what="Node 的儲存清理結果"
            )
        except ComponentError as err:
            return all_failed("RUNTIME_ERROR", f"{err.message}；遠端結果未知")
        out: dict[tuple[str, str], tuple[str, str | None, str | None]] = {}
        for row in doc["items"]:
            message = row.get("message") or (
                "Node 的執行中呼叫正在使用或紀錄仍在寫入"
                if row["status"] == "kept"
                else None
            )
            out[(row["kind"], str(row["id"]).lower())] = (
                row["status"],
                row.get("code"),
                message,
            )
        return out

    @staticmethod
    def _merge(
        item: dict[str, Any], statuses: list[tuple[str, str | None, str | None]]
    ) -> dict[str, Any]:
        """One item over several files: failed beats kept beats deleted; all missing → missing."""
        names = [s[0] for s in statuses]
        for wanted in ("failed", "kept"):
            if wanted in names:
                _, code, message = statuses[names.index(wanted)]
                out = {**item, "status": wanted}
                if code:
                    out["code"] = code
                if message:
                    out["message" if wanted == "failed" else "reason"] = message
                return out
        return {
            **item,
            "status": "missing"
            if names and all(n == "missing" for n in names)
            else "deleted",
        }

    # ------------------------------------------------------------------ audit
    def _audit(self, result: Mapping[str, Any], client: str) -> None:
        counts: dict[str, dict[str, int]] = {}
        for item in result["items"]:
            per = counts.setdefault(item["category"], {})
            per[item["status"]] = per.get(item["status"], 0) + 1
        line = {
            "at": result["finished_at"],
            "client": client,
            "categories": result["categories"],
            "options": result["options"],
            "scope": result["scope"],
            "counts": counts,
            "deleted_bytes": sum(t["size_bytes"] for t in result["totals"].values()),
            "items": [
                {k: item[k] for k in ("item_id", "status", "code") if k in item}
                for item in result["items"][:AUDIT_ITEMS]
            ],
        }
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            with self.audit_path.open("a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n"
                )
        except OSError:
            log.exception("儲存清理的稽核紀錄無法寫入；清理本身已完成")
        log.info(
            "儲存清理完成（%s）：%s，釋放 %d bytes",
            client,
            json.dumps(counts, ensure_ascii=False),
            line["deleted_bytes"],
        )


__all__ = [
    "BUSY_MARKER",
    "KeepMap",
    "PinStore",
    "StorageService",
    "category_of",
    "collectable_runs",
    "resolve",
]
