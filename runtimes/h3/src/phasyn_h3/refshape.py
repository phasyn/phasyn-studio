"""實驗：Ref2VA 參考影片的前處理短邊（h3.conditioning 的 ``reference_video_short_edge``；torch-free）.

釘版 SGLang 一律以 ``MINIMAX_H3_BASE_SHORT_EDGE``\N{FULLWIDTH EQUALS SIGN}768 解析參考影片的畫面（adapt_shape_v1：短邊 × 比例、
768×1344 面積上限、兩軸各取最近的 32 倍數；1280×720 → 1344×768）。這個實驗參數只換掉那一個 base 短邊，
其餘照舊：同一個釘版 resolver、同一條 ffmpeg 轉換、同一個 VAE／Qwen／DiT。

* 不填、null 或 768 \N{FULLWIDTH EQUALS SIGN}官方路徑：prepared 與 job 逐位元和以前相同（不寫任何新欄位）；
* 256\N{EN DASH}768 之間的其他 32 倍數 \N{FULLWIDTH EQUALS SIGN}實驗：參考影片以較小的畫面前處理（例如 448：1280×720 → 800×448），
  Qwen 的影片 token 與 DiT 的參考影片列都跟著變少；釘版對非 768 的短邊會記「未驗證」警告
  （官方只有 768 的 recipe 與參考輸出，品質與 prompt 遵循沒有量測）。

只影響 ``reference_video`` 素材：參考圖（2048 短邊）、首尾幀（目標畫面）與聲音（含影片原聲）都不受影響。
實際套用時，數值記在 job（``reference_video_short_edge``）、prepared（同名欄位與每段影片的
``resolved_shape.base_short_edge``）與紀錄裡；下游（venc、DiT、phase=encode）以 :func:`mismatches` 核對。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components.errors import ComponentError


PARAM = "reference_video_short_edge"
OFFICIAL = 768  # 釘版 MINIMAX_H3_BASE_SHORT_EDGE（SG:resolved_plan.py:43），唯一經官方驗證的短邊
MINIMUM = 256
MULTIPLE = 32
REFERENCE_VIDEO = "reference_video"

PARAMETER_SCHEMA: dict[str, Any] = {
    "type": ["integer", "null"],
    "minimum": MINIMUM,
    "maximum": OFFICIAL,
    "multipleOf": MULTIPLE,
    "default": OFFICIAL,
    "title": "實驗：參考影片短邊",
    "description": "實驗參數：參考影片（reference_video）前處理用的短邊，256\N{EN DASH}768 的 32 倍數；不填、null 或 768\N{FULLWIDTH EQUALS SIGN}官方路徑"
    "（逐位元不變）。官方只驗證 768；其他值會讓參考影片以較小畫面送進 Qwen 與 VAE（例如 448：1280×720 → 800×448），"
    "DiT 序列變短，但品質未經 MiniMax／SGLang 量測。只影響參考影片，參考圖、首尾幀與聲音不變；沒有參考影片時不生效",
}


def _invalid(value: Any, field_path: str, reason: str) -> ComponentError:
    return ComponentError(
        "INVALID_ARGUMENT",
        f"{field_path}={value!r} 不合法：{reason}（{MINIMUM}\N{EN DASH}{OFFICIAL} 的 {MULTIPLE} 倍數；不填／null\N{FULLWIDTH EQUALS SIGN}官方 {OFFICIAL}）",
        details={
            "field_path": field_path,
            "expected": f"integer, multiple of {MULTIPLE}, {MINIMUM}..{OFFICIAL}, or null",
            "actual": value,
        },
    )


def normalize(value: Any, *, field_path: str = f"parameters.{PARAM}") -> int | None:
    """值 → 實驗短邊；``None``\N{FULLWIDTH EQUALS SIGN}官方 768 路徑（null 或 768）.

    不合法 → 422 INVALID_ARGUMENT（附 field_path）。
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid(value, field_path, "必須是整數")
    if isinstance(value, float):
        if not value.is_integer():
            raise _invalid(value, field_path, "必須是整數")
        value = int(
            value
        )  # JSON 的 448.0 與 448 是同一個整數（JSON Schema 也這樣判定）
    if not MINIMUM <= value <= OFFICIAL:
        raise _invalid(value, field_path, "超出範圍")
    if value % MULTIPLE:
        raise _invalid(value, field_path, f"不是 {MULTIPLE} 的倍數")
    return None if value == OFFICIAL else int(value)


def requested(params: Mapping[str, Any]) -> int | None:
    """Invoke 參數（已疊上元件 invoke 預設）裡的實驗短邊；``None``\N{FULLWIDTH EQUALS SIGN}官方路徑."""
    return normalize(params.get(PARAM))


def of_job(job: Mapping[str, Any]) -> int | None:
    """Job 宣告的實驗短邊（只有實際套用時才有這個欄位）；``None``\N{FULLWIDTH EQUALS SIGN}官方 768."""
    return normalize(job.get(PARAM), field_path=f"job.{PARAM}")


def has_reference_video(materials: Any) -> bool:
    """Check whether the job supplies a video reference."""
    return any(
        isinstance(m, Mapping) and m.get("role") == REFERENCE_VIDEO
        for m in materials or []
    )


def note(value: int) -> str:
    """紀錄上的可見標示（套用時）."""
    return f"實驗：參考影片短邊 {value}（官方只驗證 {OFFICIAL}）"


def unused_note(value: int) -> str:
    """Explain why the reference shape setting was unused."""
    return f"實驗參數 {PARAM}={value} 未生效：這次沒有參考影片（只影響 reference_video；參考圖、首尾幀與聲音不受影響）"


def mismatches(job: Mapping[str, Any], prepared: Mapping[str, Any]) -> list[str]:
    """Job 宣告的參考影片短邊與 prepared 實際的前處理是否一致；回傳不一致的說明.

    以每段參考影片的 ``resolved_shape.base_short_edge``（釘版 resolver 的輸出）為準，所以這個實驗之前
    產生的 prepared（一律 768）與官方 job 也能通過；prepared 的同名欄位只在實驗時出現，也一併核對。
    """
    wanted = of_job(job) or OFFICIAL
    problems: list[str] = []
    declared = prepared.get(PARAM)
    if declared is not None and declared != wanted:
        problems.append(f"prepared 的 {PARAM}={declared}，job 是 {wanted}")
    for entry in prepared.get("materials") or []:
        if not isinstance(entry, Mapping) or entry.get("role") != REFERENCE_VIDEO:
            continue
        base = (entry.get("resolved_shape") or {}).get("base_short_edge")
        if base is not None and base != wanted:
            problems.append(
                f"materials[{entry.get('material_index')}] 參考影片以短邊 {base} 前處理，job 是 {wanted}"
            )
    if declared is None and wanted != OFFICIAL and not problems:
        problems.append(
            f"job 宣告實驗短邊 {wanted}，但 prepared 沒有以實驗短邊前處理的參考影片"
        )
    return problems


def check(job: Mapping[str, Any], prepared: Mapping[str, Any], *, what: str) -> None:
    """下游（venc／DiT）收到的 prepared 必須是以 job 宣告的短邊前處理的；不一致一律拒絕，不猜."""
    problems = mismatches(job, prepared)
    if problems:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"{what}：參考影片短邊不一致：" + "；".join(problems),
            details={"problems": problems, "field_path": f"job.{PARAM}"},
        )


__all__ = [
    "MINIMUM",
    "MULTIPLE",
    "OFFICIAL",
    "PARAM",
    "PARAMETER_SCHEMA",
    "check",
    "has_reference_video",
    "mismatches",
    "normalize",
    "note",
    "of_job",
    "requested",
    "unused_note",
]
