"""舊 recipe 的 tensor bundle（manifest JSON\N{FULLWIDTH PLUS SIGN}payload safetensors）與 4.0 FileRef／FinalLatentManifest 的轉換.

payload 的 SHA-256 由舊 bundle writer 寫入 manifest 時算過一次；這裡直接採用（同 filesystem rename，
不再讀回）。consumer 端以 manifest 宣告的 artifact_id 對應本機 payload，舊 recipe 會自行驗證。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.canonical import canonical_json, sha256_hex
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.provider import InputValue, OutputFile, RunContext


BUNDLE_MEDIA_TYPE = "application/vnd.phasyn.h3-bundle+json"
LATENT_MANIFEST_MEDIA_TYPE = "application/vnd.phasyn.latent-manifest+json"
SAFETENSORS = "application/x-safetensors"
VIDEO_LATENT_SPACE = "minimax-h3.video-vae.v1"
AUDIO_LATENT_SPACE = "minimax-h3.audio-vae.v1"
BINDING_ID = "phasyn_h3.target_latents.v1"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_bytes())
    except (OSError, ValueError) as exc:
        raise ComponentError(
            "RUNTIME_ERROR", f"無法讀取 recipe 輸出 {path.name}：{exc}"
        ) from exc
    if not isinstance(doc, dict):
        raise ComponentError("RUNTIME_ERROR", f"{path.name} 不是 JSON object")
    return doc


def adopt_payload(
    ctx: RunContext, path: Path, payload_ref: Mapping[str, Any], *, role: str
) -> OutputFile:
    """Register the existing payload as a stage output."""
    out = ctx.new_file(
        None,
        str(payload_ref.get("media_type") or SAFETENSORS),
        {"role": role},
        type_id="file.attachment.v1",
    )
    out.adopt_file(
        path, sha256=str(payload_ref["sha256"]), size=int(payload_ref["size_bytes"])
    )
    return out


def publish_bundle(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    ctx: RunContext,
    *,
    port: str,
    type_id: str,
    manifest_path: Path,
    payload_path: Path,
    kind: str,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """舊 (manifest, payload) → 4.0 主檔 FileRef（metadata.links.payload）."""
    doc = _read_json(manifest_path)
    payload_ref = doc.get("payload") or {}
    if not payload_ref.get("sha256"):
        raise ComponentError("RUNTIME_ERROR", f"{manifest_path.name} 沒有 payload 參照")
    payload = adopt_payload(ctx, payload_path, payload_ref, role=f"{kind}.payload")
    out = ctx.new_file(
        port,
        BUNDLE_MEDIA_TYPE,
        {
            "kind": kind,
            "links": {"payload": ctx.file_ref(payload)},
            **dict(extra or {}),
        },
        type_id=type_id,
    )
    out.write(manifest_path.read_bytes())
    ctx.set_file_output(port, out)
    return doc


def materialize_bundle(
    item: InputValue, *, port: str
) -> tuple[Path, dict[str, Path], dict[str, Any]]:
    """4.0 bundle 輸入 → (manifest 路徑, 舊 attachments, manifest doc)；payload 身分不符時拒絕."""
    manifest_path = item.require_path(port)
    doc = _read_json(manifest_path)
    link = item.links.get("payload")
    if link is None:
        raise ComponentError("INVALID_ARGUMENT", f"{port} 缺少 payload 附檔")
    ref, path = link
    declared = doc.get("payload") or {}
    if declared.get("sha256") != ref.get("sha256"):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"{port} 的 payload 與 manifest 宣告不同",
            details={
                "manifest_sha256": declared.get("sha256"),
                "linked_sha256": ref.get("sha256"),
            },
        )
    return manifest_path, {str(declared["artifact_id"]): path}, doc


def publish_final_latents(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    ctx: RunContext,
    *,
    manifest_path: Path,
    payload_path: Path,
    job: Mapping[str, Any],
    plan: Mapping[str, Any],
    generator_identity: Mapping[str, Any],
) -> dict[str, Any]:
    """target_latents bundle → video.final-latent.v1 與 audio.final-latent.v1（兩份 manifest 共用同一 blob）."""
    bundle = _read_json(manifest_path)
    payload_ref = bundle.get("payload") or {}
    blob = adopt_payload(ctx, payload_path, payload_ref, role="final_latent_blob")
    blob_ref = ctx.file_ref(blob)
    bundle_out = ctx.new_file(
        None,
        BUNDLE_MEDIA_TYPE,
        {"kind": "target_latents"},
        type_id="file.attachment.v1",
    )
    bundle_out.write(manifest_path.read_bytes())
    bundle_out.finish()
    bundle_ref = ctx.file_ref(bundle_out)
    tensors = {str(t.get("name")): t for t in bundle.get("tensors") or []}
    geometry = plan["geometry"]
    target = {
        "width": int(geometry["width"]),
        "height": int(geometry["height"]),
        "frames": int(geometry["generated_frames"]),
        "fps": {
            "num": int(geometry.get("fps_numerator") or 24),
            "den": int(geometry.get("fps_denominator") or 1),
        },
    }
    run_id = ctx.run_id or new_id()
    binding_common = {
        "binding_id": BINDING_ID,
        "bundle": bundle_ref,
        "normalization_config_digest": bundle.get("normalization_config_digest"),
        "plan_digest": bundle.get("plan_digest"),
        "model_digest": bundle.get("model_digest"),
        "job": dict(job),
        "geometry": dict(geometry),
        "schedule": {
            k: plan["schedule"].get(k)
            for k in (
                "steps",
                "planned_updates",
                "video_shift",
                "audio_shift",
                "sigmas_digest",
            )
            if k in plan["schedule"]
        },
        "seed": (plan.get("requested") or {}).get("sampling", {}).get("seed"),
    }
    manifests: dict[str, Any] = {}
    for port, key, layout, space, domain in (
        (
            "video_latent",
            "video_latent",
            "BCTHW",
            VIDEO_LATENT_SPACE,
            "minimax_h3.video_vae.normalized",
        ),
        (
            "audio_latent",
            "audio_latent",
            "BCTD",
            AUDIO_LATENT_SPACE,
            "minimax_h3.audio_vae.normalized",
        ),
    ):
        spec = tensors.get(key)
        if spec is None:
            raise ComponentError("RUNTIME_ERROR", f"target_latents 缺少 {key}")
        manifest: dict[str, Any] = {
            "schema_version": "4.0",
            "latent_id": new_id(),
            "stage": "final",
            "latent_space_id": space,
            "tensor": {
                "key": key,
                "shape": [int(x) for x in spec.get("shape") or []],
                "dtype": str(spec.get("dtype", "F32")),
                "layout": layout,
                "domain": domain,
            },
            "target": target,
            "blob": blob_ref,
            "generation_run_id": run_id,
            "generator_identity": dict(generator_identity),
            "binding": binding_common,
        }
        contracts.validate(
            "FinalLatentManifest",
            manifest,
            code="RUNTIME_ERROR",
            what="final latent manifest",
        )
        data = canonical_json(manifest)
        out = ctx.new_file(
            port,
            LATENT_MANIFEST_MEDIA_TYPE,
            {
                "latent_id": manifest["latent_id"],
                "latent_space_id": space,
                "shape": manifest["tensor"]["shape"],
                "dtype": manifest["tensor"]["dtype"],
                "layout": layout,
                "manifest_sha256": sha256_hex(data),
                "links": {"blob": blob_ref, "bundle": bundle_ref},
            },
        )
        out.write(data)
        ctx.set_file_output(port, out)
        manifests[port] = manifest
    return manifests


def read_final_latent(
    ctx: RunContext, *, port: str, expect_space: str
) -> tuple[dict[str, Any], dict[str, Any], Path, dict[str, Path]]:
    """Final latent 輸入 → (manifest, LatentRef, 舊 bundle manifest 路徑, 舊 attachments).

    同源檢查：manifest 宣告的 blob、附檔 blob 與舊 bundle 的 payload 三者 SHA 必須一致；latent space
    不符直接拒絕（不 reshape、不猜 normalization）。原 blob 只讀，不 in-place cast。
    """
    item = ctx.input(port)
    manifest_path = item.require_path(port)
    data = manifest_path.read_bytes()
    try:
        manifest = json.loads(data)
    except ValueError as exc:
        raise ComponentError(
            "LATENT_MISMATCH", f"latent manifest 不是有效 JSON：{exc}"
        ) from exc
    contracts.validate(
        "FinalLatentManifest",
        manifest,
        code="LATENT_MISMATCH",
        what="final latent manifest",
    )
    if manifest["latent_space_id"] != expect_space:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"此解碼器需要 {expect_space}，輸入是 {manifest['latent_space_id']}",
        )
    blob_link = item.links.get("blob")
    bundle_link = item.links.get("bundle")
    if blob_link is None or bundle_link is None:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH", "latent manifest 缺少 blob／bundle 附檔"
        )
    blob_ref, blob_path = blob_link
    if (
        blob_ref.get("sha256") != manifest["blob"]["sha256"]
        or blob_ref.get("file_id") != manifest["blob"]["file_id"]
    ):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            "附檔 blob 與 manifest 宣告的來源不同（不可誤用另一份 latent）",
        )
    _bundle_ref, bundle_path = bundle_link
    bundle = _read_json(bundle_path)
    payload = bundle.get("payload") or {}
    if payload.get("sha256") != blob_ref.get("sha256"):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH", "舊 bundle 的 payload 與 blob 不同"
        )
    latent_ref = {
        "latent_id": manifest["latent_id"],
        "blob_sha256": blob_ref["sha256"],
        "manifest_sha256": sha256_hex(data),
        "manifest_file": dict(item.file or {}),
    }
    return manifest, latent_ref, bundle_path, {str(payload["artifact_id"]): blob_path}


__all__ = [
    "AUDIO_LATENT_SPACE",
    "BUNDLE_MEDIA_TYPE",
    "LATENT_MANIFEST_MEDIA_TYPE",
    "VIDEO_LATENT_SPACE",
    "adopt_payload",
    "materialize_bundle",
    "publish_bundle",
    "publish_final_latents",
    "read_final_latent",
]
