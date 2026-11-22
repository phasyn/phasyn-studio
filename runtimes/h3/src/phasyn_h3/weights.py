"""H3 元件的權重計畫：MiniMax-H3 variant 目錄與內建 LoRA 的固定版本檔案。.

每個 role 用到哪些 variant 目錄，與 SGLang 載入前的檢查相同（``providers._variant_dirs_sglang_checks``）：檢查的是整個
variant 目錄（model_index.json 列的每個元件都要在），所以計畫以整個 variant 目錄為單位；FL2VA 與 Ref2VA 內容相同的
檔案（一半以上）以 hard link 共用，不重複下載。AdaLN fixed 的 sidecar 要在 GPU 上計算、NF4 單檔 DiT 與沒有記錄來源的
LoRA 由使用者自己放好，這些只寫成說明。這裡不 import PyTorch。
"""

from __future__ import annotations

import functools
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.weights import (
    WeightFile,
    WeightLicense,
    WeightManifest,
    WeightPlan,
    WeightSet,
    identical_links,
    load_manifest,
)

from .config import VARIANT_DIR, merged_options
from .plan import BUNDLED_LORA_DIR, lora_manifest_candidates
from .providers import _variant_dirs_sglang_checks
from .recipe.adapter.constants import LICENSE_URL


MANIFEST_DIR = Path(__file__).resolve().parent / "weight_manifests"
H3_DIR = "MiniMax-H3"
H3_LICENSE_NAME = "MiniMax H3 Community License Agreement"
H3_LICENSE_NOTE = "適用地區不含歐盟、英國、韓國與美國；使用須遵守授權附件的 Acceptable Use Policy（見 THIRD_PARTY_NOTICES.md 3.1）"
# Where the bundled LoRA files sit in their repos. The bundled manifests record only where a file goes under the model
# root and are frozen into the DiT's load plan, so the source paths live here. Only files whose repo path was read from
# the repo's file tree are listed; the others are not downloadable.
LORA_SOURCE_PATHS: Mapping[str, str] = {
    "pai-h3-fl2va-acc8": "MiniMax-H3-FL2VA-Acc-8Step.safetensors",
    "pai-h3-ref2va-acc8": "MiniMax-H3-Ref2VA-Acc-8Step.safetensors",
}
NO_MODEL_PATH = "未設定 load.model_path（模型根目錄）"
NF4_NOTE = (
    "NF4 單檔 DiT（provider_options.transformer_file）由使用者提供，不在下載清單內"
)
SIDECAR_NOTE = (
    "AdaLN fixed 需要的 sidecar 要在 GPU 上用 phasyn-h3-adaln-sidecar 建立，不能下載"
)
LORA_SOURCE_UNKNOWN = "這個 LoRA 的來源路徑沒有記錄，不能下載：請自行把檔案放到 LoRA manifest 的 file.relative_path"
LORA_MANIFEST_MISSING = "找不到設定的 LoRA manifest，無法列出它的檔案"


@functools.cache
def h3_manifest() -> WeightManifest:
    """Read the manifest of the selected H3 model snapshot."""
    return load_manifest(MANIFEST_DIR / "minimax-h3.json")


@functools.cache
def variant_set(variant: str) -> WeightSet:
    """一個 variant 目錄的全部檔案（加上 repo 的 LICENSE 與 README），放在 ``<model_path>/MiniMax-H3/``。."""
    manifest = h3_manifest()
    own = f"{VARIANT_DIR[variant]}/"
    other = next(f"{VARIANT_DIR[name]}/" for name in VARIANT_DIR if name != variant)
    files = manifest.select(own, include=("LICENSE", "README.md"))
    links = identical_links(files, own, other, manifest.files)
    return WeightSet(
        set_id=f"minimax-h3-{variant}",
        label=f"MiniMax-H3 {VARIANT_DIR[variant]}",
        repo=manifest.repo,
        revision=manifest.revision,
        license=WeightLicense(
            name=H3_LICENSE_NAME, url=LICENSE_URL, note=H3_LICENSE_NOTE
        ),
        dest=H3_DIR,
        files=files,
        links={
            path: tuple(f"{H3_DIR}/{twin}" for twin in twins)
            for path, twins in links.items()
        },
    )


def _lora(options: Mapping[str, Any], model_root: Path) -> WeightSet | str | None:
    """設定的 LoRA：有記錄來源的內建 manifest → 權重組；其他 → 說明；沒有設定 LoRA → None。."""
    lora = options.get("lora") or {}
    manifest_path = lora.get("manifest_path") if isinstance(lora, Mapping) else None
    if not manifest_path:
        return None
    return _lora_entry(str(manifest_path), model_root)


def _loras(options: Mapping[str, Any], model_root: Path) -> list[WeightSet | str]:
    """``lora``（一個）或 ``loras``（串接，依序）的每個 LoRA：權重組或說明."""
    stack = options.get("loras")
    if isinstance(stack, list) and stack:
        return [
            _lora_entry(str(e["manifest_path"]), model_root)
            for e in stack
            if isinstance(e, Mapping) and e.get("manifest_path")
        ]
    one = _lora(options, model_root)
    return [] if one is None else [one]


def _lora_entry(manifest_path: str, model_root: Path) -> WeightSet | str:
    path = next(
        (
            c
            for c in lora_manifest_candidates(str(manifest_path), model_root=model_root)
            if c.is_file()
        ),
        None,
    )
    if path is None:
        return LORA_MANIFEST_MISSING
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        file = manifest["file"]
        lora_id = str(manifest["lora_id"])
    except (OSError, ValueError, KeyError, TypeError):
        return LORA_MANIFEST_MISSING
    source = LORA_SOURCE_PATHS.get(lora_id) if path.parent == BUNDLED_LORA_DIR else None
    if source is None:
        return LORA_SOURCE_UNKNOWN
    return WeightSet(
        set_id=f"lora-{lora_id}",
        label=f"LoRA {lora_id}",
        repo=str(manifest["source_repo"]),
        revision=str(manifest["source_revision"]),
        license=WeightLicense(
            name=H3_LICENSE_NAME, url=str(manifest["license_url"]), note=H3_LICENSE_NOTE
        ),
        dest="",
        files=(
            WeightFile(
                path=str(file["relative_path"]),
                size=int(file["size_bytes"]),
                sha256=str(file["sha256"]),
                source_path=source,
            ),
        ),
    )


def _add_loras(
    loras: list[WeightSet | str], sets: list[WeightSet], notes: list[str]
) -> None:
    for lora in loras:
        if isinstance(lora, WeightSet):
            if all(existing.set_id != lora.set_id for existing in sets):
                sets.append(lora)
        elif lora not in notes:
            notes.append(lora)


def plan(role: str, settings: Mapping[str, Any] | None) -> WeightPlan:
    """這個 role 在這組設定下需要的權重（providers.H3Provider.weights 在呼叫時才 import 這個模組）。."""
    load = (settings or {}).get("load") or {}
    root = load.get("model_path")
    if not root:
        return WeightPlan(root=None, notes=(NO_MODEL_PATH,))
    model_root = Path(str(root))
    _precision, _offload, options = merged_options(role, load)
    variant = str(options.get("variant") or "fl2va")
    shared = options.get("shared_from")
    names = {
        path.name: name
        for name, path in (
            (name, model_root / H3_DIR / folder) for name, folder in VARIANT_DIR.items()
        )
    }
    sets: list[WeightSet] = []
    notes: list[str] = []
    for variant_dir in _variant_dirs_sglang_checks(
        role, model_root, variant, shared, options
    ):
        name = names.get(variant_dir.name)
        if name is not None:
            sets.append(variant_set(name))
    if role == "dit":
        if options.get("transformer_file"):
            notes.append(NF4_NOTE)
        _add_loras(_loras(options, model_root), sets, notes)
        adaln = options.get("adaln") or {}
        if adaln.get("mode") == "fixed":
            cache_root = Path(
                str(options.get("adaln_cache_root") or model_root / "adaln-cache")
            )
            if not (cache_root / f"{adaln.get('cache_ref')}.safetensors").is_file():
                notes.append(SIDECAR_NOTE)
    return WeightPlan(root=str(model_root), sets=tuple(sets), notes=tuple(notes))


__all__ = ["LORA_SOURCE_PATHS", "h3_manifest", "plan", "variant_set"]
