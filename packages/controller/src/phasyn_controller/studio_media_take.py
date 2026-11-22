"""Adopt a published video as an editorial candidate while retaining its actual media inputs."""

from __future__ import annotations

import asyncio
from contextlib import ExitStack
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.ids import require_local_id, require_uuid
from phasyn_server.http import read_json
from starlette.responses import JSONResponse

from .media_file_holds import FileKey, hold_media_files
from .purge import file_key, referenced_files
from .revisions import require_revision
from .studio_audit import client_tag
from .studio_take_attach import append_candidate, target
from .studio_take_source import Doc, conflict, published, published_video, step_source


if TYPE_CHECKING:
    from .state import Controller


_MAX_INPUTS = 128
_PROBE_BATCH = 8
_METHOD = "adopt_published_media"


def _published_asset(run: Doc, key: str) -> tuple[Doc, Doc]:
    if run.get("state") != "succeeded":
        raise conflict("run_not_succeeded")
    asset = published_video(run, key)
    step, _ = step_source(run, run["request"]["pipeline"]["outputs"][key])
    record = run["steps"][step["step_id"]]
    if step["component_id"] != record.get("component_id") or step[
        "node_id"
    ] != record.get("node_id"):
        raise conflict("published_media_producer_changed")
    return asset, step


def _bound(run: Doc, binding: Doc) -> tuple[Doc | None, Doc | None]:
    if "from_step" in binding:
        return step_source(run, binding)
    if "literal" in binding:
        return None, binding["literal"]
    name = binding["from_input"]
    value = run["request"]["inputs"].get(name)
    if value is None and not any(
        p["name"] == name and p.get("required") is False
        for p in run["request"]["pipeline"]["inputs"]
    ):
        raise conflict("adopted_media_input_not_recorded")
    return None, value


@dataclass
class _Files:
    """Unique immutable file identities and the actual input role of each referenced file."""

    refs: dict[FileKey, Doc]
    inputs: dict[tuple[str, str, FileKey], Doc]

    def add(self, value: Doc, step: str | None = None, port: str | None = None) -> None:
        """Collect direct FileRefs and nested media references from one frozen TypedValue."""
        for raw in referenced_files(value):
            ref = dict(raw)
            if not contracts.is_valid("FileRef", ref):
                raise conflict("invalid_adopted_media_file")
            key = file_key(ref)
            known = self.refs.setdefault(key, ref)
            if digest(known) != digest(ref):
                raise conflict("inconsistent_adopted_media_file")
            if step is not None and port is not None:
                self.inputs[step, port, key] = {
                    "step_id": step,
                    "port": port,
                    "type_id": value["type_id"],
                    "file": ref,
                }
            if len(self.inputs) > _MAX_INPUTS or len(self.refs) > _MAX_INPUTS + 1:
                raise conflict("adopted_media_source_limit")


def _lineage(run: Doc, step: Doc, asset: Doc) -> _Files:
    files = _Files({}, {})
    files.add({"type_id": "media.asset.v1", "value": asset})
    pending = [step]
    seen: set[str] = set()
    while pending:
        node = pending.pop()
        sid = node["step_id"]
        if sid in seen:
            continue
        seen.add(sid)
        for port, binding in sorted(node["inputs"].items()):
            ancestor, typed = _bound(run, binding)
            if ancestor is not None:
                pending.append(ancestor)
            if typed is not None:
                files.add(typed, sid, port)
    return files


def _candidate(
    run: Doc,
    published_output: tuple[Doc, Doc],
    inputs: list[Doc],
    *,
    destination: tuple[str, str],
    body: Doc,
) -> Doc:
    asset, step = published_output
    parent = body.get("parent_take_id")
    key = body["output_key"]
    take = {
        "take_id": str(
            uuid5(
                NAMESPACE_URL,
                digest(["adopt_published_media", *destination, run["run_id"], key]),
            )
        ),
        "run_id": run["run_id"],
        "output_key": key,
        "created_at": run["created_at"],
        "state": "succeeded",
        "prompt": None,
        "seed": None,
        "steps": None,
        "width": asset["width"],
        "height": asset["height"],
        "frames": asset["frame_count"],
        "route": run["request"]["pipeline"]["pipeline_id"],
        "asset": asset,
        "video_latent": None,
        "error": None,
        "timings_ms": {},
        "media_adoption": {
            "method": _METHOD,
            "run_id": run["run_id"],
            "step_id": step["step_id"],
            "output_port": run["request"]["pipeline"]["outputs"][key]["output"],
            "component_id": step["component_id"],
            "node_id": step["node_id"],
            "source_inputs": inputs,
            "parent_take_id": parent,
        },
    }
    contracts.validate("StudioTake", take)
    return take


def _receipt(project: Doc, shot: Doc, take: Doc) -> Doc | None:
    for current in shot["takes"]:
        if (
            current["run_id"] == take["run_id"]
            and current["output_key"] == take["output_key"]
        ):
            if digest(current) != digest(take):
                raise conflict("candidate_already_bound_with_other_provenance")
            return {
                "project_id": project["project_id"],
                "shot_id": shot["shot_id"],
                "revision": project["revision"],
                "created": False,
                "take": current,
            }
    return None


def _destination(
    project: Doc, sid: str, body: Doc, take: Doc
) -> tuple[Doc, Doc | None]:
    shot = target(project, sid)
    previous = _receipt(project, shot, take)
    if previous is None:
        require_revision(
            project["revision"],
            body["expected_revision"],
            what="專案",
            suffix="請重新讀取專案",
        )
        parent = body.get("parent_take_id")
        if parent is not None and not any(
            old["take_id"] == parent
            and old["state"] == "succeeded"
            and old.get("asset")
            for old in shot["takes"]
        ):
            raise conflict("editorial_parent_must_belong_to_target_shot")
    return shot, previous


def _commit(ctl: Controller, project: Doc, shot: Doc, take: Doc, client: str) -> Doc:
    append_candidate(shot, take)
    saved = ctl.studio.put(project["project_id"], project, client, adopt_media=True)
    return {
        "project_id": project["project_id"],
        "shot_id": shot["shot_id"],
        "revision": saved["revision"],
        "created": True,
        "take": take,
    }


async def _adopt(ctl: Controller, pid: str, sid: str, body: Doc, client: str) -> Doc:
    contracts.validate("StudioMediaTakeAdoptRequest", body)
    rid = require_uuid(body["run_id"], "run_id")
    if body.get("parent_take_id") is not None:
        require_local_id(body["parent_take_id"], "parent_take_id")
    with ExitStack() as holds:
        holds.enter_context(ctl.purge.hold_for_attach(rid))
        run = await asyncio.to_thread(ctl.runs.read, rid)
        if run["run_id"] != rid:
            raise conflict("adopted_source_run_identity_mismatch")
        published_output = _published_asset(run, body["output_key"])
        asset, step = published_output
        files = _lineage(run, step, asset)
        take = _candidate(
            run,
            published_output,
            list(files.inputs.values()),
            destination=(pid, sid),
            body=body,
        )
        project = await asyncio.to_thread(ctl.studio.get, pid)
        shot, previous = _destination(project, sid, body, take)
        if previous is not None:
            return previous
        holds.enter_context(hold_media_files(ctl, set(files.refs)))
        refs = list(files.refs.values())
        for index in range(0, len(refs), _PROBE_BATCH):
            await asyncio.gather(
                *(published(ctl, ref) for ref in refs[index : index + _PROBE_BATCH])
            )
        # Probes and reads above change nothing; a failure there lets the same receipt key retry.
        ctl.studio.writes.committing()
        writing = asyncio.create_task(
            asyncio.to_thread(_commit, ctl, project, shot, take, client)
        )
        leases = holds.pop_all()

        def finished(task: asyncio.Task[Doc]) -> None:
            leases.close()
            if not task.cancelled():
                task.exception()

        writing.add_done_callback(finished)
        return await asyncio.shield(writing)


def routes(ctl: Controller) -> APIRouter:
    """Allow the editor to nominate a published output without asserting how the original shot was rendered."""
    router = APIRouter()

    @router.post("/api/studio/projects/{project_id}/shots/{shot_id}/takes/adopt-media")
    async def adopt(project_id: str, shot_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        sid = require_local_id(shot_id, "shot_id")
        body = await read_json(request, limit=4096)

        async def apply() -> Doc:
            return await _adopt(ctl, pid, sid, body, client_tag(request.headers))

        return await ctl.studio.writes.perform(request, pid, body, apply)

    return router
