"""The Qwen-Image weight plans: text conditioning, the VAEs and the DiT share one
pinned Qwen-Image 2.1 directory; a custom base, GGUF files, adapters and overrides are notes; qimg.vision gets the
pinned Qwen3-VL-4B-Instruct at its model path. No weights are read or downloaded."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from phasyn_qimg import weights
from phasyn_qimg.conditioning import ConditioningProvider
from phasyn_qimg.config import DEFAULT_BASE, RESEARCH_USE_NOTE
from phasyn_qimg.dit.provider import QimgDitProvider
from phasyn_qimg.vae import VaeDecodeProvider, VaeEncodeProvider
from phasyn_qimg.vision.provider import QwenVisionProvider


def settings(root: Path | None, **options: Any) -> dict[str, Any]:
    load: dict[str, Any] = {"provider_options": options}
    if root is not None:
        load["model_path"] = str(root)
    return {"load": load}


@pytest.mark.static
def test_the_image_set_is_the_pinned_full_pipeline_directory() -> None:
    image = weights.image_set()
    assert (image.set_id, image.dest, image.repo) == ("qwen-image-2.1", DEFAULT_BASE, "Qwen/Qwen-Image-2.1")
    paths = {item.path for item in image.files}
    assert {"model_index.json", "LICENSE"} <= paths
    for sub in ("transformer/", "text_encoder/", "vae/", "scheduler/"):
        assert any(path.startswith(sub) for path in paths), sub
    assert image.license.name == "Qwen Research License Agreement"
    assert image.license.note == RESEARCH_USE_NOTE
    assert image.license.url.endswith(f"{image.revision}/LICENSE")


def test_every_image_role_shares_the_same_directory(tmp_path: Path) -> None:
    for provider in (ConditioningProvider, VaeEncodeProvider, VaeDecodeProvider, QimgDitProvider):
        plan = provider.weights(settings(tmp_path))
        assert plan.root == str(tmp_path)
        assert [item.set_id for item in plan.sets] == ["qwen-image-2.1"], provider.__name__
        assert plan.notes == ()


def test_a_custom_base_has_no_pinned_source(tmp_path: Path) -> None:
    plan = ConditioningProvider.weights(settings(tmp_path, base="my-model"))
    assert (plan.root, plan.sets, plan.notes) == (str(tmp_path), (), (weights.CUSTOM_BASE_NOTE,))
    escaping = ConditioningProvider.weights(settings(tmp_path, base="../elsewhere"))
    assert escaping.sets == () and len(escaping.notes) == 1


def test_without_a_model_root_there_is_nothing_to_download() -> None:
    plan = ConditioningProvider.weights(settings(None))
    assert plan.root is None and plan.sets == () and len(plan.notes) == 1
    vision = QwenVisionProvider.weights(settings(None))
    assert (vision.root, vision.sets, vision.notes) == (None, (), (weights.NO_VISION_PATH,))
