"""Project work metadata projected from durable requests, including older Studio versions."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.ids import is_local_id


_FIELDS = ("project_id", "shot_id", "operation_kind", "source_digest", "recipe_digest")
_TYPES = {
    "studio.audio-mix.v1": "audio_mix",
    "studio.timeline-export.v1": "export",
    "studio.otio-reference.v1": "reference",
}


def query_work(params: Mapping[str, str]) -> dict[str, str]:
    """Validate optional project-scoped filters before pagination."""
    result = {key: params[key] for key in _FIELDS if key in params}
    if not result:
        return result
    if not contracts.is_valid(
        "StudioWorkOrigin", {"operation_kind": "render", **result}
    ):
        raise ComponentError("INVALID_ARGUMENT", "專案工作篩選條件無效")
    return result


type ProjectLinks = dict[str, set[tuple[str, str | None]]]


@dataclass(frozen=True)
class ProjectScope:
    """The project a run listing is scoped to: its recorded links, and whether origin-only runs count (related)."""

    links: ProjectLinks
    related: bool = False


def project_links(project: dict[str, Any]) -> ProjectLinks:
    """Index only explicitly recorded Take and export destinations in this project snapshot."""
    links: ProjectLinks = {}
    for collection, id_key in (("shots", "shot_id"), ("image_shots", "image_shot_id")):
        for shot in project.get(collection) or []:
            for take in shot.get("takes") or []:
                links.setdefault(take["run_id"].lower(), set()).add(
                    ("render", shot[id_key])
                )
    for export in project.get("exports") or []:
        destinations = links.setdefault(export["run_id"].lower(), set())
        destinations.update(
            ("export", shot) for shot in export.get("shot_ids") or [None]
        )
    return links


def projected_work(
    origin: dict[str, str],
    query: dict[str, str],
    links: set[tuple[str, str | None]] | None,
) -> dict[str, str] | None:
    """Match before pagination and return only destinations in the requested project."""
    if not query or not links:
        scoped = origin if "project_id" in origin else {}
        return scoped if query.items() <= scoped.items() else None
    project = query["project_id"]
    facts: dict[str, str] = {
        key: origin[key] for key in ("source_digest", "recipe_digest") if key in origin
    }
    candidates = []
    if origin.get("project_id") == project:
        candidates.append(origin)
    for kind, shot in links:
        candidate: dict[str, str] = {
            **facts,
            "project_id": project,
            "operation_kind": origin.get("operation_kind", kind),
        }
        if shot is not None:
            candidate["shot_id"] = shot
        candidates.append(candidate)
    matching = [
        candidate for candidate in candidates if query.items() <= candidate.items()
    ]
    if not matching:
        return None
    # A Run can feed multiple shots. Without a shot filter, mark it as project-level.
    # An explicit export also identifies the operation when a legacy result was used as a Take.
    selected = min(matching, key=lambda row: row["operation_kind"] != "export")
    shots = {
        row["shot_id"]
        for row in matching
        if row["operation_kind"] == selected["operation_kind"] and "shot_id" in row
    }
    if len(shots) == 1:
        return {**selected, "shot_id": next(iter(shots))}
    if len(shots) > 1:
        return {key: value for key, value in selected.items() if key != "shot_id"}
    return selected


def project_match(
    origin: dict[str, str],
    named: str | None,
    project: str,
    links: set[tuple[str, str | None]] | None,
) -> dict[str, str] | None:
    """Match a run related to the project: its project work or links, else an origin that only names the project."""
    match = projected_work(origin, {"project_id": project}, links)
    if match is not None:
        return match
    return {} if named == project else None


def indexed_origin(request: Any) -> dict[str, str]:
    """Keep explicit operation facts even when only a project document can establish its destination."""
    if not isinstance(request, dict) or not isinstance(
        origin := request.get("origin"), dict
    ):
        return {}
    typed = origin.get("studio_work")
    if isinstance(typed, dict) and contracts.is_valid("StudioWorkOrigin", typed):
        return {key: typed[key] for key in _FIELDS if key in typed}
    return _legacy_origin(origin.get("note"), request.get("inputs"))


def work_origin(request: Any) -> dict[str, str]:
    """Project metadata from a request alone; unscoped facts require a verified project link."""
    facts = indexed_origin(request)
    return facts if "project_id" in facts else {}


def origin_project(request: Any) -> str | None:
    """The project a run's origin names, also when it is no indexed project work.

    Typed or legacy project work counts, and so do tool runs started from a project: an origin note that is a JSON
    object with ``project_id`` (also under ``draft_branch``) or a note of the form ``<project_id>/<detail>``. This
    only scopes listings to a project; it never establishes an operation, shot or take.
    """
    work = indexed_origin(request)
    if "project_id" in work:
        return work["project_id"]
    if not isinstance(request, dict) or not isinstance(
        origin := request.get("origin"), dict
    ):
        return None
    note = origin.get("note")
    if not isinstance(note, str) or not note:
        return None
    try:
        parsed = json.loads(note)
    except (TypeError, ValueError, RecursionError):
        parsed = None
    if isinstance(parsed, dict):
        nested = parsed.get("draft_branch")
        scope = nested if isinstance(nested, dict) else parsed
        project = scope.get("project_id")
        return project if isinstance(project, str) and is_local_id(project) else None
    head, separator, _ = note.partition("/")
    return head if separator and is_local_id(head) else None


def history_entry(
    run: dict[str, Any], work: dict[str, str] | None = None
) -> dict[str, Any]:
    """Classify a history row without modifying its frozen request."""
    if work is None:
        work = work_origin(run.get("request"))
    return {**run, "studio_work": work} if work else run


def _legacy_origin(raw: Any, inputs: Any) -> dict[str, str]:
    try:
        note = json.loads(raw or "null")
    except (TypeError, ValueError, RecursionError):
        return {}
    if not isinstance(note, dict):
        return {}
    types = (
        {
            v["type_id"]
            for v in inputs.values()
            if isinstance(v, dict) and isinstance(v.get("type_id"), str)
        }
        if isinstance(inputs, dict)
        else set()
    )
    if isinstance(note.get("draft_branch"), dict):
        note = note["draft_branch"]
        kind = "draft_branch"
    elif note.get("operation") == "native_retake":
        kind = "retake"
    elif "media.mask-annotations.v1" in types:
        kind = "mask"
    elif "media.previs-frames.v1" in types:
        kind = "animatic"
    else:
        tag = note.get("type")
        kind = _TYPES.get(tag, "") if isinstance(tag, str) else ""
    result = {"project_id": note.get("project_id"), "operation_kind": kind}
    for key, legacy in (
        ("shot_id", "shot_id"),
        ("source_digest", "source_sha256"),
        ("recipe_digest", "recipe_digest"),
    ):
        if isinstance(note.get(legacy), str):
            result[key] = note[legacy]
    if result["project_id"] is None:
        # Validate optional fields with a syntactically valid scope, never index that placeholder.
        result.pop("project_id")
    return (
        result
        if contracts.is_valid("StudioWorkOrigin", {"project_id": "unscoped", **result})
        else {}
    )
