"""參考素材的 token 預算（torch-free、唯讀）：哪些列讓 Qwen 與 DiT 的序列變長.

只讀既有檔案，不改任何數值：

* ``prepared`` 文件（``prepare_media`` 的輸出）：每個素材的原始尺寸 → 前處理後尺寸（參考圖固定短邊 2048、
  允許放大；參考影片短邊 768\N{FULLWIDTH PLUS SIGN}面積上限，實驗參數 ``reference_video_short_edge`` 時另附官方 768 的對照；
  首尾幀走目標畫面；凍結最後一格（``hold_last_frame``）的參考影片另附 ``hold``：視窗解出與補滿後的格數）；
* presentation／conditioning payload 裡的 ``text_token_tags``（I64 [S]，1\N{FULLWIDTH EQUALS SIGN}文字、0\N{FULLWIDTH EQUALS SIGN}視覺區塊：
  ``<|vision_start|>``\N{FULLWIDTH PLUS SIGN}pad×N\N{FULLWIDTH PLUS SIGN}``<|vision_end|>``）與 ``text_video_token_mask``（BOOL [S]，只有 ``<|video_pad|>``
  列）：Qwen 序列 S 拆成文字／視覺（其中影片 pad）token；
* ``assemble_inputs`` 寫的 ``packed`` 文件：DiT 全序列拆成 Qwen 列、參考圖／參考影片／參考聲音 latent 列、
  首尾幀列與目標影音列（與釘版 ``packed_sequence`` 的計數規則相同；加總必須等於 ``used_len``，
  不一致時照實標記，不硬湊）；
* ``encode_references`` 的逐項進度回報：VAE encode 每個素材各花多少時間（例如一段參考影片 vs 兩張參考圖）。

DiT 每步耗時隨全序列長度超線性成長（attention 的平方項），所以這些數字直接說明「加參考素材後為什麼慢」。
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from phasyn_h3.recipe.abi.tensors import read_header_from_file
from phasyn_h3.recipe.adapter.geometry import (
    resolve_spatial_shape,  # 釘版 resolver 的純 Python port（逐值相同）
)

from .refshape import OFFICIAL


TAG_TENSOR = "text_token_tags"
VIDEO_MASK_TENSOR = "text_video_token_mask"
_DIT_PATCH = 2  # DiT latent patch [1,2,2]（S/packed_sequence.py _PATCH_H／_PATCH_W）
_AUDIO_CHANNELS = 2  # 參考／目標聲音每個 latent 時間點 2 列（L、R）
_PIXELS_PER_ROW = 32  # VAE 空間壓縮 16 × DiT patch 2


def qwen_token_split(payload: Path) -> dict[str, int]:
    """presentation／conditioning payload 的 S 拆分（只讀兩個小 tensor）.

    ``text``\N{FULLWIDTH EQUALS SIGN}文字列；``vision``\N{FULLWIDTH EQUALS SIGN}視覺區塊列（pad 加每個區塊的起訖標記）；``video``\N{FULLWIDTH EQUALS SIGN}``<|video_pad|>`` 列；
    ``image``\N{FULLWIDTH EQUALS SIGN}``vision \N{MINUS SIGN} video``（圖片 pad 加所有視覺區塊的起訖標記，所以比 image_token_counts 的和多 2×區塊數）。
    """
    import numpy as np  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

    header = read_header_from_file(payload)
    wanted = {TAG_TENSOR: ("I64", "<i8"), VIDEO_MASK_TENSOR: ("BOOL", "|u1")}
    arrays: dict[str, Any] = {}
    with Path(payload).open("rb") as fh:
        for name, (dtype, np_dtype) in wanted.items():
            info = header.tensors.get(name)
            if info is None or info.dtype != dtype or len(info.shape) != 1:
                raise ValueError(f"{Path(payload).name} 沒有 {dtype} 一維的 {name}")
            fh.seek(header.data_offset + info.start)
            raw = fh.read(info.byte_length)
            if len(raw) != info.byte_length:
                raise ValueError(f"{name}：payload 讀取長度不足")
            arrays[name] = np.frombuffer(raw, dtype=np_dtype)
    tags, mask = arrays[TAG_TENSOR], arrays[VIDEO_MASK_TENSOR]
    if tags.shape != mask.shape:
        raise ValueError(f"{TAG_TENSOR} 與 {VIDEO_MASK_TENSOR} 長度不同")
    total = int(tags.shape[0])
    vision = int((tags == 0).sum())
    video = int((mask != 0).sum())
    return {
        "total": total,
        "text": total - vision,
        "vision": vision,
        "image": vision - video,
        "video": video,
    }


def _pair(width: Any, height: Any) -> list[int] | None:
    try:
        w, h = round(float(width)), round(float(height))
    except (TypeError, ValueError):
        return None
    return [w, h] if w > 0 and h > 0 else None


def material_budget(prepared: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Prepared 文件 → 每個素材的 原始尺寸 → 前處理尺寸、面積倍率與每格的 DiT latent 列數."""
    canvas = prepared.get("canvas") or {}
    out: list[dict[str, Any]] = []
    for m in prepared.get("materials") or []:
        chain = str(m.get("material_chain") or "")
        probe = m.get("probe") or {}
        entry: dict[str, Any] = {
            "material_index": m.get("material_index"),
            "role": m.get("role"),
            "material_chain": chain,
            "source": _pair(probe.get("display_width"), probe.get("display_height")),
        }
        if chain == "audio":
            entry.update({"resolved": None, "frames": None, "rows_per_frame": 0})
            out.append(entry)
            continue
        shape = m.get("resolved_shape") or {}
        if chain == "image.target_canvas":
            resolved = _pair(canvas.get("width"), canvas.get("height"))
        else:
            resolved = _pair(shape.get("width"), shape.get("height"))
        entry["resolved"] = resolved
        entry["size_mode"] = shape.get("size_mode")
        entry["frames"] = int(m.get("frame_count") or 1)
        source = entry["source"]
        entry["area_scale"] = (
            round(resolved[0] * resolved[1] / (source[0] * source[1]), 3)
            if resolved and source
            else None
        )
        entry["rows_per_frame"] = (
            (resolved[0] // _PIXELS_PER_ROW) * (resolved[1] // _PIXELS_PER_ROW)
            if resolved
            else None
        )
        if m.get("role") == "reference_video":
            entry.update(_short_edge_facts(shape, source, entry["rows_per_frame"]))
        if m.get("audio"):
            entry["has_audio"] = True
        if m.get(
            "hold"
        ):  # frames above are the held count; this says how many the window decoded
            entry["hold"] = dict(m["hold"])
        out.append(entry)
    return out


def _short_edge_facts(
    shape: Mapping[str, Any], source: list[int] | None, rows: int | None
) -> dict[str, Any]:
    """參考影片的前處理短邊；實驗短邊（非 768）時另附官方 768 會得到的畫面與列數（同一條 resolver 公式推算）."""
    base = shape.get("base_short_edge")
    out: dict[str, Any] = {"base_short_edge": base}
    if base is None or base == OFFICIAL:
        return out
    out["experimental"] = True
    official = None
    if source is not None:
        with contextlib.suppress(ValueError):
            official = resolve_spatial_shape(
                source[0], source[1], base_short_edge=OFFICIAL
            )
    if official is None:
        out["official"] = None
        out["official_reason"] = "沒有可用的原始尺寸，無法推算官方 768 的畫面"
        return out
    official_rows = (int(official["width"]) // _PIXELS_PER_ROW) * (
        int(official["height"]) // _PIXELS_PER_ROW
    )
    out["official"] = {
        "short_edge": OFFICIAL,
        "resolved": [int(official["width"]), int(official["height"])],
        "rows_per_frame": official_rows,
        "source": "derived：phasyn_h3.recipe.adapter.geometry.resolve_spatial_shape（與釘版 minimax_h3_resolve_spatial_shape 同公式）",
    }
    out["rows_factor_vs_official"] = (
        round(rows / official_rows, 4) if rows is not None and official_rows else None
    )
    return out


def sequence_breakdown(
    packed: Mapping[str, Any], qwen: Mapping[str, int] | None = None
) -> dict[str, Any]:
    """assemble_inputs 的 packed 文件 → DiT 全序列的組成（列數）；``qwen`` 是 conditioning 的 token 拆分."""
    latent = packed.get("latent") or {}
    t, h, w = int(latent["t"]), int(latent["h"]), int(latent["w"])
    audio_t = int(latent["audio_t"])
    frame_rows = (h // _DIT_PATCH) * (w // _DIT_PATCH)
    condition = packed.get("condition") or {}
    keyframe_rows = len(condition.get("keyframes") or []) * frame_rows
    ref_image = ref_video = ref_audio = 0
    blocks: list[dict[str, Any]] = []
    for block in condition.get("ref2va_blocks") or []:
        kind = str(block.get("kind"))
        if kind == "image":
            rows = (int(block["latent_h"]) // _DIT_PATCH) * (
                int(block["latent_w"]) // _DIT_PATCH
            )
            ref_image += rows
            blocks.append(
                {
                    "kind": kind,
                    "latent_hw": [int(block["latent_h"]), int(block["latent_w"])],
                    "rows": rows,
                }
            )
        elif kind == "audio":
            rows = int(block["ref_audio_t"]) * _AUDIO_CHANNELS
            ref_audio += rows
            blocks.append(
                {"kind": kind, "ref_audio_t": int(block["ref_audio_t"]), "rows": rows}
            )
        else:  # video／video_audio：自己的聲音列在影像列之前
            lt, lh, lw = (
                int(block["latent_t"]),
                int(block["latent_h"]),
                int(block["latent_w"]),
            )
            video_rows = lt * (lh // _DIT_PATCH) * (lw // _DIT_PATCH)
            audio_rows = int(block.get("ref_audio_t") or 0) * _AUDIO_CHANNELS
            ref_video += video_rows
            ref_audio += audio_rows
            blocks.append(
                {
                    "kind": kind,
                    "latent_thw": [lt, lh, lw],
                    "rows": video_rows,
                    "audio_rows": audio_rows,
                }
            )
    text_rows = int(packed["text_len"])
    target_video = t * frame_rows
    target_audio = audio_t * _AUDIO_CHANNELS
    used = (
        text_rows
        + keyframe_rows
        + ref_image
        + ref_video
        + ref_audio
        + target_audio
        + target_video
    )
    used_len = int(packed["used_len"])
    out: dict[str, Any] = {
        "seq_len": int(packed["seq_len"]),
        "used_len": used_len,
        "counted_rows": used,
        "consistent": used == used_len,
        "qwen_rows": text_rows,
        "keyframe_rows": keyframe_rows,
        "ref_image_rows": ref_image,
        "ref_video_rows": ref_video,
        "ref_audio_rows": ref_audio,
        "target_video_rows": target_video,
        "target_audio_rows": target_audio,
        "blocks": blocks,
    }
    reference_rows = keyframe_rows + ref_image + ref_video + ref_audio
    if qwen is not None:
        out["qwen"] = dict(qwen)
        if (
            int(qwen.get("total", -1)) == text_rows
        ):  # 同一份 conditioning 才把 Qwen 的視覺 token 算進參考
            reference_rows += int(qwen["vision"])
            out["reference_rows_include_qwen_vision"] = True
    out["reference_rows"] = reference_rows
    out["reference_share"] = round(reference_rows / used_len, 4) if used_len else None
    return out


def encode_item_timings(
    marks: Sequence[Mapping[str, Any]], sources: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """encode_references 的逐項進度（completed\N{FULLWIDTH EQUALS SIGN}第幾項完成、at_ms\N{FULLWIDTH EQUALS SIGN}自 stage 呼叫起的時間）→ 每項的耗時.

    recipe stage 每編完一項就回報一次，而每項結束時 latent 會複製回 CPU（``z.cpu()``），所以相鄰兩次
    回報的間隔包含該項的 GPU 工作；第一項的間隔另含 stage 前置（payload 驗證、tensor 載入、VAE 取得）。
    ``sources`` 是同一 scope 依序編碼的素材項，用來標示角色與影格數。
    """
    items: list[dict[str, Any]] = []
    previous = 0.0
    for mark in sorted(marks, key=lambda m: int(m["completed"])):
        index = int(mark["completed"]) - 1
        source = sources[index] if 0 <= index < len(sources) else {}
        at_ms = float(mark["at_ms"])
        items.append(
            {
                "item": index + 1,
                "material_index": source.get("material_index"),
                "role": source.get("role"),
                "material_chain": source.get("material_chain"),
                "frames": source.get("frame_count"),
                "done_at_ms": round(at_ms, 3),
                "since_previous_ms": round(at_ms - previous, 3),
                "includes_stage_setup": index == 0,
            }
        )
        previous = at_ms
    return items


__all__ = [
    "encode_item_timings",
    "material_budget",
    "qwen_token_split",
    "sequence_breakdown",
]
