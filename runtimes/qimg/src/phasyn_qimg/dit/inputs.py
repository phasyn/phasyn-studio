"""Consistency checks of the DiT inputs (conditioning and reference latents) against the call parameters.

Every mismatch is a 422; nothing is reshaped, cast or guessed. Pure functions over tensors and bundle metadata, so
the rules are testable without loading a transformer (torch is imported lazily).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components.errors import ComponentError

from .options import DitParams


_FRAME_GRID_DIMENSIONS = 3
_SPATIAL_DIMENSIONS = 2
_MASK_RANK = 2
_PACKED_RANK = 3


def _runs(mask: Any) -> list[int]:
    """1-D bool mask 中連續 True 的長度（每段=一張參考圖的 VLM 影像槽）."""
    runs: list[int] = []
    current = 0
    for value in mask.tolist():
        if value:
            current += 1
        elif current:
            runs.append(current)
            current = 0
    if current:
        runs.append(current)
    return runs


def _shape_pair(value: Any) -> tuple[int, int]:
    if isinstance(value, Mapping):
        h = value.get("h", value.get("height"))
        w = value.get("w", value.get("width"))
        return int(h), int(w)
    seq = [int(x) for x in value]
    if len(seq) == _FRAME_GRID_DIMENSIONS:
        seq = seq[1:]
    if len(seq) != _SPATIAL_DIMENSIONS:
        raise ValueError(value)
    return seq[0], seq[1]


def ref_shapes_from_meta(meta: Mapping[str, Any]) -> list[tuple[int, int]]:
    """ref_latents meta 的每張參考圖 latent (h, w)：``shapes`` 或 ``refs[i].shape``（[h,w]、[1,h,w] 或 {h,w}）."""
    raw = meta.get("shapes")
    if raw is None and isinstance(meta.get("refs"), list):
        raw = [r.get("shape") for r in meta["refs"] if isinstance(r, Mapping)]
    if not isinstance(raw, list) or not raw:
        raise ComponentError(
            "LATENT_MISMATCH",
            "ref_latents 的 meta 缺少每張參考圖的 latent 形狀（shapes）",
        )
    try:
        return [_shape_pair(v) for v in raw]
    except (TypeError, ValueError) as exc:
        raise ComponentError(
            "LATENT_MISMATCH", f"ref_latents 的 shapes 無法解析：{raw}"
        ) from exc


def _bool_mask(tensor: Any, name: str, length: int) -> Any:
    import torch

    if tensor is None:
        raise ComponentError("LATENT_MISMATCH", f"conditioning 缺少 {name}")
    if tensor.dim() != _MASK_RANK or tensor.shape[0] != 1 or tensor.shape[1] != length:
        raise ComponentError(
            "LATENT_MISMATCH",
            f"{name} 形狀 {list(tensor.shape)} 與 embeds 長度 {length} 不符",
        )
    if tensor.dtype != torch.bool:
        raise ComponentError(
            "LATENT_MISMATCH", f"{name} 必須是 bool（收到 {tensor.dtype}）"
        )
    return tensor


def check_inputs(  # noqa: PLR0913 - Keep the published runtime API.
    params: DitParams,
    cond_meta: Mapping[str, Any],
    cond: Mapping[str, Any],
    ref_meta: Mapping[str, Any] | None,
    ref_tensors: Mapping[str, Any] | None,
    *,
    context_dim: int,
    channels: int,
) -> dict[str, Any]:
    """conditioning／ref_latents 與參數的一致性；任何不符都 422（不 reshape、不轉 dtype、不猜）."""

    def branch(prefix: str) -> tuple[Any, Any, Any]:
        return _conditioning_branch(cond, prefix, context_dim)

    pos_embeds, pos_pad, pos_mask = branch("")
    has_neg = _check_guidance(cond, cond_meta, params)
    out: dict[str, Any] = {
        "cond_meta": dict(cond_meta),
        "pos_embeds": pos_embeds,
        "pos_pad": pos_pad,
        "pos_mask": pos_mask,
        "pos_len": int(pos_embeds.shape[1]),
        "pos_slots": int(pos_pad.sum()),
        "neg_embeds": None,
        "neg_pad": None,
        "neg_mask": None,
        "neg_len": 0,
        "neg_slots": 0,
    }
    if has_neg:
        neg_embeds, neg_pad, neg_mask = branch("neg_")
        out.update(
            neg_embeds=neg_embeds,
            neg_pad=neg_pad,
            neg_mask=neg_mask,
            neg_len=int(neg_embeds.shape[1]),
            neg_slots=int(neg_pad.sum()),
        )
        if out["neg_slots"] != out["pos_slots"]:
            raise ComponentError(
                "LATENT_MISMATCH",
                "正負向 conditioning 的影像槽數不同（必須以同一組參考圖編碼）",
            )

    slots = out["pos_slots"]
    if ref_tensors is None:
        if slots:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"conditioning 含 {slots} 個參考圖影像槽（圖生圖），但沒有接 ref_latents",
            )
        check_img_shapes(cond_meta.get("img_shapes"), [], params)
        out.update(ref_latents=None, ref_shapes=[])
        return out
    if ref_meta is None:
        raise AssertionError
    if not slots:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "接了 ref_latents，但 conditioning 是純文字（沒有參考圖影像槽）",
        )
    latents = _reference_latents(ref_tensors, channels)
    shapes, tokens = _reference_grid(ref_meta, latents, slots)
    _check_slot_order(pos_pad, shapes, tokens)
    _check_offsets(ref_meta, tokens)
    check_img_shapes(cond_meta.get("img_shapes"), shapes, params)
    out.update(ref_latents=latents, ref_shapes=shapes)
    return out


def _check_offsets(ref_meta: Mapping[str, Any], tokens: list[int]) -> None:
    offsets = ref_meta.get("offsets")
    if isinstance(offsets, list) and offsets:
        expected = [0]
        for t in tokens:
            expected.append(expected[-1] + t)
        if [int(x) for x in offsets] not in (expected, expected[:-1]):
            raise ComponentError(
                "LATENT_MISMATCH", f"ref_latents offsets {offsets} 與 shapes 不符"
            )


def _reference_grid(
    ref_meta: Mapping[str, Any], latents: Any, slots: int
) -> tuple[list[tuple[int, int]], list[int]]:
    shapes = ref_shapes_from_meta(ref_meta)
    tokens = [h * w for h, w in shapes]
    if any(h <= 0 or w <= 0 or (h * w) % 4 for h, w in shapes):
        raise ComponentError("LATENT_MISMATCH", f"參考圖 latent 形狀不合法：{shapes}")
    if sum(tokens) != int(latents.shape[1]):
        raise ComponentError(
            "LATENT_MISMATCH",
            f"ref_latents 有 {int(latents.shape[1])} 個 token，但 shapes 合計 {sum(tokens)}",
        )
    if sum(tokens) != 4 * slots:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"參考圖 latent token（{sum(tokens)}）與 conditioning 影像槽 ×4（{4 * slots}）不符；兩者必須來自同一份 prepared",
        )
    # Qwen 的 template 在每張圖之間都有文字 token（<imageN><|vision_start|>…），所以每張圖是一段獨立的連續影像槽
    return shapes, tokens


def _check_guidance(
    cond: Mapping[str, Any], cond_meta: Mapping[str, Any], params: DitParams
) -> bool:
    has_neg = cond.get("neg_prompt_embeds") is not None
    meta_cfg = cond_meta.get("cfg")
    if meta_cfg is not None and bool(meta_cfg) != has_neg:
        raise ComponentError(
            "LATENT_MISMATCH", "conditioning 的 meta.cfg 與是否含負向 embeds 不一致"
        )
    if params.cfg and not has_neg:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"guidance={params.guidance} > 1 會啟用 CFG，但 conditioning 沒有負向（以 cfg=false 編碼）；"
            "請讓 conditioning 的 cfg 參數與 DiT 的 guidance > 1 一致",
        )
    if not params.cfg and has_neg:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"guidance={params.guidance} ≤ 1 不使用 CFG，但 conditioning 以 cfg=true 編碼了負向；"
            "請讓 conditioning 的 cfg 參數與 DiT 的 guidance > 1 一致（不暗中忽略）",
        )
    return has_neg


def _check_slot_order(
    pos_pad: Any, shapes: list[tuple[int, int]], tokens: list[int]
) -> None:
    runs = _runs(pos_pad[0])
    if len(runs) != len(shapes):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"conditioning 有 {len(runs)} 段影像槽，ref_latents 有 {len(shapes)} 張參考圖；兩者必須來自同一份 prepared",
        )
    if [4 * r for r in runs] != tokens:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"每張參考圖的影像槽 {runs} 與 latent 形狀 {shapes} 不符（順序或來源不同）",
        )


def _reference_latents(ref_tensors: Mapping[str, Any], channels: int) -> Any:
    import torch

    latents = ref_tensors.get("ref_latents")
    if latents is None:
        raise ComponentError(
            "LATENT_MISMATCH", "ref_latents bundle 缺少 ref_latents tensor"
        )
    if (
        latents.dim() != _PACKED_RANK
        or latents.shape[0] != 1
        or int(latents.shape[2]) != channels
    ):
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"ref_latents 必須是 (1, N, {channels})，收到 {list(latents.shape)}",
        )
    if latents.dtype != torch.bfloat16:
        raise ComponentError(
            "LATENT_MISMATCH",
            f"ref_latents 必須是 bfloat16（收到 {latents.dtype}；不自動轉換）",
        )
    return latents


def _conditioning_branch(
    cond: Mapping[str, Any], prefix: str, context_dim: int
) -> tuple[Any, Any, Any]:
    import torch

    embeds = cond.get(f"{prefix}prompt_embeds")
    if embeds is None:
        raise ComponentError(
            "LATENT_MISMATCH", f"conditioning 缺少 {prefix}prompt_embeds"
        )
    if embeds.dim() != _PACKED_RANK or embeds.shape[0] != 1:
        raise ComponentError(
            "LATENT_MISMATCH",
            f"{prefix}prompt_embeds 必須是 (1, L, D)，收到 {list(embeds.shape)}",
        )
    if embeds.dtype != torch.bfloat16:
        raise ComponentError(
            "LATENT_MISMATCH",
            f"{prefix}prompt_embeds 必須是 bfloat16（收到 {embeds.dtype}；不自動轉換精度）",
        )
    if int(embeds.shape[2]) != context_dim:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"conditioning 的維度 {int(embeds.shape[2])} 與 Transformer context_in_dim {context_dim} 不相容",
        )
    length = int(embeds.shape[1])
    pad = _bool_mask(
        cond.get(f"{prefix}image_pad_mask"), f"{prefix}image_pad_mask", length
    )
    mask = cond.get(f"{prefix}prompt_mask")
    if mask is not None:
        mask = _bool_mask(mask, f"{prefix}prompt_mask", length)
        if bool(mask.all()):
            mask = None  # 與 encode_prompt 相同：沒有 padding 就不帶 mask（帶了會走不同 attention kernel）
    return embeds, pad, mask


def check_img_shapes(
    raw: Any, ref_shapes: list[tuple[int, int]], params: DitParams
) -> None:
    """Conditioning meta 的 img_shapes（TE 看到的每張參考圖 latent 形狀；若照 pipeline 的寫法多帶最後一個目標形狀， 也要等於 DiT 參數的 height/16、width/16）。缺少時不檢查（t2i 的 TE 不知道輸出尺寸）."""
    if not isinstance(raw, list) or not raw:
        return
    try:
        parsed = [_shape_pair(v) for v in raw]
    except (TypeError, ValueError) as exc:
        raise ComponentError(
            "LATENT_MISMATCH", f"conditioning 的 img_shapes 無法解析：{raw}"
        ) from exc
    target = (params.height // 16, params.width // 16)
    if len(parsed) == len(ref_shapes) + 1:
        if parsed[-1] != target:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"conditioning 以目標 {parsed[-1][1] * 16}×{parsed[-1][0] * 16} 編碼，DiT 參數是 {params.width}×{params.height}",
            )
        parsed = parsed[:-1]
    if parsed != list(ref_shapes):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"conditioning 的 img_shapes {parsed} 與 ref_latents 的 shapes {ref_shapes} 不同",
        )


__all__ = ["check_img_shapes", "check_inputs", "ref_shapes_from_meta"]
