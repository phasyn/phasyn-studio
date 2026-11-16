// 比較條件摘要：只轉述伺服器的判定（same_source、confounders），不自行推論「誰比較快」。
// 工具列的常駐 chip 與「來源與混淆因素」區段共用同一份文字，避免兩處說法不一致。
import type { Comparison } from "@/api/generated/contracts";
import type { Tone } from "@/components/workbench/tones";
import { t } from "@/i18n";

export type SourceVerdict = "same" | "different" | "unknown";

export interface Comparability {
  source: SourceVerdict;
  sourceLabel: string;
  sourceTone: Tone;
  sourceNote: string;
  confounderCount: number;
  confounderLabel: string;
  confounderTone: Tone;
  /** 同來源且伺服器沒有列出混淆因素：設定差異才是耗時／記憶體差異的「可歸因候選」。 */
  comparable: boolean;
}

const SOURCE: Record<SourceVerdict, { label: string; tone: Tone; note: string }> = {
  same: { label: t("同來源"), tone: "info", note: t("伺服器判定這些 recording 使用相同的來源輸入。") },
  different: { label: t("來源不同"), tone: "warning", note: t("輸入來源不同：輸出與耗時差異可能來自輸入，不只來自設定；不冒充同源。") },
  unknown: { label: t("來源未知"), tone: "neutral", note: t("無法判定是否同來源（缺少可比對的來源身分），視為未知。") },
};

export function comparability(data: Pick<Comparison, "same_source" | "confounders">): Comparability {
  const source: SourceVerdict = data.same_source === true ? "same" : data.same_source === false ? "different" : "unknown";
  const spec = SOURCE[source];
  const count = data.confounders.length;
  return {
    source,
    sourceLabel: spec.label,
    sourceTone: spec.tone,
    sourceNote: spec.note,
    confounderCount: count,
    confounderLabel: count > 0 ? t("{count} 個混淆因素", { count }) : t("無已知混淆因素"),
    confounderTone: count > 0 ? "warning" : "neutral",
    comparable: source === "same" && count === 0,
  };
}

export type ComparisonSectionId = "source" | "conditions" | "settings" | "metrics";

export interface ComparisonSectionLink {
  id: ComparisonSectionId;
  label: string;
  /** 不能跳轉的原因（例如尚無比較結果）；null＝可用。 */
  disabledReason: string | null;
}

/** 工具列「跳到」的區段：沒有比較結果時全部停用並說明；沒有可讀出的量測條件時只停用該區段。 */
export function sectionLinks(state: { hasData: boolean; conditionRows: number }): ComparisonSectionLink[] {
  const noData = state.hasData ? null : t("尚無比較結果");
  return [
    { id: "source", label: t("來源"), disabledReason: noData },
    { id: "conditions", label: t("量測條件"), disabledReason: noData ?? (state.conditionRows === 0 ? t("各 recording 的 context 沒有可讀出的量測條件") : null) },
    { id: "settings", label: t("設定差異"), disabledReason: noData },
    { id: "metrics", label: t("量測值"), disabledReason: noData },
  ];
}
