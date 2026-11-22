"""Verify declarative generation evidence recorded by a provider on its own successful call."""

from __future__ import annotations

import asyncio
import re
from typing import TYPE_CHECKING

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.ids import require_uuid

from . import studio_take_source as source


if TYPE_CHECKING:
    from contextlib import ExitStack

    from .state import Controller
    from .studio_take_source import DecodedTake, Doc


RECEIPT_TYPE = "studio.generation-receipt.v1"
JOB_TYPE = "studio.generation-job.v1"
BINDING_ID = "phasyn.studio-generation.v1"
_JOB_FIELDS = {
    "task",
    "prompt",
    "seed",
    "steps",
    "frames",
    "width",
    "height",
    "fps",
    "references",
    "parent",
}
_PARENT_FIELDS = {"generation_run_id", "latent_id", "manifest_file", "blob"}


def declared_parent_run_id(manifest: Doc) -> str | None:
    """Identify the declared parent for the caller's purge lock before reading either run."""
    binding = manifest["binding"]
    if binding.get("binding_id") != BINDING_ID:
        return None
    job = binding.get("job")
    if not isinstance(job, dict):
        raise source.conflict("invalid_declared_job")
    parent = job.get("parent")
    if parent is None:
        return None
    if not isinstance(parent, dict) or set(parent) != _PARENT_FIELDS:
        raise source.conflict("invalid_declared_parent")
    return require_uuid(parent.get("generation_run_id"), "parent_generation_run_id")


def _job(run: Doc, step: Doc) -> Doc:
    port = step["inputs"].get("job") or {}
    if set(port) != {"from_input"}:
        raise source.conflict("declared_job_must_be_a_frozen_input")
    typed = run["request"]["inputs"].get(port["from_input"]) or {}
    job = typed.get("value")
    if (
        typed.get("type_id") != JOB_TYPE
        or not isinstance(job, dict)
        or set(job) != _JOB_FIELDS
        or job["task"] != "t2va"
        or job["references"] != []
        or not isinstance(job["prompt"], str)
        or not job["prompt"].strip()
        or any(
            type(job[k]) is not int
            for k in ("seed", "steps", "frames", "width", "height")
        )
        or not contracts.is_valid("Rational", job["fps"])
    ):
        raise source.conflict("unsupported_or_invalid_declared_job")
    expected = {"job"} if job["parent"] is None else {"job", "init_latent"}
    if set(step["inputs"]) != expected:
        raise source.conflict("undeclared_or_missing_generator_input")
    return job


def _output(record: Doc, kind: str) -> Doc:
    found = [v for v in record["outputs"].values() if v.get("type_id") == kind]
    if len(found) != 1:
        raise source.conflict("no_unique_declared_output_of_type")
    result: Doc = found[0]
    return result


def _attested_job(run: Doc, step: Doc, port: str, typed: Doc) -> Doc:
    record = run["steps"][step["step_id"]]
    settings = record.get("invoke_snapshot")
    if (
        record.get("state") != "succeeded"
        or record.get("node_id") != step["node_id"]
        or record.get("component_id") != step["component_id"]
        or not isinstance(settings, dict)
        or not isinstance(record.get("call_id"), str)
        or record["outputs"].get(port) != typed
    ):
        raise source.conflict("generation_call_identity_mismatch")
    call_id = require_uuid(record["call_id"], "call_id")
    job = _job(run, step)
    expected = {
        "schema": RECEIPT_TYPE,
        "run_id": run["run_id"],
        "step_id": step["step_id"],
        "call_id": call_id,
        "node_id": step["node_id"],
        "component_id": step["component_id"],
        "output_port": port,
        "output_digest": digest(typed),
        "job_digest": digest(job),
        "parameters_digest": digest(settings),
    }
    if _output(record, RECEIPT_TYPE) != {"type_id": RECEIPT_TYPE, "value": expected}:
        raise source.conflict("generation_receipt_does_not_match_recorded_call")
    # A second source for the same role must agree with the frozen job, including JSON types.
    if any(digest(settings[k]) != digest(job[k]) for k in job.keys() & settings.keys()):
        raise source.conflict("generation_parameters_conflict_with_declared_job")
    return job


def _geometry(job: Doc, asset: Doc) -> None:
    if (
        job["frames"] != asset["frame_count"]
        or job["width"] != asset["width"]
        or job["height"] != asset["height"]
        or job["fps"] != asset["fps"]
    ):
        raise source.conflict("declared_job_geometry_does_not_match_output")


async def declared_take(
    ctl: Controller, run: Doc, key: str, asset: Doc
) -> tuple[Doc, int]:
    """Accept a reference-free generator publishing the video file, complete Asset and its call receipt."""
    if asset != source.decode_asset(run, key) or asset["source_latent"] is not None:
        raise source.conflict("direct_generation_requires_its_own_published_asset")
    edge = run["request"]["pipeline"]["outputs"][key]
    step, typed = source.step_source(run, edge)
    job = _attested_job(run, step, edge["output"], typed)
    record = run["steps"][step["step_id"]]
    if (
        job["parent"] is not None
        or asset["file"]["node_id"] != step["node_id"]
        or digest(_output(record, "media.video.v1"))
        != digest({"type_id": "media.video.v1", "file": asset["file"]})
    ):
        raise source.conflict("direct_video_not_emitted_by_the_attested_call")
    _geometry(job, asset)
    await source.published(ctl, asset["file"])
    output = source.PublishedVideo(run, key, asset)
    take = source.take_result(output, run, job)
    return take, job["frames"]


def _identity(manifest: Doc) -> tuple[str, str, str]:
    identity = manifest["generator_identity"]
    provider = identity.get("provider_id")
    model = identity.get("model_sha256")
    space = manifest["latent_space_id"]
    if (
        manifest["binding"].get("binding_id") != BINDING_ID
        or not isinstance(provider, str)
        or not provider.strip()
        or provider == "h3.dit"
        or space == "minimax-h3.video-vae.v1"
        or not isinstance(model, str)
        or re.fullmatch(r"[0-9a-f]{64}", model) is None
    ):
        raise source.conflict("invalid_or_reserved_declared_latent_identity")
    return provider, model, space


def _producer(generation: Doc, manifest: Doc, video: Doc) -> tuple[Doc, Doc]:
    source.succeeded(generation)
    _identity(manifest)
    identity = manifest["generator_identity"]
    matches: list[tuple[Doc, str]] = []
    for step in generation["request"]["pipeline"]["steps"]:
        entry = generation["steps"].get(step["step_id"]) or {}
        if (
            step["node_id"] == identity.get("node_id")
            and step["component_id"] == identity.get("component_id")
            and entry.get("state") == "succeeded"
        ):
            matches.extend(
                (step, port)
                for port, value in entry["outputs"].items()
                if value == video and digest(value) == digest(video)
            )
    if len(matches) != 1:
        raise source.conflict("no_unique_producer_of_declared_latent")
    step, port = matches[0]
    context = generation["steps"][step["step_id"]].get("settings") or {}
    model = context.get("model_identity") or {}
    if model.get("sha256") != identity["model_sha256"]:
        raise source.conflict("declared_model_does_not_match_loaded_model_digest")
    job = _attested_job(generation, step, port, video)
    if (
        video["type_id"] != "video.final-latent.v1"
        or video["file"]["node_id"] != step["node_id"]
        or manifest["blob"]["node_id"] != step["node_id"]
        or manifest["generation_run_id"] != generation["run_id"]
        or type(identity.get("seed")) is not int
        or job["seed"] != identity["seed"]
        or digest(manifest["binding"].get("job")) != digest(job)
    ):
        raise source.conflict("declared_generation_or_sampling_identity_mismatch")
    return step, job


async def _check_parent(
    ctl: Controller, generation: Doc, step: Doc, manifest: Doc, holds: ExitStack
) -> str | None:
    gid = declared_parent_run_id(manifest)
    if gid is None:
        return None
    holds.enter_context(ctl.purge.hold_for_attach(gid))
    job = manifest["binding"]["job"]
    parent = job["parent"]
    initial = source.source_input(generation, step, "init_latent")
    if (
        initial["type_id"] != "video.final-latent.v1"
        or digest(initial["file"]) != digest(parent["manifest_file"])
        or not contracts.is_valid("FileRef", parent["blob"])
        or gid == generation["run_id"]
        or parent["latent_id"] == manifest["latent_id"]
    ):
        raise source.conflict("invalid_declared_refinement_input")
    ref = initial["file"]
    # Reuse the decoder's full manifest, publication, digest, links and geometry checks on the actual input.
    original = await source.load_manifest(
        ctl,
        {
            "source_latent": {
                "manifest_file": ref,
                "manifest_sha256": ref["sha256"],
                "latent_id": parent["latent_id"],
                "blob_sha256": parent["blob"]["sha256"],
            },
            "width": job["width"],
            "height": job["height"],
            "frame_count": job["frames"],
            "fps": job["fps"],
        },
    )
    if (
        original["generation_run_id"] != gid
        or digest(original["blob"]) != digest(parent["blob"])
        or _identity(original) != _identity(manifest)
        or declared_parent_run_id(original) is not None
    ):
        raise source.conflict("declared_parent_is_not_a_compatible_draft")
    previous = await asyncio.to_thread(ctl.runs.read, gid)
    _, parent_job = _producer(previous, original, initial)
    if any(
        digest(parent_job[k]) != digest(job[k])
        for k in _JOB_FIELDS - {"steps", "parent"}
    ):
        raise source.conflict("declared_parent_job_changed")
    await source.published(ctl, original["blob"])
    return gid


async def assembled(
    ctl: Controller,
    decoded: DecodedTake,
    manifest: Doc,
    generation: Doc,
    holds: ExitStack,
) -> Doc:
    """Dispatch existing H3 evidence or validate a model's explicitly declared staged receipt."""
    if manifest["binding"].get("binding_id") != BINDING_ID:
        return await source.assembled(ctl, decoded, manifest, generation, holds=holds)
    step, job = _producer(generation, manifest, decoded.video)
    _geometry(job, decoded.asset)
    if decoded.audio is not None:
        audio = _output(generation["steps"][step["step_id"]], "audio.final-latent.v1")
        if audio != decoded.audio or audio["file"]["node_id"] != step["node_id"]:
            raise source.conflict("declared_audio_not_emitted_by_the_same_call")
        await source.published(ctl, audio["file"])
    parent = await _check_parent(ctl, generation, step, manifest, holds)
    return source.take_result(decoded, generation, job, parent=parent)
