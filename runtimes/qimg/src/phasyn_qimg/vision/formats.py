"""op × output format → template, schema and converter; strict parsing and conversion of the raw model output.

The output format is an explicit setting (``provider_options.output_format``), never chosen by model size:

- ``compact`` (flat formats designed for Qwen3-VL-4B): analyze/revise use per-section inline evidence
  (inline-scene/1; the server assigns o001-style IDs), compare uses eight flat metrics (flat-comparison/1) and
  pairwise uses the flat 4B instructions.
- ``full`` (the complete schemas, for 8B/32B): the model writes SceneDraft/Comparison/Pairwise directly.

Conversions only change structure: nothing is filled in, relabelled or dropped, and an invalid output stays invalid
(its errors feed the single repair). The one exception is evidence the model writes inside a locked section of a
compact revision: a locked section always keeps the previous scene's evidence, so those observations are not used;
they are counted in ``Parsed.ignored_locked_observations`` and reported, never merged.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from phasyn_components import contracts

from ..prompting.scene import (
    SECTION_KEYS,
    SceneError,
    draft_to_scene,
    merge_revision,
    normalized_draft_section,
    strict_json,
    validate_scene,
    validate_structure,
)
from .templates import model_schema

OPS: tuple[str, ...] = ("caption", "analyze", "revise", "compare", "pairwise")
OUTPUT_FORMATS: tuple[str, ...] = ("compact", "full")
COMPACT_SCENE_FORMAT = "inline-scene/1"
# /2: observations inside a locked section are ignored and reported (/1 rejected the whole output)
COMPACT_SCENE_CONVERTER = "inline-scene-to-draft/2"
COMPACT_COMPARISON_FORMAT = "flat-comparison/1"
COMPACT_COMPARISON_CONVERTER = "flat-comparison-to-public/1"
REPAIR_INPUT_POLICY = "bounded-repair-input/1"
MAX_ERRORS = 8


class OutputInvalid(ValueError):
    """模型輸出不符合契約；``errors`` 原樣回饋給修復（最多 8 條、每條 1000 字）。"""

    def __init__(self, errors: Iterable[str]) -> None:
        self.errors = tuple(str(item)[:1000] or "invalid" for item in errors)[:MAX_ERRORS] or ("invalid",)
        super().__init__("; ".join(self.errors))


@dataclass(frozen=True)
class OpFormat:
    op: str
    compact: bool

    @property
    def output_format(self) -> str:
        if self.op == "caption":
            return "plain-caption/1"
        if self.op in ("analyze", "revise"):
            return COMPACT_SCENE_FORMAT if self.compact else "scene-draft/1"
        if self.op == "compare":
            return COMPACT_COMPARISON_FORMAT if self.compact else "comparison/1"
        return "pairwise/1"

    @property
    def compact_scene(self) -> bool:
        return self.compact and self.op in ("analyze", "revise")

    @property
    def compact_comparison(self) -> bool:
        return self.compact and self.op == "compare"

    @property
    def compact_pairwise(self) -> bool:
        return self.compact and self.op == "pairwise"

    @property
    def template_name(self) -> str:
        if self.compact_scene:
            return "qwen_scene_inline"
        if self.compact_comparison:
            return "qwen_compare_flat"
        if self.compact_pairwise:
            return "qwen_pairwise_4b"
        return f"qwen_{self.op}"

    @property
    def repair_template_name(self) -> str | None:
        if self.op == "caption":
            return None  # caption 是純文字，不做 JSON schema 修復
        if self.compact_scene:
            return "qwen_scene_inline_repair"
        if self.compact_comparison:
            return "qwen_compare_flat_repair"
        if self.compact_pairwise:
            return "qwen_pairwise_4b_repair"
        return "qwen_repair"

    @property
    def schema_name(self) -> str | None:
        if self.op == "caption":
            return None
        if self.op in ("analyze", "revise"):
            return "CompactScene" if self.compact else "SceneDraft"
        if self.op == "compare":
            return "CompactComparison" if self.compact else "Comparison"
        return "Pairwise"

    @property
    def converter(self) -> str | None:
        if self.compact_scene:
            return COMPACT_SCENE_CONVERTER
        if self.compact_comparison:
            return COMPACT_COMPARISON_CONVERTER
        return None

    @property
    def repairable(self) -> bool:
        return self.op != "caption"


def op_format(op: str, output_format: str) -> OpFormat:
    if op not in OPS:
        raise ValueError(f"未知的 op {op!r}")
    if output_format not in OUTPUT_FORMATS:
        raise ValueError(f"未知的 output_format {output_format!r}")
    return OpFormat(op, output_format == "compact")


# ---------------------------------------------------------------------- schema validation
def schema_errors(name: str, value: Any) -> list[str]:
    from jsonschema import Draft202012Validator

    validator = Draft202012Validator(model_schema(name))
    out: list[str] = []
    for error in sorted(validator.iter_errors(value), key=lambda item: [str(p) for p in item.absolute_path]):
        location = ".".join(str(part) for part in error.absolute_path) or "(root)"
        out.append(f"{location}: {error.message}"[:1000])
        if len(out) >= MAX_ERRORS:
            break
    return out


def _check_schema(name: str, value: Any) -> None:
    problems = schema_errors(name, value)
    if problems:
        raise OutputInvalid(problems)


def _compact_scene_semantics(value: Mapping[str, Any]) -> None:
    """CompactScene 的 pydantic validators：claim 不可空白、全部 observation ≤80。"""
    total = 0
    for key in SECTION_KEYS:
        for index, item in enumerate(value["sections"][key]["observations"]):
            total += 1
            if not str(item["claim_en"]).strip():
                raise OutputInvalid([f"sections.{key}.observations.{index}: inline observation.claim_en 不可空白"])
    if total > 80:
        raise OutputInvalid(["inline observations 總數不得超過 80"])


def _compact_comparison_semantics(value: Mapping[str, Any]) -> None:
    for index, item in enumerate(value["metrics"]):
        if not str(item["evidence_zh_tw"]).strip():
            raise OutputInvalid([f"metrics.{index}: metric.evidence_zh_tw 不可空白"])
    names = [item["section"] for item in value["metrics"]]
    if len(set(names)) != len(SECTION_KEYS) or set(names) != set(SECTION_KEYS):
        duplicate = sorted({key for key in names if names.count(key) > 1})
        missing = sorted(set(SECTION_KEYS) - set(names))
        raise OutputInvalid([f"metrics 必須包含每個 section 恰好一次；duplicate={duplicate}, missing={missing}"])


def _unique_sections(values: list[Any], where: str) -> None:
    if len({str(item) for item in values}) != len(values):
        raise OutputInvalid([f"{where}: 陣列內容不得重複"])


# ---------------------------------------------------------------------- conversions
def compact_to_scene_draft(
    compact: Mapping[str, Any],
    *,
    previous: Mapping[str, Any] | None,
    view_ids: Iterable[str],
    language: str,
) -> dict[str, Any]:
    """Only assigns structural references (o001…); never creates, translates or repairs the model's statements.

    On revise the whole ID space of the previous scene (unlocked sections included) stays reserved, so a new
    statement never reuses an ID that belongs to other evidence. A locked section must repeat its three text fields
    byte for byte (anything else is rejected) and always keeps all of its previous evidence, including evidence the
    user kept by hand. Observations the model writes inside a locked section are therefore not used (the 4B model
    tends to fill them in even when told to return []); :func:`ignored_locked_observations` reports them.
    """
    views = list(view_ids)
    old_observations = {item["id"]: item for item in previous["observations"]} if previous else {}
    used_ids = set(old_observations)
    observations: list[dict[str, Any]] = []
    sections: dict[str, dict[str, Any]] = {}
    next_id = 1
    for key in SECTION_KEYS:
        supplied = compact["sections"][key]
        before = previous["sections"][key] if previous is not None else None
        if before is not None and before["locked"]:
            for name in ("text_en", "text_zh_tw", "explanation_zh_tw"):
                if str(supplied.get(name, "")) != str(before[name]):
                    raise SceneError(f"自動修訂不可修改鎖定的 {key}.{name}")
            sections[key] = {name: before[name] for name in ("text_en", "text_zh_tw", "explanation_zh_tw")}
            sections[key]["observation_ids"] = list(before["observation_ids"])
            observations.extend(dict(item) for item in old_observations.values() if item["section"] == key)
            continue
        text_en = str(supplied["text_en"])
        text_zh_tw = str(supplied.get("text_zh_tw", ""))
        if text_en.strip() or text_zh_tw.strip():
            if not any(item["certainty"] == "observed" for item in supplied["observations"]):
                raise SceneError(f"自動產生的 {key} 必須具有 observed 證據")
            if any(item["certainty"] == "uncertain" for item in supplied["observations"]):
                raise SceneError(f"{key} 不可將 uncertain 證據編成肯定句")
        ids: list[str] = []
        for evidence in supplied["observations"]:
            while f"o{next_id:03d}" in used_ids:
                next_id += 1
            if next_id > 999:
                raise SceneError("observation ID 空間不足")
            observation_id = f"o{next_id:03d}"
            next_id += 1
            used_ids.add(observation_id)
            ids.append(observation_id)
            observations.append(
                {
                    "id": observation_id,
                    "view_id": evidence["view_id"],
                    "section": key,
                    "claim_en": evidence["claim_en"],
                    "certainty": evidence["certainty"],
                }
            )
        sections[key] = {
            "text_en": text_en,
            "text_zh_tw": text_zh_tw,
            "explanation_zh_tw": str(supplied["explanation_zh_tw"]),
            "observation_ids": ids,
        }
    draft = {
        "sections": sections,
        "observations": observations,
        "uncertainty_notes": list(compact["uncertainty_notes"]),
    }
    _check_schema("SceneDraft", draft)
    validate_structure(draft)
    if previous is None:
        validate_scene(draft, origin="analysis", view_ids=views, prompt_language=language)
    else:
        merge_revision(previous, draft, view_ids=views)
    return draft


def ignored_locked_observations(compact: Mapping[str, Any], previous: Mapping[str, Any] | None) -> dict[str, int]:
    """Number of observations the model wrote inside each locked section; they are not used (see above)."""
    if previous is None:
        return {}
    return {
        key: len(compact["sections"][key]["observations"])
        for key in SECTION_KEYS
        if previous["sections"][key]["locked"] and compact["sections"][key]["observations"]
    }


def compact_to_comparison(compact: Mapping[str, Any]) -> dict[str, Any]:
    """Flat metrics → public PromptComparison; nothing is filled in, relabelled or dropped."""
    by_section = {item["section"]: item for item in compact["metrics"]}
    return {
        "schema_version": 1,
        "sections": {
            key: {"label": by_section[key]["label"], "evidence_zh_tw": by_section[key]["evidence_zh_tw"]}
            for key in SECTION_KEYS
        },
        "unexpected_elements": list(compact["unexpected_elements"]),
        "differences": [dict(item) for item in compact["differences"]],
        "text_transcription": compact["text_transcription"],
        "unjudgeable_reason": compact["unjudgeable_reason"],
    }


# ---------------------------------------------------------------------- parse
@dataclass
class Parsed:
    caption: str | None = None
    scene: dict[str, Any] | None = None
    comparison: dict[str, Any] | None = None
    pairwise: dict[str, Any] | None = None
    # compact revise: observations the model wrote inside locked sections, per section (not used)
    ignored_locked_observations: dict[str, int] = field(default_factory=dict)


def parse_output(
    fmt: OpFormat,
    raw: str,
    finish_reason: str,
    *,
    language: str,
    view_ids: Iterable[str],
    previous_scene: Mapping[str, Any] | None,
) -> Parsed:
    """模型原始文字 → 驗證過的公開結果；任何不合格都丟 OutputInvalid（附可回饋的錯誤）。"""
    if finish_reason == "length":
        raise OutputInvalid(["模型達輸出 token 上限，輸出已截斷"])
    if not raw.strip():
        raise OutputInvalid(["模型輸出空白"])
    if fmt.op == "caption":
        return Parsed(caption=raw.strip())
    try:
        value = strict_json(raw)
    except ValueError as exc:  # json.JSONDecodeError 也是 ValueError
        raise OutputInvalid([str(exc)]) from exc
    views = list(view_ids)
    assert fmt.schema_name is not None
    _check_schema(fmt.schema_name, value)
    try:
        if fmt.op in ("analyze", "revise"):
            previous = previous_scene if fmt.op == "revise" else None
            ignored: dict[str, int] = {}
            if fmt.compact_scene:
                _compact_scene_semantics(value)
                draft = compact_to_scene_draft(value, previous=previous, view_ids=views, language=language)
                ignored = ignored_locked_observations(value, previous)
            else:
                draft = {
                    "sections": {key: normalized_draft_section(value["sections"][key]) for key in SECTION_KEYS},
                    "observations": [dict(item) for item in value["observations"]],
                    "uncertainty_notes": list(value["uncertainty_notes"]),
                }
                validate_structure(draft)
            if previous is None:
                return Parsed(scene=draft_to_scene(draft, view_ids=views, prompt_language=language))
            return Parsed(scene=merge_revision(previous, draft, view_ids=views), ignored_locked_observations=ignored)
        if fmt.op == "compare":
            if fmt.compact_comparison:
                _compact_comparison_semantics(value)
                comparison = compact_to_comparison(value)
            else:
                comparison = dict(value)
            problems = contracts.errors("PromptComparison", comparison)
            if problems:
                raise OutputInvalid(problems)
            return Parsed(comparison=comparison)
        _unique_sections(list(value["violated_sections"]), "violated_sections")
        problems = contracts.errors("PromptPairwise", value)
        if problems:
            raise OutputInvalid(problems)
        return Parsed(pairwise=dict(value))
    except SceneError as exc:
        raise OutputInvalid([str(exc)]) from exc


__all__ = [
    "COMPACT_COMPARISON_CONVERTER",
    "COMPACT_COMPARISON_FORMAT",
    "COMPACT_SCENE_CONVERTER",
    "COMPACT_SCENE_FORMAT",
    "OPS",
    "OUTPUT_FORMATS",
    "REPAIR_INPUT_POLICY",
    "OpFormat",
    "OutputInvalid",
    "Parsed",
    "compact_to_comparison",
    "compact_to_scene_draft",
    "ignored_locked_observations",
    "op_format",
    "parse_output",
    "schema_errors",
]
