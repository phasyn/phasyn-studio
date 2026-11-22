"""The H3 weight plan: every role asks for the variant directories SGLang verifies,
whole and pinned; FL2VA and Ref2VA share their identical files through links; a bundled LoRA with a recorded source
is downloadable, the others and the GPU-built AdaLN sidecar are notes. Example components from examples/components;
no weights are read or downloaded.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from h3_examples import component
from phasyn_components.weights import WeightPlan

from phasyn_h3 import weights
from phasyn_h3.plan import BUNDLED_LORA_DIR
from phasyn_h3.providers import ConditioningProvider, DitProvider, VideoDecodeProvider
from phasyn_h3.recipe.adapter.constants import SOURCE_REPO, SOURCE_REVISION


def settings(component_id: str, root: Path, **options: Any) -> dict[str, Any]:
    out: dict[str, Any] = copy.deepcopy(component(component_id)["settings"])
    out["load"]["model_path"] = str(root)
    out["load"].setdefault("provider_options", {}).update(options)
    return out


def set_ids(plan: WeightPlan) -> list[str]:
    return [item.set_id for item in plan.sets]


@pytest.mark.static
def test_the_manifest_is_the_pinned_snapshot_with_complete_variant_dirs() -> None:
    manifest = weights.h3_manifest()
    assert (manifest.repo, manifest.revision) == (SOURCE_REPO, SOURCE_REVISION)
    by_variant = {
        name: {
            item.path.split("/", 1)[1]
            for item in manifest.files
            if item.path.startswith(f"{name}/")
        }
        for name in ("FL2VA", "Ref2VA")
    }
    assert (
        by_variant["FL2VA"] == by_variant["Ref2VA"] and len(by_variant["FL2VA"]) == 81
    )
    assert {
        "model_index.json",
        "transformer/config.json",
        "text_encoder/config.json",
    } <= by_variant["FL2VA"]
    assert all(item.sha256 or item.git_oid for item in manifest.files)


def test_variant_sets_link_only_identical_files() -> None:
    fl2va = weights.variant_set("fl2va")
    ref2va = weights.variant_set("ref2va")
    assert fl2va.dest == ref2va.dest == "MiniMax-H3"
    assert {"LICENSE", "README.md"} <= {item.path for item in fl2va.files}
    by_path = {item.path: item for item in weights.h3_manifest().files}
    assert len(fl2va.links) == len(ref2va.links) > 0
    for path, (twin,) in fl2va.links.items():
        assert (
            path.startswith("FL2VA/")
            and twin == f"MiniMax-H3/Ref2VA/{path.removeprefix('FL2VA/')}"
        )
        assert (
            by_path[path].identity == by_path[twin.removeprefix("MiniMax-H3/")].identity
        )
    # the DiT weights differ (only the transformer's config and shard index are the same)
    assert not any(
        path.startswith("FL2VA/transformer/") and path.endswith(".safetensors")
        for path in fl2va.links
    )
    assert "MiniMax H3 Community License" in fl2va.license.name and fl2va.license.note


def test_a_shared_text_encoder_needs_both_variant_dirs(tmp_path: Path) -> None:
    plan = ConditioningProvider.weights(settings("te-gpu0", tmp_path))
    assert plan.root == str(tmp_path)
    assert set_ids(plan) == ["minimax-h3-fl2va", "minimax-h3-ref2va"]
    assert plan.notes == ()
    # the example decoder reads its VAE from Ref2VA (shared_from), like SGLang's check of that directory
    decoder = VideoDecodeProvider.weights(settings("vae-gpu0", tmp_path))
    assert set_ids(decoder) == ["minimax-h3-ref2va"]
    own = VideoDecodeProvider.weights(settings("vae-gpu0", tmp_path, shared_from=None))
    assert set_ids(own) == ["minimax-h3-fl2va"]


@pytest.mark.static
def test_lora_sources_belong_to_bundled_manifests() -> None:
    for lora_id, source in weights.LORA_SOURCE_PATHS.items():
        manifest = json.loads(
            (BUNDLED_LORA_DIR / f"{lora_id}.json").read_text(encoding="utf-8")
        )
        assert manifest["lora_id"] == lora_id
        assert Path(manifest["file"]["relative_path"]).name == source


@pytest.mark.parametrize("load", [{}, {"model_path": ""}])
def test_without_a_model_root_there_is_nothing_to_download(
    load: dict[str, Any],
) -> None:
    plan = DitProvider.weights({"load": load})
    assert (plan.root, plan.sets, plan.notes) == (None, (), (weights.NO_MODEL_PATH,))
