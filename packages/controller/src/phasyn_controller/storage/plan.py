"""What the storage cleanup may collect: the five categories over the reference graph and the inventories.

Pure planning (no deletion, no HTTP): the service gathers the graph, the Controller's and Nodes' inventories, the
active runs and the pins into a :class:`Context`, and :func:`plan` lists the eligible items of each category with
what the executor needs to delete them. The rules:

- **runs**: finished, not executing, not pinned, older than ``min_age_hours``, made for a project (or any run with
  ``include_standalone_runs``), and mentioned by nothing but other collected runs (a fixpoint: a run that only a
  collected run names goes too). Its produced files that anything else still mentions are kept.
- **files**: published files that nothing mentions (except runs collected in the same plan), not pinned, not used by
  an active run or a node's running call, older than ``min_age_hours``, and not attached (``metadata.links``) to a
  file that stays.
- **remote_cache**: a node's downloaded copy whose origin still has the same file (it can be fetched again), or whose
  origin lost the file while nothing mentions it any more; never one that an active run or call uses.
- **latents**: the ``video_latent`` of a succeeded, decoded take, when no other take, run request, plan or study
  names it (the producing run's outputs do not count); its attachments and sibling manifests sharing them go along.
- **recordings**: recordings older than ``recordings_older_than_days`` that are complete and whose run is neither
  executing nor pinned.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from phasyn_components.storage import FileKey, key_of, tree_size
from phasyn_components.timeutil import parse_rfc3339
from phasyn_components.typed import file_links, is_fileref

from ..purge import produced_files
from .graph import Graph, RunDoc, finished, read_run


CATEGORIES = ("runs", "files", "remote_cache", "latents", "recordings")
MAX_LISTED = 2000
DEFAULT_MIN_AGE_HOURS = 24.0
DEFAULT_RECORDINGS_DAYS = 30


@dataclass(frozen=True)
class Options:
    """The resolved StorageCleanOptions."""

    min_age_hours: float = DEFAULT_MIN_AGE_HOURS
    recordings_older_than_days: int = DEFAULT_RECORDINGS_DAYS
    include_standalone_runs: bool = False

    def wire(self) -> dict[str, Any]:
        """The options as the result reports them."""
        return {
            "min_age_hours": self.min_age_hours,
            "recordings_older_than_days": self.recordings_older_than_days,
            "include_standalone_runs": self.include_standalone_runs,
        }


@dataclass(frozen=True)
class Scope:
    """StorageScope: only these runs, projects' runs and files are considered."""

    project_ids: frozenset[str] = frozenset()
    run_ids: frozenset[str] = frozenset()
    files: frozenset[FileKey] = frozenset()

    def wire(self) -> dict[str, Any]:
        """The scope as the result reports it."""
        return {
            "project_ids": sorted(self.project_ids),
            "run_ids": sorted(self.run_ids),
            "files": [{"node_id": n, "file_id": f} for n, f in sorted(self.files)],
        }


@dataclass(frozen=True)
class FileInfo:
    """A published file found on disk (the Controller's store or a node's inventory)."""

    key: FileKey
    size_bytes: int
    sha256: str
    created_at: str | None
    links: tuple[FileKey, ...]


@dataclass
class NodeView:
    """One node's inventory (None when it could not be read) and its state for the report."""

    node_id: str
    label: str
    state: str  # ok | unsupported | unreachable | failed
    message: str | None = None
    inventory: dict[str, Any] | None = None

    def wire(self) -> dict[str, Any]:
        """StorageNodeState."""
        out: dict[str, Any] = {
            "node_id": self.node_id,
            "label": self.label,
            "state": self.state,
        }
        if self.message:
            out["message"] = self.message
        return out


@dataclass
class Context:
    """Everything one plan is computed from (gathered by the service, never modified by the planner)."""

    controller_id: str
    graph: Graph
    controller_files: list[dict[str, Any]]
    controller_recordings: list[tuple[str, str, str | None, bool]]
    recordings_root: Any  # Path of the Controller's recording copies
    recording_ids_for_run: Any  # Callable[[str], list[str]]
    nodes: list[NodeView]
    active_runs: frozenset[str]
    busy_ids: frozenset[str]  # file ids that active runs, adoptions or node calls use
    pinned_runs: frozenset[str]
    pinned_files: frozenset[FileKey]
    projects: list[dict[str, Any]]  # stored Studio project documents
    now: datetime = field(default_factory=lambda: datetime.now(UTC))

    def files(self) -> dict[str, FileInfo]:
        """Every published file we can see, by file id."""
        out: dict[str, FileInfo] = {}
        sources: list[tuple[str, list[dict[str, Any]]]] = [
            (self.controller_id, self.controller_files)
        ]
        sources += [
            (node.node_id, node.inventory.get("files") or [])
            for node in self.nodes
            if node.inventory is not None
        ]
        for node_id, rows in sources:
            for row in rows:
                fid = str(row["file_id"]).lower()
                out[fid] = FileInfo(
                    key=(node_id, fid),
                    size_bytes=int(row["size_bytes"]),
                    sha256=str(row["sha256"]),
                    created_at=row.get("created_at"),
                    links=tuple(key_of(link) for link in row.get("links") or []),
                )
        return out


@dataclass
class Planned:
    """One eligible item: its public StorageItem and what the executor needs."""

    item: dict[str, Any]
    files: list[FileKey] = field(
        default_factory=list
    )  # latents: files to delete; files: the file itself
    remote: tuple[str, FileKey] | None = None  # remote_cache: (holder node, origin key)
    recording: tuple[str, str] | None = None  # recordings: (holder id, recording id)
    take: tuple[str, str, str, FileKey] | None = (
        None  # latents: project, shot, take, latent key
    )


@dataclass
class Plan:
    """The items of each selected category (all of them; the result lists at most MAX_LISTED each)."""

    items: dict[str, list[Planned]]
    collected_runs: frozenset[str]
    # file id -> the reason a produced file of a collected run is kept (the purge's ``keep``)
    keep: dict[FileKey, str]


def _old_enough(stamp: str | None, cutoff: datetime) -> bool:
    if not stamp:
        return False
    try:
        return parse_rfc3339(stamp) <= cutoff
    except ValueError:
        return False


def item(category: str, item_id: str, label: str, **fields: Any) -> dict[str, Any]:
    """A planned StorageItem; ``fields`` holds node_id, size_bytes, created_at and the optional fields."""
    return {
        "item_id": item_id,
        "category": category,
        "status": "planned",
        "label": label[:2000],
        "node_id": fields.pop("node_id", None),
        "size_bytes": fields.pop("size_bytes", None),
        "created_at": fields.pop("created_at", None),
        **{k: v for k, v in fields.items() if v is not None},
    }


def run_sources(runs: Iterable[str]) -> set[str]:
    """The mention sources of these runs' documents."""
    return {f"r:{rid}" for rid in runs}


def collectable_runs(
    ctx: Context,
    opts: Options,
    scope: Scope | None,
    *,
    within: frozenset[str] | None = None,
) -> frozenset[str]:
    """Runs category: the fixpoint of finished, unpinned, idle, old runs that only other collected runs mention."""
    cutoff = ctx.now - timedelta(hours=opts.min_age_hours)
    base: set[str] = set()
    for rid, doc in ctx.graph.runs.items():
        if within is not None and rid not in within:
            continue
        if not finished(doc) or rid in ctx.active_runs or rid in ctx.pinned_runs:
            continue
        if not _old_enough(doc.created_at, cutoff):
            continue
        if scope is not None:
            if rid not in scope.run_ids and doc.project_id not in scope.project_ids:
                continue
        elif doc.project_id is None and not opts.include_standalone_runs:
            continue
        base.add(rid)
    while True:
        allowed = run_sources(base)
        dropped = {rid for rid in base if not ctx.graph.sources(rid) <= allowed}
        if not dropped:
            return frozenset(base)
        base -= dropped


def _kept_reason(ctx: Context, key: FileKey, allowed: set[str]) -> str | None:
    if key in ctx.pinned_files:
        return "已固定（pin），保留檔案"
    if key[1] in ctx.busy_ids:
        return "執行中的 run 正在使用，保留檔案"
    if not ctx.graph.sources(key[1]) <= allowed:
        return "仍被其他專案、run 或計畫引用，保留檔案"
    return None


def _run_items(
    ctx: Context, collected: frozenset[str], files: Mapping[str, FileInfo]
) -> tuple[list[Planned], dict[FileKey, str]]:
    allowed = run_sources(collected)
    keep: dict[FileKey, str] = {}
    out: list[Planned] = []
    for rid in sorted(collected, key=lambda r: ctx.graph.runs[r].created_at):
        doc: RunDoc = ctx.graph.runs[rid]
        run = read_run(doc)
        size = tree_size(doc.path.parent)
        for ref in produced_files(run or {}):
            key = (ref["node_id"], ref["file_id"])
            reason = _kept_reason(ctx, key, allowed)
            if reason is not None:
                keep[key] = reason
                continue
            known = files.get(key[1])
            size += (
                known.size_bytes if known is not None else int(ref["size_bytes"] or 0)
            )
        for recording_id in ctx.recording_ids_for_run(rid):
            directory = ctx.recordings_root / recording_id
            if directory.is_dir():
                size += tree_size(directory)
        out.append(
            Planned(
                item(
                    "runs",
                    f"run:{rid}",
                    doc.label,
                    node_id=None,
                    size_bytes=size,
                    created_at=doc.created_at or None,
                    run_id=rid,
                    project_id=doc.project_id,
                    reason="沒有專案、計畫或研究引用"
                    if doc.project_id
                    else "不屬於任何專案，也沒有計畫或研究引用",
                )
            )
        )
    return out, keep


def _produced_by(ctx: Context, runs: Iterable[str]) -> set[FileKey]:
    out: set[FileKey] = set()
    for rid in runs:
        run = read_run(ctx.graph.runs[rid])
        out.update(
            (ref["node_id"], ref["file_id"]) for ref in produced_files(run or {})
        )
    return out


def _keep_attachments(
    eligible: dict[FileKey, FileInfo],
    files: Mapping[str, FileInfo],
    handled: set[FileKey],
) -> None:
    """An attachment of a file that stays is not collected (a manifest without its blob is useless)."""
    changed = True
    while changed:
        changed = False
        for info in files.values():
            if info.key in eligible or info.key in handled:
                continue
            for link in info.links:
                if link in eligible:
                    del eligible[link]
                    changed = True


def _file_items(
    ctx: Context,
    opts: Options,
    scope: Scope | None,
    files: Mapping[str, FileInfo],
    collected: frozenset[str],
) -> list[Planned]:
    cutoff = ctx.now - timedelta(hours=opts.min_age_hours)
    allowed = run_sources(collected)
    handled = _produced_by(ctx, collected)  # the runs category deletes these
    eligible: dict[FileKey, FileInfo] = {}
    for info in files.values():
        key = info.key
        if scope is not None and key not in scope.files:
            continue
        if key in handled or not _old_enough(info.created_at, cutoff):
            continue
        if _kept_reason(ctx, key, allowed) is None:
            eligible[key] = info
    _keep_attachments(eligible, files, handled)
    out: list[Planned] = []
    for key, info in sorted(eligible.items(), key=lambda kv: kv[1].created_at or ""):
        where = "主控" if key[0] == ctx.controller_id else "Node"
        out.append(
            Planned(
                item(
                    "files",
                    f"file:{key[0]}/{key[1]}",
                    f"{where} 檔案 {key[1]}",
                    node_id=key[0],
                    size_bytes=info.size_bytes,
                    created_at=info.created_at,
                    reason="沒有任何專案、run 或計畫引用",
                ),
                files=[key],
            )
        )
    return out


def _remote_items(ctx: Context, files: Mapping[str, FileInfo]) -> list[Planned]:
    readable = {node.node_id for node in ctx.nodes if node.inventory is not None}
    readable.add(ctx.controller_id)
    out: list[Planned] = []
    for node in ctx.nodes:
        if node.inventory is None:
            continue
        held = {key_of(ref) for ref in node.inventory.get("busy_files") or []}
        for row in node.inventory.get("remote") or []:
            origin = (str(row["node_id"]).lower(), str(row["file_id"]).lower())
            if origin in held or origin[1] in ctx.busy_ids:
                continue
            source = files.get(origin[1])
            if (
                source is not None
                and source.key[0] == origin[0]
                and source.sha256 == row["sha256"]
            ):
                reason = "來源仍有同一份檔案，需要時會重新下載"
            elif (
                origin[0] in readable
                and source is None
                and not ctx.graph.sources(origin[1])
                and origin not in ctx.pinned_files
            ):
                reason = "來源已沒有這個檔案，也沒有任何引用"
            else:
                continue
            out.append(
                Planned(
                    item(
                        "remote_cache",
                        f"remote:{node.node_id}/{origin[0]}/{origin[1]}",
                        f"{node.label} 的下載副本 {origin[1]}",
                        node_id=node.node_id,
                        size_bytes=int(row["size_bytes"]),
                        created_at=row.get("created_at"),
                        reason=reason,
                    ),
                    remote=(node.node_id, origin),
                )
            )
    return out


def _take_latents(
    projects: list[dict[str, Any]],
) -> Iterable[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    for project in projects:
        for shot in project.get("shots") or []:
            if not isinstance(shot, dict):
                continue
            for take in shot.get("takes") or []:
                if isinstance(take, dict) and is_fileref(take.get("video_latent")):
                    yield project, shot, take


def _latent_items(ctx: Context, files: Mapping[str, FileInfo]) -> list[Planned]:
    uses: dict[str, int] = {}
    for _, _, take in _take_latents(ctx.projects):
        fid = key_of(take["video_latent"])[1]
        uses[fid] = uses.get(fid, 0) + 1
    out: list[Planned] = []
    for project, shot, take in _take_latents(ctx.projects):
        latent = take["video_latent"]
        key = key_of(latent)
        if (
            take.get("state") != "succeeded"
            or take.get("asset") is None
            or take.get("media_adoption")
            or uses.get(key[1]) != 1
            or key[1] not in files
        ):
            continue
        pid = str(project.get("project_id"))
        lineage = {
            str(take.get(field) or "").lower()
            for field in ("run_id", "generation_run_id", "parent_generation_run_id")
        } - {""}
        planned = _latent_files(ctx, LatentTake(pid, key, latent, lineage), files, uses)
        if planned is None:
            continue
        size = sum(files[k[1]].size_bytes for k in planned if k[1] in files)
        out.append(
            Planned(
                item(
                    "latents",
                    f"latent:{pid}/{shot['shot_id']}/{take['take_id']}",
                    f"{project.get('title') or pid}・{shot.get('title') or shot['shot_id']}・{take['take_id']}",
                    node_id=key[0],
                    size_bytes=size,
                    created_at=take.get("created_at"),
                    run_id=str(take.get("run_id") or "").lower() or None,
                    project_id=pid,
                    reason="影片已解碼完成；刪除後無法從 latent 重新解碼或細修",
                ),
                files=planned,
                take=(pid, str(shot["shot_id"]), str(take["take_id"]), key),
            )
        )
    return out


@dataclass(frozen=True)
class LatentTake:
    """The take whose latent is considered: its project, the latent and the take's own runs."""

    project_id: str
    key: FileKey
    latent: Mapping[str, Any]
    lineage: set[str]


def _latent_files(
    ctx: Context,
    take: LatentTake,
    files: Mapping[str, FileInfo],
    uses: Mapping[str, int],
) -> list[FileKey] | None:
    """The latent, its attachments and the sibling manifests sharing them, or None when something else needs one.

    Only the project and the take's own runs (its render, its generation and refinement parent, and whichever run
    produced the latent) may mention them.
    """
    key, latent = take.key, take.latent
    producers = {
        source[2:]
        for source in ctx.graph.sources(key[1])
        if source.startswith("r:") and source[2:] in ctx.graph.runs
    }
    producing = {
        rid
        for rid in producers
        if key
        in {
            (r["node_id"], r["file_id"])
            for r in produced_files(read_run(ctx.graph.runs[rid]) or {})
        }
    }
    allowed = {f"p:{take.project_id}"} | run_sources(producing | take.lineage)
    links = {key_of(link) for link in file_links(latent).values()}
    links |= set(files[key[1]].links)
    chosen = {key, *links}
    for info in files.values():
        if (
            info.key not in chosen
            and set(info.links) & links
            and uses.get(info.key[1], 0) == 0
        ):
            chosen.add(info.key)
    for member in chosen:
        if (
            member in ctx.pinned_files
            or member[1] in ctx.busy_ids
            or member[1] not in files
        ):
            return None
        if not ctx.graph.sources(member[1]) <= allowed:
            return None
    return sorted(chosen)


def _recording_items(ctx: Context, opts: Options) -> list[Planned]:
    cutoff = ctx.now - timedelta(days=opts.recordings_older_than_days)
    blocked = ctx.active_runs | ctx.pinned_runs
    out: list[Planned] = []
    rows: list[tuple[str, str, dict[str, Any]]] = [
        (
            ctx.controller_id,
            "主控紀錄副本",
            {
                "recording_id": rid,
                "created_at": created,
                "run_id": run_id,
                "open": not done,
                "size_bytes": None,
            },
        )
        for rid, created, run_id, done in ctx.controller_recordings
    ]
    for node in ctx.nodes:
        if node.inventory is not None:
            rows.extend(
                (node.node_id, f"{node.label} 本機紀錄", row)
                for row in node.inventory.get("recordings") or []
            )
    for holder, where, row in rows:
        if row["open"] or not _old_enough(row.get("created_at"), cutoff):
            continue
        run_id = str(row.get("run_id") or "").lower() or None
        if run_id is not None and run_id in blocked:
            continue
        rid = str(row["recording_id"]).lower()
        size = row["size_bytes"]
        if size is None:
            directory = ctx.recordings_root / rid
            size = tree_size(directory) if directory.is_dir() else 0
        out.append(
            Planned(
                item(
                    "recordings",
                    f"recording:{holder}/{rid}",
                    f"{where} {rid}",
                    node_id=holder,
                    size_bytes=int(size),
                    created_at=row.get("created_at"),
                    run_id=run_id,
                    reason=f"超過 {opts.recordings_older_than_days} 天的效能紀錄",
                ),
                recording=(holder, rid),
            )
        )
    return out


def plan(
    ctx: Context,
    categories: Iterable[str],
    opts: Options,
    scope: Scope | None,
    *,
    runs_within: frozenset[str] | None = None,
) -> Plan:
    """The eligible items of ``categories`` (in CATEGORIES order). ``runs_within`` limits the runs considered."""
    wanted = set(categories)
    files = ctx.files()
    collected = (
        collectable_runs(ctx, opts, scope, within=runs_within)
        if "runs" in wanted
        else frozenset()
    )
    items: dict[str, list[Planned]] = {}
    keep: dict[FileKey, str] = {}
    if "runs" in wanted:
        items["runs"], keep = _run_items(ctx, collected, files)
    if "files" in wanted:
        items["files"] = _file_items(ctx, opts, scope, files, collected)
    if "remote_cache" in wanted:
        items["remote_cache"] = [] if scope is not None else _remote_items(ctx, files)
    if "latents" in wanted:
        items["latents"] = [] if scope is not None else _latent_items(ctx, files)
    if "recordings" in wanted:
        items["recordings"] = [] if scope is not None else _recording_items(ctx, opts)
    return Plan(items=items, collected_runs=collected, keep=keep)


def totals(items: Mapping[str, list[Planned]]) -> dict[str, dict[str, int]]:
    """StorageTotals of the listed categories (zero for the others)."""
    out: dict[str, dict[str, int]] = {}
    for category in CATEGORIES:
        rows = items.get(category) or []
        out[category] = {
            "count": len(rows),
            "size_bytes": sum(int(p.item["size_bytes"] or 0) for p in rows),
        }
    return out


__all__ = [
    "CATEGORIES",
    "DEFAULT_MIN_AGE_HOURS",
    "DEFAULT_RECORDINGS_DAYS",
    "MAX_LISTED",
    "Context",
    "FileInfo",
    "NodeView",
    "Options",
    "Plan",
    "Planned",
    "Scope",
    "collectable_runs",
    "item",
    "plan",
    "totals",
]
