"""Which runs a prompt study (or any Studio JSON) refers to."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

from phasyn_components.ids import is_uuid

RUN_ID_KEYS = frozenset({"run_id", "render_run_id"})


def _walk(obj: Any) -> Iterator[tuple[str | None, Any]]:
    stack: list[tuple[str | None, Any]] = [(None, obj)]
    while stack:
        key, current = stack.pop()
        yield key, current
        if isinstance(current, Mapping):
            stack.extend((str(name), value) for name, value in current.items())
        elif isinstance(current, list):
            stack.extend((key, value) for value in current)


def deep_run_ids(obj: Any) -> set[str]:
    """任意 JSON 中 run_id／render_run_id／run_ids 欄位的 UUID（小寫）。"""
    out: set[str] = set()
    for key, value in _walk(obj):
        if key in RUN_ID_KEYS and is_uuid(value):
            out.add(str(value).lower())
        elif key == "run_ids" and isinstance(value, str) and is_uuid(value):
            out.add(value.lower())
    return out


def study_run_ids(doc: Mapping[str, Any]) -> list[str]:
    """研究引用的 run：只看明確欄位（任務 run_ids、結果參照、版本 provenance、acceptance），不深度猜測 settings。"""
    ordered: list[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        if is_uuid(value) and str(value).lower() not in seen:
            seen.add(str(value).lower())
            ordered.append(str(value).lower())

    for task in doc.get("tasks") or []:
        for run_id in task.get("run_ids") or []:
            add(run_id)
        for ref in task.get("result_refs") or []:
            add(ref.get("render_run_id"))
            add(ref.get("run_id"))
    for version in doc.get("versions") or []:
        for run_id in (version.get("provenance") or {}).get("run_ids") or []:
            add(run_id)
    add((doc.get("acceptance") or {}).get("run_id"))
    return ordered


__all__ = ["deep_run_ids", "study_run_ids"]
