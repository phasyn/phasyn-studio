"""Attach a verified published video as a Take, retaining the shot's current selection."""

from __future__ import annotations

import asyncio
from contextlib import ExitStack
from dataclasses import dataclass
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.ids import require_local_id, require_uuid
from phasyn_server.http import read_json
from starlette.responses import JSONResponse

from .studio_audit import client_tag
from .studio_take_receipt import assembled, declared_take
from .studio_take_source import (
    DecodedTake,
    Doc,
    conflict,
    decode_asset,
    decoded_latents,
    load_manifest,
    published,
)


if TYPE_CHECKING:
    from .state import Controller


@dataclass(frozen=True)
class TakeTarget:
    """Identify the project and shot revision accepting a take."""

    project_id: str
    shot_id: str
    expected_revision: int


def compatible(project: Doc, shot: Doc, take: Doc, requested_frames: int) -> bool:
    """Check whether the selected take belongs to the requested generation stage."""
    return (
        not project.get("prompt_plugins")
        and not shot.get("references")
        and (shot.get("continuity") or {}).get("mode", "none") == "none"
        and shot.get("prompt") == take["prompt"]
        and shot.get("frames") == requested_frames
        and (not shot.get("seed_locked") or shot.get("seed") == take["seed"])
    )


def target(project: Doc, shot_id: str) -> Doc:
    """Find the unique shot with the requested identity."""
    found: list[Doc] = [s for s in project["shots"] if s["shot_id"] == shot_id]
    if len(found) != 1:
        raise conflict("no_unique_target_shot")
    return found[0]


def append_candidate(shot: Doc, take: Doc) -> None:
    """Pin the effective selection when adding a published candidate to a shot."""
    if not shot.get("active_take_id"):
        selected = next(
            (old for old in reversed(shot["takes"]) if old["state"] == "succeeded"),
            take,
        )
        shot["active_take_id"] = selected["take_id"]
    shot["takes"].append(take)


def receipt(
    project: Doc, shot_id: str, run_id: str, key: str, asset: Doc
) -> Doc | None:
    """Build the response linking the attached take and its source run."""
    for shot in project["shots"]:
        for take in shot["takes"]:
            if take["run_id"] == run_id and take["output_key"] == key:
                if (
                    shot["shot_id"] != shot_id
                    or take.get("asset") != asset
                    or take["state"] != "succeeded"
                ):
                    raise conflict("output_already_bound_elsewhere_or_inconsistent")
                return {
                    "project_id": project["project_id"],
                    "shot_id": shot_id,
                    "revision": project["revision"],
                    "created": False,
                    "take": take,
                }
    return None


async def _resolve(
    ctl: Controller, run: Doc, key: str, asset: Doc, holds: ExitStack
) -> tuple[Doc, int]:
    if asset["source_latent"] is None:
        return await declared_take(ctl, run, key, asset)
    video, audio = decoded_latents(run, key, asset)
    manifest = await load_manifest(ctl, asset)
    gid = require_uuid(manifest["generation_run_id"], "generation_run_id")
    holds.enter_context(ctl.purge.hold_for_attach(gid))
    generation = await asyncio.to_thread(ctl.runs.read, gid)
    take = await assembled(
        ctl, DecodedTake(run, key, asset, video, audio), manifest, generation, holds
    )
    await asyncio.gather(
        published(ctl, asset["file"]), published(ctl, manifest["blob"])
    )
    return take, manifest["binding"]["job"]["frames"]


def routes(ctl: Controller) -> APIRouter:
    """Expose attachment of a verified run output to a Studio shot."""
    router = APIRouter()

    @router.post("/api/studio/projects/{project_id}/shots/{shot_id}/takes/from-run")
    async def attach(project_id: str, shot_id: str, request: Request) -> JSONResponse:
        pid = require_local_id(project_id, "project_id")
        sid = require_local_id(shot_id, "shot_id")
        body = await read_json(request, limit=4096)

        async def apply() -> Doc:
            contracts.validate("StudioTakeAttachRequest", body)
            rid = require_uuid(body["run_id"], "run_id")
            key = body["output_key"]
            with ExitStack() as holds:
                holds.enter_context(ctl.purge.hold_for_attach(rid))
                run = await asyncio.to_thread(ctl.runs.read, rid)
                asset = decode_asset(run, key)
                doc = await asyncio.to_thread(ctl.studio.get, pid)
                target(doc, sid)
                previous = receipt(doc, sid, rid, key, asset)
                if previous:
                    return previous
                take, frames = await _resolve(ctl, run, key, asset, holds)
                # Probes and reads above change nothing; a failure there lets the same receipt key retry.
                ctl.studio.writes.committing()
                write = asyncio.create_task(
                    asyncio.to_thread(
                        ctl.studio.attach_take,
                        TakeTarget(pid, sid, body["expected_revision"]),
                        take,
                        requested_frames=frames,
                        client=client_tag(request.headers),
                    )
                )
                # A cancelled HTTP request cannot withdraw these locks from a pending disk write.
                leases = holds.pop_all()

                def release(finished: asyncio.Task[Doc]) -> None:
                    leases.close()
                    if not finished.cancelled():
                        finished.exception()

                write.add_done_callback(release)
                return await asyncio.shield(write)

        return await ctl.studio.writes.perform(request, pid, body, apply)

    return router
