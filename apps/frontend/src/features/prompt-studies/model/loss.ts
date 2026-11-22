// 逐區段誤差的顯示（純函式）：prompt.scene_score（op=loss）回報每個區段的權重、判斷、扣分與加權扣分；這裡換算成
// 「對整體誤差的貢獻」（加權扣分 ÷ 可判斷權重），並用同一份比較依同一套凍結規則重算一次核對（與 phasyn_qimg.prompting.evaluation 相同）：
// 只看原圖場景中有內容的區段；match/minor/major/missing 扣 0/1/2/3 分乘上權重，uncertain／not_applicable 不可判斷；
// 可判斷權重不到 75%、模型宣告無法判斷、或沒有可判斷區段時為「不可判斷」（loss＝null，不是 0）。
import type { MetricLabel, PromptComparison, PromptScene, PromptScore, SectionKey } from "../types";
import { LABEL_PENALTY, METRIC_LABELS, SECTION_KEYS, SECTION_WEIGHTS, sectionText } from "./sections";
import { t } from "@/i18n";

export const MIN_EVALUABLE_FRACTION = 0.75;

export interface SectionLossRow {
  key: SectionKey;
  label: MetricLabel;
  weight: number;
  /** 原圖場景中有內容（屬於評分範圍）。 */
  applicable: boolean;
  /** 有意修改的區段（比較時以修改後的內容為目標）。 */
  intentional: boolean;
  penalty: number | null;
  /** 權重×扣分。 */
  weighted: number | null;
  /** 對整體誤差的貢獻（權重×扣分 ÷ 可判斷權重）；整體不可判斷時為 null。 */
  contribution: number | null;
}

export interface LossBreakdown {
  rows: SectionLossRow[];
  loss: number | null;
  evaluableWeightFraction: number;
  unverified: boolean;
  evaluableWeight: number;
  /** 不可判斷的原因（繁中）；可判斷時為空。 */
  reasons: string[];
}

/** 原圖場景中有生成文字的區段（凍結評分規則的適用範圍）。 */
export function applicableSections(scene: PromptScene): SectionKey[] {
  return SECTION_KEYS.filter((key) => sectionText(scene.sections[key], scene.prompt_language).trim().length > 0);
}

function finish(rows: Omit<SectionLossRow, "contribution">[], comparisonUnjudgeable: string | null): LossBreakdown {
  let applicableWeight = 0;
  let evaluableWeight = 0;
  let weighted = 0;
  for (const row of rows) {
    if (row.applicable) applicableWeight += row.weight;
    if (row.weighted !== null) {
      evaluableWeight += row.weight;
      weighted += row.weighted;
    }
  }
  const fraction = applicableWeight > 0 ? evaluableWeight / applicableWeight : 0;
  const reasons: string[] = [];
  if (fraction < MIN_EVALUABLE_FRACTION) reasons.push(t("可判斷權重只有 {fraction}（需要至少 {minEvaluableFraction}）", { fraction: formatFraction(fraction), minEvaluableFraction: formatFraction(MIN_EVALUABLE_FRACTION) }));
  if (comparisonUnjudgeable != null && comparisonUnjudgeable !== "") reasons.push(t("視覺模型表示無法判斷：{comparisonUnjudgeable}", { comparisonUnjudgeable }));
  if (evaluableWeight === 0) reasons.push(t("沒有可判斷的適用區段"));
  const unverified = reasons.length > 0;
  const loss = unverified ? null : weighted / evaluableWeight;
  return {
    rows: rows.map((row) => ({ ...row, contribution: loss === null || row.weighted === null ? null : row.weighted / evaluableWeight })),
    loss,
    evaluableWeightFraction: fraction,
    unverified,
    evaluableWeight,
    reasons,
  };
}

/** 依同一份比較與凍結規則在本頁重算（核對元件的分數；沒有 score 時也能先看）。 */
export function lossBreakdown(comparison: PromptComparison, applicable: readonly SectionKey[], intentional: readonly SectionKey[] = []): LossBreakdown {
  const rows = SECTION_KEYS.map((key) => {
    const label = comparison.sections[key].label;
    const weight = SECTION_WEIGHTS[key];
    const isApplicable = applicable.includes(key);
    const penalty = isApplicable ? (LABEL_PENALTY[label] ?? null) : null;
    return { key, label, weight, applicable: isApplicable, intentional: intentional.includes(key), penalty, weighted: penalty === null ? null : weight * penalty };
  });
  return finish(rows, comparison.unjudgeable_reason);
}

/** 元件回報的逐區段分數（prompt.scene_score）換算成同樣的顯示列；loss 與可判斷比例沿用元件的數字。 */
export function scoreBreakdown(score: PromptScore): LossBreakdown {
  const rows = SECTION_KEYS.map((key) => {
    const item = score.sections[key];
    return { key, label: item.label, weight: item.weight, applicable: item.applicable, intentional: item.intentional, penalty: item.penalty, weighted: item.weighted_penalty };
  });
  const evaluableWeight = rows.reduce((sum, row) => sum + (row.weighted === null ? 0 : row.weight), 0);
  const loss = score.unverified ? null : score.loss;
  return {
    rows: rows.map((row) => ({ ...row, contribution: loss === null || row.weighted === null || evaluableWeight === 0 ? null : row.weighted / evaluableWeight })),
    loss,
    evaluableWeightFraction: score.evaluable_weight_fraction,
    unverified: score.unverified,
    evaluableWeight,
    reasons: score.unverified_reasons,
  };
}

/** 誤差顯示：三位小數；null＝不可判斷。誤差是機器評審的差異量，不是相似百分比。 */
export function formatLoss(loss: number | null | undefined): string {
  return loss === null || loss === undefined || !Number.isFinite(loss) ? t("不可判斷") : loss.toFixed(3);
}

export function formatFraction(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return t("未知");
  const percent = Math.round(fraction * 1000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

export function metricLabelText(label: MetricLabel): string {
  return METRIC_LABELS[label];
}

export type LossTone = "success" | "info" | "warning" | "danger" | "neutral";

/** 判斷的色調（只是第二線索，文字永遠存在）。 */
export function metricTone(label: MetricLabel): LossTone {
  switch (label) {
    case "match":
      return "success";
    case "minor":
      return "info";
    case "major":
      return "warning";
    case "missing":
      return "danger";
    case "not_applicable":
    case "uncertain":
    default:
      return "neutral";
  }
}

export type LossAgreement = "agree" | "disagree";

/** 元件回報的分數與本頁依同一份比較重算的結果是否一致（兩邊都不可判斷也算一致）。 */
export function lossAgreement(score: Pick<PromptScore, "loss" | "unverified">, local: LossBreakdown): LossAgreement {
  if (score.unverified !== local.unverified) return "disagree";
  if (score.loss === null || local.loss === null) return score.loss === local.loss || score.unverified ? "agree" : "disagree";
  return Math.abs(score.loss - local.loss) <= 1e-9 ? "agree" : "disagree";
}

/** 依加權扣分高低列出差異最大的區段；不可判斷的區段不列。 */
export function worstSections(breakdown: LossBreakdown, limit = 3): SectionKey[] {
  return breakdown.rows
    .filter((row) => row.weighted !== null && row.weighted > 0)
    .sort((a, b) => (b.weighted ?? 0) - (a.weighted ?? 0) || SECTION_KEYS.indexOf(a.key) - SECTION_KEYS.indexOf(b.key))
    .slice(0, limit)
    .map((row) => row.key);
}
