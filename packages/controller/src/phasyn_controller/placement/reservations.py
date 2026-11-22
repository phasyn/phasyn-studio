"""Admission allowances share a physical pool. A guarded run retains its allowance until it leaves RunManager.active."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from ..state import Controller
type Doc = dict[str, Any]


def physical_pools(nodes: Doc) -> Doc:
    """Identify the physical memory pools consumed by a placement."""
    pools: Doc = {}
    for node in nodes.values():
        for key, local in node["pools"].items():
            physical = (
                node["host_pool_id"]
                if key == "host"
                else node["devices"][key]["pool_id"]
            )
            if not physical:
                continue
            if local["capacity_bytes"] is None or local["available_bytes"] is None:
                continue
            entry = pools.setdefault(physical, dict(local, required_bytes=0))
            entry["required_bytes"] += local["required_bytes"]
            # Co-located Nodes may have different cgroup views. Retain the tighter bound.
            entry["capacity_bytes"] = min(
                entry["capacity_bytes"], local["capacity_bytes"]
            )
            entry["available_bytes"] = min(
                entry["available_bytes"], local["available_bytes"]
            )
    return pools


def current(ctl: Controller) -> dict[str, int]:
    """Collect resources already reserved by active runs."""
    amounts: dict[str, int] = {}
    for active in ctl.runner.active:
        guard = active.run["request"].get("placement") or {}
        for pool, amount in guard.get("claims", {}).items():
            amounts[pool] = amounts.get(pool, 0) + amount
    return amounts


def apply(option: Doc, active: dict[str, int]) -> dict[str, int]:
    """Account for active reservations in the available memory estimate."""
    claims = {}
    for pool, bounds in option["physical_pools"].items():
        amount = bounds["required_bytes"]
        claimed = active.get(pool, 0)
        bounds["already_reserved_bytes"] = claimed
        claims[pool] = amount
        if amount > bounds["capacity_bytes"]:
            option["state"] = "rejected"
            option["reasons"].append("combined_pool_exceeds_capacity:" + pool)
        elif (
            amount + claimed > bounds["available_bytes"]
            and option["state"] != "rejected"
        ):
            option["state"] = "waiting"
            option["reasons"].append("combined_pool_or_reservation_busy:" + pool)
    return claims
