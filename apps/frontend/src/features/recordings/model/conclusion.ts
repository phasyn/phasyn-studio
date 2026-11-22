// 可行動結論：只用已量測的時間指標判斷「主要時間在哪個區域」，並附來源方法與品質。
// 不推測、不給最佳化建議；各區域可能重疊（例如 copy 與 compute 並行），所以佔比不相加為 100%。
import type { Metric, RecordingSummary } from "@/api/generated/contracts";
import { metricState } from "./metrics";
import { transferTotalsRows } from "./transfers";
import { t, tServer } from "@/i18n";

export interface AreaDef {
  key: string;
  label: string;
  metricName: string;
}

/** host 區間類的區域（皆為同一 call 的本機 monotonic 量測）。 */
export const TIME_AREAS: readonly AreaDef[] = [
  { key: "compute", label: t("計算（元件程序內）"), metricName: "runtime.host_wall_ms" },
  { key: "load", label: t("載入"), metricName: "host_load_ms" },
  { key: "input", label: t("輸入取得"), metricName: "host_input_transfer_ms" },
  { key: "wait", label: t("等待"), metricName: "host_wait_ms" },
  { key: "encode", label: t("編碼"), metricName: "host_encode_ms" },
  { key: "publish", label: t("輸出發布"), metricName: "host_output_publish_ms" },
];

export interface AreaMeasure {
  key: string;
  label: string;
  metricName: string;
  metric: Metric;
  ms: number;
  /** 相對整段 wall 的比例；wall 未量測時為 null。copy 加總可能 > 1（並行）。 */
  share: number | null;
}

export interface UnmeasuredArea {
  key: string;
  label: string;
  metricName: string;
  state: "unmeasured" | "not_applicable" | "missing";
  reason: string | null;
}

export type ConclusionKind = "dominant" | "wall_only" | "not_measurable";

export interface Conclusion {
  kind: ConclusionKind;
  wall: Metric | null;
  areas: AreaMeasure[];
  dominant: AreaMeasure | null;
  unmeasured: UnmeasuredArea[];
  gpuEvent: Metric | null;
}

function usable(metric: Metric | undefined): metric is Metric & { value: number } {
  return metric !== undefined && metricState(metric) === "measured" && metric.quality !== "unavailable" && metric.value !== null && metric.value >= 0;
}

export function buildConclusion(summary: RecordingSummary): Conclusion {
  const metrics = summary.metrics;
  const wallMetric = metrics["host_wall_ms"];
  const wall = usable(wallMetric) ? wallMetric : null;
  const areas: AreaMeasure[] = [];
  const unmeasured: UnmeasuredArea[] = [];

  for (const area of TIME_AREAS) {
    const metric = metrics[area.metricName];
    if (usable(metric)) {
      areas.push({ ...area, metric, ms: metric.value, share: wall && wall.value > 0 ? metric.value / wall.value : null });
    } else {
      unmeasured.push({
        key: area.key,
        label: area.label,
        metricName: area.metricName,
        state: metric === undefined ? "missing" : metricState(metric) === "not_applicable" ? "not_applicable" : "unmeasured",
        // A fixed server reason reads in the interface language (others stay as they are)
        reason: tServer(metric?.reason) ?? (metric === undefined ? t("summary 未回報") : null),
      });
    }
  }

  // copy：每個類別各自一項（host 區間加總；不同類別不相加，也不與 compute 相加）。
  for (const row of transferTotalsRows(summary)) {
    if (typeof row.hostMsSum !== "number" || row.hostMsSum <= 0) continue;
    const metric: Metric = {
      value: row.hostMsSum,
      unit: "ms",
      quality: "derived",
      scope: `transfer_totals.${row.category}`,
      method: "host_ms_sum",
      reason: t("此類別各次 copy 的 host 區間加總；可能與計算重疊，並行時可大於 wall"),
    };
    areas.push({
      key: `copy:${row.category}`,
      label: t("搬運 {category}", { category: row.category }),
      metricName: `transfer_totals.${row.category}.host_ms_sum`,
      metric,
      ms: row.hostMsSum,
      share: wall && wall.value > 0 ? row.hostMsSum / wall.value : null,
    });
  }

  areas.sort((a, b) => b.ms - a.ms);
  const dominant = areas[0] ?? null;
  const gpu = metrics["gpu_event_ms"];
  return {
    kind: dominant ? "dominant" : wall ? "wall_only" : "not_measurable",
    wall,
    areas,
    dominant,
    unmeasured,
    gpuEvent: usable(gpu) ? gpu : null,
  };
}
