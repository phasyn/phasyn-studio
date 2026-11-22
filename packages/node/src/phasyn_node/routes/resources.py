"""On-demand placement readings for installed components. No model or runtime is started by this endpoint."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import platform
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

import psutil
from fastapi import APIRouter, Request
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_components.timeutil import utc_now
from phasyn_server.http import json_response
from starlette.responses import JSONResponse

from ..sampler import NvmlDevice, host_metrics


if TYPE_CHECKING:
    from ..service import NodeService


MAX_COMPONENTS = 32
CGROUP_FIELDS = 3


def _memory_paths(
    root: Path, membership: Path
) -> tuple[Path, str | None, str, str, bool]:
    rows = [row.split(":", 2) for row in membership.read_text().splitlines()]
    unified = next(
        (row[2] for row in rows if len(row) == CGROUP_FIELDS and row[:2] == ["0", ""]),
        None,
    )
    legacy = next(
        (
            row[2]
            for row in rows
            if len(row) == CGROUP_FIELDS and "memory" in row[1].split(",")
        ),
        None,
    )
    v2 = unified is not None and (root / "cgroup.controllers").is_file()
    if v2:
        group = unified
        limit_file, current_file = "memory.max", "memory.current"
    else:
        group = legacy
        root = root / "memory"
        limit_file, current_file = "memory.limit_in_bytes", "memory.usage_in_bytes"
    return root, group, limit_file, current_file, v2


def cgroup_memory(
    root: Path = Path("/sys/fs/cgroup"), membership: Path = Path("/proc/self/cgroup")
) -> tuple[str, int | None, int | None]:
    """Take the tightest visible ancestor limit/headroom, including legacy v1 memory controllers."""
    if platform.system() != "Linux":
        return "not_applicable", None, None
    try:
        root, group, limit_file, current_file, v2 = _memory_paths(root, membership)
        if group is None or not group.startswith("/") or ".." in Path(group).parts:
            return "unavailable", None, None
        folder = root / group.lstrip("/")
        if not folder.is_dir():
            return "unavailable", None, None
        page = os.sysconf("SC_PAGE_SIZE")
        unlimited_v1 = (sys.maxsize // page) * page
        totals = []
        headroom = []
        while True:
            cap = folder / limit_file
            if cap.is_file():
                raw = cap.read_text().strip()
                if raw != "max" and (v2 or int(raw) != unlimited_v1):
                    total = int(raw)
                    used = int((folder / current_file).read_text())
                    if total < 0 or used < 0:
                        return "unavailable", None, None
                    totals.append(total)
                    headroom.append(max(0, total - used))
            if folder == root:
                break
            folder = folder.parent
        return (
            ("limited", min(totals), min(headroom))
            if totals
            else ("no_visible_limit", None, None)
        )
    except (OSError, ValueError):
        return "unavailable", None, None


def sample_memory(
    devices: dict[str, str], unified: tuple[str, ...]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Sample host and configured device memory without starting model runtimes."""
    available = host_metrics()["host_available_bytes"]["value"]
    total = None
    with contextlib.suppress(OSError, RuntimeError):
        total = int(psutil.virtual_memory().total)
    status, cap, headroom = cgroup_memory()
    host = {
        "total_bytes": total,
        "available_bytes": available,
        "cgroup_state": status,
        "cgroup_limit_bytes": cap,
        "cgroup_available_bytes": headroom,
    }
    observed = {}
    for dev, kind in devices.items():
        topology = (
            "host" if kind == "cpu" else "unified" if dev in unified else "unknown"
        )
        physical = None
        card_total = None
        card_free = None
        util = None
        if kind == "cuda":
            try:
                with contextlib.closing(NvmlDevice(dev)) as nv:
                    physical = nv.physical_id()
                    metrics = nv.device_metrics()
                capacity = metrics["nvml_device_total_bytes"]["value"]
                used = metrics["nvml_device_used_bytes"]["value"]
                util = metrics["device_utilization_pct"]["value"]
                if (
                    topology != "unified"
                    and isinstance(capacity, int)
                    and isinstance(used, int)
                    and 0 <= used <= capacity
                    and capacity > 0
                ):
                    topology = "dedicated"
                    card_total = capacity
                    card_free = capacity - used
            except Exception as exc:  # pynvml exception classes are optional on CPU-only installations.
                logging.getLogger(__name__).debug(
                    "Placement NVML sample unavailable (%s)",
                    type(exc).__name__,
                    exc_info=True,
                )
        observed[dev] = {
            "kind": kind,
            "pool": topology,
            "pool_id": "gpu-" + physical if physical else None,
            "total_bytes": card_total,
            "available_bytes": card_free,
            "utilization_pct": util,
        }
    return host, observed


def routes(service: NodeService) -> APIRouter:
    """Expose placement observations for requested local components."""
    router = APIRouter()
    try:
        identity = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        identity = ""
    host_pool = "host-" + digest(identity or service.node_id)

    @router.get("/api/resources")
    async def resources(request: Request) -> JSONResponse:
        names = request.query_params.getlist("component")
        if not 1 <= len(names) <= MAX_COMPONENTS or len(names) != len(set(names)):
            raise ComponentError("INVALID_ARGUMENT", "請指定一至三十二個不同元件")
        instances = [
            service.instance(require_local_id(name, "component_id")) for name in names
        ]
        guard = service.admission
        gated = {
            i.component_id
            for i in instances
            if guard
            and guard.gates(
                exclusive_group=i.exclusive_group, provider_id=i.provider_id
            )
        }
        holds = [h.reason for h in await guard.holds()] if guard and gated else []
        devices = {}
        components = {}
        for instance in instances:
            dev = instance.loaded_device()
            did = str(dev["id"])
            devices[did] = str(dev["kind"])
            group = str(dev["resource_group"])
            effective = ((instance.load_context or {}).get("effective") or {}).get(
                "load"
            )
            components[instance.component_id] = {
                "provider_id": instance.provider_id,
                "runtime_id": instance.runtime_id,
                "state": instance.state,
                "device_id": did,
                "resource_group": group,
                "busy": service.locks.holder(group) is not None,
                "holds": holds if instance.component_id in gated else [],
                "loaded_revision": instance.settings.loaded_revision,
                "effective_load_digest": digest(effective)
                if isinstance(effective, dict)
                else None,
            }
        host, snapshot = await asyncio.to_thread(
            sample_memory, devices, service.config.unified_memory_devices
        )
        return json_response(
            {
                "node_id": service.node_id,
                "host_pool_id": host_pool,
                "source_revision": service.source_revision,
                "sampled_at": utc_now(),
                "host": host,
                "devices": snapshot,
                "components": components,
            }
        )

    return router
