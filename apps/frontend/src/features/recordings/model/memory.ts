// 記憶體取樣曲線：只用 sample 事件的實際值。缺值、取樣間隔過大或事件缺段一律斷線，絕不補 0。
// allocated／reserved／NVML 整卡／NVML 程序／host RSS 是不同口徑，各自成線、分面板，不相加。
import type { Metric, Quality, RecordingEvent } from "@/api/generated/contracts";
import { nsToRelMs, parseNs } from "./clock";
import { t as tr } from "@/i18n";

export type MemoryPanelId = "allocator" | "nvml_device" | "nvml_process" | "host_rss";

export interface MemorySeriesDef {
  metric: string;
  label: string;
  panel: MemoryPanelId;
}

export const MEMORY_SERIES: readonly MemorySeriesDef[] = [
  { metric: "torch_allocated_current_bytes", label: "allocated", panel: "allocator" },
  { metric: "torch_reserved_current_bytes", label: "reserved", panel: "allocator" },
  { metric: "nvml_device_used_bytes", label: tr("整卡已用"), panel: "nvml_device" },
  { metric: "nvml_process_used_bytes", label: tr("此程序已用"), panel: "nvml_process" },
  { metric: "host_rss_current_bytes", label: "RSS", panel: "host_rss" },
];

export const MEMORY_PANELS: Record<MemoryPanelId, { title: string; scope: string; note: string }> = {
  allocator: {
    title: "PyTorch allocator",
    scope: tr("此 actor 程序 · 指定 device"),
    note: tr("allocated 包含於 reserved，兩線不可相加；不涵蓋直接 CUDA／NCCL 配置。"),
  },
  nvml_device: {
    title: tr("NVML 整卡"),
    scope: tr("整張 device（含其他程序與 driver）"),
    note: tr("取樣值，未必抓到瞬間峰值；不代表此元件獨占。"),
  },
  nvml_process: {
    title: tr("NVML 此程序"),
    scope: tr("依 PID 的 device 用量"),
    note: tr("NVML 不支援時為 null，不以整卡用量代替。"),
  },
  host_rss: {
    title: "Host RSS",
    scope: tr("actor 程序（取樣）"),
    note: tr("取樣峰值不等於程序生命週期高水位。"),
  },
};

export interface MemoryPoint {
  t: number;
  v: number;
}

export interface MemorySeries {
  key: string;
  metric: string;
  label: string;
  panel: MemoryPanelId;
  deviceId: string | null;
  processId: number | null;
  /** 連續段；段與段之間是缺口（不連線）。 */
  segments: MemoryPoint[][];
  /** 每個取樣時刻的值；null 表示該時刻缺值。 */
  samples: { t: number; v: number | null }[];
  quality: Quality | null;
  method: string | null;
  /** 全部為 null 時的原因（例如 NVML 不支援）。 */
  nullReason: string | null;
  max: number | null;
}

export interface MemoryModel {
  sampleCount: number;
  /** 取樣時刻（相對此 stream 第一個 sample 的 ms）。 */
  times: number[];
  durationMs: number;
  expectedIntervalMs: number | null;
  gapThresholdMs: number | null;
  series: MemorySeries[];
  /** NVML 整卡總量（最近一次非 null 取樣），作為參考線。 */
  deviceTotal: Map<string, number>;
  invalidTime: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? null);
}

/**
 * @param events 單一 stream、依 seq 遞增的已載入事件（含非 sample 事件，用來偵測缺段）。
 * @param sampleHz context.recording.device_sample_hz（有的話決定預期取樣間隔）。
 */
export function buildMemoryModel(events: readonly RecordingEvent[], sampleHz?: number | null): MemoryModel {
  const samples: { t: bigint; gapBefore: boolean; metrics: Record<string, Metric | undefined>; deviceId: string | null; processId: number | null }[] = [];
  let invalidTime = 0;
  let lastSeq: number | null = null;
  let pendingGap = false;
  for (const event of events) {
    if (lastSeq !== null && event.seq !== lastSeq + 1) pendingGap = true;
    lastSeq = event.seq;
    if (event.kind !== "sample") continue;
    const t = parseNs(event.monotonic_ns);
    if (t === null) {
      invalidTime += 1;
      pendingGap = true;
      continue;
    }
    samples.push({ t, gapBefore: pendingGap, metrics: event.data.metrics, deviceId: event.data.device_id, processId: event.data.process_id });
    pendingGap = false;
  }
  const empty: MemoryModel = {
    sampleCount: 0,
    times: [],
    durationMs: 0,
    expectedIntervalMs: null,
    gapThresholdMs: null,
    series: [],
    deviceTotal: new Map(),
    invalidTime,
  };
  const first = samples[0];
  if (!first) return empty;
  let base = first.t;
  for (const sample of samples) if (sample.t < base) base = sample.t;
  const rel = samples.map((sample) => ({ ...sample, ms: nsToRelMs(base, sample.t) }));

  // 預期間隔：優先使用設定的取樣頻率；否則以實際間隔中位數估計。
  const deltas: number[] = [];
  for (let i = 1; i < rel.length; i += 1) {
    const prev = rel[i - 1];
    const cur = rel[i];
    if (prev && cur && cur.ms > prev.ms) deltas.push(cur.ms - prev.ms);
  }
  const expected = (sampleHz != null && Boolean(sampleHz)) && sampleHz > 0 ? 1000 / sampleHz : deltas.length >= 2 ? median(deltas) : null;
  const threshold = expected !== null ? expected * 2.5 : null;

  const seriesMap = new Map<string, MemorySeries & { lastT: number | null; open: MemoryPoint[] | null }>();
  const deviceTotal = new Map<string, number>();
  const ensure = (def: MemorySeriesDef, deviceId: string | null, processId: number | null) => {
    const usesProcess = def.panel === "nvml_process" || def.panel === "host_rss" || def.panel === "allocator";
    const key = `${def.metric}|${deviceId ?? "-"}|${String(usesProcess ? (processId ?? "-") : "-")}`;
    let series = seriesMap.get(key);
    if (!series) {
      series = {
        key,
        metric: def.metric,
        label: def.label,
        panel: def.panel,
        deviceId,
        processId: usesProcess ? processId : null,
        segments: [],
        samples: [],
        quality: null,
        method: null,
        nullReason: null,
        max: null,
        lastT: null,
        open: null,
      };
      seriesMap.set(key, series);
    }
    return series;
  };

  for (const sample of rel) {
    const total = sample.metrics["nvml_device_total_bytes"];
    if (total?.value != null && Number.isFinite(total.value)) deviceTotal.set(sample.deviceId ?? "-", total.value);
    for (const def of MEMORY_SERIES) {
      const metric = sample.metrics[def.metric];
      // 這個 sample 沒有此 metric：只有在該系列已存在時才視為缺值（斷線）。
      const key = `${def.metric}|${sample.deviceId ?? "-"}`;
      const exists = [...seriesMap.keys()].some((existing) => existing.startsWith(`${key}|`));
      if (!metric && !exists) continue;
      const series = ensure(def, sample.deviceId, sample.processId);
      const value = metric?.value != null && Number.isFinite(metric.value) ? metric.value : null;
      if (metric) {
        series.quality = metric.quality;
        series.method = metric.method;
        if (value === null && (metric.reason != null && metric.reason !== "")) series.nullReason = metric.reason;
      }
      series.samples.push({ t: sample.ms, v: value });
      const tooFar = threshold !== null && series.lastT !== null && sample.ms - series.lastT > threshold;
      if (value === null || sample.gapBefore || tooFar) {
        if (series.open && series.open.length > 0) series.segments.push(series.open);
        series.open = null;
      }
      if (value !== null) {
        series.open = series.open ?? [];
        series.open.push({ t: sample.ms, v: value });
        series.max = series.max === null ? value : Math.max(series.max, value);
        series.lastT = sample.ms;
      } else {
        series.lastT = null;
      }
    }
  }
  const series: MemorySeries[] = [];
  for (const entry of seriesMap.values()) {
    if (entry.open && entry.open.length > 0) entry.segments.push(entry.open);
    const { lastT: _lastT, open: _open, ...rest } = entry;
    if (rest.max !== null) rest.nullReason = null;
    series.push(rest);
  }
  const times = rel.map((sample) => sample.ms);
  return {
    sampleCount: rel.length,
    times,
    durationMs: Math.max(0, ...times),
    expectedIntervalMs: expected,
    gapThresholdMs: threshold,
    series,
    deviceTotal,
    invalidTime,
  };
}
