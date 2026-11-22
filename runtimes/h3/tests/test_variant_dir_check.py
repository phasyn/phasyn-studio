"""A variant directory whose ``model_index.json`` names component directories that are not there is reported by describe
(``providers._missing_files``) instead of failing inside SGLang, at a load or in the middle of a job (``prepare_media``).

The layouts are synthetic: only the marker files the provider looks for, no weights.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from h3_examples import component

from phasyn_h3 import providers


MARKERS = {
    "text_encoder": "config.json",
    "tokenizer": "tokenizer_config.json",
    "processor": "preprocessor_config.json",
    "transformer": "config.json",
    "video_vae": "config.json",
    "audio_vae": "config.json",
}
INDEX: dict[str, Any] = {
    "_class_name": "MiniMaxH3Pipeline",
    "_diffusers_version": "0.37.0",
    **{name: ["library", "Class"] for name in MARKERS},
}
ROLES = {
    "te-gpu0": "conditioning",
    "venc-gpu0": "video_encode",
    "aenc-gpu1": "audio_encode",
    "vae-gpu0": "video_decode",
    "audio-gpu1": "audio_decode",
    "dit-fl2va-fp8-pai8": "dit",
    "dit-ref2va-fp8-pai8": "dit",
}


def snapshot(
    root: Path,
    variant: str,
    present: tuple[str, ...] = tuple(MARKERS),
    *,
    index: bool = True,
) -> None:
    base = root / "MiniMax-H3" / variant
    base.mkdir(parents=True, exist_ok=True)
    if index:
        (base / "model_index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    for sub in present:
        (base / sub).mkdir(exist_ok=True)
        (base / sub / MARKERS[sub]).write_text("{}", encoding="utf-8")


def settings(doc: dict[str, Any], root: Path) -> dict[str, Any]:
    out: dict[str, Any] = copy.deepcopy(doc["settings"])
    out["load"]["model_path"] = str(root)
    adaln = (out["load"].get("provider_options") or {}).get("adaln") or {}
    if adaln.get("mode") == "fixed":  # a fixed AdaLN DiT also needs its sidecar file
        sidecar = root / "adaln-cache" / f"{adaln['cache_ref']}.safetensors"
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_bytes(b"")
    return out


def reason(component_id: str, root: Path) -> str | None:
    return providers._missing_files(
        ROLES[component_id], settings(component(component_id), root)
    )


def test_a_text_encoder_node_with_a_partial_variant_dir_is_reported(
    tmp_path: Path,
) -> None:
    snapshot(tmp_path, "Ref2VA")
    snapshot(
        tmp_path, "FL2VA", ("tokenizer", "processor")
    )  # a text-encoder-only copy that stopped at the tokenizer
    text = reason("te-gpu0", tmp_path)
    assert text is not None
    assert (
        "MiniMax-H3/FL2VA" in text
        and "text_encoder、transformer、video_vae、audio_vae" in text
    )
    assert (
        str(tmp_path) not in text
    )  # paths in messages are relative to load.model_path
    assert "hard link" in text
