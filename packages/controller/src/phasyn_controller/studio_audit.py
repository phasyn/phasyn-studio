"""Audit trail of Studio project writes: one JSON line per saved write, so a lost edit can be traced to its writer.

Every write that saves a project (PUT, timeline commands, export record, run purge, delete) appends a line to
``<studio root>/_audit/writes.jsonl``: when, which path, which client (the ``X-Phasyn-Client`` header the frontend
and API clients send: a tab id or an agent name), the revision before and after, and what changed (top-level fields,
timeline parts, every changed track field with its old and new value, and the shots added, removed or edited).
The file never holds prompts or other content: field names, ids and track flags only. A failure to write the line
is logged and never blocks the save it describes.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.timeutil import utc_now

log = logging.getLogger("phasyn_controller.studio_audit")

AUDIT_DIR = "_audit"  # not a local id, so it can never be a project
CLIENT_HEADER = "x-phasyn-client"
_CLIENT_RE = re.compile(r"[^A-Za-z0-9._:/@+-]")
_CLIENT_MAX = 80
# Fields every save changes; they say nothing about who changed what
_BOOKKEEPING = frozenset({"revision", "updated_at"})
_TRACK_KEYS = ("name", "locked", "muted", "solo", "sync_lock", "gain_db", "pan")


def client_tag(headers: Mapping[str, str]) -> str:
    """The writer as the request names it (sanitized and capped), or ``unknown``."""
    raw = headers.get(CLIENT_HEADER, "")
    tag = _CLIENT_RE.sub("", raw)[:_CLIENT_MAX]
    return tag or "unknown"


def _by_id(items: Any, key: str) -> dict[str, Mapping[str, Any]]:
    if not isinstance(items, list):
        return {}
    return {str(item[key]): item for item in items if isinstance(item, Mapping) and key in item}


def _track_changes(before: Any, after: Any) -> list[dict[str, Any]]:
    old, new = _by_id(before, "track_id"), _by_id(after, "track_id")
    out: list[dict[str, Any]] = []
    for track_id in sorted(old.keys() | new.keys()):
        if track_id not in old or track_id not in new:
            out.append({"track_id": track_id, "change": "added" if track_id in new else "removed"})
            continue
        for field in _TRACK_KEYS:
            if old[track_id].get(field) != new[track_id].get(field):
                out.append(
                    {
                        "track_id": track_id,
                        "field": field,
                        "from": old[track_id].get(field),
                        "to": new[track_id].get(field),
                    }
                )
    return out


def changes(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> dict[str, Any]:
    """What a write changed, by name only (no content)."""
    old, new = before or {}, after or {}
    fields = sorted(key for key in old.keys() | new.keys() if key not in _BOOKKEEPING and old.get(key) != new.get(key))
    out: dict[str, Any] = {"fields": fields}
    old_tl, new_tl = old.get("timeline"), new.get("timeline")
    if isinstance(old_tl, Mapping) and isinstance(new_tl, Mapping):
        out["timeline"] = sorted(key for key in old_tl.keys() | new_tl.keys() if old_tl.get(key) != new_tl.get(key))
        tracks = _track_changes(old_tl.get("tracks"), new_tl.get("tracks"))
        if tracks:
            out["tracks"] = tracks
    old_shots, new_shots = _by_id(old.get("shots"), "shot_id"), _by_id(new.get("shots"), "shot_id")
    added = sorted(new_shots.keys() - old_shots.keys())
    removed = sorted(old_shots.keys() - new_shots.keys())
    edited = sorted(sid for sid in old_shots.keys() & new_shots.keys() if old_shots[sid] != new_shots[sid])
    if added or removed or edited:
        out["shots"] = {"added": added, "removed": removed, "edited": edited}
    return out


class StudioAudit:
    """Appends one line per project write; callers hold the project store's lock, this lock guards the file."""

    def __init__(self, root: Path) -> None:
        self.path = Path(root) / AUDIT_DIR / "writes.jsonl"
        self._lock = threading.Lock()

    def record(
        self,
        *,
        project_id: str,
        path: str,
        client: str,
        before: Mapping[str, Any] | None,
        after: Mapping[str, Any] | None,
    ) -> None:
        line = {
            "at": utc_now(),
            "project_id": project_id,
            "path": path,
            "client": client,
            "revision_before": None if before is None else before.get("revision"),
            "revision_after": None if after is None else after.get("revision"),
            **changes(before, after),
        }
        try:
            text = json.dumps(line, ensure_ascii=False, separators=(",", ":"), default=str)
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(text + "\n")
        except Exception:
            log.exception("Studio 專案 %s 的寫入稽核紀錄無法寫入（%s，%s）；保存本身已完成", project_id, path, client)


__all__ = ["AUDIT_DIR", "CLIENT_HEADER", "StudioAudit", "changes", "client_tag"]
