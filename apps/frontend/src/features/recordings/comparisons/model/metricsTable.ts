// 比較表：metric 列依紀錄頁同一套分組排序；只呈現各 recording 的原值，不計算倍率、差值或「勝出」。
import type { Metric } from "@/api/generated/contracts";
import { toCsv } from "../../model/csv";
import { METRIC_GROUPS, parseTransferMetricName } from "../../model/metrics";
import { t } from "@/i18n";

export interface MetricSection {
  id: string;
  title: string;
  names: string[];
}

export function orderComparisonMetrics(names: readonly string[]): MetricSection[] {
  const remaining = new Set(names);
  const sections: MetricSection[] = [];
  for (const group of METRIC_GROUPS) {
    const list = [...group.core, ...group.optional].filter((name) => remaining.has(name));
    for (const name of list) remaining.delete(name);
    if (list.length > 0) sections.push({ id: group.id, title: group.title, names: list });
  }
  const transfers = [...remaining].filter((name) => parseTransferMetricName(name) !== null).sort((a, b) => a.localeCompare(b));
  for (const name of transfers) remaining.delete(name);
  if (transfers.length > 0) sections.push({ id: "transfers", title: t("搬運計數"), names: transfers });
  const others = [...remaining].sort((a, b) => a.localeCompare(b));
  if (others.length > 0) sections.push({ id: "other", title: t("其他指標"), names: others });
  return sections;
}

export interface BasisMismatch {
  unit: boolean;
  method: boolean;
  scope: boolean;
  quality: boolean;
}

/** 同一列的口徑（unit／method／scope）或品質不同：不可直接比較數值。只看有回報的格。 */
export function basisMismatch(cells: readonly (Metric | undefined)[]): BasisMismatch {
  const present = cells.filter((cell): cell is Metric => cell !== undefined);
  const differs = (pick: (metric: Metric) => string) => new Set(present.map(pick)).size > 1;
  return {
    unit: differs((metric) => metric.unit),
    method: differs((metric) => metric.method),
    scope: differs((metric) => metric.scope),
    quality: differs((metric) => metric.quality),
  };
}

/** 比較表的長格式 CSV：recording × metric 一列；null 留空並寫 reason。 */
export function comparisonCsv(ids: readonly string[], metrics: Record<string, Metric[] | undefined>): string {
  const rows: unknown[][] = [];
  for (const [name, list] of Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b))) {
    ids.forEach((id, index) => {
      const metric = list?.[index];
      if (!metric) {
        rows.push([id, name, null, null, null, null, null, t("比較結果未包含此 recording 的值"), null]);
        return;
      }
      rows.push([
        id,
        name,
        metric.value,
        metric.unit,
        metric.quality,
        metric.method,
        metric.scope,
        metric.value === null ? (metric.reason ?? (metric.quality === "not_applicable" ? t("不適用") : t("未量測"))) : metric.reason,
        metric.count ?? null,
      ]);
    });
  }
  return toCsv(["recording_id", "metric", "value", "unit", "quality", "method", "scope", "reason", "count"], rows);
}
