"""Torch-free part of ``qimg.vision``: settings/parameter schemas, option resolution, model checks, the path-free model identity and describe()."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components import model_identity as identity
from phasyn_components.errors import ComponentError
from phasyn_components.provider import Description, Part, Port, settings_schema
from phasyn_components.settings import normalize_recording

from .. import memory
from ..prompting.scene import SECTION_KEYS
from . import capacity
from .formats import OPS


PROVIDER_ID = "qimg.vision"
IMAGE = "media.image.v1"
PROMPT = "text.prompt.v1"
SCENE = "prompt.scene.v1"
COMPARISON = "prompt.comparison.v1"
PAIRWISE = "prompt.pairwise.v1"
RESULT = "prompt.vision.result.v1"
SUPPORTED_ARCHS = ("Qwen3VLForConditionalGeneration",)

OPTIONS: dict[str, dict[str, Any]] = {
    "attn_implementation": {"enum": ["sdpa", "eager"], "default": "sdpa"},
    "output_format": {
        "enum": ["compact", "full"],
        "default": "compact",
        "description": "compact\N{FULLWIDTH EQUALS SIGN}為 Qwen3-VL-4B 設計的扁平格式（inline evidence／扁平 metrics）；full\N{FULLWIDTH EQUALS SIGN}8B／32B 的完整 schema。明確選擇，不依模型大小自動切換",
    },
    "max_context_tokens": {
        "type": "integer",
        "minimum": 1024,
        "maximum": 16384,
        "default": 8192,
    },
    "max_new_tokens": {
        "type": "integer",
        "minimum": 512,
        "maximum": 4096,
        "default": 3072,
    },
    "caption_max_new_tokens": {
        "type": "integer",
        "minimum": 128,
        "maximum": 1024,
        "default": 768,
    },
    "min_pixels": {
        "type": "integer",
        "minimum": 1024,
        "maximum": 1048576,
        "default": 65536,
    },
    "max_pixels": {
        "type": "integer",
        "minimum": 1024,
        "maximum": 1048576,
        "default": 262144,
    },
    "capacity_check": {
        "enum": ["enforce", "report"],
        "default": "enforce",
        "description": "enforce\N{FULLWIDTH EQUALS SIGN}預檢放不下就在載入／生成前回明確錯誤；report\N{FULLWIDTH EQUALS SIGN}只回報照常執行",
    },
    "activation_reserve_bytes": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1 << 40,
        "default": capacity.DEFAULT_ACTIVATION_RESERVE_BYTES,
        "description": "activation 預留（預設 1 GiB 涵蓋 Qwen3-VL-4B 在預設 max_pixels 的峰值；8B／32B 或更大圖請自行量測）",
    },
    "reserve_bytes": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1 << 40,
        "default": capacity.DEFAULT_RESERVE_BYTES,
    },
    "memory_model": {
        "enum": list(memory.MEMORY_MODELS),
        "default": "auto",
        "description": "容量預檢的記憶體模型：auto\N{FULLWIDTH EQUALS SIGN}依 is_integrated 判斷（讀不到就不猜，需明確設定）；"
        "unified\N{FULLWIDTH EQUALS SIGN}整合／統一記憶體（UMA）GPU，可用\N{FULLWIDTH EQUALS SIGN}MemAvailable \N{MINUS SIGN} unified_reserve_bytes；"
        "discrete\N{FULLWIDTH EQUALS SIGN}獨立 GPU，可用\N{FULLWIDTH EQUALS SIGN}min(mem_get_info free, MemAvailable)（原規則）",
    },
    "unified_reserve_bytes": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1 << 40,
        "default": memory.DEFAULT_UNIFIED_RESERVE_BYTES,
        "description": "統一記憶體時從 MemAvailable 扣掉、留給 OS 與其他程序的量（預設 4 GiB 是保守設定，不是量測值）；"
        "獨立 GPU 不使用",
    },
}
CROP = {
    "type": "object",
    "properties": {
        "view_id": {"enum": ["v-crop-1", "v-crop-2"]},
        "x0": {"type": "number", "minimum": 0, "maximum": 1},
        "y0": {"type": "number", "minimum": 0, "maximum": 1},
        "x1": {"type": "number", "minimum": 0, "maximum": 1},
        "y1": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["view_id", "x0", "y0", "x1", "y1"],
    "additionalProperties": False,
}
PARAMS: dict[str, dict[str, Any]] = {
    "op": {"enum": list(OPS), "default": "caption"},
    "language": {"enum": ["en", "zh-TW"], "default": "zh-TW"},
    "instruction": {
        "type": "string",
        "maxLength": 2000,
        "default": "",
        "description": "revise：使用者的修訂指示（資料，不是系統指令）",
    },
    "intentional_changes": {
        "type": "array",
        "items": {"enum": list(SECTION_KEYS)},
        "maxItems": 8,
        "uniqueItems": True,
        "default": [],
        "description": "revise／compare／pairwise：凍結的有意修改（必須是鎖定區段）",
    },
    "crops": {
        "type": "array",
        "items": CROP,
        "maxItems": 2,
        "default": [],
        "description": "analyze／revise：原圖的局部視圖",
    },
}


def model_problem(model_path: str | None) -> str | None:
    """Describe a problem with the configured model, if any."""
    if not model_path:
        return "未設定 load.model_path（Qwen3-VL 權重目錄）"
    root = Path(model_path)
    cfg = root / "config.json"
    if not cfg.is_file():
        return f"找不到 {identity.display_path(cfg, root)}"
    try:
        cfg_doc = json.loads(cfg.read_text(encoding="utf-8"))
    except ValueError:
        return f"{identity.display_path(cfg, root)} 無法解析"
    archs = cfg_doc.get("architectures") or []
    # Qwen3-VL 2B／4B 的輸出層與詞嵌入共用（tie_word_embeddings），safetensors 裡沒有獨立的 lm_head
    tied = bool(
        cfg_doc.get("tie_word_embeddings")
        or (cfg_doc.get("text_config") or {}).get("tie_word_embeddings")
    )
    if not any(arch in SUPPORTED_ARCHS for arch in archs):
        return f"不支援的架構 {archs}（需要 {', '.join(SUPPORTED_ARCHS)}）"
    problem = _generation_head_problem(root, tied=tied)
    if problem is not None:
        return problem
    return _processor_problem(root)


def _processor_problem(root: Path) -> str | None:
    if not capacity.weight_files(root):
        return "目錄內沒有 safetensors 權重（不自動下載）"
    if not (
        (root / "preprocessor_config.json").is_file()
        or (root / "processor_config.json").is_file()
    ):
        return "缺少 processor 設定（preprocessor_config.json）"
    if not (
        (root / "tokenizer.json").is_file() or (root / "tokenizer.model").is_file()
    ):
        return "缺少 tokenizer"
    return None


def _generation_head_problem(root: Path, *, tied: bool) -> str | None:
    index = root / "model.safetensors.index.json"
    if index.is_file():
        try:
            weights = (
                json.loads(index.read_text(encoding="utf-8")).get("weight_map") or {}
            )
        except ValueError:
            return f"{identity.display_path(index, root)} 無法解析"
        has_head = any(str(key).endswith("lm_head.weight") for key in weights)
        has_embed = any(str(key).endswith("embed_tokens.weight") for key in weights)
        if not has_head and not (tied and has_embed):
            return "權重沒有 lm_head（也不是共用詞嵌入的 tie_word_embeddings），無法做文字生成"
    return None


def resolve_options(load: Mapping[str, Any]) -> dict[str, Any]:
    """provider_options 補齊明確預設值，並檢查跨欄位限制（不合法 → 422 UNSUPPORTED_SETTING）."""
    given = dict(load.get("provider_options") or {})
    options = {key: spec["default"] for key, spec in OPTIONS.items()} | given
    if int(options["min_pixels"]) > int(options["max_pixels"]):
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            "min_pixels 不可超過 max_pixels",
            details={"options": options},
        )
    longest = max(
        int(options["max_new_tokens"]), int(options["caption_max_new_tokens"])
    )
    if longest >= int(options["max_context_tokens"]):
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            "輸出上限必須小於 max_context_tokens（保留原生圖片與文字輸入空間）",
            details={"options": options},
        )
    precision = dict(load.get("precision") or {})
    if precision.get("compute_dtype", "bf16") != "bf16":
        raise ComponentError(
            "UNSUPPORTED_SETTING", "qimg.vision 只支援 bf16（不自動換精度）"
        )
    if ((precision.get("quantization") or {}).get("scheme") or "none") != "none":
        raise ComponentError(
            "UNSUPPORTED_SETTING", "qimg.vision 不支援量化（不自動降級）"
        )
    if ((load.get("offload") or {}).get("mode") or "none") != "none":
        raise ComponentError("UNSUPPORTED_SETTING", "qimg.vision 不支援 offload")
    options["memory_model"], options["unified_reserve_bytes"] = memory.parse_settings(
        options["memory_model"], options["unified_reserve_bytes"]
    )
    return options


def vision_settings_schema() -> dict[str, Any]:
    """Describe the supported vision provider settings."""
    return settings_schema(
        precision_properties={
            "compute_dtype": {"enum": ["bf16"]},
            "quantization": {
                "type": "object",
                "properties": {"scheme": {"enum": ["none"]}},
                "additionalProperties": False,
            },
        },
        offload_schema={
            "type": "object",
            "properties": {"mode": {"enum": ["none"]}},
            "additionalProperties": False,
        },
        provider_options=OPTIONS,
        invoke_properties=PARAMS,
        require_model_path=True,
        device_kinds=("cuda",),
    )


def model_identity(model_path: str) -> dict[str, Any]:
    """Path-free identity of the Qwen3-VL folder (``load.model_path`` is the model folder itself)."""
    root = Path(model_path)
    config = (root / "config.json").read_bytes()
    return identity.model_identity(
        root,
        {"model": root},
        architectures=json.loads(config).get("architectures"),
        config_json_sha256=hashlib.sha256(config).hexdigest(),
        weight_bytes=capacity.weight_bytes(root),
    )


def describe_vision(settings: Mapping[str, Any] | None) -> Description:
    """describe() of ``qimg.vision``; never imports torch/transformers."""
    reason = None
    code = None
    missing = [
        m
        for m in ("torch", "transformers", "PIL")
        if importlib.util.find_spec(m) is None
    ]
    if missing:
        reason, code = (
            f"此 runtime 沒有安裝 {', '.join(missing)}",
            "PROVIDER_NOT_INSTALLED",
        )
    elif settings is not None:
        reason = model_problem((settings.get("load") or {}).get("model_path"))
        code = "COMPONENT_NOT_CONFIGURED" if reason else None
    empty = {"type": "object", "properties": {}}
    return Description(
        provider_id=PROVIDER_ID,
        kind="image.vision",
        label="圖片反推（Qwen3-VL：caption／八區段分析／修訂／原圖與生成圖比較／A/B 比較）",
        inputs=[
            Port(
                "image",
                IMAGE,
                required=True,
                transport="file",
                description="v-full：原圖（研究來源；透明區以白底看）",
            ),
            Port(
                "generated",
                IMAGE,
                required=False,
                transport="file",
                description="compare：v-generated，生成圖（白底版）",
            ),
            Port(
                "candidate_a",
                IMAGE,
                required=False,
                transport="file",
                description="pairwise：v-A",
            ),
            Port(
                "candidate_b",
                IMAGE,
                required=False,
                transport="file",
                description="pairwise：v-B",
            ),
            Port(
                "caption",
                PROMPT,
                required=False,
                transport="inline",
                description="analyze：另一次 caption 的文字（假設，不是事實來源）",
            ),
            Port(
                "scene",
                SCENE,
                required=False,
                transport="inline",
                description="revise：目前場景；compare／pairwise：任務凍結的場景",
            ),
            Port(
                "comparison",
                COMPARISON,
                required=False,
                transport="inline",
                description="revise：要依據的比較結果（選用）",
            ),
        ],
        outputs=[
            Port(
                "result",
                RESULT,
                required=True,
                transport="inline",
                description="PromptVisionResult（結果、每次嘗試、provenance、容量預檢）",
            ),
            Port(
                "caption",
                PROMPT,
                required=False,
                transport="inline",
                description="op=caption：caption 文字",
            ),
            Port(
                "scene",
                SCENE,
                required=False,
                transport="inline",
                description="op=analyze／revise：PromptScene",
            ),
            Port(
                "comparison",
                COMPARISON,
                required=False,
                transport="inline",
                description="op=compare：PromptComparison",
            ),
            Port(
                "pairwise",
                PAIRWISE,
                required=False,
                transport="inline",
                description="op=pairwise：PromptPairwise",
            ),
        ],
        parts=[
            Part("vision.preprocess", "preprocess", empty, ["host_ms"], "full", None),
            Part(
                "vision_encoder",
                "vision",
                empty,
                ["host_ms"],
                "partial",
                "視覺塔時間計入 language_model 的 generate",
            ),
            Part(
                "language_model",
                "llm",
                empty,
                ["host_ms", "input_tokens", "output_tokens", "caption_ttft_ms"],
                "full",
                None,
            ),
            Part("vision.parse", "rules", empty, ["host_ms"], "full", None),
        ],
        settings_schema=vision_settings_schema(),
        parameters_schema={
            "type": "object",
            "properties": PARAMS,
            "additionalProperties": False,
        },
        default_settings={
            "load": {
                "model_path": "",
                "device": {
                    "kind": "cuda",
                    "id": "GPU-REPLACE",
                    "resource_group": "gpu",
                },
                "precision": {
                    "compute_dtype": "bf16",
                    "quantization": {"scheme": "none"},
                },
                "offload": {"mode": "none"},
                "part_overrides": [],
                "provider_options": {
                    key: spec["default"] for key, spec in OPTIONS.items()
                },
            },
            "invoke": {"op": "caption", "language": "zh-TW"},
            "recording": normalize_recording({"mode": "detailed"}),
        },
        available=reason is None
        or (settings is None and code != "PROVIDER_NOT_INSTALLED"),
        unavailable_code=code,
        unavailable_reason=reason,
        notes=[
            "提示詞模板與模型端 schema 是固定資料檔，以指紋鎖定",
            "沒有 JoyCaption（不同模型家族\N{FULLWIDTH EQUALS SIGN}不同 provider）；caption 也由 Qwen3-VL 執行",
        ],
    )


__all__ = [
    "OPTIONS",
    "PARAMS",
    "PROVIDER_ID",
    "describe_vision",
    "model_identity",
    "model_problem",
    "resolve_options",
    "vision_settings_schema",
]
