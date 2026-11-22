"""Exclusive groups (``InstanceDefinition.exclusive_group``): at most one member per Node holds a model.

Some components need so much host memory that two of them must never be loaded on the same Node (the
example configs put every DiT in ``exclusive_group: "dit"``). The Node is the only place that enforces this,
when a member starts or restarts:

- ``loading``, ``stopping``, ``busy`` (or an active call, or a restart between its unload and its start)
  → 409 EXCLUSIVE_GROUP_BUSY;
- ``ready``, or ``error`` while its process still exists → an idle holder: 409 EXCLUSIVE_GROUP_CONFLICT,
  unless the request carries ``replace_exclusive: true`` — then the idle holders are stopped one by one first;
- ``stopped``, or ``error`` with the process confirmed gone, holds nothing; a restarting target never counts
  as its own holder.

The rules are pure functions of a few attributes (:class:`Member`), so they are tested as a table.

Lock order: the group's lock is the outermost one (group, then the instance's control lock). It is a
try-lock: while one start/restart of the group is in progress, another answers BUSY instead of queueing.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any, Protocol

from phasyn_components.errors import ComponentError


BUSY_STATES = frozenset({"loading", "stopping", "busy"})


class Call(Protocol):
    @property
    def call_id(self) -> str: ...


class Member(Protocol):
    """What the rules read from a component instance."""

    @property
    def component_id(self) -> str:
        """Return the configured component ID."""
        ...

    @property
    def exclusive_group(self) -> str | None:
        """Return the component's configured exclusive group."""
        ...

    @property
    def state(self) -> str:
        """Return the component lifecycle state."""
        ...

    @property
    def process(self) -> object | None:
        """Return the supervised runtime process, when present."""
        ...

    @property
    def active_call(self) -> Call | None:
        """Return the current call, when present."""
        ...

    @property
    def restart_pending(self) -> bool:
        """Return whether a settings change requires a restart."""
        ...

    @property
    def deleted(self) -> bool:
        """Return whether the component has been removed."""
        ...


def is_holder(member: Member) -> bool:
    """Holds (or is about to hold) a model: loading, loaded, a live process, or a restart in progress."""
    return (
        member.state in BUSY_STATES
        or member.state == "ready"
        or member.process is not None
        or member.restart_pending
    )


def is_busy(member: Member) -> bool:
    """A holder that cannot be stopped for a replacement right now."""
    return (
        member.state in BUSY_STATES
        or member.active_call is not None
        or member.restart_pending
    )


def holders[M: Member](members: Iterable[M], group: str, *, exclude: Member) -> list[M]:
    """Members of ``group`` other than ``exclude`` that hold (or may hold) a model, by component id."""
    found = [
        member
        for member in members
        if member is not exclude
        and member.exclusive_group == group
        and not member.deleted
        and is_holder(member)
    ]
    return sorted(found, key=lambda member: member.component_id)


def details(group: str, members: Iterable[Member]) -> dict[str, Any]:
    """Contract ``ExclusiveGroupDetails``."""
    return {
        "group": group,
        "holders": [
            {
                "component_id": member.component_id,
                "state": member.state,
                "active_call_id": member.active_call.call_id
                if member.active_call is not None
                else None,
            }
            for member in members
        ],
    }


def busy_error(
    group: str, members: Sequence[Member], *, switching: bool = False
) -> ComponentError:
    """409 EXCLUSIVE_GROUP_BUSY listing ``members``.

    ``switching``: the group lock is held by another start or replacement. That is the reason given then,
    even when the listed holders themselves are idle.
    """
    if members and not switching:
        names = "、".join(member.component_id for member in members)
        message = f"互斥群組 {group} 的 {names} 正在載入、停止或執行呼叫；同一 Node 一次只能載入一個成員，請等它結束後再試"
    else:
        message = (
            f"互斥群組 {group} 正在切換成員（另一個啟動或替換仍在進行）；請稍後再試"
        )
    return ComponentError(
        "EXCLUSIVE_GROUP_BUSY", message, details=details(group, members)
    )


def conflict_error(group: str, members: Sequence[Member]) -> ComponentError:
    """Describe which members already hold the exclusive group."""
    names = "、".join(member.component_id for member in members)
    return ComponentError(
        "EXCLUSIVE_GROUP_CONFLICT",
        f"互斥群組 {group} 已由 {names} 載入；同一 Node 一次只能載入一個成員。"
        "確認要換成這個元件時，請以 replace_exclusive=true 重新送出（Node 會先停止它們）",
        details=details(group, members),
    )


def refusal(target: Member, members: Iterable[Member]) -> ComponentError | None:
    """Why ``target`` may not load now (None when its group is free); used for the final synchronous check."""
    group = target.exclusive_group
    if group is None:
        return None
    found = holders(members, group, exclude=target)
    if not found:
        return None
    return (
        busy_error(group, found)
        if any(map(is_busy, found))
        else conflict_error(group, found)
    )


__all__ = [
    "BUSY_STATES",
    "Member",
    "busy_error",
    "conflict_error",
    "details",
    "holders",
    "is_busy",
    "is_holder",
    "refusal",
]
