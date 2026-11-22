"""Model manifests of a local MiniMax H3 snapshot (``<model root>/MiniMax-H3/<FL2VA|Ref2VA>/…``).

Layout: the pinned SGLang loader reads the native partition subfolder
(``default_model_subfolder = "FL2VA"``; fl2va -> ``FL2VA``, ref2va -> ``Ref2VA``) and
requires processor, text_encoder, tokenizer, video_vae, audio_vae and transformer
(SGR:runtime/pipelines/minimax_h3_pipeline.py:39-53,74-89).  The Diffusers root
layout (``transformer/``, ``vae/`` ...) is a different identity and is not used here.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_h3.recipe.abi.canonical import canonical_json_bytes

from . import constants


COMPONENT_KINDS = (
    "processor",
    "tokenizer",
    "text_encoder",
    "transformer",
    "video_vae",
    "audio_vae",
)

# metadata.total_size of the native index JSONs (identical for FL2VA and Ref2VA at H3@d21241f0):
# FL2VA|Ref2VA/text_encoder/model.safetensors.index.json, FL2VA|Ref2VA/transformer/model.safetensors.index.json.
# video_vae / audio_vae ship single model.safetensors files without an index -> null (unknown, not 0).
NATIVE_INDEX_TENSOR_BYTES: dict[str, int | None] = {
    "processor": None,
    "tokenizer": None,
    "text_encoder": constants.TEXT_INDEX_BYTES,
    "transformer": constants.DIT_INDEX_BYTES,
    "video_vae": None,
    "audio_vae": None,
}

_DIGEST = re.compile(r"^(sha256:)?[0-9a-f]{64}$")


def _component(
    model_id: str, kind: str, path: str, fmt: str, index_bytes: int | None
) -> dict[str, Any]:
    return {
        "component_id": f"{model_id}-{kind}",
        "kind": kind,
        "relative_path": path,
        "format": fmt,
        "index_tensor_bytes": index_bytes,
        "file_manifest": None,
        "config_digest": None,
        "verification": "not_downloaded",
    }


def content_revision(component_digests: Mapping[str, str]) -> str:
    """Content-derived 40-hex revision: sha256(canonical JSON of the digests)[:40].

    This is NOT an upstream git SHA; it only pins the exact local file set.
    """
    return hashlib.sha256(canonical_json_bytes(dict(component_digests))).hexdigest()[
        :40
    ]


def local_manifest(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
    variant: str,
    *,
    model_id: str | None = None,
    shared_from: str | None = None,
    transformer_file: str | None = None,
    transformer_digest: str | None = None,
    layout_root: str = "MiniMax-H3",
) -> dict[str, Any]:
    """Manifest for the pinned snapshot as it sits under ``<model root>/<layout_root>/``.

    * ``shared_from``: the other variant whose directory serves processor, tokenizer, text_encoder,
      video_vae and audio_vae.  At 42ed227e these five are byte-identical in FL2VA and Ref2VA (same
      LFS sha256 / git blob per file in the upstream snapshot listing), so FL2VA may reuse the Ref2VA
      download; only the transformer differs.
    * ``transformer_file`` (+ its sha256): a user-provided single-file DiT outside the snapshot (for
      example a bitsandbytes NF4 checkpoint); the revision is then content-derived from the snapshot
      revision and that file's digest (not an upstream git SHA).

    The source is recorded as ``local:...``: the files are the user's copy, never fetched by Phasyn Studio.
    """
    _check_variants(variant, shared_from)
    if (transformer_file is None) != (transformer_digest is None):
        raise ValueError("transformer_file and transformer_digest go together")
    if transformer_digest is not None and not _DIGEST.match(transformer_digest):
        raise ValueError("transformer_digest must be lower-case sha256 hex")
    if transformer_file is not None and (
        transformer_file.startswith("/") or ".." in Path(transformer_file).parts
    ):
        raise ValueError("transformer_file must be a path relative to the model root")
    root = layout_root.strip("/")

    def variant_dir(name: str) -> str:
        return (
            f"{root}/{constants.VARIANT_SUBFOLDER[name]}"
            if root
            else constants.VARIANT_SUBFOLDER[name]
        )

    own = variant_dir(variant)
    shared = variant_dir(shared_from) if shared_from else own
    snapshot = f"{constants.SOURCE_REPO}@{constants.SOURCE_REVISION}"
    if transformer_file is not None:
        if not (transformer_digest is not None):
            raise AssertionError
        suffix = "nf4dit" if "nf4" in Path(transformer_file).name.lower() else "dit"
        model_id = model_id or f"h3-{variant}-local-{suffix}"
        source_repo = f"local:{root or '.'} copy of {snapshot} + {transformer_file} (user-provided DiT)"
        revision = content_revision(
            {"snapshot": constants.SOURCE_REVISION, "transformer": transformer_digest}
        )
    else:
        model_id = model_id or f"h3-{variant}-local"
        source_repo = f"local:{root or '.'} copy of {snapshot}"
        revision = constants.SOURCE_REVISION
    components = []
    for kind in COMPONENT_KINDS:
        if kind == "transformer" and transformer_file is not None:
            components.append(
                _component(model_id, kind, transformer_file, "safetensors", None)
            )
            continue
        base = own if kind == "transformer" else shared
        components.append(
            _component(
                model_id,
                kind,
                f"{base}/{kind}",
                "hf_native",
                NATIVE_INDEX_TENSOR_BYTES[kind],
            )
        )
    return {
        "schema_version": "1.0",
        "model_id": model_id,
        "family": constants.FAMILY,
        "variant": variant,
        "source_repo": source_repo[:256],
        "source_revision": revision,
        "license_url": constants.LICENSE_URL,
        "license_digest": None,
        "components": components,
        "supported_tasks": list(constants.VARIANT_TASKS[variant]),
        "status": "registered",
        "is_fixture": False,
    }


__all__ = ["COMPONENT_KINDS", "content_revision", "local_manifest"]


def _check_variants(variant: str, shared_from: str | None) -> None:
    if variant not in constants.VARIANT_SUBFOLDER:
        raise ValueError(
            f"unknown MiniMax H3 variant {variant!r}; expected fl2va or ref2va"
        )
    if shared_from is not None and shared_from not in constants.VARIANT_SUBFOLDER:
        raise ValueError(
            f"unknown shared_from variant {shared_from!r}; expected fl2va or ref2va"
        )
