"""h3.conditioning 的 phase（torch-free）：把「前處理」與「Qwen 編碼」拆成同一元件的兩個步驟。.

* ``all``（預設，與以前相同）：prepare_media → encode_conditioning，輸出 conditioning+prepared+job；
* ``prepare``：只跑 prepare_media，輸出 prepared+job（不跑 Qwen）；
* ``encode``：吃另一個 ``prepare`` 步驟的 prepared+job，只跑 encode_conditioning，輸出 conditioning
  （job 原樣轉出）。

只是編排：兩種走法用同一個 recipe stage、同一份 prepared bytes（payload 以 SHA-256 驗證），Qwen 的輸入
逐位元相同；拆開後 Video／Audio VAE Encode 可接在 ``prepare`` 步驟後面，與 Qwen 同時跑（TE 的時間大多花在 Qwen
編碼，前處理只佔一小部分）。``encode`` 前先核對 prepared 確實是這個 job 前處理出來的（task、幾何、
prompt、素材、參考影片短邊），不一致一律拒絕，不猜。
"""

from __future__ import annotations

import hashlib
from collections.abc import Collection, Mapping, Sequence
from typing import Any

from phasyn_components.errors import ComponentError

from . import refimage, refshape


PHASES = ("all", "prepare", "encode")
SPLIT_PORTS = ("prepared", "job")
MEDIA_PORTS = ("first_frame", "last_frame", "materials")


def resolve_phase(params: Mapping[str, Any], *, bound: Collection[str]) -> str:
    """Invoke 參數 ``phase`` +實際接上的輸入 → phase；接線與 phase 不符時拒絕（不默默改走另一條路）。."""
    phase = str(params.get("phase") or "all")
    if phase not in PHASES:
        raise ComponentError(
            "INVALID_ARGUMENT", f"phase={phase!r} 不合法（all／prepare／encode）"
        )
    if phase == "encode":
        missing = [port for port in SPLIT_PORTS if port not in bound]
        if missing:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"phase=encode 需要 {'、'.join(missing)} 輸入（接同一流程中 phase=prepare 步驟的 prepared 與 job）",
                details={"missing": missing},
            )
        media = [port for port in MEDIA_PORTS if port in bound]
        if media:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"phase=encode 不讀素材（{'、'.join(media)}）；素材請接到 phase=prepare 的步驟",
                details={"ports": media},
            )
    else:
        extra = [port for port in SPLIT_PORTS if port in bound]
        if extra:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"{'／'.join(extra)} 輸入只用於 phase=encode（目前 phase={phase}）",
                details={"ports": extra},
            )
    return phase


def material_mismatches(
    job_materials: Sequence[Mapping[str, Any]],
    prepared_materials: Sequence[Mapping[str, Any]],
) -> list[str]:
    """Job 的素材描述與 prepared 的素材項是不是同一批（來源 SHA-256、角色、起點）；回傳不一致的說明。."""
    entries = list(prepared_materials)
    indices = sorted(int(e.get("material_index", -1)) for e in entries)
    if indices != list(range(len(job_materials))):
        return [
            f"素材數量或索引不同（job {len(job_materials)} 項，prepared 索引 {indices}）"
        ]
    problems: list[str] = []
    for entry in entries:
        index = int(entry["material_index"])
        wanted = job_materials[index]
        if entry.get("source_sha256") != wanted.get("sha256"):
            problems.append(f"materials[{index}] 來源檔不同")
        if entry.get("role") != wanted.get("role"):
            problems.append(
                f"materials[{index}] 角色 {entry.get('role')} ≠ {wanted.get('role')}"
            )
        if float(entry.get("start_time_seconds") or 0.0) != float(
            wanted.get("start_seconds") or 0.0
        ):
            problems.append(f"materials[{index}] 起點不同")
    return problems


def check_prepared_for_job(
    prepared: Mapping[str, Any],
    job: Mapping[str, Any],
    *,
    prompt: str,
    geometry_digest: str,
) -> None:
    """phase=encode：prepared 必須是由這個 job 前處理的；``prompt`` 是本步驟收到的 prompt 文字。."""
    refimage.check(job, prepared)
    problems: list[str] = []
    if prepared.get("kind") != "h3_prepared_media":
        problems.append(f"kind 是 {prepared.get('kind')}，不是 h3_prepared_media")
    if prepared.get("task") != job.get("task"):
        problems.append(f"task {prepared.get('task')} ≠ job {job.get('task')}")
    if prepared.get("geometry_digest") != geometry_digest:
        problems.append("幾何（寬高／影格）與 job 重建的 plan 不同")
    if job.get("geometry_digest") not in (None, geometry_digest):
        problems.append("job.geometry_digest 與重建的 plan 不同")
    job_prompt = str(job.get("prompt") or "")
    job_sha = hashlib.sha256(job_prompt.encode("utf-8")).hexdigest()
    if (prepared.get("prompt") or {}).get("sha256") != job_sha:
        problems.append("prepared 的 prompt 與 job 不同")
    if prompt != job_prompt:
        problems.append("本步驟的 prompt 輸入與 job 不同（prompt 請接同一個流程輸入）")
    problems.extend(
        material_mismatches(
            list(job.get("materials") or []), list(prepared.get("materials") or [])
        )
    )
    problems.extend(
        refshape.mismatches(job, prepared)
    )  # 實驗的參考影片短邊（官方 768 時兩邊都沒有欄位）
    if problems:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            "prepared 不是由這個 job 前處理的：" + "；".join(problems),
            details={"problems": problems},
        )


__all__ = [
    "MEDIA_PORTS",
    "PHASES",
    "SPLIT_PORTS",
    "check_prepared_for_job",
    "material_mismatches",
    "resolve_phase",
]
