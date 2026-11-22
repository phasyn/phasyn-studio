"""八區段場景的語意規則（JSON Schema 之外的語意檢查與轉換）.

wire 形狀（PromptScene、PromptComparison…）由 ``phasyn_components.contracts`` 以 JSON Schema 驗證；這裡補上
JSON Schema 表達不了的規則：observation 只能被同區段引用、subject 非空、自動產生的區段要有 observed 證據且
不可把 uncertain 寫成肯定句、zh-TW 要兩種語言都有、有意修改只能是鎖定區段、自動修訂不可改鎖定區段與其證據。

違反時丟 ``SceneError``（ValueError；訊息固定，模型輸出不合格時會原樣回饋給同一個 invoke 內唯一
一次的格式修復）。場景可以是完整的 PromptScene（有 ``prompt_language``／``locked``），也可以是模型輸出的
SceneDraft（沒有語言、沒有鎖定）。
"""

from __future__ import annotations

import copy
import json
from collections.abc import Iterable, Mapping
from typing import Any, Literal

from phasyn_components import contracts
from phasyn_components.canonical import canonical_json, digest
from phasyn_components.errors import ComponentError


SECTION_KEYS: tuple[str, ...] = (
    "subject",
    "action",
    "composition",
    "environment",
    "lighting",
    "appearance",
    "style",
    "visible_text",
)
LANGUAGES: tuple[str, ...] = ("en", "zh-TW")
SCENE_VIEWS: tuple[str, ...] = ("v-full", "v-crop-1", "v-crop-2")
Origin = Literal["analysis", "manual", "refinement"]


class SceneError(ValueError):
    """場景語意不合法."""


def canonical_text(value: Any) -> str:
    """Canonical JSON: sorted keys, non-ASCII unescaped, no whitespace, NaN rejected."""
    return canonical_json(value).decode("utf-8")


def scene_sha256(scene: Mapping[str, Any]) -> str:
    """Hash the canonical scene document."""
    return digest(scene)


def strict_json(raw: str | bytes) -> Any:
    """Strict JSON: duplicate keys and NaN/Infinity are rejected; no Markdown-fence stripping, no truncation repair."""

    def invalid_constant(_: str) -> None:
        raise ValueError("JSON 不可包含非有限數值")

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("JSON 不可包含重複鍵值")
            result[key] = value
        return result

    return json.loads(
        raw, parse_constant=invalid_constant, object_pairs_hook=unique_object
    )


def section_text(section: Mapping[str, Any], language: str) -> str:
    """只回傳該語言的生成欄位；不以 explanation 或另一種語言代替."""
    return str(
        section.get("text_zh_tw", "")
        if language == "zh-TW"
        else section.get("text_en", "")
    )


def is_document(scene: Mapping[str, Any]) -> bool:
    """完整場景（PromptScene）有 prompt_language；模型輸出的 SceneDraft 沒有."""
    return "prompt_language" in scene


def normalized_draft_section(section: Mapping[str, Any]) -> dict[str, Any]:
    """A SceneDraft section (text_zh_tw defaults to an empty string)."""
    return {
        "text_en": str(section["text_en"]),
        "text_zh_tw": str(section.get("text_zh_tw", "")),
        "explanation_zh_tw": str(section["explanation_zh_tw"]),
        "observation_ids": list(section["observation_ids"]),
    }


def validate_structure(scene: Mapping[str, Any]) -> None:
    """Non-empty subject, unique observation ids, every reference exists and belongs to the same section."""
    sections = scene["sections"]
    subject = sections["subject"]
    if is_document(scene):
        nonempty = section_text(subject, str(scene["prompt_language"])).strip()
    else:
        nonempty = (
            str(subject.get("text_en", "")).strip()
            or str(subject.get("text_zh_tw", "")).strip()
        )
    if not nonempty:
        raise SceneError("subject 不可空白")
    observations = {item["id"]: item for item in scene["observations"]}
    if len(observations) != len(scene["observations"]):
        raise SceneError("observation id 不得重複")
    invalid: list[str] = []
    for key in SECTION_KEYS:
        ids = list(sections[key]["observation_ids"])
        if len(set(ids)) != len(ids):
            invalid.append(f"{key}.observation_ids: 陣列內容不得重複")
        for observation_id in ids:
            observation = observations.get(observation_id)
            if observation is None:
                invalid.append(
                    f"{key}.observation_ids references missing {observation_id}"
                )
            elif observation["section"] != key:
                invalid.append(
                    f"{key}.observation_ids references {observation_id} "
                    f"with section={observation['section']}; expected section={key}"
                )
    if invalid:
        raise SceneError("Invalid observation references: " + "; ".join(invalid))


def validate_scene(
    scene: Mapping[str, Any],
    *,
    origin: Origin = "manual",
    view_ids: Iterable[str] | None = None,
    prompt_language: str | None = None,
) -> None:
    """Check the evidence according to where the scene came from.

    manual：只檢查結構（使用者可寫沒有證據的描述）。analysis：每個非空區段都要有 observed 證據、不可引用
    uncertain 證據、zh-TW 要兩種語言。refinement：同 analysis，但鎖定區段沿用原內容不再檢查。
    ``view_ids`` 是實際送進模型的視圖。
    """
    validate_structure(scene)
    document = is_document(scene)
    language = prompt_language or (str(scene["prompt_language"]) if document else "en")
    if document and scene["prompt_language"] != language:
        raise SceneError(
            "scene.prompt_language must match the requested prompt_language"
        )
    if (
        origin != "manual"
        and not section_text(scene["sections"]["subject"], language).strip()
    ):
        field = "text_zh_tw" if language == "zh-TW" else "text_en"
        raise SceneError(f"sections.subject.{field} must be nonempty for {language}")
    allowed = set(view_ids) if view_ids is not None else None
    observations = {item["id"]: item for item in scene["observations"]}
    for item in scene["observations"]:
        if allowed is not None and item["view_id"] not in allowed:
            raise SceneError(f"observation {item['id']} 引用了未提交的 view")
    if origin == "manual":
        return
    _check_section_evidence(scene, origin, language, observations)


def _check_section_evidence(
    scene: Mapping[str, Any],
    origin: Origin,
    language: str,
    observations: Mapping[str, Any],
) -> None:
    for key in SECTION_KEYS:
        section = scene["sections"][key]
        if origin == "refinement" and section.get("locked", False):
            continue
        nonempty = bool(
            str(section["text_en"]).strip() or section_text(section, language).strip()
        )
        if not nonempty:
            continue
        if language == "zh-TW" and (
            not str(section.get("text_zh_tw", "")).strip()
            or not str(section["text_en"]).strip()
        ):
            raise SceneError(
                f"sections.{key} must provide both text_en and text_zh_tw for zh-TW output"
            )
        evidence = [observations[item] for item in section["observation_ids"]]
        if not any(item["certainty"] == "observed" for item in evidence):
            raise SceneError(f"自動產生的 {key} 必須具有 observed 證據")
        if any(item["certainty"] == "uncertain" for item in evidence):
            raise SceneError(f"{key} 不可將 uncertain 證據編成肯定句")


def validate_intentional_changes(
    scene: Mapping[str, Any], changes: Iterable[str]
) -> list[str]:
    """有意修改必須是鎖定區段、不可重複；回傳依原順序的清單."""
    values = list(changes)
    for key in values:
        if key not in SECTION_KEYS:
            raise SceneError(f"未知的區段 {key!r}")
        if not scene["sections"][key]["locked"]:
            raise SceneError("intentional_changes 的所有區段必須 locked")
    if len(set(values)) != len(values):
        raise SceneError("intentional_changes 不得重複")
    return values


def _observation(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "view_id": item["view_id"],
        "section": item["section"],
        "claim_en": item["claim_en"],
        "certainty": item["certainty"],
    }


def _document(
    language: str,
    sections: Mapping[str, Any],
    observations: Iterable[Mapping[str, Any]],
    notes: Iterable[str],
) -> dict[str, Any]:
    scene = {
        "prompt_language": language,
        "schema_version": 1,
        "sections": {key: dict(sections[key]) for key in SECTION_KEYS},
        "observations": [_observation(item) for item in observations],
        "uncertainty_notes": [str(note) for note in notes],
    }
    problems = contracts.errors("PromptScene", scene)
    if problems:
        raise SceneError("場景不符合 PromptScene 契約：" + "; ".join(problems[:4]))
    validate_structure(scene)
    return scene


def draft_to_scene(
    draft: Mapping[str, Any], *, view_ids: Iterable[str] | None, prompt_language: str
) -> dict[str, Any]:
    """Analysis output (SceneDraft) → an unlocked PromptScene."""
    validate_scene(
        draft, origin="analysis", view_ids=view_ids, prompt_language=prompt_language
    )
    sections = {
        key: {**normalized_draft_section(draft["sections"][key]), "locked": False}
        for key in SECTION_KEYS
    }
    return _document(
        prompt_language, sections, draft["observations"], draft["uncertainty_notes"]
    )


def merge_revision(
    previous: Mapping[str, Any],
    draft: Mapping[str, Any],
    *,
    view_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Automatic revision: locked sections (with their observations) must be identical, else rejected; the rest is taken."""
    old = {item["id"]: item for item in previous["observations"]}
    new = {item["id"]: item for item in draft["observations"]}
    sections: dict[str, Any] = {}
    for key in SECTION_KEYS:
        before = previous["sections"][key]
        after = normalized_draft_section(draft["sections"][key])
        if before["locked"]:
            if {
                name: value for name, value in before.items() if name != "locked"
            } != after:
                raise SceneError(f"自動修訂不可修改鎖定的 {key}")
            for observation_id in before["observation_ids"]:
                if new.get(observation_id) != old[observation_id]:
                    raise SceneError(
                        f"自動修訂不可修改鎖定的 observation {observation_id}"
                    )
            sections[key] = copy.deepcopy(dict(before))
        else:
            sections[key] = {**after, "locked": False}
    scene = _document(
        str(previous["prompt_language"]),
        sections,
        draft["observations"],
        draft["uncertainty_notes"],
    )
    validate_scene(scene, origin="refinement", view_ids=view_ids)
    return scene


def require_scene(value: Any, *, what: str = "場景") -> dict[str, Any]:
    """輸入的 PromptScene：契約+結構檢查；不合格 → 422 INVALID_ARGUMENT."""
    contracts.validate("PromptScene", value, what=what)
    try:
        validate_structure(value)
    except SceneError as exc:
        raise ComponentError("INVALID_ARGUMENT", f"{what}不合法：{exc}") from exc
    return dict(value)


__all__ = [
    "LANGUAGES",
    "SCENE_VIEWS",
    "SECTION_KEYS",
    "SceneError",
    "canonical_text",
    "draft_to_scene",
    "is_document",
    "merge_revision",
    "normalized_draft_section",
    "require_scene",
    "scene_sha256",
    "section_text",
    "strict_json",
    "validate_intentional_changes",
    "validate_scene",
    "validate_structure",
]
