"""Pinned upstream MiniMax H3 configs read from the user's own snapshot (``reference_json``) and the LoRA manifest
lookup (``lora_manifest_candidates`` / ``lora_binding``). Synthetic files only; nothing is downloaded."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from phasyn_components.errors import ComponentError

from phasyn_h3.plan import LORA_MANIFEST_DIRS_ENV, lora_binding
from phasyn_h3.recipe.abi.canonical import sha256_hex
from phasyn_h3.recipe.runtime import checkpoint_inspect
from phasyn_h3.recipe.runtime.checkpoint_inspect import reference_json
from phasyn_h3.recipe.runtime.errors import IntegrityMismatch, ModelFilesMissing


CONFIG = json.dumps({"_class_name": "SyntheticConfig", "num_layers": 2}).encode()


@pytest.fixture
def pinned(monkeypatch: pytest.MonkeyPatch) -> None:
    """One synthetic reference file with two candidate locations, pinned to CONFIG's sha256."""
    files = {"synthetic.json": (("A/config.json", "B/config.json"), sha256_hex(CONFIG))}
    monkeypatch.setattr(checkpoint_inspect, "REFERENCE_FILES", files)


def write(root: Path, relative: str, data: bytes) -> None:
    path = root / checkpoint_inspect.REFERENCE_LAYOUT_ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


@pytest.mark.usefixtures("pinned")
def test_a_hash_mismatch_never_falls_through_to_another_candidate(
    tmp_path: Path,
) -> None:
    write(tmp_path, "A/config.json", CONFIG + b"\n")  # first candidate edited
    write(
        tmp_path, "B/config.json", CONFIG
    )  # a valid copy exists further down the list
    with pytest.raises(IntegrityMismatch) as err:
        reference_json("synthetic.json", model_root=tmp_path)
    assert (
        err.value.reason_code == "REFERENCE_CONFIG_MISMATCH"
        and err.value.expected == sha256_hex(CONFIG)
    )
    assert (
        "MiniMax-H3/A/config.json" in err.value.message
        and str(tmp_path) not in err.value.message
    )


@pytest.mark.usefixtures("pinned")
def test_missing_configs_are_named_relative_to_the_model_root(tmp_path: Path) -> None:
    with pytest.raises(ModelFilesMissing) as err:
        reference_json("synthetic.json", model_root=tmp_path)
    assert (err.value.reason_code, err.value.error_code) == (
        "REFERENCE_CONFIG_MISSING",
        "COMPONENT_NOT_CONFIGURED",
    )
    assert (
        "MiniMax-H3/A/config.json" in err.value.message
        and "MiniMax-H3/B/config.json" in err.value.message
    )
    assert str(tmp_path) not in err.value.message
    with pytest.raises(KeyError):
        reference_json("unknown.json", model_root=tmp_path)


@pytest.mark.static
def test_the_shipped_pins_are_relative_paths_with_a_sha256() -> None:
    for candidates, digest in checkpoint_inspect.REFERENCE_FILES.values():
        assert re.fullmatch(r"[0-9a-f]{64}", digest) and candidates
        assert all(
            not Path(c).is_absolute() and ".." not in Path(c).parts for c in candidates
        )


def test_lora_binding_uses_the_first_manifest_found_and_checks_the_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(LORA_MANIFEST_DIRS_ENV, raising=False)
    root = tmp_path / "models"
    weights = root / "loras" / "synthetic.safetensors"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"0" * 16)

    def manifest(lora_id: str) -> str:
        file = {"relative_path": "loras/synthetic.safetensors", "size_bytes": 16}
        return json.dumps(
            {"lora_id": lora_id, "source_revision": "synthetic", "file": file}
        )

    (root / "m.json").write_text(manifest("from-model-root"))
    (root / "loras" / "m.json").write_text(manifest("from-loras"))
    binding, verified = lora_binding("m.json", scale=0.5, model_root=root)
    assert (binding["lora_id"], binding["scale"], verified["status"]) == (
        "from-model-root",
        0.5,
        "verified",
    )
    (root / "m.json").unlink()
    assert (
        lora_binding("m.json", scale=1.0, model_root=root)[0]["lora_id"] == "from-loras"
    )

    with pytest.raises(ComponentError) as err:
        lora_binding("missing.json", scale=1.0, model_root=root)
    assert (
        err.value.code == "COMPONENT_NOT_CONFIGURED"
        and str(tmp_path) not in err.value.message
    )
    weights.write_bytes(b"0" * 15)  # not the size the manifest promises
    with pytest.raises(ComponentError) as err:
        lora_binding("m.json", scale=1.0, model_root=root)
    assert (
        err.value.code == "MODEL_INCOMPATIBLE"
        and str(tmp_path) not in err.value.message
    )
    (root / "loras" / "m.json").write_text("{not json")
    with pytest.raises(ComponentError) as err:
        lora_binding("m.json", scale=1.0, model_root=root)
    assert (
        err.value.code == "COMPONENT_NOT_CONFIGURED"
        and str(tmp_path) not in err.value.message
    )
