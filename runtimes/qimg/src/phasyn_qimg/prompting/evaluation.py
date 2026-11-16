"""凍結 rubric、逐區段加權損失、共同 seeds 排名與 A/B＋B/A 確認。

- rubric 在任務開始時由「當時的場景＋有意修改」凍結；之後修訂出的新場景不會改變評分基準。
  ``sha256``＝canonical JSON ``{applicable_sections, initial_scene, intentional_changes}`` 的 SHA-256。
- 損失＝Σ 權重×懲罰 ÷ 可判斷權重（match 0、minor 1、major 2、missing 3；uncertain／not_applicable 不計分
  但降低可判斷權重）。可判斷權重 < 75%、模型宣告無法判斷或沒有可判斷區段 → unverified、loss=null（不是 0）。
- 排名：不完整、未驗證或不同 rubric 的評估不能獲勝；挑戰者平均損失至少低 0.05 才有資格進入雙順序確認；
  代表圖取最接近平均損失的 seed（兩者不同時取現任最小 seed）。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from statistics import mean
from typing import Any

from phasyn_components.canonical import digest

from .scene import SECTION_KEYS, SceneError, scene_sha256, section_text, validate_intentional_changes

SCORER_VERSION = "prompt-score/1"
WEIGHTS: dict[str, int] = {
    "subject": 3,
    "action": 2,
    "composition": 3,
    "environment": 1,
    "lighting": 1,
    "appearance": 2,
    "style": 2,
    "visible_text": 3,
}
PENALTIES: dict[str, int] = {"match": 0, "minor": 1, "major": 2, "missing": 3}
VERIFIED_FRACTION = 0.75
IMPROVEMENT_THRESHOLD = 0.05
# Fixed instruction for revising a scene from a comparison (its first three differences); the Inference Studio
# frontend sends it explicitly with revise.
REFINE_FROM_COMPARISON_INSTRUCTION = "只優先修正比較中前三個可見差異，遵循凍結意圖並逐字保留所有鎖定區段及其證據。"


class EvaluationError(ValueError):
    """評估資料不一致（不同 rubric、seed 不齊、沒有可判斷候選…）。"""


def freeze_rubric(
    scene: Mapping[str, Any],
    intentional_changes: Iterable[str] = (),
    *,
    applicable_sections: Iterable[str] | None = None,
) -> dict[str, Any]:
    """適用區段來自原圖場景（非空區段），不是候選的判斷；沒有可見文字時 visible_text 不罰也不送分。"""
    changes = validate_intentional_changes(scene, intentional_changes)
    language = str(scene["prompt_language"])
    applicable = (
        set(applicable_sections)
        if applicable_sections is not None
        else {key for key in SECTION_KEYS if section_text(scene["sections"][key], language).strip()}
    )
    if not applicable or not applicable.issubset(SECTION_KEYS):
        raise SceneError("rubric 必須至少有一個有效適用區段")
    ordered = [key for key in SECTION_KEYS if key in applicable]
    data = {"initial_scene": scene, "intentional_changes": changes, "applicable_sections": ordered}
    return {
        "sha256": digest(data),
        "scene_sha256": scene_sha256(scene),
        "intentional_changes": changes,
        "applicable_sections": ordered,
    }


def evaluate_comparison(comparison: Mapping[str, Any], rubric: Mapping[str, Any]) -> dict[str, Any]:
    """PromptComparison × PromptRubric → PromptScore（逐區段明細）。"""
    applicable = list(rubric["applicable_sections"])
    intentional = set(rubric["intentional_changes"])
    applicable_weight = sum(WEIGHTS[key] for key in applicable)
    weighted_penalty = 0
    evaluable_weight = 0
    sections: dict[str, Any] = {}
    for key in SECTION_KEYS:
        label = str(comparison["sections"][key]["label"])
        is_applicable = key in applicable
        penalty = PENALTIES.get(label) if is_applicable else None
        if penalty is not None:
            evaluable_weight += WEIGHTS[key]
            weighted_penalty += WEIGHTS[key] * penalty
        sections[key] = {
            "label": label,
            "weight": WEIGHTS[key],
            "applicable": is_applicable,
            "intentional": key in intentional,
            "penalty": penalty,
            "weighted_penalty": float(WEIGHTS[key] * penalty) if penalty is not None else None,
        }
    fraction = evaluable_weight / applicable_weight if applicable_weight else 0.0
    reasons: list[str] = []
    if fraction < VERIFIED_FRACTION:
        reasons.append(f"可判斷權重 {fraction:.3f} 低於 {VERIFIED_FRACTION}")
    if comparison.get("unjudgeable_reason") is not None:
        reasons.append(f"模型宣告無法判斷：{str(comparison['unjudgeable_reason'])[:400]}")
    if not evaluable_weight:
        reasons.append("沒有可判斷的適用區段")
    unverified = bool(reasons)
    return {
        "scorer_version": SCORER_VERSION,
        "rubric": dict(rubric),
        "loss": None if unverified else weighted_penalty / evaluable_weight,
        "evaluable_weight_fraction": fraction,
        "unverified": unverified,
        "unverified_reasons": reasons,
        "sections": sections,
    }


@dataclass(frozen=True)
class Ranked:
    version_id: str
    version_number: int
    variant: str
    mean_loss: float | None
    complete: bool
    rows: tuple[Mapping[str, Any], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "version_id": self.version_id,
            "version_number": self.version_number,
            "variant": self.variant,
            "mean_loss": self.mean_loss,
            "complete": self.complete,
            "seeds": [int(row["seed"]) for row in self.rows],
        }


def rank_candidates(
    rows: Iterable[Mapping[str, Any]], search_seeds: Iterable[int], *, rubric_sha256: str | None = None
) -> list[Ranked]:
    """只用 split=search 的評估；同候選必須在每個共同 seed 都有已驗證的 loss 才算完整。"""
    seeds = tuple(int(seed) for seed in search_seeds)
    if not seeds or len(seeds) != len(set(seeds)):
        raise EvaluationError("搜尋 seeds 必須非空且不重複")
    search = [row for row in rows if row["split"] == "search"]
    if len({row["rubric_sha256"] for row in search}) > 1 or (
        rubric_sha256 is not None and any(row["rubric_sha256"] != rubric_sha256 for row in search)
    ):
        raise EvaluationError("不同 rubric 的評估不可直接排名")
    grouped: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    numbers: dict[str, int] = {}
    for row in search:
        if int(row["seed"]) not in seeds:
            raise EvaluationError("評估包含不屬於共同搜尋 seeds 的資料")
        version_id = str(row["version_id"])
        number = int(row["version_number"])
        if numbers.setdefault(version_id, number) != number:
            raise EvaluationError(f"版本 {version_id} 的 version_number 不一致")
        grouped.setdefault((version_id, str(row["variant"])), []).append(row)
    ranked: list[Ranked] = []
    for (version_id, variant), group in grouped.items():
        by_seed = {int(row["seed"]): row for row in group}
        if len(by_seed) != len(group):
            raise EvaluationError("同候選與 seed 不可具有重複評估")
        complete = set(by_seed) == set(seeds) and all(
            row["loss"] is not None and not row["unverified"] for row in group
        )
        average = mean(float(row["loss"]) for row in group if row["loss"] is not None) if complete else None
        ranked.append(
            Ranked(
                version_id,
                numbers[version_id],
                variant,
                average,
                complete,
                tuple(sorted(group, key=lambda row: int(row["seed"]))),
            )
        )
    return sorted(
        ranked,
        key=lambda item: (
            not item.complete,
            item.mean_loss if item.mean_loss is not None else float("inf"),
            item.variant != "core",
            item.version_number,
        ),
    )


def select_initial(ranked: Iterable[Ranked]) -> Ranked:
    valid = [item for item in ranked if item.complete and item.mean_loss is not None]
    if not valid:
        raise EvaluationError("沒有完整且可判斷的候選結果")
    return min(
        valid,
        key=lambda item: (
            item.mean_loss if item.mean_loss is not None else float("inf"),
            item.variant != "core",
            item.version_number,
        ),
    )


def _require_common_experiment(first: Ranked, second: Ranked) -> None:
    first_seeds = {int(row["seed"]) for row in first.rows}
    second_seeds = {int(row["seed"]) for row in second.rows}
    if not first_seeds or first_seeds != second_seeds:
        raise EvaluationError("候選必須具有相同完整搜尋 seeds")
    if len({row["rubric_sha256"] for row in (*first.rows, *second.rows)}) != 1:
        raise EvaluationError("候選必須來自同一個凍結實驗")


def improvement_eligible(incumbent: Ranked, challenger: Ranked) -> bool:
    if not incumbent.complete or not challenger.complete:
        return False
    if incumbent.mean_loss is None or challenger.mean_loss is None:
        return False
    _require_common_experiment(incumbent, challenger)
    return incumbent.mean_loss - challenger.mean_loss >= IMPROVEMENT_THRESHOLD - 1e-12


def representative_pair(incumbent: Ranked, challenger: Ranked) -> dict[str, int]:
    if not incumbent.complete or not challenger.complete:
        raise EvaluationError("代表圖需來自完整候選")
    if incumbent.mean_loss is None or challenger.mean_loss is None:
        raise EvaluationError("代表圖需具有可判斷 loss")
    _require_common_experiment(incumbent, challenger)
    incumbent_mean = incumbent.mean_loss
    challenger_mean = challenger.mean_loss
    first = min(
        incumbent.rows,
        key=lambda row: (
            abs(float(row["loss"]) - incumbent_mean) if row["loss"] is not None else float("inf"),
            int(row["seed"]),
        ),
    )
    second = min(
        challenger.rows,
        key=lambda row: (
            abs(float(row["loss"]) - challenger_mean) if row["loss"] is not None else float("inf"),
            int(row["seed"]),
        ),
    )
    seed = int(first["seed"]) if first["seed"] == second["seed"] else min(int(row["seed"]) for row in incumbent.rows)
    return {"seed": seed, "incumbent_seed": seed, "challenger_seed": seed}


def pairwise_confirms(ab_winner: str, ba_winner: str, *, challenger_first: bool = False) -> bool:
    """預設第一次 A＝現任、B＝挑戰者，第二次交換圖片；兩次都選挑戰者才確認。"""
    expected_first, expected_second = ("A", "B") if challenger_first else ("B", "A")
    return ab_winner == expected_first and ba_winner == expected_second


def ranking(evaluations: Mapping[str, Any]) -> dict[str, Any]:
    """PromptEvaluationSet → PromptRanking（op=rank）。"""
    ranked = rank_candidates(
        evaluations["items"], evaluations["search_seeds"], rubric_sha256=str(evaluations["rubric_sha256"])
    )
    try:
        best = select_initial(ranked)
        initial: dict[str, str] | None = {"version_id": best.version_id, "variant": best.variant}
        initial_reason = None
    except EvaluationError as exc:
        initial, initial_reason = None, str(exc)
    improvement: dict[str, Any] | None = None
    incumbent_ref = evaluations.get("incumbent")
    challenger_ref = evaluations.get("challenger")
    if incumbent_ref is not None and challenger_ref is not None:
        by_key = {(item.version_id, item.variant): item for item in ranked}
        incumbent = by_key.get((str(incumbent_ref["version_id"]), str(incumbent_ref["variant"])))
        challenger = by_key.get((str(challenger_ref["version_id"]), str(challenger_ref["variant"])))
        if incumbent is None or challenger is None:
            improvement = {
                "eligible": False,
                "delta": None,
                "threshold": IMPROVEMENT_THRESHOLD,
                "reason": "現任或挑戰者沒有搜尋評估",
                "representative_pair": None,
            }
        else:
            eligible = improvement_eligible(incumbent, challenger)
            delta = (
                incumbent.mean_loss - challenger.mean_loss
                if incumbent.mean_loss is not None and challenger.mean_loss is not None
                else None
            )
            reason = None
            if not (incumbent.complete and challenger.complete):
                reason = "現任或挑戰者的評估不完整或未驗證"
            elif not eligible:
                reason = f"平均損失改善 {delta:.3f} 未達門檻 {IMPROVEMENT_THRESHOLD}"
            improvement = {
                "eligible": eligible,
                "delta": delta,
                "threshold": IMPROVEMENT_THRESHOLD,
                "reason": reason,
                "representative_pair": representative_pair(incumbent, challenger) if eligible else None,
            }
    return {
        "ranked": [item.to_dict() for item in ranked],
        "initial": initial,
        "initial_reason": initial_reason,
        "improvement": improvement,
    }


__all__ = [
    "IMPROVEMENT_THRESHOLD",
    "PENALTIES",
    "REFINE_FROM_COMPARISON_INSTRUCTION",
    "SCORER_VERSION",
    "VERIFIED_FRACTION",
    "WEIGHTS",
    "EvaluationError",
    "Ranked",
    "evaluate_comparison",
    "freeze_rubric",
    "improvement_eligible",
    "pairwise_confirms",
    "rank_candidates",
    "ranking",
    "representative_pair",
    "select_initial",
]
