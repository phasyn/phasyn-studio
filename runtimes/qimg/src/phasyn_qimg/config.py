"""Settings and parameter schemas, model folder resolution and combination rules for phasyn_qimg (torch-free).

Rules: every strategy is an explicit setting or parameter,
never chosen automatically; an unsupported combination is a 422 (UNSUPPORTED_SETTING/INVALID_ARGUMENT), never a
silently changed value. Size, dtype and seed are decided by the caller and recorded as given.

Model location: ``load.model_path`` is the Phasyn Studio models root (as for H3) and
``load.provider_options.base`` a relative folder below it (default ``qwen-image-2.1``; same name and meaning as
for ``qimg.dit``) holding the diffusers layout (processor/text_encoder/vae/scheduler/transformer).
"""

from __future__ import annotations

import copy
import importlib.util
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any

from phasyn_components import contracts, upstream
from phasyn_components.errors import ComponentError
from phasyn_components.model_identity import display_path
from phasyn_components.provider import settings_schema
from phasyn_components.settings import normalize_recording

from . import SIZE_MULTIPLE


GIB = 1024**3
DEFAULT_BASE = "qwen-image-2.1"
# Libraries recorded in actual_settings of the Qwen-Image providers
QIMG_LIBRARIES = (
    "torch",
    "torchvision",
    "transformers",
    "tokenizers",
    "diffusers",
    "accelerate",
    "safetensors",
    "pillow",
    "numpy",
)
# Shown in describe() of every provider that loads Qwen-Image 2.1 weights (decision: mark research use)
RESEARCH_USE_NOTE = "研究用途：Qwen-Image 2.1 權重採 Qwen Research License（僅限非商業研究），不隨本專案散布"
SIZE_MIN = 256
SIZE_MAX = 2048
REFERENCE_RESOLUTION_MIN = 256
REFERENCE_RESOLUTION_MAX = 1536
MAX_REFERENCES = 4
COMPOSE_METADATA_MAX_BYTES = 64 * 1024

# 每個 provider 需要的模型子目錄（diffusers 版面）
MODEL_SUBDIRS: dict[str, tuple[str, ...]] = {
    "conditioning": ("text_encoder", "processor"),
    "vae_encode": ("vae",),
    "vae_decode": ("vae",),
}
# diffusers build with the QwenImage21 classes, pinned in deploy/runtimes/qimg-x86_64. Other builds (for example
# a PyPI diffusers pulled in by another runtime) are refused in describe() instead of failing at load time.
DIFFUSERS_COMMIT = "578c9b2c6636ab2424a0e56186268b83623656b2"
DIFFUSERS_ROLES = frozenset({"vae_encode", "vae_decode", "dit"})
# 各角色缺少時回報 PROVIDER_NOT_INSTALLED 的匯入名稱（只用 find_spec，不匯入）
RUNTIME_MODULES: dict[str, tuple[str, ...]] = {
    "prepare": ("PIL", "numpy"),
    "compose": ("PIL", "numpy", "torch", "safetensors"),
    "conditioning": ("torch", "transformers", "safetensors", "PIL", "numpy"),
    "vae_encode": ("torch", "diffusers", "safetensors", "numpy"),
    "vae_decode": ("torch", "diffusers", "safetensors", "PIL", "numpy"),
}

# ----------------------------------------------------------------------------- parameters
SIZE_SCHEMA: dict[str, Any] = {
    "type": "integer",
    "minimum": SIZE_MIN,
    "maximum": SIZE_MAX,
    "multipleOf": SIZE_MULTIPLE,
}
PREPARE_PARAMS: dict[str, Any] = {
    "width": {
        **SIZE_SCHEMA,
        "default": 1024,
        "description": "輸出寬（px，32 的倍數）：遮罩與合成底圖縮放到這個尺寸；DiT 的 width 必須相同",
    },
    "height": {
        **SIZE_SCHEMA,
        "default": 1024,
        "description": "輸出高（px，32 的倍數）",
    },
    "reference_resolution": {
        "type": "integer",
        "minimum": REFERENCE_RESOLUTION_MIN,
        "maximum": REFERENCE_RESOLUTION_MAX,
        "default": 1024,
        "description": "參考圖縮放到面積約 reference_resolution²、兩邊各取 32 的倍數（保持比例；同一次縮放給 TE 與 VAE）",
    },
    "base_index": {
        "type": ["integer", "null"],
        "minimum": 0,
        "maximum": MAX_REFERENCES - 1,
        "default": 0,
        "description": "遮罩合成的底圖是第幾張參考圖（0 起）；null\N{FULLWIDTH EQUALS SIGN}沒有底圖（此時不能接遮罩）",
    },
    "mask_invert": {
        "type": "boolean",
        "default": False,
        "description": "反轉遮罩（白\N{FULLWIDTH EQUALS SIGN}重新生成、黑\N{FULLWIDTH EQUALS SIGN}保留底圖）",
    },
}
CONDITIONING_PARAMS: dict[str, Any] = {
    "cfg": {
        "type": "boolean",
        "default": False,
        "description": "true\N{FULLWIDTH EQUALS SIGN}同時編碼 negative_prompt（空白時以單一空白字元編碼）。必須與 DiT 的 guidance > 1 一致，DiT 會檢查",
    },
}
VAE_ENCODE_PARAMS: dict[str, Any] = {
    "tiling": {
        "type": "boolean",
        "default": False,
        "description": "VAE 分塊 encode（diffusers 預設 tile 256／stride 192）；不會依尺寸自動切換",
    },
}
VAE_DECODE_PARAMS: dict[str, Any] = {
    "mode": {
        "enum": ["full", "tiled"],
        "default": "full",
        "description": "full\N{FULLWIDTH EQUALS SIGN}完整解碼（峰值記憶體隨輸出尺寸增加）；tiled\N{FULLWIDTH EQUALS SIGN}分塊解碼（較省記憶體，可能出現接縫）。不會依尺寸自動切換",
    },
}
COMPOSE_PARAMS: dict[str, Any] = {
    "metadata": {
        "type": ["object", "null"],
        "default": None,
        "description": "額外寫進 PNG tEXt phasyn 的請求資訊（例如 prompt、Studio 鏡頭／take）；canonical JSON ≤ 64 KiB",
    },
}
PARAMS_BY_ROLE: dict[str, dict[str, Any]] = {
    "prepare": PREPARE_PARAMS,
    "conditioning": CONDITIONING_PARAMS,
    "vae_encode": VAE_ENCODE_PARAMS,
    "vae_decode": VAE_DECODE_PARAMS,
    "compose": COMPOSE_PARAMS,
}


def parameters_schema(role: str) -> dict[str, Any]:
    """Describe accepted invocation parameters."""
    return {
        "type": "object",
        "properties": copy.deepcopy(PARAMS_BY_ROLE[role]),
        "additionalProperties": False,
    }


def resolve_params(role: str, parameters: Mapping[str, Any]) -> dict[str, Any]:
    """Schema 預設值疊上本次參數，並以 parameters_schema 驗證（未宣告或不合法 → 422）."""
    props = PARAMS_BY_ROLE[role]
    merged = {name: copy.deepcopy(spec.get("default")) for name, spec in props.items()}
    merged.update(dict(parameters))
    contracts.validate_with_schema(
        parameters_schema(role), merged, code="INVALID_ARGUMENT", what=f"{role} 參數"
    )
    return merged


# ----------------------------------------------------------------------------- settings
def _base_schema() -> dict[str, Any]:
    return {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096,
        "pattern": r"^(?!/)(?!.*(^|/)\.\.(/|$)).+",
        "description": "Qwen-Image 2.1 pipeline 目錄（diffusers 版面；相對 load.model_path）。不可是絕對路徑或含 ..",
    }


def offload_schema(role: str) -> dict[str, Any]:
    modes = ["none", "sequential"] if role == "conditioning" else ["none"]
    return {
        "type": "object",
        "properties": {
            "mode": {
                "enum": modes,
                "description": "none\N{FULLWIDTH EQUALS SIGN}整個模組一起搬；sequential\N{FULLWIDTH EQUALS SIGN}accelerate cpu_offload（權重留在 host，逐子模組上 GPU）",
            },
            "after_use": {
                "enum": ["keep", "host"],
                "description": "兩次呼叫之間權重的位置：keep\N{FULLWIDTH EQUALS SIGN}留在裝置上；host\N{FULLWIDTH EQUALS SIGN}回到主記憶體（下次呼叫再搬上 GPU）",
            },
            "pinned": {
                "type": "boolean",
                "description": "after_use=host 時 host 權重用 pinned memory（H2D 較快；占用不可換頁的主記憶體）",
            },
        },
        "required": ["mode", "after_use"],
        "additionalProperties": False,
    }


def build_settings_schema(role: str) -> dict[str, Any]:
    """Describe the allowed component settings."""
    if role in ("prepare", "compose"):
        return settings_schema(
            invoke_properties=PARAMS_BY_ROLE[role], device_kinds=("cpu",)
        )
    dtypes = ["bf16"] if role == "conditioning" else ["bf16", "fp32"]
    return settings_schema(
        precision_properties={
            "compute_dtype": {
                "enum": dtypes,
                "description": "權重與運算 dtype（不自動降精度；VAE 的原生權重是 FP32，bf16 較省記憶體）",
            }
        },
        offload_schema=offload_schema(role),
        provider_options={
            "base": _base_schema(),
            **(
                {
                    "encoding_cache_mib": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 16384,
                        "default": 0,
                        "description": "此元件在 Node 的前置編碼快取容量（MiB），0 表示停用。",
                    }
                }
                if role in ("conditioning", "vae_encode")
                else {}
            ),
        },
        invoke_properties=PARAMS_BY_ROLE[role],
        require_model_path=True,
        device_kinds=("cuda", "cpu"),
    )


def default_settings(role: str) -> dict[str, Any]:
    """Build the default component settings."""
    recording = normalize_recording({"mode": "detailed"})
    if role in ("prepare", "compose"):
        group = "cpu-qimg-prepare" if role == "prepare" else "cpu-image-compose"
        return {
            "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": group}},
            "invoke": {},
            "recording": recording,
        }
    offload = (
        {"mode": "sequential", "after_use": "host"}
        if role == "conditioning"
        else {"mode": "none", "after_use": "host", "pinned": True}
    )
    return {
        "load": {
            "model_path": "",
            "device": {"kind": "cuda", "id": "GPU-REPLACE", "resource_group": "gpu"},
            "precision": {"compute_dtype": "bf16"},
            "offload": offload,
            "part_overrides": [],
            "provider_options": {"base": DEFAULT_BASE},
        },
        "invoke": {},
        "recording": recording,
    }


def diffusers_problem() -> str | None:
    """None when the installed diffusers is the pinned QwenImage21 build; reads package metadata only (no import)."""
    problem = upstream.distribution_problem("diffusers", vcs_commit=DIFFUSERS_COMMIT)
    if problem is None:
        return None
    return f"此 runtime 的 diffusers 沒有 qimg 需要的 QwenImage21（{problem}）；請使用 qimg-x86_64 runtime 環境"


def runtime_problem(role: str) -> str | None:
    """Return the runtime dependency problem, if any."""
    missing = [
        name for name in RUNTIME_MODULES[role] if importlib.util.find_spec(name) is None
    ]
    if missing:
        return f"此 runtime 沒有安裝 {', '.join(missing)}（qimg 元件需要 qimg-x86_64 之類的 GPU runtime 環境）"
    return diffusers_problem() if role in DIFFUSERS_ROLES else None


def model_root(load: Mapping[str, Any]) -> Path:
    """``load.model_path``: the models root every relative model path is resolved against."""
    root = str(load.get("model_path") or "")
    if not root:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED", "未設定 load.model_path（models 根目錄）"
        )
    return Path(root)


def model_dir(load: Mapping[str, Any]) -> Path:
    """Models root + relative ``base``; absolute paths and ``..`` are rejected (stay inside the root)."""
    root = model_root(load)
    rel = str((load.get("provider_options") or {}).get("base") or DEFAULT_BASE)
    pure = PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts or not pure.parts:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            f"provider_options.base 必須是相對目錄（收到 {rel!r}）",
        )
    return root / rel


def model_problem(role: str, settings: Mapping[str, Any] | None) -> str | None:
    """describe() 用：模型檔是否就位（只看檔案是否存在，不載入）."""
    if settings is None or role not in MODEL_SUBDIRS:
        return None
    load = settings.get("load") or {}
    try:
        base = model_dir(load)
    except ComponentError as exc:
        return exc.message
    root = model_root(load)
    if not base.is_dir():
        return f"模型目錄不存在：{display_path(base, root)}；權重未就位或路徑錯誤（不自動下載）"
    for sub in MODEL_SUBDIRS[role]:
        path = base / sub
        markers = ("config.json", "preprocessor_config.json", "tokenizer_config.json")
        if not any((path / m).is_file() for m in markers):
            return (
                f"缺少 {sub}：{display_path(path, root)}；找不到 config／processor 設定"
            )
    return None


def check_load(role: str, load: Mapping[str, Any]) -> dict[str, Any]:
    """組合規則（schema 擋不住的部分）→ 正規化後的 offload；不支援 → UNSUPPORTED_SETTING."""
    device = load.get("device") or {}
    kind = device.get("kind")
    if role in ("prepare", "compose"):
        if kind != "cpu":
            raise ComponentError("UNSUPPORTED_SETTING", f"{role} 只在 CPU 執行")
        return {}
    offload = dict(load.get("offload") or {})
    mode = offload.get("mode", "none")
    after_use = offload.get("after_use", "keep")
    pinned = bool(offload.get("pinned", False))
    if kind == "cpu" and (mode != "none" or after_use != "keep" or pinned):
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            "CPU 裝置只支援 offload {mode: none, after_use: keep}（權重本來就在主記憶體）",
            details={"offload": offload},
        )
    if mode == "sequential":
        if kind != "cuda":
            raise ComponentError(
                "UNSUPPORTED_SETTING", "offload.mode=sequential 需要 CUDA 裝置"
            )
        if after_use != "host":
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "offload.mode=sequential 的權重一律留在 host；after_use 必須是 host（不默默改成別的意思）",
            )
        if pinned:
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "offload.pinned 只用於 mode=none\N{FULLWIDTH PLUS SIGN}after_use=host",
            )
    if pinned and after_use != "host":
        raise ComponentError(
            "UNSUPPORTED_SETTING", "offload.pinned 只用於 after_use=host"
        )
    return {"mode": mode, "after_use": after_use, "pinned": pinned}


def compute_dtype_name(load: Mapping[str, Any]) -> str:
    """Return the configured computation dtype name."""
    return str((load.get("precision") or {}).get("compute_dtype") or "bf16")


def check_output_size(width: int, height: int) -> None:
    """Validate the requested image dimensions."""
    for name, value in (("width", width), ("height", height)):
        _check_dimension(name, value)


def _check_dimension(name: str, value: object) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ComponentError("INVALID_ARGUMENT", f"{name} 必須是整數")
    if not SIZE_MIN <= value <= SIZE_MAX or value % SIZE_MULTIPLE:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"{name}={value} 不合法：需要 {SIZE_MIN}\N{EN DASH}{SIZE_MAX} 且是 {SIZE_MULTIPLE} 的倍數"
            "（Qwen-Image 2.1 一個影像 slot\N{FULLWIDTH EQUALS SIGN}2×2 latent token\N{FULLWIDTH EQUALS SIGN}32 px；不自動取整）",
        )


__all__ = [
    "COMPOSE_METADATA_MAX_BYTES",
    "DEFAULT_BASE",
    "DIFFUSERS_COMMIT",
    "GIB",
    "MAX_REFERENCES",
    "MODEL_SUBDIRS",
    "PARAMS_BY_ROLE",
    "QIMG_LIBRARIES",
    "RESEARCH_USE_NOTE",
    "build_settings_schema",
    "check_load",
    "check_output_size",
    "compute_dtype_name",
    "default_settings",
    "diffusers_problem",
    "model_dir",
    "model_problem",
    "model_root",
    "parameters_schema",
    "resolve_params",
    "runtime_problem",
]
