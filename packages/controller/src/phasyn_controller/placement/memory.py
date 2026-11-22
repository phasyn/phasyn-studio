"""Compare an owner-supplied, shape-specific incremental peak against live independent or shared pools."""

from __future__ import annotations

from typing import Any


type Doc = dict[str, Any]


def evaluate_memory(
    node: Doc, need: Doc, devices: set[str]
) -> tuple[list[str], list[str], Doc]:
    """Check device and host requirements against their physical memory pools."""
    bad = []
    waiting = []
    host = node["host"]
    devs = node["devices"]
    cuda = {d for d in devices if devs.get(d, {}).get("kind") == "cuda"}
    if set(need["device_bytes"]) != cuda:
        return ["device_envelope_mismatch"], [], {}
    want = need["host_bytes"]
    pools = {}
    for did in cuda:
        d = devs[did]
        amount = need["device_bytes"][did]
        if d["pool"] == "unified":
            want += amount
        elif d["pool"] == "dedicated":
            pools[did] = {
                "required_bytes": amount,
                "capacity_bytes": d["total_bytes"],
                "available_bytes": d["available_bytes"],
            }
        else:
            bad.append("device_pool_unknown:" + did)
    capacities = [
        v for v in [host["total_bytes"], host["cgroup_limit_bytes"]] if v is not None
    ]
    availabilities = [
        v
        for v in [host["available_bytes"], host["cgroup_available_bytes"]]
        if v is not None
    ]
    if (
        host["cgroup_state"] == "unavailable"
        or host["available_bytes"] is None
        or host["total_bytes"] is None
    ):
        bad.append("host_pool_unmeasured")
    pools["host"] = {
        "required_bytes": want,
        "capacity_bytes": min(capacities, default=None),
        "available_bytes": min(availabilities, default=None),
    }
    for key, pool in pools.items():
        capacity = pool["capacity_bytes"]
        free = pool["available_bytes"]
        if capacity is None or free is None:
            bad.append("capacity_unknown:" + key)
        elif pool["required_bytes"] > capacity:
            bad.append("exceeds_capacity:" + key)
        elif pool["required_bytes"] > free:
            waiting.append("insufficient_headroom:" + key)
    return bad, waiting, pools
