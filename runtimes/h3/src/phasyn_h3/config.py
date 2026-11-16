"""H3 元件的設定 schema、已知可用預設與「設定 → recipe runtime profile」轉換（torch-free）。

只暴露既有 recipe 真正支援的值（見 recipe/runtime/policy.py、recipe/adapter/profile_rules.py）：TE／DiT compute 只接受
native／bf16，VAE decode 接受 fp32（native）或 fp16（approximate）；DiT 量化只有 nf4 單檔、
int8_convrot、fp8_e4m3；offload 只有 none／component／block。逐部件精度只支援「線上量化時保留
BF16」（excluded_modules）；其他欄位一律以 schema enum 限制，不能填了卻被忽略。

``video_encode``／``audio_encode`` 是把 ``reference``（同一個 encode_references stage）拆成兩個元件：
各自只載入自己的 VAE、跑同一個 recipe stage 的 ``reference_scope=visual|audio``（數值完全相同），
輸出 partial bundle；DiT 合併兩者後得到與 ``reference`` 逐位元相同的 payload。
``video_vae_scope``：video_encode 預設 ``encode_only``（只讀 encoder＋quant_conv 的 tensor，decoder 從不配置）、
video_decode 可選 ``decode_only``（只讀 decoder＋post_quant_conv）；同一 loader 規則與權重，數值不變，見 recipe/runtime/loaders.py。

``weight_streaming``（只有 video_decode，預設關閉）：decoder 的 36 個 block 不常駐，每次解碼從 checkpoint 串流進
``slots`` 個 GPU 槽、依 layer-major 套用到一個時間 clip 的所有 tile；FP32 約 2 GB 顯存、與常駐解碼逐位元相同
（recipe/runtime/stages/vae_weight_streaming.py）。只在 ``video_vae_scope=decode_only``、``offload.mode=none`` 時可用；
不填或 ``enabled=false`` 時一切照舊（不傳進 runtime）。

``frame_streaming``（只有 video_encode，預設關閉）：參考影片的 uint8 格留在 host，每個 tile 才搬上 GPU 轉換；因果的
encoder 的高解析層每次只送 ``frames_per_pass`` 格、每個時間卷積只保留前兩格，低解析層每個 tile 一次算完，它們的權重在
高解析層串流時暫放 host（recipe/runtime/stages/vae_frame_streaming.py）。同一 recipe、權重與 tile 256／64，FP32 只差
卷積的累加順序；顯存不再隨一個 17 格 clip 成長。不填或 ``enabled=false`` 時一切照舊（不傳進 runtime）；
``compute_dtype=fp16``（approximate）只在它開啟時可用。
"""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from pathlib import PurePosixPath
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.provider import Part, settings_schema
from phasyn_components.settings import normalize_recording

from . import refimage, refshape
from .recipe.adapter import ref_kv_rules
from .recipe.adapter.constants import SGLANG_REVISION

COMPONENT_KEYS = ("text_encoder", "transformer", "video_vae", "audio_vae")
ROLE_COMPONENTS: dict[str, tuple[str, ...]] = {
    "conditioning": ("text_encoder",),
    "reference": ("video_vae", "audio_vae"),
    "video_encode": ("video_vae",),
    "audio_encode": ("audio_vae",),
    "dit": ("transformer",),
    "video_decode": ("video_vae",),
    "audio_decode": ("audio_vae",),
}
TASK_VARIANT = {"t2va": "fl2va", "fl2va": "fl2va", "ref2va": "ref2va"}
VARIANT_DIR = {"fl2va": "FL2VA", "ref2va": "Ref2VA"}
GIB = 1024**3
CACHE_REF_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$"
# video VAE 只載入用得到的一半（recipe loaders.py video_vae_scope；FP32 位元組數見 safetensors header）
VIDEO_VAE_SCOPES: dict[str, tuple[str, ...]] = {
    "video_encode": ("full", "encode_only"),
    "video_decode": ("full", "decode_only"),
}
VIDEO_VAE_HALF_BYTES = {"encode_only": 721_351_552, "decode_only": 9_694_132_576, "full": 10_415_484_128}
# provider_options.weight_streaming of video_decode (recipe stages/vae_weight_streaming.py keeps the same ranges)
WEIGHT_STREAMING_SOURCES = ("nvme", "pinned_host")
WEIGHT_STREAMING_PRECISIONS = ("fp32", "fp16")
WEIGHT_STREAMING_SLOTS = (1, 4)
WEIGHT_STREAMING_DEFAULTS: dict[str, Any] = {"source": "nvme", "slots": 2, "tiles_per_pass": None}
WEIGHT_STREAMING_AFTER_USE = ("device", "drop")
# provider_options.frame_streaming of video_encode (recipe stages/vae_frame_streaming.py keeps the same ranges)
FRAME_STREAMING_PRECISIONS = ("fp32", "fp16")
FRAME_STREAMING_FRAMES_PER_PASS = (1, 17)  # 17 = the video VAE's clip length: a pass never spans two clips
FRAME_STREAMING_DEFAULTS: dict[str, Any] = {"frames_per_pass": 2}

# profile extension schema digest = canonical_digest(PROFILE_EXTENSION_SCHEMAS[namespace]) (the runtime validates
# namespace and values); test_h3_extension_digests keeps these pinned values in sync with the schemas
EXTENSION_DIGESTS = {
    "phasyn.sglang_h3.residency": "3943d274f262cd3d21c6b28ba67c1249545f0f9845779834fd945e67abfabd4f",
    "phasyn.sglang_h3.lora": "950681614ad41651ac418cb0636dc3640f9bd55a2c0caafd81dc21ba63f23027",
    "phasyn.sglang_h3.checkpoint": "bb218ce935f64d6339b59c176e792c837e41cc67f12b6765b966f0084941df46",
    "phasyn.sglang_h3.ref_kv_cache": "d7999042f7221e27e8f66ef9bad56908a714558710949affd29656aee0b3538e",
}

COMPUTE_DTYPES = {
    "conditioning": ["native", "bf16"],
    "reference": ["native", "fp32"],
    "video_encode": ["native", "fp32", "fp16"],
    "audio_encode": ["native", "fp32"],
    "dit": ["native", "bf16"],
    "video_decode": ["native", "fp32", "fp16"],
    "audio_decode": ["native", "fp32"],
}
QUANT_SCHEMES = {"dit": ["none", "nf4", "int8_convrot", "fp8_e4m3"]}
QUANT_PROVIDER = {"none": "native", "nf4": "bitsandbytes", "int8_convrot": "sglang_native", "fp8_e4m3": "sglang_native"}
ATTENTION_PROVIDERS = [
    "auto_exact",
    "pytorch_sdpa",
    "flash_attention_3",
    "flash_attention_4",
    "fp8_fa_sm120",
    "subblock_sparse_attn",
]


def _below_model_path(value: str) -> bool:
    """Whether a path setting stays inside ``load.model_path``: relative, without ``..``."""
    path = PurePosixPath(value)
    return not path.is_absolute() and ".." not in path.parts and "\\" not in value


def _null_only(description: str) -> dict[str, Any]:
    return {"type": "null", "description": description}


def precision_schema(role: str) -> dict[str, Any]:
    props: dict[str, Any] = {
        "weight_format": {
            "enum": ["native", "nf4_single_file"] if role == "dit" else ["native"],
            "description": "checkpoint 形式；nf4_single_file 只用於 DiT 的 bitsandbytes NF4 單檔",
        },
        "weight_dtype": {"enum": ["native"], "description": "裝置上的權重 dtype 由 recipe 決定（量化時另記 scheme）"},
        "compute_dtype": {
            "enum": COMPUTE_DTYPES[role],
            "description": "TE／DiT 原生 BF16；VAE 原生 FP32；video decode 另可 fp16（approximate）",
        },
        "autocast_dtype": _null_only("由 recipe 內部決定（video decode fp16 時自動 autocast）；不提供任意設定"),
        "accumulation_dtype": _null_only("kernel 累加精度無法由此 backend 控制或證明；observed 為 null"),
        "matmul_tf32": _null_only("recipe 依元件自行設定（FP32 VAE decode 要求關閉）；observed 記錄實際值"),
        "cudnn_tf32": _null_only("recipe 依元件自行設定；observed 記錄實際值"),
        "reduced_precision_reduction": _null_only("此 backend 不提供設定；observed 記錄實際值"),
        "output_dtype": {"enum": ["native"], "description": "wire 輸出 dtype 由 bundle 契約決定（latent F32）"},
    }
    if role == "video_encode":
        props["compute_dtype"]["description"] = (
            "VAE 原生 FP32；fp16（approximate）只在 provider_options.frame_streaming 開啟時可用，"
            "只改參考影片的串流編碼（參考圖與首尾幀照舊 FP32）"
        )
    if role == "dit":
        props["quantization"] = {
            "type": "object",
            "properties": {
                "scheme": {"enum": QUANT_SCHEMES["dit"]},
                "excluded_modules": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "線上量化時保留 BF16 的模組（SGLang quantization_ignored_layers；adaln_proj 一律保留）",
                },
            },
            "additionalProperties": False,
        }
    else:
        props["quantization"] = {
            "type": "object",
            "properties": {"scheme": {"enum": ["none"]}},
            "additionalProperties": False,
        }
    return props


def offload_schema(role: str) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "mode": {
                "enum": ["none", "component", "block"],
                "description": "none=常駐；component=整個元件 host 備份；block=逐層串流",
            },
            "resident_layers": {"type": "integer", "minimum": 0, "maximum": 64, "description": "block 時常駐的前 N 層"},
            "prefetch_depth": {"type": "integer", "minimum": 1, "maximum": 4},
            "max_pinned_bytes": {"type": "integer", "minimum": 0},
            "after_use": {"enum": ["device", "host", "drop"], "description": "兩次呼叫之間權重的位置"},
        },
        "additionalProperties": False,
    }


def provider_options_schema(role: str) -> dict[str, Any]:
    props: dict[str, Any] = {
        "variant": {"enum": ["fl2va", "ref2va"], "description": "使用哪個 checkpoint 目錄（FL2VA／Ref2VA）"},
        "shared_from": {"enum": [None, "fl2va", "ref2va"], "description": "非 DiT 元件改用另一 variant 的同 hash 目錄"},
        "mode": {
            "enum": ["exact", "approximate", "experimental"],
            "description": "量化／近似 attention／LoRA／fp16 decode 不可用 exact",
        },
        "adaln_cache_root": {"type": ["string", "null"]},
        "jit_cache_dir": {"type": ["string", "null"]},
    }
    if role == "conditioning":
        props["encoder_max_tokens"] = {"type": "integer", "minimum": 1, "maximum": 262144}
    if role == "video_encode":
        props["video_vae_scope"] = {
            "enum": list(VIDEO_VAE_SCOPES[role]),
            "description": "encode_only：只從 video_vae/source/model.safetensors 讀 encoder.*＋quant_conv.*（FP32 721,351,552 B），"
            "decoder 只以 meta 佔位建構後刪除、從不配置也不讀取；同一模組類別與 loader 規則，encode 數值不變。"
            "full：整個 video VAE（10,415,484,128 B）",
        }
        props["frame_streaming"] = frame_streaming_schema()
    if role == "video_decode":
        props["video_vae_scope"] = {
            "enum": list(VIDEO_VAE_SCOPES[role]),
            "description": "decode_only：只讀 decoder.*＋post_quant_conv.*（FP32 9,694,132,576 B），encoder 不讀取；"
            "decoder 的 dtype 規則與 CUDA fast path 照釘版 loader 套用，解碼數值不變。full：整個 video VAE",
        }
    if role == "dit":
        props.update(
            {
                "transformer_file": {"type": ["string", "null"], "description": "NF4 單檔 DiT（相對 model_path）"},
                "attention": {
                    "type": "object",
                    "properties": {
                        "provider": {"enum": ATTENTION_PROVIDERS},
                        "reject_quadratic_materialization": {"type": "boolean"},
                        "subblock_sparse": {"type": "object"},
                    },
                    "additionalProperties": False,
                },
                "adaln": {
                    "type": "object",
                    "properties": {
                        "mode": {"enum": ["off", "online", "fixed"]},
                        # a sidecar name inside the AdaLN cache directory, never a path
                        "cache_ref": {"type": ["string", "null"], "maxLength": 200, "pattern": CACHE_REF_PATTERN},
                        "host_cache_bytes": {"type": "integer", "minimum": 0},
                    },
                    "additionalProperties": False,
                },
                "lora": {
                    "anyOf": [
                        {"type": "null"},
                        {
                            "type": "object",
                            "properties": {
                                "manifest_path": {
                                    "type": "string",
                                    "description": "LoRA manifest JSON；相對路徑依序在 load.model_path、load.model_path/loras、"
                                    "PHASYN_H3_LORA_MANIFEST_DIRS 與內建 manifest 尋找",
                                },
                                "scale": {"type": "number"},
                                "merge_mode": {"enum": ["dynamic", "merge"]},
                                "dynamic_chunk_tokens": {"type": "integer", "minimum": 0, "maximum": 1048576},
                            },
                            "required": ["manifest_path"],
                            "additionalProperties": False,
                        },
                    ]
                },
                "bounded_fp8_load": {
                    "type": "boolean",
                    "description": "FP8＋block＋fixed AdaLN 的有界冷載入（其他組合會被拒絕）",
                },
                # Ref2VA reference-row K/V cache across denoise steps (recipe/adapter/ref_kv_rules.py); absent = off
                ref_kv_rules.OPTION: copy.deepcopy(ref_kv_rules.OPTION_SCHEMA),
                # the convrot_int8 DiT as built, saved once and read back (recipe/runtime/quantized_cache.py); absent = off
                "quantized_cache": quantized_cache_schema(),
            }
        )
    if role == "video_decode":
        props.update(
            {
                "encode_provider": {"enum": ["auto_validated", "cpu_ffmpeg", "nvenc"]},
                "video_codec": {"enum": ["h264", "hevc", "av1"]},
                "pixel_format": {"enum": ["yuv420p", "yuv420p10le"]},
                "quality": {"type": "integer", "minimum": 1, "maximum": 51},
                "max_frame_buffer_bytes": {"type": "integer", "minimum": 1048576},
                "weight_streaming": weight_streaming_schema(),
            }
        )
    return props


def weight_streaming_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "description": "decoder block 權重串流（預設關閉）：36 個 FP32 block（9.69 GB）不常駐，每次解碼依序串流進 GPU 槽、"
        "套用到一個 clip 的所有 tile 再換下一個 block；與常駐解碼逐位元相同，FP32 顯存約 2 GB。需要 video_vae_scope=decode_only、"
        "offload.mode=none",
        "properties": {
            "enabled": {"type": "boolean", "description": "true＝開啟；不填或 false＝照舊常駐解碼（不傳進 runtime）"},
            "source": {
                "enum": list(WEIGHT_STREAMING_SOURCES),
                "description": "nvme＝每次從 checkpoint 以 O_DIRECT 讀（不經 page cache；host 只多 slots 個 256 MiB staging）；"
                "pinned_host＝載入時把 36 個 block 讀進 page-locked host 記憶體一次（約 9.0 GiB）",
            },
            "slots": {
                "type": "integer",
                "minimum": WEIGHT_STREAMING_SLOTS[0],
                "maximum": WEIGHT_STREAMING_SLOTS[1],
                "description": "GPU 上的 block 槽數（每個 FP32 256 MiB）；2＝讀下一個 block 時算這一個（預設）",
            },
            "precision": {
                "enum": list(WEIGHT_STREAMING_PRECISIONS),
                "description": "必須等於 precision.compute_dtype 解析出的解碼精度（native／fp32→fp32；fp16 需 mode=approximate）；"
                "不填＝跟隨 compute_dtype",
            },
            "tiles_per_pass": {
                "type": ["integer", "null"],
                "minimum": 1,
                "maximum": 4096,
                "description": "每次權重走一遍處理的 tile 數；null＝一個 clip 的所有 tile（預設）。不改數值，只改顯存與讀取量",
            },
        },
        "additionalProperties": False,
    }


def quantized_cache_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "description": "量化權重快取（預設關閉）：int8_convrot 第一次載入後把量化好的 DiT 存成 safetensors，之後同一組權重與設定"
        "直接讀取，不再讀 BF16 權重、不再量化；權重檔、量化設定或 runtime 版本有任何改變就重新量化並另存一份",
        "properties": {
            "enabled": {
                "type": "boolean",
                "description": "true＝開啟；不填或 false＝照舊每次載入時線上量化（不傳進 runtime）",
            },
            "dir": {
                "type": "string",
                "description": "快取目錄：Node 主機上的絕對路徑（不可含 ..），每組設定約佔 20 GiB",
            },
        },
        "additionalProperties": False,
    }


def frame_streaming_schema() -> dict[str, Any]:
    low, high = FRAME_STREAMING_FRAMES_PER_PASS
    return {
        "type": "object",
        "description": "參考影片因果串流編碼（預設關閉）：影片的 uint8 格留在 host，每個 tile 才搬上 GPU 轉換；encoder 的高解析層"
        "每次只送 frames_per_pass 格、每個時間卷積保留前兩格（encoder 在時間上是因果的、GroupNorm 逐格），低解析層每個 tile "
        "一次算完，它們的權重在高解析層串流時暫放 host。同一 recipe、權重、tile 256／overlap 64；顯存不再隨一個 17 格 clip "
        "成長。參考圖與首尾幀照舊",
        "properties": {
            "enabled": {
                "type": "boolean",
                "description": "true＝開啟；不填或 false＝照舊一次編碼整個 clip（不傳進 runtime）",
            },
            "frames_per_pass": {
                "type": "integer",
                "minimum": low,
                "maximum": high,
                "description": "每次送進 encoder 的格數（預設 2）；越少顯存越低、越慢。17＝一個 clip 一次（與一般編碼逐位元相同），"
                "較少時只差卷積的累加順序",
            },
            "precision": {
                "enum": list(FRAME_STREAMING_PRECISIONS),
                "description": "必須等於 precision.compute_dtype 解析出的精度（native／fp32→fp32；fp16 需 mode=approximate）；"
                "不填＝跟隨 compute_dtype",
            },
        },
        "additionalProperties": False,
    }


def decode_precision(precision: Mapping[str, Any]) -> str:
    """The video decode precision ``compute_dtype`` resolves to (recipe policy: native/fp32 -> fp32)."""
    return "fp16" if precision.get("compute_dtype") == "fp16" else "fp32"


def weight_streaming_settings(role: str, load: Mapping[str, Any]) -> dict[str, Any] | None:
    """The resolved ``provider_options.weight_streaming`` the runtime gets (source, slots, precision,
    tiles_per_pass), or None when the option is absent or off: then nothing about it reaches the runtime."""
    if role != "video_decode":
        return None
    precision, _offload, options = merged_options(role, load)
    raw = options.get("weight_streaming")
    if not isinstance(raw, Mapping) or raw.get("enabled") is not True:
        return None
    resolved = {**WEIGHT_STREAMING_DEFAULTS, **{k: v for k, v in raw.items() if k != "enabled"}}
    resolved["precision"] = raw.get("precision") or decode_precision(precision)
    return resolved


def encode_precision(precision: Mapping[str, Any]) -> str:
    """The streamed reference-video precision ``compute_dtype`` resolves to (native/fp32 -> fp32, fp16 -> fp16)."""
    return "fp16" if precision.get("compute_dtype") == "fp16" else "fp32"


def frame_streaming_settings(role: str, load: Mapping[str, Any]) -> dict[str, Any] | None:
    """The resolved ``provider_options.frame_streaming`` the encode stage gets (frames_per_pass, precision), or None
    when the option is absent or off: then nothing about it reaches the runtime."""
    if role != "video_encode":
        return None
    precision, _offload, options = merged_options(role, load)
    raw = options.get("frame_streaming")
    if not isinstance(raw, Mapping) or raw.get("enabled") is not True:
        return None
    resolved = {**FRAME_STREAMING_DEFAULTS, **{k: v for k, v in raw.items() if k != "enabled"}}
    resolved["precision"] = raw.get("precision") or encode_precision(precision)
    return resolved


INVOKE_PROPS: dict[str, dict[str, Any]] = {
    "conditioning": {
        "task": {"enum": ["t2va", "fl2va", "ref2va"]},
        "width": {"type": "integer", "minimum": 32, "maximum": 4096, "multipleOf": 32},
        "height": {"type": "integer", "minimum": 32, "maximum": 4096, "multipleOf": 32},
        "frames": {
            "type": "integer",
            "minimum": 96,
            "maximum": 360,
            "description": "要求影格數（24 fps；實際對齊到 17n+5）",
        },
        "phase": {
            "enum": ["all", "prepare", "encode"],
            "description": "all（預設）＝前處理＋Qwen；prepare＝只前處理（輸出 prepared／job，VAE encode 可先開始）；"
            "encode＝只跑 Qwen（接 prepare 步驟的 prepared／job，依 job 建 plan）。同一 stage、數值不變",
        },
        # 實驗參數：只換參考影片前處理的短邊；不填／null／768＝官方路徑（見 refshape.py）
        refshape.PARAM: copy.deepcopy(refshape.PARAMETER_SCHEMA),
        # 參考圖短邊：1024＝建議用於短邊 1024 px 以內的參考圖；不填／null／2048＝官方路徑（見 refimage.py）
        refimage.PARAM: copy.deepcopy(refimage.PARAMETER_SCHEMA),
    },
    "reference": {},
    "video_encode": {},
    "audio_encode": {},
    "dit": {
        "seed": {"type": "integer", "minimum": 0, "maximum": 9223372036854775807},
        "steps": {"type": "integer", "minimum": 1, "maximum": 200},
        "video_shift": {"type": "number", "exclusiveMinimum": 0},
        "audio_shift": {"type": "number", "exclusiveMinimum": 0},
    },
    "video_decode": {},
    "audio_decode": {},
}


def build_settings_schema(role: str) -> dict[str, Any]:
    return settings_schema(
        precision_properties=precision_schema(role),
        offload_schema=offload_schema(role),
        provider_options=provider_options_schema(role),
        invoke_properties=INVOKE_PROPS[role],
        require_model_path=True,
        device_kinds=("cuda",),
    )


def parameters_schema(role: str, *, accepted_steps: Sequence[int] | None = None) -> dict[str, Any]:
    """The invoke parameters; ``accepted_steps`` (the bound LoRA's ``sampling_contract.steps``) narrows the DiT's
    ``steps`` to an enum, so the Controller and the Node refuse another step count before any step runs."""
    properties = copy.deepcopy(INVOKE_PROPS[role])
    if accepted_steps and "steps" in properties:
        properties["steps"]["enum"] = sorted(set(accepted_steps))
    return {"type": "object", "properties": properties, "additionalProperties": False}


# known-good defaults (combinations that have run end to end); not an optimisation result
ROLE_DEFAULTS: dict[str, dict[str, Any]] = {
    "conditioning": {
        "precision": {"compute_dtype": "native"},
        "offload": {"mode": "none", "after_use": "device"},
        "provider_options": {"variant": "fl2va", "mode": "exact", "encoder_max_tokens": 32768},
        "invoke": {"task": "t2va", "width": 768, "height": 448, "frames": 124},
    },
    "reference": {
        "precision": {"compute_dtype": "native"},
        "offload": {"mode": "component", "max_pinned_bytes": 11 * GIB, "after_use": "host"},
        "provider_options": {"variant": "fl2va", "mode": "exact"},
        "invoke": {},
    },
    # 拆開的參考編碼：預設常駐（native FP32）；video 只保留 encoder（見 provider_options.video_vae_scope）
    "video_encode": {
        "precision": {"compute_dtype": "native"},
        "offload": {"mode": "none", "after_use": "device"},
        "provider_options": {"variant": "fl2va", "mode": "exact", "video_vae_scope": "encode_only"},
        "invoke": {},
    },
    "audio_encode": {
        "precision": {"compute_dtype": "native"},
        "offload": {"mode": "none", "after_use": "device"},
        "provider_options": {"variant": "fl2va", "mode": "exact"},
        "invoke": {},
    },
    # The native recipe (the official checkpoint, unquantized, the official 50-step schedule, exact attention and the
    # online AdaLN): it runs on every supported GPU and needs nothing but the model files. FP8/INT8 quantization,
    # accelerating LoRAs, the fixed AdaLN sidecar and the approximate fp8_fa_sm120 attention are explicit choices
    # (the deploy templates and examples/generate_dit_components.py) — a default never lowers precision silently.
    "dit": {
        "precision": {"compute_dtype": "native", "quantization": {"scheme": "none"}},
        "offload": {
            "mode": "block",
            "resident_layers": 0,
            "prefetch_depth": 1,
            "max_pinned_bytes": 24 * GIB,
            "after_use": "host",
        },
        "provider_options": {
            "variant": "fl2va",
            "mode": "exact",
            "attention": {"provider": "auto_exact", "reject_quadratic_materialization": True},
            "adaln": {"mode": "online", "host_cache_bytes": 8 * GIB},
            "lora": None,
            "bounded_fp8_load": False,
        },
        "invoke": {"seed": 42, "steps": 50, "video_shift": 12.0, "audio_shift": 3.0},
    },
    "video_decode": {
        "precision": {"compute_dtype": "native"},
        "offload": {"mode": "component", "max_pinned_bytes": 11 * GIB, "after_use": "host"},
        "provider_options": {
            "variant": "fl2va",
            "mode": "exact",
            "encode_provider": "cpu_ffmpeg",
            "video_codec": "h264",
            "pixel_format": "yuv420p",
            "quality": 18,
        },
        "invoke": {},
    },
    "audio_decode": {
        "precision": {"compute_dtype": "native"},
        "offload": {"mode": "none", "after_use": "device"},
        "provider_options": {"variant": "fl2va", "mode": "exact"},
        "invoke": {},
    },
}


def default_settings(
    role: str, *, model_path: str = "", device_id: str = "GPU-REPLACE", resource_group: str = "gpu"
) -> dict[str, Any]:
    d = copy.deepcopy(ROLE_DEFAULTS[role])
    return {
        "load": {
            "model_path": model_path,
            "model_revision": None,
            "device": {"kind": "cuda", "id": device_id, "resource_group": resource_group},
            "precision": d["precision"],
            "offload": d["offload"],
            "part_overrides": [],
            "provider_options": d["provider_options"],
        },
        "invoke": d["invoke"],
        "recording": normalize_recording({"mode": "detailed"}),
    }


def merged_options(role: str, load: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """把已保存的 load 設定疊在 role 預設上（使用者未填的欄位用預設），回傳 (precision, offload, options)。"""
    d = ROLE_DEFAULTS[role]
    precision = {**copy.deepcopy(d["precision"]), **dict(load.get("precision") or {})}
    offload = {**copy.deepcopy(d["offload"]), **dict(load.get("offload") or {})}
    options = {**copy.deepcopy(d["provider_options"]), **dict(load.get("provider_options") or {})}
    return precision, offload, options


def dit_parts(num_layers: int = 50, refiner_layers: int = 2, *, adaln_mode: str = "fixed") -> list[Part]:
    keep = {
        "type": "object",
        "properties": {
            "keep_bf16": {
                "type": "boolean",
                "description": "線上量化（int8_convrot／fp8_e4m3）時此部件保留 BF16；其他模式不接受",
            }
        },
    }
    observe_block = [
        "forward_count",
        "host_ms",
        "gpu_event_ms",
        "prefetch_wait_gpu_ms",
        "weight_h2d_bytes",
        "block_load_count",
        "device_discard_count",
    ]
    parts: list[Part] = []
    for i in range(num_layers):
        parts.append(Part(f"transformer.blocks.{i}", "dit_block", keep, observe_block))
        parts.append(
            Part(f"transformer.blocks.{i}.attn", "attention", keep, [], "none", "子模組未單獨計時；時間計入所屬 block")
        )
        parts.append(
            Part(f"transformer.blocks.{i}.mlp", "mlp", keep, [], "none", "子模組未單獨計時；時間計入所屬 block")
        )
        if adaln_mode == "off":
            parts.append(
                Part(
                    f"transformer.blocks.{i}.adaln_proj",
                    "adaln",
                    {"type": "object", "properties": {}},
                    [],
                    "none",
                    "adaln_proj 一律保留 BF16（量化時強制排除）",
                )
            )
    for j in range(refiner_layers):
        parts.append(Part(f"transformer.token_refiner.blocks.{j}", "refiner_block", keep, observe_block))
    parts.append(Part("transformer.final_layer", "output_head", keep, [], "none", "輸出頭未單獨計時"))
    return parts


def role_parts(role: str, *, adaln_mode: str = "fixed") -> list[Part]:
    empty = {"type": "object", "properties": {}}
    if role == "dit":
        return dit_parts(adaln_mode=adaln_mode)
    if role == "conditioning":
        return [
            Part(
                "text_encoder.language_model",
                "language_model",
                empty,
                ["host_ms"],
                "partial",
                "TE 以整次 forward 量測（含同步邊界）；不逐層計時",
            ),
            Part("text_encoder.visual", "vision_encoder", empty, [], "none", "視覺塔時間計入整次 forward"),
            Part("tokenizer", "preprocess", empty, ["host_ms"], "full", None),
        ]
    if role == "video_encode":
        return [
            Part(
                "video_vae.encoder",
                "vae_encoder",
                empty,
                ["host_ms", "chunks"],
                "partial",
                "以 stage／chunk 為單位量測",
            )
        ]
    if role == "audio_encode":
        return [Part("audio_vae.encoder", "vae_encoder", empty, ["host_ms"], "partial", "以 stage 為單位量測")]
    if role in ("reference", "video_decode"):
        kind = "encoder" if role == "reference" else "decoder"
        parts = [
            Part(
                f"video_vae.{kind}",
                f"vae_{kind}",
                empty,
                ["host_ms", "chunks"],
                "partial",
                "以 stage／chunk 為單位量測",
            )
        ]
        if role == "reference":
            parts.append(Part("audio_vae.encoder", "vae_encoder", empty, ["host_ms"], "partial", "以 stage 為單位量測"))
        return parts
    return [Part("audio_vae.decoder", "vae_decoder", empty, ["host_ms"], "partial", "以 stage 為單位量測")]


def part_override_patterns(overrides: list[Mapping[str, Any]], expanded: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """keep_bf16=true 的展開 part → SGLang quantization_ignored_layers 樣式（去掉 'transformer.' 前綴）。"""
    patterns: list[str] = []
    for path, values in sorted(expanded.items()):
        if values.get("keep_bf16") is True:
            name = path[len("transformer.") :] if path.startswith("transformer.") else path
            patterns.append(name)
    return patterns


def check_supported(role: str, settings: Mapping[str, Any], expanded: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """recipe 層級的組合規則（schema 擋不住的部分）；回傳 notes，不支援時拋 UNSUPPORTED_SETTING。"""
    load = settings.get("load") or {}
    precision, offload, options = merged_options(role, load)
    notes: list[str] = []
    device = load.get("device") or {}
    if device.get("kind") != "cuda":
        raise ComponentError("UNSUPPORTED_SETTING", "H3 元件需要 CUDA 裝置（此 recipe 在 import 時就需要可見 GPU）")
    mode = options.get("mode", "exact")
    scheme = ((precision.get("quantization") or {}).get("scheme")) or "none"
    if role == "dit":
        if scheme != "none" and mode == "exact":
            raise ComponentError("UNSUPPORTED_SETTING", f"量化 {scheme} 不可用 mode=exact（請改 approximate）")
        if scheme == "nf4":
            if precision.get("weight_format") != "nf4_single_file" or not options.get("transformer_file"):
                raise ComponentError(
                    "UNSUPPORTED_SETTING", "nf4 需要 weight_format=nf4_single_file 與 provider_options.transformer_file"
                )
            if offload.get("mode") != "none":
                raise ComponentError("UNSUPPORTED_SETTING", "nf4 DiT 只支援 offload none")
        elif precision.get("weight_format") == "nf4_single_file":
            raise ComponentError("UNSUPPORTED_SETTING", "nf4_single_file 必須搭配 quantization.scheme=nf4")
        keep = [p for p, v in expanded.items() if v.get("keep_bf16") is True]
        if keep and scheme not in ("int8_convrot", "fp8_e4m3"):
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "keep_bf16 只在線上量化（int8_convrot／fp8_e4m3）時有作用",
                details={"parts": keep[:20]},
            )
        attention = (options.get("attention") or {}).get("provider", "auto_exact")
        if attention in ("fp8_fa_sm120", "subblock_sparse_attn") and mode == "exact":
            raise ComponentError("UNSUPPORTED_SETTING", f"attention {attention} 是近似 kernel，不可用 mode=exact")
        adaln = options.get("adaln") or {}
        if adaln.get("mode") == "fixed" and not adaln.get("cache_ref"):
            raise ComponentError("UNSUPPORTED_SETTING", "adaln fixed 需要 cache_ref（sidecar 名稱）")
        transformer_file = options.get("transformer_file")
        if transformer_file and not _below_model_path(str(transformer_file)):
            raise ComponentError(
                "UNSUPPORTED_SETTING", "transformer_file 必須是 model_path 之下的相對路徑（不可是絕對路徑或含 ..）"
            )
        if options.get("lora") and mode == "exact":
            raise ComponentError("UNSUPPORTED_SETTING", "LoRA 屬近似，不可用 mode=exact")
        if options.get("bounded_fp8_load") and not (
            scheme == "fp8_e4m3" and offload.get("mode") == "block" and adaln.get("mode") == "fixed"
        ):
            raise ComponentError("UNSUPPORTED_SETTING", "bounded_fp8_load 只適用 fp8_e4m3＋block offload＋AdaLN fixed")
        if keep:
            notes.append("keep_bf16（excluded_modules）除 adaln_proj 以外的樣式尚未有 GPU 實測紀錄；結果請自行比較")
        notes.extend(_check_ref_kv_cache(options, mode=mode, attention=attention))
        notes.extend(_check_quantized_cache(scheme, options))
    elif scheme != "none":
        raise ComponentError("UNSUPPORTED_SETTING", f"{role} 不支援量化（recipe 只對 DiT 實作）")
    if role == "video_decode" and precision.get("compute_dtype") == "fp16" and mode == "exact":
        raise ComponentError("UNSUPPORTED_SETTING", "video VAE fp16 decode 屬近似，請用 mode=approximate")
    if role == "video_encode" and precision.get("compute_dtype") == "fp16" and mode == "exact":
        raise ComponentError("UNSUPPORTED_SETTING", "video VAE fp16 encode 屬近似，請用 mode=approximate")
    if offload.get("mode") != "block" and int(offload.get("resident_layers") or 0) != 0:
        raise ComponentError("UNSUPPORTED_SETTING", "resident_layers 只在 offload=block 時有意義")
    if offload.get("mode") == "component" and offload.get("after_use") == "device":
        raise ComponentError("UNSUPPORTED_SETTING", "offload=component 與 after_use=device 互相矛盾")
    if role in VIDEO_VAE_SCOPES:
        scope = options.get("video_vae_scope", "full")
        if scope not in VIDEO_VAE_SCOPES[role]:
            raise ComponentError(
                "UNSUPPORTED_SETTING", f"{role} 的 video_vae_scope 必須是 {'／'.join(VIDEO_VAE_SCOPES[role])}"
            )
        if scope == "encode_only" and offload.get("mode") == "block":
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "video_vae_scope=encode_only 不支援 offload=block（video VAE 只有 decoder 能逐層串流；encoder 不串流）",
            )
        if scope == "decode_only" and offload.get("mode") == "block":
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                "video_vae_scope=decode_only 尚未驗證 offload=block（逐層串流）；請用 none 或 component",
            )
    if role == "video_decode":
        notes.extend(_check_weight_streaming(precision, offload, options))
    if role == "video_encode":
        notes.extend(_check_frame_streaming(precision, options))
    return notes


def _check_weight_streaming(
    precision: Mapping[str, Any], offload: Mapping[str, Any], options: Mapping[str, Any]
) -> list[str]:
    """Rules of ``provider_options.weight_streaming`` the schema cannot express (only when enabled)."""
    raw = options.get("weight_streaming")
    if raw is None:
        return []
    if not isinstance(raw, Mapping):
        raise ComponentError("UNSUPPORTED_SETTING", "weight_streaming 必須是 object")
    if raw.get("enabled") is not True:
        return []

    def refuse(message: str) -> ComponentError:
        return ComponentError("UNSUPPORTED_SETTING", f"weight_streaming：{message}")

    if options.get("video_vae_scope", "full") != "decode_only":
        raise refuse("需要 video_vae_scope=decode_only（只建 decoder 外殼，block 從 checkpoint 串流）")
    if offload.get("mode") != "none":
        raise refuse("需要 offload.mode=none（block 由權重串流搬運，不用 component／block offload）")
    if offload.get("after_use", "device") not in WEIGHT_STREAMING_AFTER_USE:
        raise refuse(
            f"offload.after_use 必須是 {'／'.join(WEIGHT_STREAMING_AFTER_USE)}（外殼只有約 25 MiB，不值得停到 host）"
        )
    source = raw.get("source", WEIGHT_STREAMING_DEFAULTS["source"])
    if source not in WEIGHT_STREAMING_SOURCES:
        raise refuse(f"source 必須是 {'／'.join(WEIGHT_STREAMING_SOURCES)}")
    slots = raw.get("slots", WEIGHT_STREAMING_DEFAULTS["slots"])
    low, high = WEIGHT_STREAMING_SLOTS
    if type(slots) is not int or not low <= slots <= high:
        raise refuse(f"slots 必須是 {low}..{high} 的整數")
    tiles = raw.get("tiles_per_pass")
    if tiles is not None and (type(tiles) is not int or not 1 <= tiles <= 4096):
        raise refuse("tiles_per_pass 必須是 1..4096 的整數或 null")
    want = decode_precision(precision)
    if raw.get("precision") is not None and raw.get("precision") != want:
        raise refuse(f"precision={raw.get('precision')} 與 precision.compute_dtype 解析出的 {want} 不同")
    notes = []
    if source == "pinned_host":
        notes.append("weight_streaming source=pinned_host：載入時在 host 鎖住約 9.0 GiB（36 個 FP32 decoder block）")
    if want == "fp16":
        notes.append("weight_streaming fp16：decoder linear 以 FP16 持有（approximate），只在 CUDA 上")
    return notes


def _check_quantized_cache(scheme: str, options: Mapping[str, Any]) -> list[str]:
    """``provider_options.quantized_cache`` (h3.dit): only an enabled cache is checked."""
    raw = options.get("quantized_cache")
    if raw is None:
        return []
    if not isinstance(raw, Mapping):
        raise ComponentError("UNSUPPORTED_SETTING", "quantized_cache 必須是 object")
    if raw.get("enabled") is not True:
        return []
    if scheme != "int8_convrot":
        raise ComponentError("UNSUPPORTED_SETTING", "quantized_cache 只適用 quantization.scheme=int8_convrot")
    directory = raw.get("dir")
    if (
        not isinstance(directory, str)
        or not PurePosixPath(directory).is_absolute()
        or ".." in PurePosixPath(directory).parts
    ):
        raise ComponentError("UNSUPPORTED_SETTING", "quantized_cache.dir 必須是 Node 主機上的絕對路徑（不可含 ..）")
    return ["quantized_cache：第一次載入會多寫約 20 GiB 到快取目錄，之後同一設定的載入直接讀取"]


def _check_ref_kv_cache(options: Mapping[str, Any], *, mode: str, attention: str) -> list[str]:
    """``provider_options.ref_kv_cache`` (h3.dit): the combinations the runtime can honour (ref_kv_rules)."""
    try:
        policy = ref_kv_rules.parse_option(options.get(ref_kv_rules.OPTION))
    except ref_kv_rules.OptionError as exc:
        field = f"{ref_kv_rules.OPTION}.{exc.field}" if exc.field else ref_kv_rules.OPTION
        raise ComponentError("UNSUPPORTED_SETTING", exc.message, details={"field": field}) from exc
    if policy is None:
        return []
    if mode == "exact":
        raise ComponentError(
            "UNSUPPORTED_SETTING", "ref_kv_cache skip 讓略過步沿用快取的參考列 K/V，屬近似加速，不可用 mode=exact"
        )
    if options.get("variant") != "ref2va":
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            f"ref_kv_cache 只用於 Ref2VA DiT（參考列只存在於 ref2va 的 packed 序列）；此元件 variant={options.get('variant')}",
        )
    reason = ref_kv_rules.attention_refusal(attention)
    if reason is not None:
        raise ComponentError("UNSUPPORTED_SETTING", f"ref_kv_cache skip 不支援此 attention：{reason}")
    return [
        f"ref_kv_cache skip（start_step={policy.start_step}，cache {policy.cache_dtype}，refresh "
        f"{list(policy.refresh_steps)}）：近似加速，畫質請自行比較"
    ]


def _check_frame_streaming(precision: Mapping[str, Any], options: Mapping[str, Any]) -> list[str]:
    """Rules of ``provider_options.frame_streaming`` the schema cannot express (mode=exact fp16 is refused above)."""
    raw = options.get("frame_streaming")
    if raw is not None and not isinstance(raw, Mapping):
        raise ComponentError("UNSUPPORTED_SETTING", "frame_streaming 必須是 object")
    enabled = isinstance(raw, Mapping) and raw.get("enabled") is True
    want = encode_precision(precision)
    if want == "fp16" and not enabled:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            "video encode 的 compute_dtype=fp16 只在 frame_streaming 開啟時可用（只有串流編碼實作 FP16）",
        )
    if not enabled:
        return []
    assert isinstance(raw, Mapping)

    def refuse(message: str) -> ComponentError:
        return ComponentError("UNSUPPORTED_SETTING", f"frame_streaming：{message}")

    frames = raw.get("frames_per_pass", FRAME_STREAMING_DEFAULTS["frames_per_pass"])
    low, high = FRAME_STREAMING_FRAMES_PER_PASS
    if type(frames) is not int or not low <= frames <= high:
        raise refuse(f"frames_per_pass 必須是 {low}..{high} 的整數")
    if raw.get("precision") is not None and raw.get("precision") != want:
        raise refuse(f"precision={raw.get('precision')} 與 precision.compute_dtype 解析出的 {want} 不同")
    if want == "fp16":
        return [
            "frame_streaming fp16：參考影片以 FP16 權重副本（約 344 MiB）與 FP16 激活串流編碼（approximate，只在 CUDA "
            "上），編碼期間 FP32 權重暫放 host；參考圖與首尾幀照舊 FP32"
        ]
    return []


def _component(kind: str) -> dict[str, Any]:
    return {
        "compute_dtype": "native",
        "weight_format": "native",
        "quantization": {"scheme": "none", "provider": "native", "excluded_modules": []},
        "offload": "none",
        "resident_layers": 0,
        "blocks_per_group": 1,
        "prefetch_depth": 1,
        "max_pinned_bytes": 8 * GIB,
        "residency_policy": "prefix",
        "resident_layer_indices": [],
    }


def build_profile(
    role: str,
    settings: Mapping[str, Any],
    *,
    profile_id: str,
    revision: int,
    expanded_parts: Mapping[str, Mapping[str, Any]] | None = None,
    lora_manifest: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """組合 recipe 的 runtime-profile 文件（每個元件程序只載入自己 role 的元件）。"""
    load = settings.get("load") or {}
    precision, offload, options = merged_options(role, load)
    components = {k: _component(k) for k in COMPONENT_KEYS}
    residency: dict[str, Any] = {}
    for kind in ROLE_COMPONENTS[role]:
        comp = components[kind]
        # recipe 接受 native 或該元件的原生 dtype（TE／DiT bf16、VAE fp32），video VAE decode 另接受 fp16
        comp["compute_dtype"] = precision.get("compute_dtype") or "native"
        quant = precision.get("quantization") or {}
        scheme = quant.get("scheme") or "none"
        if kind == "transformer":
            excluded = list(
                dict.fromkeys(
                    [
                        *(quant.get("excluded_modules") or []),
                        *part_override_patterns(list(load.get("part_overrides") or []), expanded_parts or {}),
                    ]
                )
            )
            if scheme in ("int8_convrot", "fp8_e4m3") and "adaln_proj" not in excluded:
                excluded.insert(0, "adaln_proj")
            comp["quantization"] = {"scheme": scheme, "provider": QUANT_PROVIDER[scheme], "excluded_modules": excluded}
            comp["weight_format"] = "safetensors" if precision.get("weight_format") == "nf4_single_file" else "native"
        mode = offload.get("mode") or "none"
        comp["offload"] = mode
        comp["resident_layers"] = int(offload.get("resident_layers") or 0)
        comp["prefetch_depth"] = int(offload.get("prefetch_depth") or 1)
        if offload.get("max_pinned_bytes") is not None:
            comp["max_pinned_bytes"] = int(offload["max_pinned_bytes"])
        if offload.get("after_use"):
            residency[kind] = {"after_use": offload["after_use"]}
    extensions: list[dict[str, Any]] = []
    if residency:
        extensions.append(
            {
                "namespace": "phasyn.sglang_h3.residency",
                "schema_digest": EXTENSION_DIGESTS["phasyn.sglang_h3.residency"],
                "values": residency,
            }
        )
    lora: list[dict[str, Any]] = []
    adaln = {"mode": "off", "cache_ref": None, "host_cache_bytes": 8 * GIB}
    attention = {"provider": "auto_exact", "reject_quadratic_materialization": True}
    if role == "dit":
        adaln.update({k: v for k, v in (options.get("adaln") or {}).items() if v is not None or k == "cache_ref"})
        attention.update(options.get("attention") or {})
        lora_opt = options.get("lora")
        if lora_opt and lora_manifest is not None:
            lora.append(
                {
                    "model_id": lora_manifest["lora_id"],
                    "revision": lora_manifest["source_revision"],
                    "scale": float(lora_opt.get("scale", 1.0)),
                    "alpha": None,
                }
            )
            values = {k: lora_opt[k] for k in ("merge_mode", "dynamic_chunk_tokens") if lora_opt.get(k) is not None}
            if values:
                extensions.append(
                    {
                        "namespace": "phasyn.sglang_h3.lora",
                        "schema_digest": EXTENSION_DIGESTS["phasyn.sglang_h3.lora"],
                        "values": values,
                    }
                )
        if precision.get("weight_format") == "nf4_single_file":
            extensions.append(
                {
                    "namespace": "phasyn.sglang_h3.checkpoint",
                    "schema_digest": EXTENSION_DIGESTS["phasyn.sglang_h3.checkpoint"],
                    "values": {"transformer_qkv_layout": "concat", "transformer_architecture": "pruned_curve"},
                }
            )
        ref_kv_cache = ref_kv_rules.parse_option(options.get(ref_kv_rules.OPTION))
        if ref_kv_cache is not None:  # off (absent, null or mode off) adds nothing: the profile of today
            extensions.append(
                {
                    "namespace": ref_kv_rules.EXTENSION,
                    "schema_digest": EXTENSION_DIGESTS[ref_kv_rules.EXTENSION],
                    "values": ref_kv_rules.extension_values(ref_kv_cache),
                }
            )
    if adaln.get("cache_ref") is None:
        adaln.pop("cache_ref", None)
    mode = options.get("mode") or "exact"
    return {
        "schema_version": "1.0",
        "profile_id": profile_id,
        "revision": int(revision),
        "label": f"Phasyn Studio component profile ({role})",
        "runtime_provider": "sglang_h3",
        "runtime_source_revision": SGLANG_REVISION,
        "runtime_lock_digest": None,
        "mode": mode,
        "placements": {
            "conditioning": {"role": "encoder"},
            "dit": {"role": "render"},
            "video_vae": {"role": "render"},
            "audio_vae": {"role": "assist"},
            "media": {"role": "cpu"},
        },
        "components": components,
        "adaln": adaln,
        "attention": attention,
        "compile": {"mode": "off", "max_cache_bytes": 2 * GIB},
        "cuda_graphs": {"mode": "off", "max_buckets": 2, "max_pool_bytes": 2 * GIB},
        "approximation": {"algorithm": "none", "threshold": 0, "warmup_steps": 5, "max_reuse_steps": 0},
        "lora": lora,
        "parallelism": {
            "mode": "stage_only",
            "tensor_degree": 1,
            "ulysses_degree": 1,
            "ring_degree": 1,
            "fsdp_inference": False,
        },
        "vae": {
            "spatial_tile": 256,
            "spatial_overlap": 64,
            "temporal_policy": "native",
            "transfer_dtype": "native",
            "max_frame_buffer_bytes": int(options.get("max_frame_buffer_bytes") or 512 * 1024 * 1024),
        },
        "limits": {
            "encoder_max_tokens": int(options.get("encoder_max_tokens") or 32768),
            "device_budget_fraction": 0.9,
            "external_headroom_min_bytes": GIB,
            "max_concurrent_heavy_per_device": 1,
            "max_host_resident_bytes": None,
        },
        "fallback_policy": "exact_memory_only",
        "evidence_ids": [],
        "extensions": extensions,
    }


__all__ = [
    "COMPONENT_KEYS",
    "FRAME_STREAMING_DEFAULTS",
    "ROLE_COMPONENTS",
    "ROLE_DEFAULTS",
    "SGLANG_REVISION",
    "TASK_VARIANT",
    "VARIANT_DIR",
    "VIDEO_VAE_HALF_BYTES",
    "VIDEO_VAE_SCOPES",
    "WEIGHT_STREAMING_DEFAULTS",
    "build_profile",
    "build_settings_schema",
    "check_supported",
    "decode_precision",
    "default_settings",
    "dit_parts",
    "encode_precision",
    "frame_streaming_schema",
    "frame_streaming_settings",
    "merged_options",
    "parameters_schema",
    "part_override_patterns",
    "quantized_cache_schema",
    "role_parts",
    "weight_streaming_schema",
    "weight_streaming_settings",
]
