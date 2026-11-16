// 本機 CSV（目前表格的下載）：null 輸出空欄並在 reason 欄說明，絕不寫成 0；
// 字串開頭為 = + - @（及 tab／CR）時加前置單引號，避免試算表把資料當公式執行。
import type { Metric } from "@/api/generated/contracts";
import { t } from "@/i18n";

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (typeof value === "string") text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  else text = JSON.stringify(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export const METRIC_CSV_HEADER = ["recording_id", "metric", "value", "unit", "quality", "method", "scope", "reason", "count"] as const;

/** metric 長表：一列一個 metric；value=null 留空且 reason 必填（未提供時寫明「未量測」）。 */
export function metricRows(recordingId: string, metrics: Record<string, Metric | undefined>): unknown[][] {
  return Object.entries(metrics)
    .filter((entry): entry is [string, Metric] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, metric]) => [
      recordingId,
      name,
      metric.value,
      metric.unit,
      metric.quality,
      metric.method,
      metric.scope,
      metric.value === null ? (metric.reason ?? (metric.quality === "not_applicable" ? t("不適用") : t("未量測"))) : metric.reason,
      metric.count ?? null,
    ]);
}
