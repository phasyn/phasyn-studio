"""Model identity v2: relative paths only, path_stat counts, small-file hashes, no absolute path anywhere."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from phasyn_components import model_identity as mi


def _model_dir(root: Path) -> Path:
    vae = root / "qwen-image-2.1" / "vae"
    vae.mkdir(parents=True)
    (vae / "config.json").write_text('{"z_dim": 16}', encoding="utf-8")
    (vae / "diffusion_pytorch_model.safetensors").write_bytes(b"\0" * 64)
    return vae


def test_location_is_relative_inside_root_and_basename_elsewhere(
    tmp_path: Path,
) -> None:
    root = tmp_path / "models"
    assert mi.location(root / "qwen-image-2.1" / "vae", root) == {
        "path": "qwen-image-2.1/vae"
    }
    assert mi.location(root, root) == {"name": "models"}
    assert mi.location(tmp_path / "elsewhere" / "coeffs.json", root) == {
        "name": "coeffs.json"
    }
    assert mi.location(root / "x.gguf", None) == {"name": "x.gguf"}
    assert mi.display_path(root / "a" / "b", root) == f"a/b{mi.RELATIVE_NOTE}"
    assert mi.display_path(tmp_path / "other.json", root) == "other.json"


def test_model_identity_never_contains_absolute_paths(tmp_path: Path) -> None:
    root = tmp_path / "models"
    vae = _model_dir(root)
    identity = mi.model_identity(
        root, {"vae": vae, "outside": tmp_path / "lora.safetensors"}, variant="bf16"
    )
    assert identity["path_base"] == mi.PATH_BASE and identity["variant"] == "bf16"
    assert identity["identity_strength"] == "path_stat+config_sha256"
    assert identity["components"]["outside"]["name"] == "lora.safetensors"
    assert str(tmp_path) not in json.dumps(identity)
    assert (
        mi.model_identity(root, {}, hash_configs=False)["identity_strength"]
        == "path_stat"
    )
    with pytest.raises(TypeError, match="must not be paths"):
        mi.model_identity(root, {}, model_dir=root)


def test_model_identity_rejects_absolute_path_strings_at_any_depth(
    tmp_path: Path,
) -> None:
    root = tmp_path / "models"
    for facts in (
        {"model_path": str(root)},
        {"adapters": [{"name": "a", "path": "/srv/models/a.safetensors"}]},
        {"override": "C:\\models\\x"},
    ):
        with pytest.raises(TypeError, match="must not be paths"):
            mi.model_identity(root, {}, **facts)
    relative: dict[str, Any] = {
        "base": "qwen-image-2.1",
        "adapters": [{"path": "loras/a.safetensors"}],
        "kind": "a:b",
        "url": "https://x",
    }
    assert mi.model_identity(root, {}, **relative)["base"] == "qwen-image-2.1"
