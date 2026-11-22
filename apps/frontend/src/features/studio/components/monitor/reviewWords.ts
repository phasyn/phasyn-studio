// The words of a take's reviews (TakeReview.tsx): labels of residue states, verdicts, statement kinds and roles, and
// the card's summary (a part of its accessible name and its tooltip lines: the score, the failed items, residue).
import type { StudioTakeReview } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { formatNumber, joinInline } from "@/i18n/format";
import { failedStatements, type ResidueState, type TakeReviewSummary } from "../../model/takeReviews";

/** Failed items the card's tooltip lists before 「…」. */
const TOOLTIP_ITEMS = 3;

export function percent(value: number): string {
  return formatNumber(value, { style: "percent", maximumFractionDigits: 0 });
}

export function residueLabel(state: ResidueState): string {
  switch (state) {
    case "confirmed":
      return t("確認有殘留");
    case "suspect":
      return t("殘留待確認");
    case "clean":
      return t("已檢查無殘留");
    case "unchecked":
    default:
      return t("未檢查殘留");
  }
}

export function verdictLabel(verdict: string): string {
  switch (verdict) {
    case "yes":
      return t("符合");
    case "no":
      return t("不符合");
    case "unclear":
      return t("無法判斷");
    default:
      return t("不適用");
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "identity":
      return t("角色");
    case "material":
      return t("材質");
    case "sound-effect":
      return t("聲音特效");
    case "timing":
      return t("時機與鏡位");
    case "composition":
      return t("構圖");
    default:
      return kind;
  }
}

export function roleLabel(role: StudioTakeReview["role"]): string | null {
  if (role === "shot") return t("對照鏡頭目前的 prompt");
  if (role === "generated") return t("對照生成時的 prompt");
  return null;
}

/** The card's words for its reviews: a part of its accessible name and the tooltip lines. */
export function reviewWords(summary: TakeReviewSummary): { label: string; lines: string[] } {
  const { adherence } = summary;
  const failed = failedStatements(adherence);
  const score = adherence?.score;
  const parts = [score === null || score === undefined ? null : t("遵從度 {score}", { score: percent(score) }), failed.length > 0 ? t("{count} 項未通過", { count: failed.length }) : null, residueLabel(summary.residue)];
  const lines = [joinInline(parts.filter((part): part is string => part !== null))];
  for (const statement of failed.slice(0, TOOLTIP_ITEMS)) lines.push(`✗ ${statement.text}`);
  if (failed.length > TOOLTIP_ITEMS) lines.push(t("…還有 {count} 項", { count: failed.length - TOOLTIP_ITEMS }));
  lines.push(t("點按審查標記（或按 R）看每一項"));
  return { label: lines[0] ?? "", lines };
}
