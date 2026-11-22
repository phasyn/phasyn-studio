// 時間軸模型：依 clock domain 分組（絕不跨 domain 合併或共用時間軸），組內依 GPU stream／事件種類分泳道。
// 每組時間以「該組自己的第一個事件」為 0；span 以 start/end_mono_ns 定位，
// step／transfer／log 事件沒有起點欄位，只畫成「事件記錄時刻」刻度，不由 host_ms 推回起點。
import type { RecordingEvent, SpanData } from "@/api/generated/contracts";
import { formatBytes, formatCount, formatMs, QUALITY_LABELS } from "@/lib/format";
import { eventClockDomain, nsToRelMs, parseNs, shortDomain } from "./clock";
import { t, tServer } from "@/i18n";

export type ChartCategory =
  | "phase"
  | "step"
  | "copy"
  | "step_event"
  | "transfer_event"
  | "log_warning"
  | "log_error"
  | "kernel"
  | "memcpy"
  | "memset";

export type ChartItemRef = { kind: "event"; streamId: string; seq: number } | { kind: "trace"; index: number };

export interface ChartItem {
  key: string;
  category: ChartCategory;
  /** 相對於所屬組 base 的毫秒。 */
  startMs: number;
  /** null 表示只有單一時刻（刻度標記）。 */
  endMs: number | null;
  label: string;
  row: number;
  part: string | null;
  details: readonly (readonly [string, string])[];
  ref: ChartItemRef;
}

export interface ChartLane {
  key: string;
  label: string;
  caption?: string;
  marker: boolean;
  rows: number;
  items: ChartItem[];
}

export interface ChartGroup {
  key: string;
  /** 完整 clock domain 字串（或 trace 時鐘說明）。 */
  domain: string;
  title: string;
  /** 只由事件的 node/process 推定（沒有任何自帶 clock_domain 的 span／transfer）。 */
  derived: boolean;
  lanes: ChartLane[];
  endMs: number;
  itemCount: number;
}

export interface TimelineModel {
  groups: ChartGroup[];
  /** start/end 不是合法十進位 ns 的 span 數（不繪製）。 */
  invalid: number;
  /** 終點早於起點的 span 數（不繪製）。 */
  reversed: number;
}

const COPY_SPAN = /copy|memcpy|h2d|d2h|transfer|prefetch|offload/i;

/** copy 類 span：名稱或 GPU stream 表明是搬運（例如 copy stream 上的 H2D 區間）。 */
export function isCopySpan(data: SpanData): boolean {
  return COPY_SPAN.test(data.name) || (data.gpu_stream_id !== null && /copy/i.test(data.gpu_stream_id));
}

interface Draft {
  laneKey: string;
  category: ChartCategory;
  start: bigint;
  end: bigint | null;
  label: string;
  part: string | null;
  details: (startMs: number, durationMs: number | null) => (readonly [string, string])[];
  ref: ChartItemRef;
  key: string;
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function gpuEventText(ms: number | null, streamId: string | null): string {
  if (ms === null) return t("未量測");
  return t("{ms}{value}（event 區間，可能含等待；不是 kernel 時間，未對齊 host 軸）", { ms: formatMs(ms), value: (streamId != null && streamId !== "") ? ` · stream ${streamId}` : "" });
}

function laneOrder(key: string): number {
  if (key === "span:host") return 0;
  if (key.startsWith("span:")) return 1;
  if (key === "step") return 2;
  if (key === "transfer") return 3;
  return 4;
}

function laneMeta(key: string): Pick<ChartLane, "label" | "caption" | "marker"> {
  if (key === "span:host") return { label: "host span", caption: t("CPU phase／part／step 區間"), marker: false };
  if (key.startsWith("span:")) {
    return { label: `span · GPU stream ${key.slice(5)}`, caption: t("以 host 時鐘定位；GPU event 長度見提示"), marker: false };
  }
  if (key === "step") return { label: t("step 事件"), caption: t("記錄時刻；不推算起點"), marker: true };
  if (key === "transfer") return { label: t("copy／transfer 事件"), caption: t("記錄時刻；不推算起點"), marker: true };
  return { label: t("警告／錯誤"), caption: t("log／notice 記錄時刻"), marker: true };
}

function draftFor(event: RecordingEvent, streamId: string): Draft | "invalid" | "reversed" | null {
  const ref: ChartItemRef = { kind: "event", streamId, seq: event.seq };
  const key = `${streamId}:${String(event.seq)}`;
  const seqText = `${streamId} #${String(event.seq)}`;
  switch (event.kind) {
    case "span": {
      const data = event.data;
      const start = parseNs(data.start_mono_ns);
      const end = parseNs(data.end_mono_ns);
      if (start === null || end === null) return "invalid";
      if (end < start) return "reversed";
      const category: ChartCategory = isCopySpan(data) ? "copy" : data.step_index !== null ? "step" : "phase";
      return {
        laneKey: `span:${data.gpu_stream_id ?? "host"}`,
        category,
        start,
        end,
        label: (data.part != null && data.part !== "") ? `${data.name} · ${data.part}` : data.name,
        part: data.part,
        ref,
        key,
        details: (startMs, durationMs) => [
          [t("類型"), category === "copy" ? "copy span" : category === "step" ? "step span" : "phase span"],
          [t("名稱"), data.name],
          ["part", text(data.part)],
          ["step", text(data.step_index)],
          [t("開始（相對此時鐘域）"), formatMs(startMs)],
          [t("host 區間（monotonic 起訖）"), formatMs(durationMs)],
          [t("host_ms（回報值）"), formatMs(data.host_ms)],
          ["GPU event", gpuEventText(data.gpu_event_ms, data.gpu_stream_id)],
          [t("品質"), QUALITY_LABELS[data.quality]],
          ["coverage", (data.reason != null && data.reason !== "") ? t("{coverage}（{reason}）", { coverage: data.coverage, reason: tServer(data.reason) }) : data.coverage],
          [t("事件"), seqText],
        ],
      };
    }
    case "transfer": {
      const data = event.data;
      const at = parseNs(event.monotonic_ns);
      if (at === null) return "invalid";
      return {
        laneKey: "transfer",
        category: "transfer_event",
        start: at,
        end: null,
        label: `${data.category} ${data.direction}`,
        part: data.part,
        ref,
        key,
        details: (startMs) => [
          [t("類型"), t("transfer 事件（記錄時刻）")],
          [t("類別／方向"), `${data.category} · ${data.direction}`],
          [t("owner／byte_basis"), `${data.owner} · ${data.byte_basis}`],
          ["submitted", t("{submitted_count} 次 · {submitted_bytes}", { submitted_count: formatCount(data.submitted_count), submitted_bytes: formatBytes(data.submitted_bytes) })],
          [
            "completed",
            data.completed_bytes === null || data.completed_count === null
              ? t("未確認完成")
              : t("{completed_count} 次 · {completed_bytes}", { completed_count: formatCount(data.completed_count), completed_bytes: formatBytes(data.completed_bytes) }),
          ],
          ["host_ms", formatMs(data.host_ms)],
          ["GPU event", gpuEventText(data.gpu_event_ms, null)],
          [t("狀態"), data.completion_status],
          [t("part／step"), `${text(data.part)} · ${text(data.step_index)}`],
          [t("記錄時刻（相對此時鐘域）"), formatMs(startMs)],
          [t("事件"), seqText],
        ],
      };
    }
    case "step": {
      const data = event.data;
      const at = parseNs(event.monotonic_ns);
      if (at === null) return "invalid";
      return {
        laneKey: "step",
        category: "step_event",
        start: at,
        end: null,
        label: `step ${String(data.step_index)}`,
        part: null,
        ref,
        key,
        details: (startMs) => [
          [t("類型"), t("step 事件（記錄時刻）")],
          [t("step／scheduler update"), `${String(data.step_index)} · ${text(data.scheduler_update_index)}`],
          ["forward index", text(data.forward_index)],
          [t("CFG 分支"), text(data.cfg_branch)],
          ["sigma", text(data.sigma)],
          ["host_ms", formatMs(data.host_ms)],
          ["GPU event", gpuEventText(data.gpu_event_ms, null)],
          [t("記錄時刻（相對此時鐘域）"), formatMs(startMs)],
          [t("事件"), seqText],
        ],
      };
    }
    case "log":
    case "notice": {
      if (event.level !== "warning" && event.level !== "error") return null;
      const at = parseNs(event.monotonic_ns);
      if (at === null) return "invalid";
      const message = event.kind === "log" ? event.data.message : `${event.data.code}: ${event.data.message}`;
      return {
        laneKey: "log",
        category: event.level === "error" ? "log_error" : "log_warning",
        start: at,
        end: null,
        label: message,
        part: null,
        ref,
        key,
        details: (startMs) => [
          [t("類型"), `${event.kind} · ${event.level}`],
          [t("訊息"), message],
          [t("記錄時刻（相對此時鐘域）"), formatMs(startMs)],
          [t("事件"), seqText],
        ],
      };
    }
    case "sample":
    default:
      return null;
  }
}

/** 區間依起點排序後以 first-fit 排入列，避免巢狀／重疊 span 互相遮蓋。 */
function packRows(items: ChartItem[]): number {
  const rowEnds: number[] = [];
  for (const item of items) {
    const end = item.endMs ?? item.startMs;
    let row = rowEnds.findIndex((rowEnd) => rowEnd <= item.startMs);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(end);
    } else {
      rowEnds[row] = end;
    }
    item.row = row;
  }
  return Math.max(1, rowEnds.length);
}

/** 一個 event stream 的已載入事件 → 每個 clock domain 一組泳道。 */
export function buildTimeline(events: readonly RecordingEvent[], streamId: string): TimelineModel {
  let invalid = 0;
  let reversed = 0;
  const byDomain = new Map<string, { derived: boolean; drafts: Draft[] }>();
  for (const event of events) {
    const draft = draftFor(event, streamId);
    if (draft === null) continue;
    if (draft === "invalid") {
      invalid += 1;
      continue;
    }
    if (draft === "reversed") {
      reversed += 1;
      continue;
    }
    const { domain, derived } = eventClockDomain(event);
    const bucket = byDomain.get(domain) ?? { derived: true, drafts: [] };
    bucket.derived = bucket.derived && derived;
    bucket.drafts.push(draft);
    byDomain.set(domain, bucket);
  }

  const groups: ChartGroup[] = [];
  for (const [domain, bucket] of byDomain) {
    let base: bigint | null = null;
    for (const draft of bucket.drafts) if (base === null || draft.start < base) base = draft.start;
    if (base === null) continue;
    const lanes = new Map<string, ChartItem[]>();
    let endMs = 0;
    for (const draft of bucket.drafts) {
      const startMs = nsToRelMs(base, draft.start);
      const end = draft.end === null ? null : nsToRelMs(base, draft.end);
      const duration = end === null ? null : end - startMs;
      endMs = Math.max(endMs, end ?? startMs);
      const item: ChartItem = {
        key: draft.key,
        category: draft.category,
        startMs,
        endMs: end,
        label: draft.label,
        row: 0,
        part: draft.part,
        details: draft.details(startMs, duration),
        ref: draft.ref,
      };
      const list = lanes.get(draft.laneKey) ?? [];
      list.push(item);
      lanes.set(draft.laneKey, list);
    }
    const laneList: ChartLane[] = [...lanes.entries()]
      .sort(([a], [b]) => laneOrder(a) - laneOrder(b) || a.localeCompare(b))
      .map(([key, items]) => {
        items.sort((a, b) => a.startMs - b.startMs || (b.endMs ?? b.startMs) - (a.endMs ?? a.startMs));
        const meta = laneMeta(key);
        return { key, ...meta, rows: meta.marker ? 1 : packRows(items), items };
      });
    groups.push({
      key: `${streamId}|${domain}`,
      domain,
      title: shortDomain(domain),
      derived: bucket.derived,
      lanes: laneList,
      endMs,
      itemCount: bucket.drafts.length,
    });
  }
  groups.sort((a, b) => b.itemCount - a.itemCount || a.domain.localeCompare(b.domain));
  return { groups, invalid, reversed };
}

const NICE_MS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000,
];

/** 0 起算的刻度（ms）。 */
export function msTicks(endMs: number, maxTicks: number): number[] {
  if (!Number.isFinite(endMs) || endMs <= 0) return [0];
  const target = endMs / Math.max(1, maxTicks);
  const step = NICE_MS.find((candidate) => candidate >= target) ?? Math.ceil(target / 3_600_000) * 3_600_000;
  const ticks: number[] = [];
  for (let i = 0; i * step <= endMs * (1 + 1e-9); i += 1) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}
