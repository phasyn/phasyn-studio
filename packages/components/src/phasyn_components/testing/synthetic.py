"""Synthetic final latent (a test fixture; everything is ``synthetic=true``).

Its decoder, ``test.synthetic_decode``, lives in :mod:`phasyn_media.testing.synthetic_decode` (it
needs FFmpeg); both together verify the preview/final pipeline:

They verify the "same-source preview -> final" pipeline on a CPU, without a GPU or a real decoder:
the latent blob and manifest are written once with their SHA-256; both decode runs read the same
source; the preview keeps every frame, the FPS, PTS and aspect ratio and only downsizes after RGB;
a bounded frame queue (at most 4 chunks) back-pressures the producer; ``complete=true`` is reported
only after the FFmpeg flush and a probe confirm the frame count. Never use them to claim anything
about a model's quality or speed. Registered only when test providers are enabled (see
:mod:`phasyn_components.testing`).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .. import SCHEMA_VERSION
from ..canonical import canonical_json, sha256_hex
from ..errors import ComponentError
from ..ids import new_id
from ..provider import BaseProvider, Description, Port, RunContext, settings_schema
from ..recorder.metrics import metric
from ..settings import normalize_recording

LATENT_SPACE = "test.synthetic-rgbdiv8.v1"
BINDING = "test.synthetic.identity.v1"
MANIFEST_MEDIA_TYPE = "application/vnd.phasyn.latent-manifest+json"
SPATIAL = 8

LATENT_PARAMS: dict[str, dict[str, Any]] = {
    "frames": {"type": "integer", "minimum": 1, "maximum": 2048, "default": 49},
    "width": {"type": "integer", "minimum": 16, "maximum": 4096, "default": 256},
    "height": {"type": "integer", "minimum": 16, "maximum": 4096, "default": 144},
    "fps_num": {"type": "integer", "minimum": 1, "maximum": 240000, "default": 24},
    "fps_den": {"type": "integer", "minimum": 1, "maximum": 1001, "default": 1},
    "channels": {"type": "integer", "minimum": 3, "maximum": 64, "default": 4},
    "seed": {"type": "integer", "minimum": 0, "default": 0},
}


def write_latent_manifest(
    ctx: RunContext,
    *,
    tensor: Any,
    latent_space_id: str,
    layout: str,
    dtype: str,
    target: Mapping[str, Any],
    generator_identity: Mapping[str, Any],
    binding: Mapping[str, Any],
    domain: str,
    raw_bytes: bytes | None = None,
    blob_media_type: str = "application/octet-stream",
    extra_metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """寫 final latent：blob 寫入時算 SHA 一次；manifest canonical bytes 另算 SHA。回傳主檔 TypedValue。"""
    blob = ctx.new_file(
        None,
        blob_media_type,
        {
            "role": "final_latent_blob",
            "dtype": dtype,
            "layout": layout,
            "shape": list(tensor.shape) if hasattr(tensor, "shape") else None,
        },
        type_id="file.attachment.v1",
    )
    blob.write(raw_bytes if raw_bytes is not None else tensor.tobytes())
    blob.finish()
    latent_id = new_id()
    blob_ref = {
        "node_id": node_id_of(ctx),
        "file_id": blob.file_id,
        "size_bytes": blob.size,
        "sha256": blob.sha256,
        "media_type": blob_media_type,
        "metadata": {},
    }
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "latent_id": latent_id,
        "stage": "final",
        "latent_space_id": latent_space_id,
        "tensor": {
            "key": "latent",
            "shape": [int(x) for x in tensor.shape],
            "dtype": dtype,
            "layout": layout,
            "domain": domain,
        },
        "target": dict(target),
        "blob": blob_ref,
        "generation_run_id": ctx.run_id or new_id(),
        "generator_identity": dict(generator_identity),
        "binding": dict(binding),
    }
    data = canonical_json(manifest)
    out = ctx.new_file(
        "video_latent",
        MANIFEST_MEDIA_TYPE,
        {
            "latent_id": latent_id,
            "latent_space_id": latent_space_id,
            "shape": manifest["tensor"]["shape"],
            "dtype": dtype,
            "layout": layout,
            "manifest_sha256": sha256_hex(data),
            "links": {"blob": blob_ref},
            **dict(extra_metadata or {}),
        },
    )
    out.write(data)
    ctx.set_file_output("video_latent", out)
    return manifest


def node_id_of(ctx: RunContext) -> str:
    return str(ctx.recorder.node_id)


def read_latent_input(ctx: RunContext, port: str = "latent") -> tuple[dict[str, Any], str, Path, dict[str, Any]]:
    """讀 final latent 輸入：回傳 (manifest, manifest_sha256, blob_path, latent_ref)。

    來源身分檢查：manifest 內 blob 的 SHA 必須等於實際附檔 FileRef 的 SHA；否則 LATENT_SOURCE_MISMATCH。
    """
    item = ctx.input(port)
    if item.file is None or item.path is None:
        raise ComponentError("INVALID_ARGUMENT", f"{port} 需要 final latent manifest 檔")
    data = item.path.read_bytes()
    manifest_sha = hashlib.sha256(data).hexdigest()
    try:
        manifest = json.loads(data)
    except ValueError as exc:
        raise ComponentError("LATENT_MISMATCH", f"latent manifest 不是有效 JSON：{exc}") from exc
    if manifest.get("stage") != "final":
        raise ComponentError("LATENT_MISMATCH", "輸入不是 final latent manifest")
    link = item.links.get("blob")
    if link is None:
        raise ComponentError("LATENT_SOURCE_MISMATCH", "latent manifest 沒有附帶 blob 檔")
    blob_ref, blob_path = link
    declared = manifest.get("blob") or {}
    if declared.get("sha256") != blob_ref.get("sha256") or declared.get("file_id") != blob_ref.get("file_id"):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            "manifest 宣告的 blob 與實際附檔不同（同源 final 不可誤用另一份 latent）",
            details={"manifest_blob_sha256": declared.get("sha256"), "linked_blob_sha256": blob_ref.get("sha256")},
        )
    latent_ref = {
        "latent_id": manifest.get("latent_id"),
        "blob_sha256": blob_ref.get("sha256"),
        "manifest_sha256": manifest_sha,
        "manifest_file": dict(item.file),
    }
    ctx.recorder.transfer(
        "disk_read",
        direction="DISK_IN",
        submitted_bytes=len(data),
        byte_basis="logical_file",
        owner="consumer",
        src=f"file:{item.file.get('file_id')}",
        dst="process",
        src_memory_kind="disk",
        dst_memory_kind="host",
    )
    return manifest, manifest_sha, blob_path, latent_ref


class SyntheticLatentProvider(BaseProvider):
    provider_id = "test.synthetic_latent"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return Description(
            provider_id=cls.provider_id,
            kind="test.synthetic_latent",
            label="合成 final latent（test fixture；不是 DiT）",
            inputs=[Port("prompt", "text.prompt.v1", False, "inline", "只記錄於 context，不影響內容")],
            outputs=[Port("video_latent", "video.final-latent.v1", True, "file", "合成 latent manifest（附 blob）")],
            settings_schema=settings_schema(invoke_properties=LATENT_PARAMS, device_kinds=("cpu",)),
            parameters_schema={"type": "object", "properties": LATENT_PARAMS, "additionalProperties": False},
            default_settings={
                "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-fixture"}},
                "invoke": {},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            synthetic=True,
        )

    def invoke(self, ctx: RunContext) -> None:
        import numpy as np

        p: dict[str, Any] = {k: v.get("default") for k, v in LATENT_PARAMS.items()} | dict(ctx.parameters)
        width, height, frames = int(p["width"]), int(p["height"]), int(p["frames"])
        if width % (2 * SPATIAL) or height % (2 * SPATIAL):
            raise ComponentError("INVALID_ARGUMENT", f"合成 latent 的寬高需為 {2 * SPATIAL} 的倍數（不偷偷裁切）")
        rng = np.random.default_rng(int(p["seed"]))
        shape = (1, int(p["channels"]), frames, height // SPATIAL, width // SPATIAL)
        with ctx.recorder.span("synthetic.generate", part="synthetic.latent"):
            base = rng.standard_normal(shape, dtype=np.float32)
            ramp = np.linspace(-1.0, 1.0, frames, dtype=np.float32).reshape(1, 1, frames, 1, 1)
            tensor = (base * 0.35 + ramp).astype("<f2")
        write_latent_manifest(
            ctx,
            tensor=tensor,
            latent_space_id=LATENT_SPACE,
            layout="BCTHW",
            dtype="F16",
            target={
                "width": width,
                "height": height,
                "frames": frames,
                "fps": {"num": int(p["fps_num"]), "den": int(p["fps_den"])},
            },
            generator_identity={"provider_id": self.provider_id, "synthetic": True, "seed": int(p["seed"])},
            binding={"binding_id": BINDING, "spatial_factor": SPATIAL, "temporal_factor": 1},
            domain="test.synthetic",
        )
        ctx.recorder.put_metric(
            "output_frame_count",
            metric("output_frame_count", None, quality="not_applicable", reason="latent 尚未解碼成影格"),
        )


__all__ = [
    "BINDING",
    "LATENT_SPACE",
    "MANIFEST_MEDIA_TYPE",
    "SPATIAL",
    "SyntheticLatentProvider",
    "node_id_of",
    "read_latent_input",
    "write_latent_manifest",
]
