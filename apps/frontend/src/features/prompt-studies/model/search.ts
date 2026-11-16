// 有界搜尋的設定、上界與排名（純函式；誤差規則與 phasyn_qimg.prompting.evaluation 相同）。
// 上界：每輪最多 2 個候選 × 搜尋 seed，加上 2 個候選 × 保留驗證 seed；預設 16 張、上限 32 張、4 輪、96 次視覺操作。
// 只有完整（每個搜尋 seed 都有可判斷誤差）的候選能排名；挑戰者至少要比目前最佳低 0.05，並在 A/B 與 B/A 兩個順序都勝出。
import type { CandidateRef, EvaluationRef, PromptPairwise, PromptVariant } from "../types";
import { parseSeedList } from "./seeds";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export const SEARCH_LIMITS = {
  defaultImages: 16,
  maxImages: 32,
  minImages: 4,
  maxRounds: 4,
  maxVisionOps: 96,
  searchSeeds: { min: 1, max: 4 },
  holdoutSeeds: { min: 2, max: 4 },
  stopAfter: { min: 1, max: 3 },
  /** 挑戰者的平均誤差至少要低這麼多才進入雙順序確認。 */
  improvement: 0.05,
} as const;

export interface SearchDraft {
  searchSeeds: string;
  holdoutSeeds: string;
  rounds: string;
  budget: string;
  stopAfter: string;
}

export const INITIAL_SEARCH: SearchDraft = { searchSeeds: "42, 43", holdoutSeeds: "142, 143", rounds: "3", budget: "16", stopAfter: "1" };

export interface SearchPlan {
  searchSeeds: number[];
  holdoutSeeds: number[];
  rounds: number;
  budget: number;
  stopAfter: number;
  /** 最壞情況需要的圖片數。 */
  requiredImages: number;
  /** 最壞情況的視覺操作數（比較＋修訂＋雙順序比較）。 */
  visionOps: number;
}

/** 最壞情況的圖片數：2 × 搜尋 seed × 輪數 + 2 × 保留驗證 seed。 */
export function requiredImages(searchSeeds: number, holdoutSeeds: number, rounds: number): number {
  return 2 * searchSeeds * rounds + 2 * holdoutSeeds;
}

/** 最壞情況的視覺操作數：每張圖一次比較；第 2 輪起每輪一次修訂與一組 A/B＋B/A。 */
export function visionOpsUpperBound(searchSeeds: number, holdoutSeeds: number, rounds: number): number {
  const extraRounds = Math.max(0, rounds - 1);
  return requiredImages(searchSeeds, holdoutSeeds, rounds) + extraRounds * 3;
}

export type SearchValidation = { ok: true; plan: SearchPlan } | { ok: false; errors: string[]; requiredImages: number | null; visionOps: number | null };

function integerIn(text: string, min: number, max: number, label: string, errors: string[]): number | null {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isInteger(value) || value < min || value > max) {
    errors.push(t("{label}必須是 {min}–{max} 的整數", { label, min, max }));
    return null;
  }
  return value;
}

/** 設定檢查：seed 個數與範圍、搜尋／保留驗證 seed 不重疊、輪數、預算足以涵蓋最壞情況且不超過上限、視覺操作不超過 96。 */
export function validateSearch(draft: SearchDraft): SearchValidation {
  const errors: string[] = [];
  const search = parseSeedList(draft.searchSeeds, { label: t("搜尋 seed"), ...SEARCH_LIMITS.searchSeeds, unique: true });
  const holdout = parseSeedList(draft.holdoutSeeds, { label: t("保留驗證 seed"), ...SEARCH_LIMITS.holdoutSeeds, unique: true });
  if (!search.ok) errors.push(search.error);
  if (!holdout.ok) errors.push(holdout.error);
  if (search.ok && holdout.ok) {
    const overlap = search.seeds.filter((seed) => holdout.seeds.includes(seed));
    if (overlap.length > 0) errors.push(t("搜尋與保留驗證 seed 不可重疊（{overlap}）", { overlap: formatList(overlap) }));
  }
  const rounds = integerIn(draft.rounds, 1, SEARCH_LIMITS.maxRounds, t("輪數"), errors);
  const budget = integerIn(draft.budget, SEARCH_LIMITS.minImages, SEARCH_LIMITS.maxImages, t("圖片預算"), errors);
  const stopAfter = integerIn(draft.stopAfter, SEARCH_LIMITS.stopAfter.min, SEARCH_LIMITS.stopAfter.max, t("無改善停止輪數"), errors);
  const required = search.ok && holdout.ok && rounds !== null ? requiredImages(search.seeds.length, holdout.seeds.length, rounds) : null;
  const visionOps = search.ok && holdout.ok && rounds !== null ? visionOpsUpperBound(search.seeds.length, holdout.seeds.length, rounds) : null;
  if (required !== null && required > SEARCH_LIMITS.maxImages) {
    errors.push(t("這組設定最多需要 {required} 張圖，超過上限 {maxImages} 張：減少 seed 或輪數", { required, maxImages: SEARCH_LIMITS.maxImages }));
  } else if (required !== null && budget !== null && budget < required) {
    errors.push(t("這組設定最多需要 {required} 張圖：預算至少要 {required2}（上限 {maxImages}）", { required, required2: required, maxImages: SEARCH_LIMITS.maxImages }));
  }
  if (visionOps !== null && visionOps > SEARCH_LIMITS.maxVisionOps) errors.push(t("最多需要 {visionOps} 次視覺操作，超過上限 {maxVisionOps} 次", { visionOps, maxVisionOps: SEARCH_LIMITS.maxVisionOps }));
  if (errors.length > 0 || !search.ok || !holdout.ok || rounds === null || budget === null || stopAfter === null || required === null || visionOps === null) {
    return { ok: false, errors, requiredImages: required, visionOps };
  }
  return { ok: true, plan: { searchSeeds: search.seeds, holdoutSeeds: holdout.seeds, rounds, budget, stopAfter, requiredImages: required, visionOps } };
}

// ---------------------------------------------------------------- 排名

export interface RankedCandidate {
  ref: CandidateRef;
  /** 完整時為平均誤差；否則 null。 */
  meanLoss: number | null;
  /** 每個搜尋 seed 都有可判斷的誤差。 */
  complete: boolean;
  /** 依 seed 排序。 */
  evaluations: EvaluationRef[];
  /** 版本在研究中的順序（同分時較早的版本優先）。 */
  order: number;
}

/** 可以拿來排名的評估：有誤差而且已驗證。 */
export function judgeable(evaluation: EvaluationRef): boolean {
  return !evaluation.score.unverified && evaluation.score.loss !== null;
}

/** 評估的誤差（不可判斷時 null）。 */
export function evaluationLoss(evaluation: EvaluationRef): number | null {
  return evaluation.score.unverified ? null : evaluation.score.loss;
}

/**
 * 搜尋 seed 上的候選排名：完整者優先，再依平均誤差、core 優先、較早的版本。
 * 不完整（缺 seed、有不可判斷）的候選列在後面，不能成為最佳或挑戰者。
 */
export function rankCandidates(evaluations: readonly EvaluationRef[], searchSeeds: readonly number[], order: (versionId: string) => number): RankedCandidate[] {
  const groups = new Map<string, EvaluationRef[]>();
  for (const evaluation of evaluations) {
    if (evaluation.split !== "search" || !searchSeeds.includes(evaluation.seed)) continue;
    const key = `${evaluation.version_id}::${evaluation.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), evaluation]);
  }
  const ranked: RankedCandidate[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) continue;
    // 同一個 seed 只取第一筆（重複的評估不重複計分）
    const bySeed = new Map<number, EvaluationRef>();
    for (const row of rows) if (!bySeed.has(row.seed)) bySeed.set(row.seed, row);
    const items = [...bySeed.values()].sort((a, b) => a.seed - b.seed);
    const complete = searchSeeds.every((seed) => bySeed.has(seed)) && items.every(judgeable);
    const meanLoss = complete ? items.reduce((sum, item) => sum + (evaluationLoss(item) ?? 0), 0) / items.length : null;
    ranked.push({ ref: { version_id: first.version_id, variant: first.variant }, meanLoss, complete, evaluations: items, order: order(first.version_id) });
  }
  return ranked.sort(
    (a, b) =>
      Number(!a.complete) - Number(!b.complete) ||
      (a.meanLoss ?? Number.POSITIVE_INFINITY) - (b.meanLoss ?? Number.POSITIVE_INFINITY) ||
      variantRank(a.ref.variant) - variantRank(b.ref.variant) ||
      a.order - b.order,
  );
}

function variantRank(variant: PromptVariant): number {
  return variant === "core" ? 0 : 1;
}

/** 初始輪的最佳：完整且可判斷者中平均誤差最低（同分 core 優先、較早的版本優先）；沒有時為 null。 */
export function selectInitial(ranked: readonly RankedCandidate[]): RankedCandidate | null {
  return ranked.find((item) => item.complete && item.meanLoss !== null) ?? null;
}

/** 挑戰者的平均誤差比目前最佳至少低 0.05（兩者都要完整、seed 相同）。 */
export function improvementEligible(incumbent: RankedCandidate, challenger: RankedCandidate): boolean {
  if (!incumbent.complete || !challenger.complete || incumbent.meanLoss === null || challenger.meanLoss === null) return false;
  const left = incumbent.evaluations.map((item) => item.seed).join(",");
  const right = challenger.evaluations.map((item) => item.seed).join(",");
  if (left !== right) return false;
  return incumbent.meanLoss - challenger.meanLoss >= SEARCH_LIMITS.improvement - 1e-12;
}

export interface RepresentativePair {
  seed: number;
  incumbent: EvaluationRef;
  challenger: EvaluationRef;
}

function closestToMean(candidate: RankedCandidate): EvaluationRef | null {
  const mean = candidate.meanLoss;
  if (mean === null) return null;
  const distance = (item: EvaluationRef) => Math.abs((evaluationLoss(item) ?? Infinity) - mean);
  return [...candidate.evaluations].sort((a, b) => distance(a) - distance(b) || a.seed - b.seed)[0] ?? null;
}

/**
 * 雙順序比較用的代表圖：兩邊各取誤差最接近自己平均的 seed；相同就用它，不同時用最小的搜尋 seed（同一個 seed 才公平）。
 */
export function representativePair(incumbent: RankedCandidate, challenger: RankedCandidate): RepresentativePair | null {
  if (!incumbent.complete || !challenger.complete) return null;
  const first = closestToMean(incumbent);
  const second = closestToMean(challenger);
  if (!first || !second) return null;
  const seed = first.seed === second.seed ? first.seed : Math.min(...incumbent.evaluations.map((item) => item.seed));
  const left = incumbent.evaluations.find((item) => item.seed === seed);
  const right = challenger.evaluations.find((item) => item.seed === seed);
  return left && right ? { seed, incumbent: left, challenger: right } : null;
}

/** A/B（A＝目前最佳、B＝挑戰者）與 B/A（交換位置）都選挑戰者才算確認；平手或不確定都不算（prompt.scene_score op=confirm 的規則）。 */
export function pairwiseConfirms(ab: PromptPairwise, ba: PromptPairwise): boolean {
  return ab.winner === "B" && ba.winner === "A";
}

/** 這個候選在搜尋 seed 上誤差最高的評估（修訂時用它的差異）。 */
export function worstEvaluation(candidate: RankedCandidate): EvaluationRef | null {
  return [...candidate.evaluations].sort((a, b) => (evaluationLoss(b) ?? -1) - (evaluationLoss(a) ?? -1) || a.seed - b.seed)[0] ?? null;
}
