"""Qwen-Image 元件的權重計畫：Qwen-Image 2.1 pipeline 目錄與 Qwen3-VL-4B-Instruct。

文字條件、VAE 與 DiT 共用同一個 Qwen-Image 2.1 目錄（``<model_path>/<base>``），計畫以整個目錄為單位；``base`` 不是
內建的 qwen-image-2.1 時沒有固定版本的來源。GGUF 檔、LoRA／slider 與覆寫的 Transformer 由使用者提供，只寫成說明。
影像理解（qimg.vision）的 ``load.model_path`` 就是 Qwen3-VL 目錄本身。這裡不 import PyTorch。
"""

from __future__ import annotations

import functools
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.weights import WeightLicense, WeightManifest, WeightPlan, WeightSet, load_manifest

from .config import DEFAULT_BASE, RESEARCH_USE_NOTE, model_dir

MANIFEST_DIR = Path(__file__).resolve().parent / "weight_manifests"
CUSTOM_BASE_NOTE = "provider_options.base 不是 qwen-image-2.1：沒有固定版本的下載來源，請自行放好權重"
GGUF_NOTE = "GGUF 檔（provider_options.gguf_file）由使用者提供，不在下載清單內"
ADAPTERS_NOTE = "LoRA／slider（provider_options.adapters）由使用者提供，不在下載清單內"
OVERRIDE_NOTE = "覆寫的 Transformer 目錄（provider_options.transformer_override）由使用者提供，不在下載清單內"
NO_VISION_PATH = "未設定 load.model_path（Qwen3-VL 權重目錄）"


@functools.cache
def _manifest(name: str) -> WeightManifest:
    return load_manifest(MANIFEST_DIR / f"{name}.json")


@functools.cache
def image_set(base: str = DEFAULT_BASE) -> WeightSet:
    """Qwen-Image 2.1 的完整 pipeline 目錄（transformer、text_encoder、processor、vae、scheduler…），放在 ``base``。"""
    manifest = _manifest("qwen-image-2.1")
    return WeightSet(
        set_id="qwen-image-2.1",
        label="Qwen-Image 2.1",
        repo=manifest.repo,
        revision=manifest.revision,
        license=WeightLicense(
            name="Qwen Research License Agreement",
            url=f"https://huggingface.co/{manifest.repo}/blob/{manifest.revision}/LICENSE",
            note=RESEARCH_USE_NOTE,
        ),
        dest=base,
        files=manifest.files,
    )


@functools.cache
def vision_set() -> WeightSet:
    """Qwen3-VL-4B-Instruct（範例設定 qimg-vision-* 用的模型），放在 ``load.model_path`` 本身。"""
    manifest = _manifest("qwen3-vl-4b-instruct")
    return WeightSet(
        set_id="qwen3-vl-4b-instruct",
        label="Qwen3-VL-4B-Instruct",
        repo=manifest.repo,
        revision=manifest.revision,
        license=WeightLicense(name="Apache-2.0", url="https://www.apache.org/licenses/LICENSE-2.0"),
        dest="",
        files=manifest.files,
    )


def image_plan(role: str, settings: Mapping[str, Any] | None) -> WeightPlan:
    """文字條件、VAE encode／decode 與 DiT 的計畫。"""
    load = (settings or {}).get("load") or {}
    try:
        base = model_dir(load)
    except ComponentError as exc:  # model_path 沒設定，或 base 不是相對目錄
        root = load.get("model_path")
        return WeightPlan(root=str(root) if root else None, notes=(exc.message,))
    root = str(load["model_path"])
    rel = base.relative_to(Path(root)).as_posix()
    sets = (image_set(rel),) if rel == DEFAULT_BASE else ()
    notes: list[str] = [] if sets else [CUSTOM_BASE_NOTE]
    if role == "dit":
        options = load.get("provider_options") or {}
        if options.get("variant") == "gguf_q4km" or options.get("gguf_file"):
            notes.append(GGUF_NOTE)
        if options.get("adapters"):
            notes.append(ADAPTERS_NOTE)
        if options.get("transformer_override"):
            notes.append(OVERRIDE_NOTE)
    return WeightPlan(root=root, sets=sets, notes=tuple(notes))


def vision_plan(settings: Mapping[str, Any] | None) -> WeightPlan:
    """qimg.vision：Qwen3-VL-4B-Instruct 放在 ``load.model_path``。"""
    root = ((settings or {}).get("load") or {}).get("model_path")
    if not root:
        return WeightPlan(root=None, notes=(NO_VISION_PATH,))
    return WeightPlan(root=str(root), sets=(vision_set(),))


__all__ = ["image_plan", "image_set", "vision_plan", "vision_set"]
