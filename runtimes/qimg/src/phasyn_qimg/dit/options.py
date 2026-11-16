"""Settings/parameter schema, defaults and semantic checks for ``qimg.dit`` (torch-free; shared by
describe() and load()/invoke()).

- The two variants are two different components: ``bf16`` (native BF16 transformer; placement is an
  explicit ``phase``/``group_stream``/``none``; LoRA/slider adapters and a transformer override are allowed)
  and ``gguf_q4km`` (GGUF Q4_K_M weights with BF16 compute; placement ``gguf_phase`` only; no adapters or
  override). ``gguf_q4km`` has no default weights file: ``provider_options.gguf_file`` is required.
- No automatic strategy selection: placement, pinning and preview mode are explicit settings or
  parameters; an infeasible combination is a 422, never a silent substitution.
- Every path is relative to ``load.model_path`` (the models root, as for H3); absolute paths and ``..``
  are rejected (symlinks inside the root are fine).
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.model_identity import display_path
from phasyn_components.provider import settings_schema
from phasyn_components.settings import normalize_recording

from .. import memory
from ..latents import latent_hw

PROVIDER_ID = "qimg.dit"
KIND = "dit.denoise"
CONDITIONING_TYPE = "qimg.conditioning.v1"
REF_LATENTS_TYPE = "qimg.ref_latents.v1"
LATENT_TYPE = "qimg.latent.v1"
CONDITIONING_KIND = "qimg_conditioning"
REF_LATENTS_KIND = "qimg_ref_latents"
LATENT_KIND = "qimg_latent"

VARIANTS = ("bf16", "gguf_q4km")
PLACEMENTS: dict[str, tuple[str, ...]] = {"bf16": ("phase", "group_stream", "none"), "gguf_q4km": ("gguf_phase",)}
ALL_PLACEMENTS = ("phase", "group_stream", "none", "gguf_phase")
PIN_MODES = ("static", "dynamic")
PREVIEW_MODES = ("off", "vae_thumbnail", "linear_fit")
ADAPTER_KINDS = ("lora", "slider")
MAX_ADAPTERS = 8
SEED_MAX = 2_147_483_647  # signed int32 maximum
DEFAULT_BASE = "qwen-image-2.1"
TRANSFORMER_CLASS = "QwenImage21Transformer2DModel"
GGUF_KERNEL_ENV = "DIFFUSERS_GGUF_CUDA_KERNELS"

PREVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "mode": {
            "enum": list(PREVIEW_MODES),
            "description": "off＝不產生預覽；vae_thumbnail＝CPU FP32 VAE 解碼縮小的 x0 估計（元件 load 時需 preview_vae=true）；"
            "linear_fit＝以我們自己擬合的 64→3 係數投影（係數檔不存在時 422）",
        },
        "every": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "每幾步一張（第 1 步與最後一步一定有）",
        },
        "max_side": {"type": "integer", "minimum": 256, "maximum": 512, "description": "預覽最長邊（px）"},
    },
    "additionalProperties": False,
}
PREVIEW_DEFAULT: dict[str, Any] = {"mode": "off", "every": 1, "max_side": 256}

PARAMS: dict[str, dict[str, Any]] = {
    "width": {
        "type": "integer",
        "minimum": 256,
        "maximum": 2048,
        "multipleOf": 32,
        "default": 1024,
        "description": "輸出寬（px）；Qwen-Image 2.1 一個 VLM 影像槽＝2×2 latent token，pipeline 對齊 32，不暗中縮放",
    },
    "height": {
        "type": "integer",
        "minimum": 256,
        "maximum": 2048,
        "multipleOf": 32,
        "default": 1024,
        "description": "輸出高（px；32 的倍數）",
    },
    "steps": {"type": "integer", "minimum": 2, "maximum": 100, "default": 40, "description": "取樣步數（至少 2）"},
    "guidance": {
        "type": "number",
        "minimum": 0,
        "maximum": 20,
        "default": 1.0,
        "description": "true_cfg_scale：≤1 不使用 CFG；>1 用 neg + s·(cond−neg)，需要 conditioning 以 cfg=true 編碼負向，每步 forward 加倍",
    },
    "sigma_schedule": {
        "enum": ["native", "karras", "exponential"],
        "default": "native",
        "description": "非 native 屬實驗選項，品質不保證較好",
    },
    "flow_shift_mu": {
        "anyOf": [{"type": "null"}, {"type": "number", "minimum": -1, "maximum": 3}],
        "default": None,
        "description": "null＝依解析度自動 μ（pipeline 原生）；數值＝固定 exp(μ) shift（關閉 dynamic shifting，保留 terminal stretch）",
    },
    "seed": {
        "type": "integer",
        "minimum": 0,
        "maximum": SEED_MAX,
        "description": "CPU torch.Generator 種子（必填；−1 由呼叫端先解析成實際值並記錄）",
    },
    "preview": {**copy.deepcopy(PREVIEW_SCHEMA), "default": dict(PREVIEW_DEFAULT)},
}
INVOKE_DEFAULTS: dict[str, Any] = {
    "width": 1024,
    "height": 1024,
    "steps": 40,
    "guidance": 1.0,
    "sigma_schedule": "native",
    "flow_shift_mu": None,
    "preview": dict(PREVIEW_DEFAULT),
}


def _rel_path_schema(description: str, *, nullable: bool, suffix: str | None = None) -> dict[str, Any]:
    pattern = r"^(?!/)(?!.*(^|/)\.\.(/|$)).+" + (re.escape(suffix) + "$" if suffix else "")
    string = {"type": "string", "minLength": 1, "maxLength": 4096, "pattern": pattern, "description": description}
    if not nullable:
        return string
    return {"anyOf": [{"type": "null"}, string], "description": description}


ADAPTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "pattern": r"^[A-Za-z0-9_-]{1,64}$", "description": "adapter 名稱（唯一）"},
        "path": _rel_path_schema("LoRA／slider safetensors（相對 model_path）", nullable=False, suffix=".safetensors"),
        "scale": {"type": "number", "minimum": -5, "maximum": 5, "description": "權重（slider 可為負）"},
        "kind": {"enum": list(ADAPTER_KINDS), "description": "lora 或 slider（只是標示；載入方式相同）"},
    },
    "required": ["name", "path", "scale"],
    "additionalProperties": False,
}

PROVIDER_OPTIONS: dict[str, Any] = {
    "variant": {
        "enum": list(VARIANTS),
        "description": "bf16＝原生 BF16 Transformer；gguf_q4km＝GGUF Q4_K_M 量化權重（BF16 運算）。兩者是不同元件",
    },
    "base": _rel_path_schema(
        "Qwen-Image 2.1 pipeline 目錄（含 transformer／vae／text_encoder／scheduler；相對 model_path）", nullable=False
    ),
    "gguf_file": _rel_path_schema(
        "gguf_q4km 的 Transformer GGUF 檔（相對 model_path；variant=gguf_q4km 時必填，沒有預設值）",
        nullable=True,
        suffix=".gguf",
    ),
    "transformer_override": _rel_path_schema(
        "（bf16）覆寫 Transformer 目錄（recipe；相對 model_path）；載入前檢查類別與 ABI", nullable=True
    ),
    "adapters": {
        "type": "array",
        "items": ADAPTER_SCHEMA,
        "maxItems": MAX_ADAPTERS,
        "description": "（bf16）LoRA／slider，依序載入後以各自 scale 啟用",
    },
    "preview_vae": {
        "type": "boolean",
        "description": "load 時載入一份 CPU FP32 VAE 供 vae_thumbnail 預覽（佔主記憶體；量測值記在 load 紀錄）",
    },
    "preview_coefficients": {
        "anyOf": [{"type": "null"}, {"type": "string", "minLength": 1, "maxLength": 4096}],
        "description": "linear_fit 係數 JSON（null＝套件內建檔；相對路徑以 model_path 為根）。由 fit_preview_coefficients.py 從我們自己的輸出擬合",
    },
    "memory_model": {
        "enum": list(memory.MEMORY_MODELS),
        "description": "VRAM 准入的記憶體模型：auto＝依 is_integrated 判斷（讀不到就不猜，需明確設定）；"
        "unified＝整合／統一記憶體（UMA）GPU，可用＝MemAvailable − unified_reserve_bytes；"
        "discrete＝獨立 GPU，可用＝mem_get_info free（原規則）",
    },
    "unified_reserve_bytes": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1 << 40,
        "description": "統一記憶體時從 MemAvailable 扣掉、留給 OS 與其他程序的量（預設 4 GiB 是保守設定，不是量測值）；"
        "獨立 GPU 不使用",
    },
}

OFFLOAD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "mode": {
            "enum": list(ALL_PLACEMENTS),
            "description": "placement：phase＝每次呼叫前整個 Transformer 移入 GPU、結束移回 CPU；group_stream＝逐 block 串流"
            "（record_stream）；none＝常駐 GPU；gguf_phase＝GGUF 版的 phase",
        },
        "pin_memory": {
            "enum": list(PIN_MODES),
            "description": "group_stream 專用：static＝load 時建立整份 pinned 副本（需通過 RAM 檢查）；dynamic＝每次搬運時暫時 pin",
        },
    },
    "required": ["mode"],
    "additionalProperties": False,
}

PRECISION_PROPERTIES: dict[str, Any] = {
    "compute_dtype": {"enum": ["bf16"], "description": "DiT 運算 dtype（兩個 variant 都是 BF16）"},
}
PRECISION_UNAVAILABLE = {
    "weight_format": "由 provider_options.variant 決定：bf16＝原生 BF16 safetensors；gguf_q4km＝GGUF Q4_K_M（packed，BF16 運算）",
    "weight_dtype": "由 variant 決定；實際參數 dtype 分布記在 load observed.parameter_dtypes",
    "quantization": "不提供線上量化；GGUF 量化由 variant=gguf_q4km 的檔案決定",
    "autocast_dtype": "不使用 autocast",
    "accumulation_dtype": "kernel 累加精度無法由此 backend 控制或證明",
    "matmul_tf32": "BF16 運算不涉及 TF32；observed 記錄實際旗標",
    "cudnn_tf32": "不使用 cuDNN 卷積",
    "reduced_precision_reduction": "此 backend 不提供設定；observed 記錄實際旗標",
    "output_dtype": "latent 依契約固定 BF16（qimg.latent.v1）",
}


def _conditional_rules() -> list[dict[str, Any]]:
    gguf = {
        "properties": {
            "provider_options": {"properties": {"variant": {"const": "gguf_q4km"}}, "required": ["variant"]}
        },
        "required": ["provider_options"],
    }
    stream = {
        "properties": {"offload": {"properties": {"mode": {"const": "group_stream"}}, "required": ["mode"]}},
        "required": ["offload"],
    }
    return [
        {
            "if": gguf,
            "then": {
                "properties": {
                    "offload": {"properties": {"mode": {"const": "gguf_phase"}}},
                    "provider_options": {
                        "properties": {
                            "adapters": {"maxItems": 0},
                            "transformer_override": {"type": "null"},
                            "gguf_file": {"type": "string"},
                        },
                        "required": ["gguf_file"],
                    },
                }
            },
            "else": {"properties": {"offload": {"properties": {"mode": {"enum": list(PLACEMENTS["bf16"])}}}}},
        },
        {
            "if": stream,
            "then": {"properties": {"offload": {"required": ["pin_memory"]}}},
            "else": {"properties": {"offload": {"not": {"required": ["pin_memory"]}}}},
        },
    ]


def build_settings_schema() -> dict[str, Any]:
    schema = settings_schema(
        precision_properties=PRECISION_PROPERTIES,
        offload_schema=OFFLOAD_SCHEMA,
        provider_options=PROVIDER_OPTIONS,
        invoke_properties=copy.deepcopy(PARAMS),
        require_model_path=True,
        device_kinds=("cuda",),
    )
    load = schema["properties"]["load"]
    load["properties"]["precision"]["x-unavailable"] = dict(PRECISION_UNAVAILABLE)
    load["properties"]["provider_options"]["required"] = ["variant"]
    load["required"] = [*load["required"], "offload", "provider_options"]
    load["allOf"] = _conditional_rules()
    return schema


def parameters_schema() -> dict[str, Any]:
    return {"type": "object", "properties": copy.deepcopy(PARAMS), "additionalProperties": False}


def default_settings(variant: str = "bf16", placement: str | None = None) -> dict[str, Any]:
    mode = placement or PLACEMENTS[variant][0]
    offload: dict[str, Any] = {"mode": mode}
    if mode == "group_stream":
        offload["pin_memory"] = "static"
    options: dict[str, Any] = {
        "variant": variant,
        "base": DEFAULT_BASE,
        "gguf_file": None,  # gguf_q4km: required, no default weights file
        "transformer_override": None,
        "adapters": [],
        "preview_vae": False,
        "preview_coefficients": None,
        "memory_model": "auto",
        "unified_reserve_bytes": memory.DEFAULT_UNIFIED_RESERVE_BYTES,
    }
    return {
        "load": {
            "model_path": "",
            "model_revision": None,
            "device": {"kind": "cuda", "id": "GPU-REPLACE", "resource_group": "gpu"},
            "precision": {"compute_dtype": "bf16"},
            "offload": offload,
            "part_overrides": [],
            "provider_options": options,
        },
        "invoke": copy.deepcopy(INVOKE_DEFAULTS),
        "recording": normalize_recording({"mode": "detailed"}),
    }


# ---------------------------------------------------------------------------------------------- 已解析的設定
@dataclass(frozen=True)
class Adapter:
    name: str
    path: str
    scale: float
    kind: str = "lora"

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "path": self.path, "scale": self.scale, "kind": self.kind}


@dataclass(frozen=True)
class DitOptions:
    """load 設定解析後的結果（相對路徑已接到 model_path 上）。"""

    model_root: Path
    variant: str
    placement: str
    pin_memory: str | None
    base: str
    gguf_file: str | None
    transformer_override: str | None
    adapters: tuple[Adapter, ...] = field(default_factory=tuple)
    preview_vae: bool = False
    preview_coefficients: str | None = None
    device_kind: str = "cuda"
    memory_model: str = "auto"
    unified_reserve_bytes: int = memory.DEFAULT_UNIFIED_RESERVE_BYTES

    @property
    def base_dir(self) -> Path:
        return self.model_root / self.base

    @property
    def transformer_dir(self) -> Path:
        """實際載入的 Transformer 目錄（bf16：覆寫或 base/transformer；GGUF：companion config 目錄）。"""
        if self.variant == "bf16" and self.transformer_override:
            return self.model_root / self.transformer_override
        return self.base_dir / "transformer"

    @property
    def gguf_path(self) -> Path | None:
        return None if self.gguf_file is None else self.model_root / self.gguf_file

    def adapter_path(self, adapter: Adapter) -> Path:
        return self.model_root / adapter.path

    @property
    def scheduler_config_path(self) -> Path:
        return self.base_dir / "scheduler" / "scheduler_config.json"

    @property
    def text_encoder_config_path(self) -> Path:
        return self.base_dir / "text_encoder" / "config.json"

    @property
    def vae_dir(self) -> Path:
        return self.base_dir / "vae"

    def coefficients_path(self, packaged: Path) -> Path:
        if not self.preview_coefficients:
            return packaged
        candidate = Path(self.preview_coefficients)
        return candidate if candidate.is_absolute() else self.model_root / candidate

    def to_effective(self) -> dict[str, Any]:
        return {
            "variant": self.variant,
            "base": self.base,
            "gguf_file": self.gguf_file,
            "transformer_override": self.transformer_override,
            "adapters": [a.to_dict() for a in self.adapters],
            "preview_vae": self.preview_vae,
            "preview_coefficients": self.preview_coefficients,
            "memory_model": self.memory_model,
            "unified_reserve_bytes": self.unified_reserve_bytes,
        }


def unsupported(message: str, **details: Any) -> ComponentError:
    return ComponentError("UNSUPPORTED_SETTING", message, details=details or None)


def check_relative(value: Any, what: str) -> str:
    """相對 model_path 的路徑：非空、非絕對、不含 ``..``（符號連結允許，因為 models/ 本來就以連結組成）。"""
    if not isinstance(value, str) or not value.strip() or "\x00" in value or "\\" in value:
        raise unsupported(f"{what} 必須是相對 model_path 的路徑字串")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise unsupported(f"{what} 不可為絕對路徑或包含 ..：{value}")
    return path.as_posix()


def parse_options(load: Mapping[str, Any]) -> DitOptions:
    """load 設定 → DitOptions；任何組合錯誤都 422（與 schema 的 allOf 規則相同，給直接呼叫與更清楚的訊息）。"""
    model_path = load.get("model_path")
    if not model_path:
        raise ComponentError("COMPONENT_NOT_CONFIGURED", "未設定 load.model_path（Phasyn models 根目錄）")
    options = dict(load.get("provider_options") or {})
    offload = dict(load.get("offload") or {})
    variant = options.get("variant")
    if variant not in VARIANTS:
        raise unsupported(f"provider_options.variant 必須是 {'／'.join(VARIANTS)}", variant=variant)
    placement = offload.get("mode")
    if placement not in PLACEMENTS[variant]:
        raise unsupported(
            f"variant={variant} 的 placement（offload.mode）只能是 {'／'.join(PLACEMENTS[variant])}，收到 {placement}",
            variant=variant,
            placement=placement,
        )
    pin = offload.get("pin_memory")
    if placement == "group_stream":
        if pin not in PIN_MODES:
            raise unsupported(
                "group_stream 需要明確設定 offload.pin_memory（static／dynamic）；不自動選擇", pin_memory=pin
            )
    elif pin is not None:
        raise unsupported(f"offload.pin_memory 只用於 group_stream；placement={placement} 不接受（不假裝套用）")
    extra = sorted(set(offload) - {"mode", "pin_memory"})
    if extra:
        raise unsupported(f"offload 不支援欄位 {', '.join(extra)}")
    precision = dict(load.get("precision") or {})
    if precision.get("compute_dtype", "bf16") != "bf16":
        raise unsupported(
            "qimg.dit 只支援 compute_dtype=bf16（不自動換精度）", compute_dtype=precision.get("compute_dtype")
        )
    base = check_relative(options.get("base") or DEFAULT_BASE, "provider_options.base")
    gguf_file = options.get("gguf_file")
    override = options.get("transformer_override")
    raw_adapters = options.get("adapters") or []
    if variant == "gguf_q4km":
        if raw_adapters or override:
            raise unsupported("GGUF 模型不支援 Adapter（LoRA／slider）或 Transformer 覆寫；請改用 bf16 元件")
        if not gguf_file:
            raise unsupported(
                "variant=gguf_q4km 需要 provider_options.gguf_file（相對 load.model_path 的 .gguf 檔；沒有預設值）"
            )
        gguf_file = check_relative(gguf_file, "provider_options.gguf_file")
        if not gguf_file.lower().endswith(".gguf"):
            raise unsupported("provider_options.gguf_file 必須是 .gguf 檔")
    else:
        if gguf_file:
            raise unsupported("provider_options.gguf_file 只用於 variant=gguf_q4km（不假裝套用）")
        gguf_file = None
        if override:
            override = check_relative(override, "provider_options.transformer_override")
    adapters: list[Adapter] = []
    names: set[str] = set()
    if not isinstance(raw_adapters, Sequence) or isinstance(raw_adapters, (str, bytes)):
        raise unsupported("provider_options.adapters 必須是清單")
    if len(raw_adapters) > MAX_ADAPTERS:
        raise unsupported(f"adapter 最多 {MAX_ADAPTERS} 個")
    for i, raw in enumerate(raw_adapters):
        if not isinstance(raw, Mapping):
            raise unsupported(f"adapters[{i}] 必須是物件")
        name = str(raw.get("name") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
            raise unsupported(f"adapters[{i}].name 只能用英數、_、-（1–64 字）")
        if name in names:
            raise unsupported(f"adapter 名稱重複：{name}")
        names.add(name)
        path = check_relative(raw.get("path"), f"adapters[{i}].path")
        if not path.endswith(".safetensors"):
            raise unsupported(f"adapters[{i}] 必須使用 safetensors（不載入 pickle）")
        try:
            scale = float(raw.get("scale"))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            raise unsupported(f"adapters[{i}].scale 必須是數值") from None
        if not math.isfinite(scale) or not -5 <= scale <= 5:
            raise unsupported(f"adapters[{i}].scale 必須在 −5..5")
        kind = str(raw.get("kind") or "lora")
        if kind not in ADAPTER_KINDS:
            raise unsupported(f"adapters[{i}].kind 必須是 lora 或 slider")
        adapters.append(Adapter(name=name, path=path, scale=scale, kind=kind))
    coefficients = options.get("preview_coefficients")
    if coefficients is not None and (not isinstance(coefficients, str) or not coefficients.strip()):
        raise unsupported("provider_options.preview_coefficients 必須是路徑字串或 null")
    memory_model, unified_reserve = memory.parse_settings(
        options.get("memory_model", "auto"),
        options.get("unified_reserve_bytes", memory.DEFAULT_UNIFIED_RESERVE_BYTES),
    )
    device = dict(load.get("device") or {})
    return DitOptions(
        model_root=Path(str(model_path)),
        variant=variant,
        placement=placement,
        pin_memory=pin if placement == "group_stream" else None,
        base=base,
        gguf_file=gguf_file,
        transformer_override=override or None,
        adapters=tuple(adapters),
        preview_vae=bool(options.get("preview_vae", False)),
        preview_coefficients=coefficients,
        device_kind=str(device.get("kind") or "cuda"),
        memory_model=memory_model,
        unified_reserve_bytes=unified_reserve,
    )


def gguf_kernels_requested(environ: Mapping[str, str] | None = None) -> bool:
    env = os.environ if environ is None else environ
    return env.get(GGUF_KERNEL_ENV, "false").strip().lower() in {"1", "true", "yes", "on"}


def read_config(path: Path, root: Path | None = None) -> dict[str, Any]:
    """A JSON object from a model config file; errors name the file relative to ``root`` (never absolute)."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED", f"無法讀取 {display_path(path, root)}：{type(exc).__name__}"
        ) from exc
    if not isinstance(doc, dict):
        raise ComponentError("COMPONENT_NOT_CONFIGURED", f"{display_path(path, root)} 不是 JSON object")
    return doc


def abi_problems(
    transformer_config: Mapping[str, Any], text_config: Mapping[str, Any], vae_config: Mapping[str, Any]
) -> list[str]:
    """ABI check without allocating weights: class allowlist, hidden_size == context_in_dim, z_dim == in_channels."""
    problems: list[str] = []
    cls = transformer_config.get("_class_name")
    if cls != TRANSFORMER_CLASS:
        problems.append(f"不支援的 Transformer 類別 {cls}（只接受 {TRANSFORMER_CLASS}）")
    text = text_config.get("text_config", text_config)
    hidden = text.get("hidden_size") if isinstance(text, Mapping) else None
    if hidden != transformer_config.get("context_in_dim"):
        problems.append(
            f"Qwen3-VL hidden_size {hidden} 與 Transformer context_in_dim {transformer_config.get('context_in_dim')} 不相容"
        )
    if vae_config.get("z_dim") != transformer_config.get("in_channels"):
        problems.append(
            f"Qwen VAE latent channels（z_dim {vae_config.get('z_dim')}）與 Transformer in_channels "
            f"{transformer_config.get('in_channels')} 不相容"
        )
    return problems


def configuration_problem(opts: DitOptions, *, environ: Mapping[str, str] | None = None) -> tuple[str, str] | None:
    """describe()/load() 前的檔案與相容性檢查（只讀 JSON、stat 檔案；不配置權重）→ (code, 原因)。"""
    root = opts.model_root
    if not root.is_dir():
        return "COMPONENT_NOT_CONFIGURED", "load.model_path 指向的模型根目錄不存在（權重未就緒或路徑錯誤；不自動下載）"
    if opts.variant == "gguf_q4km" and gguf_kernels_requested(environ):
        return "UNSUPPORTED_SETTING", f"GGUF 只使用本機 PyTorch 反量化；請移除環境變數 {GGUF_KERNEL_ENV}"
    for path, what in (
        (opts.transformer_dir / "config.json", "Transformer config"),
        (opts.text_encoder_config_path, "Text encoder config（ABI 檢查用）"),
        (opts.vae_dir / "config.json", "VAE config（ABI 檢查用）"),
        (opts.scheduler_config_path, "scheduler_config.json"),
    ):
        if not path.is_file():
            return (
                "COMPONENT_NOT_CONFIGURED",
                f"缺少 {what}：{display_path(path, root)}；權重未就緒或路徑錯誤（不自動下載）",
            )
    if opts.variant == "bf16" and not any(opts.transformer_dir.glob("*.safetensors")):
        return (
            "COMPONENT_NOT_CONFIGURED",
            f"Transformer 目錄沒有 safetensors 權重：{display_path(opts.transformer_dir, root)}",
        )
    gguf = opts.gguf_path
    if gguf is not None and not gguf.is_file():
        return "COMPONENT_NOT_CONFIGURED", f"找不到 GGUF 檔：{display_path(gguf, root)}"
    for adapter in opts.adapters:
        path = opts.adapter_path(adapter)
        if not path.is_file():
            return "COMPONENT_NOT_CONFIGURED", f"找不到 adapter {adapter.name}：{display_path(path, root)}"
    if opts.preview_vae and not any(opts.vae_dir.glob("*.safetensors")):
        return (
            "COMPONENT_NOT_CONFIGURED",
            f"preview_vae=true 但 VAE 目錄沒有 safetensors：{display_path(opts.vae_dir, root)}",
        )
    problems = abi_problems(
        read_config(opts.transformer_dir / "config.json", root),
        read_config(opts.text_encoder_config_path, root),
        read_config(opts.vae_dir / "config.json", root),
    )
    if problems:
        return "MODEL_INCOMPATIBLE", "；".join(problems)
    return None


def num_layers(opts: DitOptions | None) -> int:
    """describe 的 parts 數：讀 Transformer config（讀不到時用 Qwen-Image 2.1 的 32）。"""
    if opts is None:
        return 32
    try:
        return int(read_config(opts.transformer_dir / "config.json", opts.model_root).get("num_layers", 32))
    except (ComponentError, TypeError, ValueError):
        return 32


# ---------------------------------------------------------------------------------------------- 參數
@dataclass(frozen=True)
class PreviewRequest:
    mode: str
    every: int
    max_side: int

    def to_dict(self) -> dict[str, Any]:
        return {"mode": self.mode, "every": self.every, "max_side": self.max_side}


@dataclass(frozen=True)
class DitParams:
    width: int
    height: int
    steps: int
    guidance: float
    sigma_schedule: str
    flow_shift_mu: float | None
    seed: int
    preview: PreviewRequest

    @property
    def cfg(self) -> bool:
        """Qwen 語意：guidance > 1 才啟用 CFG（與 pipeline 的 do_true_cfg 相同）。"""
        return self.guidance > 1

    @property
    def latent_hw(self) -> tuple[int, int]:
        return latent_hw(self.width, self.height)

    @property
    def target_tokens(self) -> int:
        h, w = self.latent_hw
        return h * w

    def to_dict(self) -> dict[str, Any]:
        return {
            "width": self.width,
            "height": self.height,
            "steps": self.steps,
            "guidance": self.guidance,
            "sigma_schedule": self.sigma_schedule,
            "flow_shift_mu": self.flow_shift_mu,
            "seed": self.seed,
            "preview": self.preview.to_dict(),
        }


def _int(value: Any, name: str, lo: int, hi: int, *, multiple: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ComponentError("INVALID_ARGUMENT", f"{name} 必須是整數")
    if not lo <= value <= hi:
        raise ComponentError("INVALID_ARGUMENT", f"{name} 必須在 {lo}–{hi}，收到 {value}")
    if value % multiple:
        raise ComponentError(
            "INVALID_ARGUMENT", f"{name} 必須是 {multiple} 的倍數，收到 {value}（不暗中縮放）", details={name: value}
        )
    return value


def parse_params(parameters: Mapping[str, Any]) -> DitParams:
    """呼叫參數（runtime host 已疊好 invoke defaults）＋schema 預設 → DitParams；不合法 → 422。"""
    merged = {**copy.deepcopy(INVOKE_DEFAULTS), **dict(parameters)}
    unknown = sorted(set(merged) - set(PARAMS))
    if unknown:
        raise ComponentError("INVALID_ARGUMENT", f"不支援的參數 {', '.join(unknown)}")
    if merged.get("seed") is None:
        raise ComponentError("INVALID_ARGUMENT", "seed 必填（−1／隨機由呼叫端先解析成實際整數並記錄）")
    guidance = merged.get("guidance")
    if isinstance(guidance, bool) or not isinstance(guidance, (int, float)) or not math.isfinite(float(guidance)):
        raise ComponentError("INVALID_ARGUMENT", "guidance 必須是有限數值")
    if not 0 <= float(guidance) <= 20:
        raise ComponentError("INVALID_ARGUMENT", "guidance 必須在 0–20")
    schedule = merged.get("sigma_schedule")
    if schedule not in ("native", "karras", "exponential"):
        raise ComponentError("INVALID_ARGUMENT", "sigma_schedule 必須是 native／karras／exponential")
    mu = merged.get("flow_shift_mu")
    if mu is not None:
        if isinstance(mu, bool) or not isinstance(mu, (int, float)) or not math.isfinite(float(mu)):
            raise ComponentError("INVALID_ARGUMENT", "flow_shift_mu 必須是 null 或有限數值")
        if not -1 <= float(mu) <= 3:
            raise ComponentError("INVALID_ARGUMENT", "flow_shift_mu 必須在 −1..3")
        mu = float(mu)
    raw_preview = merged.get("preview")
    preview = {**PREVIEW_DEFAULT, **(dict(raw_preview) if isinstance(raw_preview, Mapping) else {})}
    if not isinstance(raw_preview, Mapping) and raw_preview is not None:
        raise ComponentError("INVALID_ARGUMENT", "preview 必須是物件")
    bad = sorted(set(preview) - set(PREVIEW_DEFAULT))
    if bad:
        raise ComponentError("INVALID_ARGUMENT", f"preview 不支援欄位 {', '.join(bad)}")
    if preview["mode"] not in PREVIEW_MODES:
        raise ComponentError("INVALID_ARGUMENT", f"preview.mode 必須是 {'／'.join(PREVIEW_MODES)}")
    return DitParams(
        width=_int(merged.get("width"), "width", 256, 2048, multiple=32),
        height=_int(merged.get("height"), "height", 256, 2048, multiple=32),
        steps=_int(merged.get("steps"), "steps", 2, 100),
        guidance=float(guidance),
        sigma_schedule=str(schedule),
        flow_shift_mu=mu,
        seed=_int(merged.get("seed"), "seed", 0, SEED_MAX),
        preview=PreviewRequest(
            mode=str(preview["mode"]),
            every=_int(preview["every"], "preview.every", 1, 100),
            max_side=_int(preview["max_side"], "preview.max_side", 256, 512),
        ),
    )


__all__ = [
    "ADAPTER_KINDS",
    "CONDITIONING_KIND",
    "CONDITIONING_TYPE",
    "KIND",
    "LATENT_KIND",
    "LATENT_TYPE",
    "PARAMS",
    "PLACEMENTS",
    "PREVIEW_MODES",
    "PROVIDER_ID",
    "REF_LATENTS_KIND",
    "REF_LATENTS_TYPE",
    "VARIANTS",
    "Adapter",
    "DitOptions",
    "DitParams",
    "PreviewRequest",
    "abi_problems",
    "build_settings_schema",
    "check_relative",
    "configuration_problem",
    "default_settings",
    "gguf_kernels_requested",
    "num_layers",
    "parameters_schema",
    "parse_options",
    "parse_params",
    "read_config",
    "unsupported",
]
