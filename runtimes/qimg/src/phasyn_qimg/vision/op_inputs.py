"""Request validation of ``qimg.vision`` ops: each op takes a fixed set of inputs and parameters (torch-free)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.provider import RunContext

from ..prompting.scene import SceneError, require_scene, validate_intentional_changes

OP_INPUTS: dict[str, tuple[set[str], set[str]]] = {
    "caption": ({"image"}, {"image"}),
    "analyze": ({"image", "caption"}, {"image", "caption"}),
    "revise": ({"image", "scene"}, {"image", "scene", "comparison"}),
    "compare": ({"image", "generated", "scene"}, {"image", "generated", "scene"}),
    "pairwise": ({"image", "candidate_a", "candidate_b", "scene"}, {"image", "candidate_a", "candidate_b", "scene"}),
}


def build_request(ctx: RunContext, op: str, language: str, params: Mapping[str, Any]) -> dict[str, Any]:
    """The op's inputs and parameters checked against its fixed rules (anything extra or missing is a 422)."""
    required, allowed = OP_INPUTS[op]
    given = set(ctx.inputs)
    missing = sorted(required - given)
    extra = sorted(given - allowed)
    if missing or extra:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"op={op} 的輸入不符："
            + (f"缺少 {', '.join(missing)}" if missing else "")
            + ("；" if missing and extra else "")
            + (f"不使用 {', '.join(extra)}（不默默忽略）" if extra else ""),
            details={"op": op, "missing_inputs": missing, "unexpected_inputs": extra},
        )
    instruction = str(params.get("instruction") or "")
    intentional = list(params.get("intentional_changes") or [])
    crops = [dict(item) for item in params.get("crops") or []]
    if crops and op not in ("analyze", "revise"):
        raise ComponentError("INVALID_ARGUMENT", f"op={op} 只看整張原圖，不接受 crops")
    if len({item["view_id"] for item in crops}) != len(crops):
        raise ComponentError("INVALID_ARGUMENT", "裁切 view_id 不得重複")
    for item in crops:
        if not (float(item["x0"]) < float(item["x1"]) and float(item["y0"]) < float(item["y1"])):
            raise ComponentError("INVALID_ARGUMENT", "裁切需符合 x0<x1、y0<y1", details={"crop": item})
    if instruction and op != "revise":
        raise ComponentError("INVALID_ARGUMENT", f"op={op} 不接受 instruction")
    if intentional and op in ("caption", "analyze"):
        raise ComponentError("INVALID_ARGUMENT", f"op={op} 不接受 intentional_changes")
    caption = ""
    if op == "analyze":
        value = ctx.input("caption").value
        if not isinstance(value, str) or not value.strip():
            raise ComponentError("INVALID_ARGUMENT", "analyze 需要非空的 caption 文字（假設，不是事實來源）")
        if len(value) > 12000:
            raise ComponentError("INVALID_ARGUMENT", "caption 超過 12,000 字元")
        caption = value
    scene = None
    if "scene" in given:
        scene = require_scene(ctx.input("scene").value, what="輸入場景")
        if scene["prompt_language"] != language:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"場景語言 {scene['prompt_language']} 與 language={language} 不同（不自動翻譯）",
            )
        try:
            intentional = validate_intentional_changes(scene, intentional)
        except SceneError as exc:
            raise ComponentError("INVALID_ARGUMENT", str(exc)) from exc
    comparison = None
    if "comparison" in given:
        comparison = ctx.input("comparison").value
        contracts.validate("PromptComparison", comparison, what="比較結果")
    if op == "revise" and comparison is None and not instruction.strip():
        raise ComponentError("INVALID_ARGUMENT", "revise 需要 comparison 輸入或非空的 instruction")
    return {
        "caption": caption,
        "scene": scene,
        "instruction": instruction,
        "comparison": comparison,
        "intentional_changes": intentional,
        "crops": crops,
    }


__all__ = ["OP_INPUTS", "build_request"]
