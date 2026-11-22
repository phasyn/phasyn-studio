"""Resolve a completed decode to its published generation and verify historical H3 evidence."""

from __future__ import annotations

import asyncio
import hashlib
import os
from contextlib import ExitStack
from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, uuid5

import httpx
from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_uuid
from phasyn_server.http import parse_json_bytes


if TYPE_CHECKING:
    from .state import Controller

type Doc = dict[str, Any]
_MAX_SAMPLE_RATE = 768_000
MAX_MANIFEST = 256 * 1024


def conflict(reason: str) -> ComponentError:
    """Describe a conflict between the recorded generation and selected output."""
    return ComponentError(
        "STATE_CONFLICT",
        "無法確認這個執行結果與鏡頭的來源關係",
        details={"reason": reason},
    )


def succeeded(run: Doc) -> None:
    """Require a successfully completed source run."""
    if run.get("state") != "succeeded":
        raise conflict("run_not_succeeded")
    # Legacy standalone staged runs can be deliberately adopted. Other origins need their own ownership proof.
    if run["request"].get("origin"):
        raise conflict("scoped_origin_requires_verified_binding")


def step_source(run: Doc, edge: Doc) -> tuple[Doc, Doc]:
    """Find the producing step and its frozen configuration."""
    sid = edge.get("from_step")
    steps = [
        step for step in run["request"]["pipeline"]["steps"] if step["step_id"] == sid
    ]
    record = run["steps"].get(sid, {})
    value = (record.get("outputs") or {}).get(edge.get("output"))
    if (
        len(steps) != 1
        or record.get("state") != "succeeded"
        or not isinstance(value, dict)
    ):
        raise conflict("unpublished_step_output")
    return steps[0], value


def decode_asset(run: Doc, key: str) -> Doc:
    """Validate the published media asset from the selected run output."""
    succeeded(run)
    return published_video(run, key)


def published_video(run: Doc, key: str) -> Doc:
    """Read a recorded, complete video. Media adoption preserves its origin independently of shot generation."""
    edge = run["request"]["pipeline"]["outputs"].get(key, {})
    _, typed = step_source(run, edge)
    if (
        typed != run.get("outputs", {}).get(key)
        or typed.get("type_id") != "media.asset.v1"
    ):
        raise conflict("output_must_be_published_media_asset")
    asset = typed.get("value")
    if not contracts.is_valid("Asset", asset) or not isinstance(asset, dict):
        raise conflict("invalid_asset")
    if (
        asset["kind"] not in {"final", "video"}
        or not asset["complete"]
        or not asset["file"]["media_type"].startswith("video/")
        or not asset.get("fps")
        or min(
            asset["width"],
            asset["height"],
            asset["frame_count"],
            asset["file"]["size_bytes"],
        )
        <= 0
    ):
        raise conflict("incomplete_published_video")
    return asset


def published_timeline_media(run: Doc, key: str) -> Doc:
    """Use the published sample clock to place standalone audio on the timeline."""
    raw = run.get("outputs", {}).get(key, {})
    if raw.get("type_id") != "media.audio.v1":
        return published_video(run, key)
    _, typed = step_source(run, run["request"]["pipeline"]["outputs"].get(key, {}))
    ref = typed.get("file")
    if (
        typed != raw
        or not isinstance(ref, dict)
        or not contracts.is_valid("FileRef", ref)
        or not ref["media_type"].startswith("audio/")
    ):
        raise conflict("unpublished_audio_output")
    samples = ref["metadata"].get("sample_count")
    rate = ref["metadata"].get("sample_rate")
    if (
        type(rate) is not int
        or not 1 <= rate <= _MAX_SAMPLE_RATE
        or type(samples) is not int
        or not 0 < samples <= rate * 86400
    ):
        raise conflict("published_audio_sample_clock_missing")
    return {
        "kind": "audio",
        "file": ref,
        "asset_id": ref["file_id"],
        "sample_count": samples,
        "sample_rate": rate,
    }


def published_library_media(run: Doc, key: str) -> Doc:
    """Resolve an immutable photo, video or audio output without relabelling its origin."""
    step, typed = step_source(run, run["request"]["pipeline"]["outputs"].get(key, {}))
    if typed != run.get("outputs", {}).get(key):
        raise conflict("unpublished_library_output")
    tag = typed["type_id"]
    asset = typed.get("value") if tag in ("media.asset.v1", "image.asset.v1") else None
    if tag == "media.asset.v1" and (
        not isinstance(asset, dict) or asset.get("complete") is not True
    ):
        raise conflict("incomplete_library_output")
    ref = asset.get("file") if isinstance(asset, dict) else typed.get("file")
    if not isinstance(ref, dict) or not contracts.is_valid("FileRef", ref):
        raise conflict("unpublished_library_file")
    kind = ref["media_type"].split("/", 1)[0]
    if kind not in ("audio", "image", "video") or tag not in (
        f"media.{kind}.v1",
        "media.asset.v1",
        "image.asset.v1",
        "file.attachment.v1",
    ):
        raise conflict("unsupported_library_file")
    meta = ref["metadata"]
    asset = asset or {}
    duration = None
    if (rate := asset.get("fps")) and asset.get("frame_count"):
        duration = asset["frame_count"] * rate["den"] / rate["num"]
    elif (
        kind == "audio"
        and type(meta.get("sample_count")) is int
        and type(meta.get("sample_rate")) is int
        and meta["sample_rate"] > 0
    ):
        duration = meta["sample_count"] / meta["sample_rate"]
    return {
        "kind": kind,
        "file": ref,
        "width": asset.get("width"),
        "height": asset.get("height"),
        "duration_seconds": duration,
        "has_audio": asset.get(
            "has_audio", True if kind == "audio" else False if kind == "image" else None
        ),
        "created_at": run["created_at"],
        "step_id": step["step_id"],
    }


def recorded_output_audio(ctl: Controller, run: Doc, key: str) -> bool | None:
    """Recover a final audio flag only from the verified provider's published output."""
    step, typed = step_source(run, run["request"]["pipeline"]["outputs"][key])
    if typed != run["outputs"].get(key):
        return None
    asset = typed.get("value") or {}
    if isinstance(asset.get("has_audio"), bool):
        return bool(asset["has_audio"])
    settings = asset.get("actual_settings") or {}
    record = run["steps"][step["step_id"]]
    receipt = record.get("recording_id")
    if not receipt or not record.get("call_id"):
        return None
    try:
        recording = ctl.store.get(receipt)
    except ComponentError as exc:
        if exc.code in ("NOT_FOUND", "RECORDING_NOT_FOUND"):
            return None
        raise
    identity = recording["context"]
    if recording["summary"].get("state") != "succeeded" or any(
        identity.get(k) != v
        for k, v in {
            "operation": "invoke",
            "run_id": run["run_id"],
            "node_id": step["node_id"],
            "component_id": step["component_id"],
            "call_id": record["call_id"],
            "recording_id": receipt,
        }.items()
    ):
        return None
    report_key = {
        "media.interpolate": "interpolation",
        "media.restore": "restoration",
    }.get(identity.get("provider_id", ""))
    report = settings.get(report_key) if report_key else None
    return (
        report["has_audio"]
        if isinstance(report, dict) and isinstance(report.get("has_audio"), bool)
        else None
    )


def source_input(run: Doc, step: Doc, port: str) -> Doc:
    """Resolve a direct pipeline input for the chosen port."""
    source = step["inputs"].get(port, {})
    if set(source) != {"from_input"}:
        raise conflict("decoder_expected_a_staged_input")
    value = run["request"]["inputs"].get(source["from_input"], {})
    if not isinstance(value, dict) or "file" not in value:
        raise conflict("decoder_input_not_a_published_file")
    return value


def decoded_latents(run: Doc, key: str, asset: Doc) -> tuple[Doc, Doc | None]:
    """Locate the exact video and optional audio latents consumed by decoding."""
    end, _ = step_source(run, run["request"]["pipeline"]["outputs"][key])
    audio = None
    if set(end["inputs"]) == {"video", "audio"}:
        video_step, intermediate = step_source(run, end["inputs"]["video"])
        audio_step, audio_value = step_source(run, end["inputs"]["audio"])
        if (
            intermediate.get("type_id") != "media.asset.v1"
            or (intermediate.get("value") or {}).get("source_latent")
            != asset["source_latent"]
            or audio_value.get("type_id") != "media.audio.v1"
        ):
            raise conflict("mux_branch_does_not_match_decoder")
        audio = source_input(run, audio_step, "latent")
        if audio["type_id"] != "audio.final-latent.v1":
            raise conflict("unexpected_audio_latent")
    else:
        video_step = end
    if set(video_step["inputs"]) != {"latent"}:
        raise conflict("unsupported_video_decoder_inputs")
    video = source_input(run, video_step, "latent")
    if (
        video["type_id"] != "video.final-latent.v1"
        or video["file"] != asset["source_latent"]["manifest_file"]
    ):
        raise conflict("video_input_does_not_match_manifest")
    return video, audio


def _controller_bytes(ctl: Controller, ref: Doc, end: int) -> bytes:
    fid = require_uuid(ref["file_id"], "file_id")
    if ctl.files.fileref(fid) != ref:
        raise conflict("file_missing_or_publication_identity_changed")
    try:
        with ctl.files.payload_path(fid).open("rb") as payload:
            if os.fstat(payload.fileno()).st_size != ref["size_bytes"]:
                raise conflict("published_file_integrity_mismatch")
            return payload.read(end + 1)
    except FileNotFoundError as exc:
        raise conflict("file_missing_or_publication_identity_changed") from exc


async def _node_bytes(ctl: Controller, ref: Doc, end: int) -> bytes:
    size = ref["size_bytes"]
    endpoint = ctl.catalog.endpoint_for_read(require_uuid(ref["node_id"], "node_id"))
    fid = require_uuid(ref["file_id"], "file_id")
    try:
        async with (
            asyncio.timeout(20),
            ctl.http.stream(
                "GET",
                f"{endpoint}/api/files/{fid}",
                headers={"Range": f"bytes=0-{end}", "Accept-Encoding": "identity"},
                timeout=10,
            ) as response,
        ):
            headers = response.headers
            if (
                response.status_code != HTTPStatus.PARTIAL_CONTENT
                or headers.get("content-range") != f"bytes 0-{end}/{size}"
                or headers.get("etag") != f'"{ref["sha256"]}"'
                or headers.get("content-length") != str(end + 1)
                or headers.get("content-encoding", "identity") != "identity"
            ):
                raise conflict("file_missing_or_publication_identity_changed")
            data = bytearray()
            async for chunk in response.aiter_raw(chunk_size=min(end + 1, 16384)):
                if len(data) + len(chunk) > end + 1:
                    raise conflict("published_response_exceeded_size")
                data.extend(chunk)
    except (httpx.HTTPError, TimeoutError) as exc:
        raise ComponentError(
            "NODE_UNREACHABLE",
            "無法讀取來源節點的已發布檔案",
            details={"node_id": ref["node_id"]},
        ) from exc
    return bytes(data)


async def published(
    ctl: Controller, ref: Doc, *, manifest: bool = False, limit: int = MAX_MANIFEST
) -> bytes:
    """Probe the owning store for one byte or read and hash a bounded manifest."""
    size = ref["size_bytes"]
    if size <= 0 or (manifest and size > limit):
        raise conflict("unsupported_published_file_size")
    end = size - 1 if manifest else 0
    data = (
        await asyncio.to_thread(_controller_bytes, ctl, ref, end)
        if ref["node_id"] == ctl.instance_id
        else await _node_bytes(ctl, ref, end)
    )
    if len(data) != end + 1 or (
        manifest and hashlib.sha256(data).hexdigest() != ref["sha256"]
    ):
        raise conflict("published_file_integrity_mismatch")
    return data


async def load_manifest(ctl: Controller, asset: Doc) -> Doc:
    """Read and validate the published manifest for this asset."""
    src = asset["source_latent"]
    ref = src["manifest_file"]
    doc = parse_json_bytes(
        await published(ctl, ref, manifest=True), what="final latent manifest"
    )
    if not isinstance(doc, dict) or not contracts.is_valid("FinalLatentManifest", doc):
        raise conflict("invalid_latent_manifest")
    links = ref["metadata"].get("links")
    if (
        doc["stage"] != "final"
        or ref["media_type"] != "application/vnd.phasyn.latent-manifest+json"
        or src["manifest_sha256"] != ref["sha256"]
        or src["latent_id"] != doc["latent_id"]
        or src["blob_sha256"] != doc["blob"]["sha256"]
        or not isinstance(links, dict)
        or digest(links.get("blob")) != digest(doc["blob"])
        or doc["target"]
        != {
            "width": asset["width"],
            "height": asset["height"],
            "frames": asset["frame_count"],
            "fps": asset["fps"],
        }
    ):
        raise conflict("manifest_does_not_describe_asset")
    return doc


def generation_step(
    generation: Doc, manifest: Doc, video: Doc, audio: Doc | None
) -> Doc:
    """Match the manifest to the generation step that produced its latents."""
    identity = manifest["generator_identity"]
    job = manifest["binding"].get("job")
    found: list[Doc] = []
    for step in generation["request"]["pipeline"]["steps"]:
        record = generation["steps"].get(step["step_id"]) or {}
        outputs = record.get("outputs") or {}
        if (
            record.get("state") == "succeeded"
            and outputs.get("video_latent") == video
            and (audio is None or outputs.get("audio_latent") == audio)
            and identity.get("node_id") == record.get("node_id")
            and identity.get("component_id") == record.get("component_id")
        ):
            found.append(step)
    if len(found) != 1:
        raise conflict("no_unique_generation_of_selected_latents")
    step = found[0]
    job_input = step.get("inputs", {}).get("job", {}).get("from_input")
    if generation["request"]["inputs"].get(job_input) != {
        "type_id": "h3.job.v1",
        "value": job,
    }:
        raise conflict("manifest_job_not_generator_job")
    return step


async def bundle(ctl: Controller, ref: Doc, kind: str) -> Doc:
    """Read the published bundle and verify its declared content kind."""
    if (
        ref["media_type"] != "application/vnd.phasyn.h3-bundle+json"
        or ref["metadata"].get("kind") != kind
    ):
        raise conflict("unexpected_conditioning_bundle")
    doc = parse_json_bytes(await published(ctl, ref, manifest=True), what=kind)
    if not isinstance(doc, dict) or doc.get("kind") != kind:
        raise conflict("invalid_conditioning_bundle")
    return doc


async def verify_text(
    ctl: Controller, generation: Doc, manifest: Doc, step: Doc, holds: ExitStack
) -> str | None:
    """The condition tensor must have been encoded from this actual verbatim prompt and reference-free preparation."""
    parent_run_id = None
    bound = source_input(generation, step, "conditioning")
    if bound["type_id"] != "h3.conditioning.tap50.v1":
        raise conflict("unexpected_conditioning")
    job = manifest["binding"]["job"]
    if set(step["inputs"]) == {"conditioning", "job", "init_latent"}:
        initial = source_input(generation, step, "init_latent")
        parent = initial["file"]
        original = parse_json_bytes(
            await published(ctl, parent, manifest=True), what="parent latent"
        )
        if not isinstance(original, dict) or not contracts.is_valid(
            "FinalLatentManifest", original
        ):
            raise conflict("invalid_refinement_parent")
        refine = manifest["generator_identity"].get("refine") or {}
        if (
            initial["type_id"] != "video.final-latent.v1"
            or original["latent_space_id"] != manifest["latent_space_id"]
            or original["binding"].get("binding_id")
            != manifest["binding"].get("binding_id")
            or original["generator_identity"].get("provider_id") != "h3.dit"
            or original["generation_run_id"] == generation["run_id"]
            or original["binding"].get("job") != job
            or refine.get("init_latent_id") != original["latent_id"]
            or refine.get("init_blob_sha256") != original["blob"]["sha256"]
        ):
            raise conflict("refinement_parent_does_not_match")
        gid = require_uuid(original["generation_run_id"], "generation_run_id")
        holds.enter_context(ctl.purge.hold_for_attach(gid))
        generation = await asyncio.to_thread(ctl.runs.read, gid)
        succeeded(generation)
        if generation["run_id"] != gid:
            raise conflict("refinement_parent_run_mismatch")
        step = generation_step(generation, original, initial, None)
        if source_input(generation, step, "conditioning") != bound:
            raise conflict("refinement_uses_other_conditioning")
        parent_run_id = gid
    if set(step["inputs"]) != {"conditioning", "job", "prepared"}:
        raise conflict("unverified_generation_conditioning_inputs")
    prepare = source_input(generation, step, "prepared")
    if prepare["type_id"] != "h3.prepared-media.v1":
        raise conflict("unexpected_prepared_media")
    cond, prep = await asyncio.gather(
        bundle(ctl, bound["file"], "h3_conditioning"),
        bundle(ctl, prepare["file"], "h3_prepared_media"),
    )
    if (
        cond.get("is_fixture") is not False
        or cond.get("prepared_inputs_digest") != digest({"prepared": prep})
        or prep.get("task") != "t2va"
        or prep.get("materials") != []
        or prep.get("geometry_digest") != job.get("geometry_digest")
        or (prep.get("prompt") or {}).get("text") != job["prompt"]
    ):
        raise conflict("encoded_prompt_or_reference_does_not_match_generation")
    return parent_run_id


@dataclass(frozen=True)
class PublishedVideo:
    """Bind a direct or decoded video to its published pipeline output."""

    run: Doc
    key: str
    asset: Doc


@dataclass(frozen=True)
class DecodedTake(PublishedVideo):
    """Bind one decoded output to its media and latent files."""

    video: Doc
    audio: Doc | None


async def assembled(
    ctl: Controller,
    decoded: DecodedTake,
    manifest: Doc,
    generation: Doc,
    *,
    holds: ExitStack | None = None,
) -> Doc:
    """Assemble a take from the checked source, media and provenance."""
    if holds is None:
        with ExitStack() as temporary:
            return await assembled(ctl, decoded, manifest, generation, holds=temporary)
    video, audio = decoded.video, decoded.audio
    succeeded(generation)
    identity = manifest["generator_identity"]
    binding = manifest["binding"]
    job = binding.get("job") or {}
    if (
        identity.get("provider_id") != "h3.dit"
        or manifest["latent_space_id"] != "minimax-h3.video-vae.v1"
        or binding.get("binding_id") != "phasyn_h3.target_latents.v1"
        or not isinstance(job, dict)
        or job.get("schema") != "h3.job.v1"
        or job.get("task") != "t2va"
        or job.get("materials") != []
        or not isinstance(job.get("prompt"), str)
        or not job["prompt"].strip()
    ):
        raise conflict("unsupported_or_unverifiable_h3_reference_conditioning")
    step = generation_step(generation, manifest, video, audio)
    parent = await verify_text(ctl, generation, manifest, step, holds)
    seed = identity.get("seed")
    steps = (binding.get("schedule") or {}).get("planned_updates")
    if (
        type(seed) is not int
        or str(seed) != binding.get("seed")
        or type(steps) is not int
    ):
        raise conflict("unverified_sampling_parameters")
    if manifest["generation_run_id"] != generation["run_id"]:
        raise conflict("generation_identity_mismatch")
    return take_result(
        decoded, generation, {**job, "seed": seed, "steps": steps}, parent=parent
    )


def take_result(
    output: PublishedVideo,
    generation: Doc,
    job: Doc,
    *,
    parent: str | None = None,
) -> Doc:
    """Create the same stable Take identity for every verified output."""
    run, key, asset = output.run, output.key, output.asset
    result = {
        "take_id": str(
            uuid5(NAMESPACE_URL, f"phasyn:studio-take:{run['run_id']}:{key}")
        ),
        "run_id": run["run_id"],
        "output_key": key,
        "generation_run_id": generation["run_id"],
        "created_at": run["created_at"],
        "state": "succeeded",
        "task": "t2va",
        "prompt": job["prompt"],
        "seed": job["seed"],
        "frames": asset["frame_count"],
        "width": asset["width"],
        "height": asset["height"],
        "route": run["request"]["pipeline"]["pipeline_id"],
        "steps": job["steps"],
        "asset": asset,
        "video_latent": output.video["file"]
        if isinstance(output, DecodedTake)
        else None,
        "error": None,
        "timings_ms": {},
    }
    if parent is not None:
        result["parent_generation_run_id"] = parent
    contracts.validate("StudioTake", result)
    return result
