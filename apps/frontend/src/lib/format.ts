// 數值顯示：bytes／ms／count 都附單位；null 一律顯示「未量測」（附原因），絕不畫成 0。
import type { Metric } from "@/api/generated/contracts";
import { formatDateTime } from "@/i18n/format";
import { t } from "@/i18n";

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("未量測");
  let n = Math.abs(value);
  let unit = 0;
  while (n >= 1024 && unit < BINARY_UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  const sign = value < 0 ? "-" : "";
  return `${sign}${unit === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 1 : 2)} ${String(BINARY_UNITS[unit])}`;
}

export function formatBytesExact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("未量測");
  return `${value.toLocaleString("en-US")} bytes`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("未量測");
  if (Math.abs(value) >= 60_000) return `${(value / 60_000).toFixed(2)} min`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(3)} s`;
  if (Math.abs(value) >= 1) return `${value.toFixed(2)} ms`;
  return `${(value * 1000).toFixed(1)} µs`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("未量測");
  return value.toLocaleString("en-US");
}

/** 十進位 GB/s（與 bytes 的 GiB 顯示分開標單位）。 */
export function formatGbps(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("未量測");
  return `${value.toFixed(2)} GB/s`;
}

/** 依 metric 的 unit 決定格式；value=null 時回傳「未量測」或「不適用」。 */
export function formatMetric(metric: Metric | null | undefined): string {
  if (!metric) return t("未量測");
  if (metric.value == null) {
    return metric.quality === "not_applicable" ? t("不適用") : t("未量測");
  }
  const v = metric.value;
  switch (metric.unit) {
    case "bytes":
      return formatBytes(v);
    case "ms":
      return formatMs(v);
    case "count":
      return formatCount(v);
    case "GB/s":
      return formatGbps(v);
    case "percent":
      return `${v.toFixed(1)} %`;
    default:
      return metric.unit ? `${String(v)} ${metric.unit}` : String(v);
  }
}

export const QUALITY_LABELS: Record<Metric["quality"], string> = {
  instrumented: t("實測（hook）"),
  sampled: t("取樣"),
  trace: "trace",
  derived: t("推導"),
  unavailable: t("不可得"),
  not_applicable: t("不適用"),
  synthetic: t("合成示例"),
};

/** monotonic_ns 是十進位字串：用 BigInt 相減，不用 Date 解讀。 */
export function nsDiffMs(startNs: string, endNs: string): number {
  return Number(BigInt(endNs) - BigInt(startNs)) / 1_000_000;
}

/** UTC RFC3339 → 本地時區、目前介面語言的日期時間（24 小時制；只作查詢與粗排）。 */
export function formatTimestamp(value: string | null | undefined): string {
  if (!(value != null && value !== "")) return "—";
  return formatDateTime(value);
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!(id != null && id !== "")) return "—";
  return id.length > length ? id.slice(0, length) : id;
}
