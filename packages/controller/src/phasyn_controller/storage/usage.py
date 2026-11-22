"""StorageUsage: what is on disk, what the default rules could reclaim, and the media each project uses."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from phasyn_components.storage import tree_size
from phasyn_components.timeutil import utc_now

from .plan import CATEGORIES, Context, Options, collectable_runs, plan, totals


if TYPE_CHECKING:
    from ..state import Controller


def _total(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "count": len(rows),
        "size_bytes": sum(int(row["size_bytes"]) for row in rows),
    }


def _projects(ctx: Context) -> list[dict[str, Any]]:
    """Per project: its runs (named by it or made for it) and the files it or those runs name."""
    runs_of: dict[str, set[str]] = {pid: set() for pid in ctx.graph.projects}
    projects_of_run: dict[str, set[str]] = {}
    for rid, doc in ctx.graph.runs.items():
        owners = {s[2:] for s in ctx.graph.sources(rid) if s.startswith("p:")}
        if doc.project_id in runs_of:
            owners.add(doc.project_id)
        for pid in owners & runs_of.keys():
            runs_of[pid].add(rid)
        projects_of_run[rid] = owners
    files = ctx.files()
    size: dict[str, int] = dict.fromkeys(runs_of, 0)
    exclusive: dict[str, int] = dict.fromkeys(runs_of, 0)
    count: dict[str, int] = dict.fromkeys(runs_of, 0)
    for fid, info in files.items():
        holders: set[str] = set()
        shared = False
        for source in ctx.graph.sources(fid):
            if source.startswith("p:"):
                holders.add(source[2:])
            elif source.startswith("r:") and projects_of_run.get(source[2:]):
                holders |= projects_of_run[source[2:]]
            else:
                shared = True
        for pid in holders & runs_of.keys():
            size[pid] += info.size_bytes
            count[pid] += 1
            if len(holders) == 1 and not shared:
                exclusive[pid] += info.size_bytes
    rows = [
        {
            "project_id": pid,
            "title": ctx.graph.projects[pid][:2000],
            "runs": len(runs_of[pid]),
            "files": count[pid],
            "size_bytes": size[pid],
            "exclusive_bytes": exclusive[pid],
        }
        for pid in runs_of
    ]
    return sorted(rows, key=lambda row: row["size_bytes"], reverse=True)


def usage(ctx: Context, ctl: Controller, pins: int) -> dict[str, Any]:
    """The StorageUsage document (blocking; run in a thread)."""
    defaults = Options()
    found = plan(ctx, CATEGORIES, defaults, None)
    standalone = (
        collectable_runs(ctx, Options(include_standalone_runs=True), None)
        - found.collected_runs
    )
    nodes: list[dict[str, Any]] = []
    for node in ctx.nodes:
        inv = node.inventory
        row: dict[str, Any] = {
            **node.wire(),
            "files": _total(inv["files"]) if inv is not None else None,
            "remote_cache": _total(inv["remote"]) if inv is not None else None,
            "recordings": _total(inv["recordings"]) if inv is not None else None,
            # Work directories of the components' processes (older Nodes do not report them)
            "work": inv.get("work") if inv is not None else None,
        }
        nodes.append(row)
    return {
        "generated_at": utc_now(),
        "controller": {
            "files": _total(ctx.controller_files),
            "runs": {
                "count": len(ctx.graph.runs),
                "size_bytes": tree_size(ctl.data_dir / "runs"),
            },
            "recordings": {
                "count": len(ctx.controller_recordings),
                "size_bytes": tree_size(ctl.recordings_root),
            },
        },
        "nodes": nodes,
        "reclaimable": totals(found.items),
        "standalone_runs": {
            "count": len(standalone),
            "size_bytes": sum(
                tree_size(ctx.graph.runs[rid].path.parent) for rid in standalone
            ),
        },
        "projects": _projects(ctx),
        "pins": pins,
    }


__all__ = ["usage"]
