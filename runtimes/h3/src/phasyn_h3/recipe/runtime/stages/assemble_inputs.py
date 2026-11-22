"""assemble_inputs: verify every DiT input and freeze the packed layout digest.

Checks the conditioning bundle ( self-check), the optional reference
latents (shapes vs. their frozen metadata), the plan sigma grid and
builds the packed sequence with the upstream builder; the ``packed`` document
records sizes and digests that ``denoise_av`` must reproduce.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from phasyn_h3.recipe.abi.stage import StageResult
from phasyn_h3.recipe.abi.tensors import verify_conditioning_bundle

from ..bundles import (
    load_bundle_manifest,
    read_bundle_metadata,
    resolve_payload,
    write_metadata_output,
)
from ..errors import EncoderContractMismatch, InvalidStageInput
from ..sigmas import load_sigma_grid
from .common import StageRun, task_of
from .layout import (
    build_packed,
    latent_dims,
    layout_digest,
    ordered_condition_blocks,
    tagged,
)
from .normalization import normalization_digest
from .tensor_io import load_tensors


def load_conditioning(run: StageRun) -> tuple[dict[str, Any], Path]:
    """Load the encoded conditioning required for this job."""
    item = run.require_input("conditioning")
    manifest = load_bundle_manifest(Path(item.path), conditioning=True)
    payload = resolve_payload(manifest, run.ctx.attachments)
    problems = verify_conditioning_bundle(
        manifest,
        payload.read_bytes(),
        max_tokens=int(run.policy.limits.get("encoder_max_tokens", 32768)),
    )
    if problems:
        raise EncoderContractMismatch("CONDITIONING_REJECTED", "; ".join(problems))
    return manifest, payload


def load_references(
    run: StageRun,
) -> tuple[dict[str, Any] | None, Path | None, dict[str, Any] | None]:
    """Load the reference blocks used in the packed sequence."""
    item = run.find_input("references")
    if item is None or item.path is None:
        return None, None, None
    manifest = load_bundle_manifest(Path(item.path))
    if manifest["kind"] != "reference_latents":
        raise InvalidStageInput(
            "REFERENCES_KIND", f"references bundle kind={manifest['kind']}"
        )
    if manifest["normalization_config_digest"] != normalization_digest(run.plan):
        raise InvalidStageInput(
            "REFERENCES_NORMALIZATION",
            "references 的 normalization_config_digest 與本環境不符",
        )
    payload = resolve_payload(manifest, run.ctx.attachments)
    metadata = read_bundle_metadata(payload, manifest)
    return manifest, payload, metadata


def run(run: StageRun) -> StageResult:
    """Assemble the encoded inputs into the packed transformer sequence."""
    task = task_of(run.plan)
    dims = latent_dims(run.geometry)
    conditioning, cond_payload = load_conditioning(run)
    references, _, ref_meta = load_references(run)
    if task in ("fl2va", "ref2va") and references is None:
        raise InvalidStageInput(
            "REFERENCES_REQUIRED", f"{task} 需要 encode_references 的輸出"
        )
    # assemble_inputs has no "sigmas" input in the integrated DAG; validate it
    # when present, otherwise record the plan's frozen digest (denoise_av checks it)
    sigmas_item = run.ctx.inputs.get("sigmas")
    sigmas_digest: str | None
    planned: int | None
    if sigmas_item is not None and sigmas_item.path is not None:
        grid = load_sigma_grid(Path(sigmas_item.path), run.plan.get("schedule") or {})
        sigmas_digest, planned = grid.sha256, grid.updates
    else:
        schedule = run.plan.get("schedule") or {}
        sigmas_digest, planned = (
            schedule.get("sigmas_digest"),
            schedule.get("planned_updates"),
        )
    adaln = run.read_json_input("adaln", required=False)
    if run.policy.adaln_mode != "off" and adaln is None:
        raise InvalidStageInput(
            "ADALN_INPUT_MISSING",
            f"adaln.mode={run.policy.adaln_mode} 需要 prepare_adaln 輸出",
        )
    residency = run.read_json_input("residency", required=False)
    blocks = ordered_condition_blocks(task, ref_meta)
    tags = load_tensors(cond_payload, ["text_token_tags"])["text_token_tags"]
    packed = build_packed(
        task,
        int(conditioning["text_len"]),
        dims,
        blocks,
        int(run.geometry["generated_frames"]),
    )
    digest = layout_digest(packed, tagged(packed, tags))
    cu = [int(v) for v in packed["cu_seqlens"].tolist()]
    document = {
        "schema_version": "1.0",
        "kind": "h3_packed_layout",
        "task": task,
        "seq_len": int(packed["seq_len"]),
        "used_len": cu[1],
        "text_len": int(conditioning["text_len"]),
        "latent": {
            "t": dims.latent_t,
            "h": dims.latent_h,
            "w": dims.latent_w,
            "audio_t": dims.audio_t,
        },
        "condition": {
            "keyframes": [int(b["frame_index"]) for b in blocks["keyframes"]],
            "ref2va_blocks": blocks["ref2va_blocks"],
            "visual_tensors": blocks["visual_tensors"],
            "audio_tensors": blocks["audio_tensors"],
        },
        "layout_digest": digest,
        "conditioning_payload": conditioning["payload"]["sha256"],
        "references_payload": None
        if references is None
        else references["payload"]["sha256"],
        "sigmas_digest": sigmas_digest,
        "planned_updates": planned,
        "adaln": None
        if adaln is None
        else {"mode": adaln.get("mode"), "cache_key": adaln.get("cache_key")},
        "residency": None
        if residency is None
        else {
            "component_key": residency.get("component_key"),
            "actor_instance_id": residency.get("actor_instance_id"),
        },
    }
    run.outputs.append(write_metadata_output(run.output_dir, "packed", document))
    run.fact(
        "PACKED_LAYOUT",
        {
            "seq_len": document["seq_len"],
            "used_len": document["used_len"],
            "digest": digest,
        },
    )
    return run.result()


__all__ = ["load_conditioning", "load_references", "run"]
