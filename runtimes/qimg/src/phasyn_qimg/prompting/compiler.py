"""Deterministic prompt compilation: no model is loaded and no facts are added.

core = subject/action/composition/style/visible_text + intentional changes + locked sections; detailed = every
non-empty section. Each line is one section's generation text in the study language (text_zh_tw for zh-TW,
text_en for en), joined with newlines in the fixed section order. Both candidates are kept even when identical
(identical=true); the generation side deduplicates. More than 12,000 characters → 422 PROMPT_TOO_LONG (never
truncated).

Token counts are not estimated here: the real limit depends on the Qwen-Image prompt template and text encoder,
so qimg.conditioning checks it with the actual processor at generation time (over → 422, never truncated).
Candidates therefore always carry token_status=unchecked and target_tokens=null.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from hashlib import sha256
from typing import Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError

from .scene import (
    SECTION_KEYS,
    SceneError,
    scene_sha256,
    section_text,
    validate_intentional_changes,
    validate_scene,
)


COMPILER_VERSION = "prompt-compiler/1"
CORE_SECTIONS = frozenset({"subject", "action", "composition", "style", "visible_text"})
PROMPT_CHAR_LIMIT = 12000
UNCHECKED_TOKENS_REASON = "CPU 編譯不載入 tokenizer；實際 token 數由 qimg.conditioning 在生成時以實際 processor 檢查（超過上限 422，不截斷）"


# The rule data that determines the compiled prompts. ``compiler_sha256`` is its canonical-JSON digest, so it
# changes exactly when a rule changes (editing comments or refactoring never does). Change this data together with
# COMPILER_VERSION whenever the compilation rules change.
COMPILER_RULES: dict[str, Any] = {
    "version": COMPILER_VERSION,
    "section_order": list(SECTION_KEYS),
    "core_sections": sorted(CORE_SECTIONS),
    "core_also_includes": ["intentional_changes", "locked_sections"],
    "text_field": {"en": "text_en", "zh-TW": "text_zh_tw"},
    "joiner": "\n",
    "char_limit": PROMPT_CHAR_LIMIT,
}


def compiler_sha256() -> str:
    """SHA-256 of the compilation rules (detects rule changes across experiments)."""
    return digest(COMPILER_RULES)


def compile_scene(
    scene: Mapping[str, Any],
    intentional_changes: Iterable[str] = (),
    *,
    view_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    """PromptScene → PromptCandidates（core 在前）。場景語意不合法 → 422 INVALID_ARGUMENT."""
    try:
        validate_scene(scene, origin="manual", view_ids=view_ids)
        changes = validate_intentional_changes(scene, intentional_changes)
    except SceneError as exc:
        raise ComponentError("INVALID_ARGUMENT", f"場景不合法：{exc}") from exc
    language = str(scene["prompt_language"])
    intentional = set(changes)
    locked = {key for key in SECTION_KEYS if scene["sections"][key]["locked"]}
    core = CORE_SECTIONS | intentional | locked
    items: list[dict[str, Any]] = []
    for variant in ("core", "detailed"):
        keys = [
            key
            for key in SECTION_KEYS
            if (variant == "detailed" or key in core)
            and section_text(scene["sections"][key], language).strip()
        ]
        prompt = "\n".join(
            section_text(scene["sections"][key], language).strip() for key in keys
        )
        if len(prompt) > PROMPT_CHAR_LIMIT:
            raise ComponentError(
                "PROMPT_TOO_LONG",
                f"{variant} 超過 12,000 Unicode 字元（{len(prompt)}）；不截斷，請縮短場景描述",
                details={
                    "variant": variant,
                    "chars": len(prompt),
                    "limit": PROMPT_CHAR_LIMIT,
                },
                status=422,
            )
        items.append(
            {
                "variant": variant,
                "prompt": prompt,
                "prompt_sha256": sha256(prompt.encode("utf-8")).hexdigest(),
                "sections": keys,
                "token_status": "unchecked",
                "target_tokens": None,
                "token_reason": UNCHECKED_TOKENS_REASON,
            }
        )
    result = {
        "compiler_version": COMPILER_VERSION,
        "compiler_sha256": compiler_sha256(),
        "language": language,
        "scene_sha256": scene_sha256(scene),
        "intentional_changes": [key for key in SECTION_KEYS if key in intentional],
        "identical": items[0]["prompt_sha256"] == items[1]["prompt_sha256"],
        "items": items,
    }
    contracts.validate(
        "PromptCandidates", result, code="RUNTIME_ERROR", what="編譯結果"
    )
    return result


def unique_candidates(items: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """每個不同 prompt 只留一個（core 優先）；生成與搜尋用這個去重."""
    result: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if item["prompt_sha256"] not in seen:
            result.append(item)
            seen.add(str(item["prompt_sha256"]))
    return result


__all__ = [
    "COMPILER_RULES",
    "COMPILER_VERSION",
    "CORE_SECTIONS",
    "PROMPT_CHAR_LIMIT",
    "compile_scene",
    "compiler_sha256",
    "unique_candidates",
]
