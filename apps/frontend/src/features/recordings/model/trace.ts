// torch.profiler Chrome trace（JSON）→ GPU kernel／memcpy 泳道。
// trace 有自己的時鐘：只在 trace 視窗內有效，獨立成一組，不與事件時間軸對齊或相加。
import { formatMs } from "@/lib/format";
import type { ChartCategory, ChartGroup, ChartItem, ChartLane } from "./timeline";
import { t } from "@/i18n";

export interface TraceModel {
  group: ChartGroup | null;
  kernelCount: number;
  memcpyCount: number;
  /** 超過繪製上限而未納入的 GPU 活動數。 */
  truncated: number;
  /** 檔案中無法解讀的條目數。 */
  skipped: number;
}

interface RawTraceEvent {
  name: string;
  cat: string;
  ts: number;
  dur: number;
  pid: string;
  tid: string;
  device: string | null;
  stream: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function idText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "?";
}

function categoryOf(cat: string): ChartCategory | null {
  const lower = cat.toLowerCase();
  if (lower === "kernel") return "kernel";
  if (lower === "gpu_memcpy" || lower === "memcpy") return "memcpy";
  if (lower === "gpu_memset" || lower === "memset") return "memset";
  return null;
}

/** 解析 trace JSON（`{traceEvents:[...]}` 或陣列）；只取 ph=X 的 kernel／gpu_memcpy／gpu_memset。 */
export function parseChromeTrace(json: unknown, limit = 20_000): TraceModel {
  const root = asRecord(json);
  const list: unknown[] = Array.isArray(json) ? json : Array.isArray(root?.traceEvents) ? (root.traceEvents as unknown[]) : [];
  const raw: Array<RawTraceEvent & { category: ChartCategory }> = [];
  let skipped = 0;
  let kernelCount = 0;
  let memcpyCount = 0;
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record || record.ph !== "X" || typeof record.cat !== "string") continue;
    const category = categoryOf(record.cat);
    if (!category) continue;
    const ts = record.ts;
    const dur = record.dur;
    if (typeof ts !== "number" || typeof dur !== "number" || !Number.isFinite(ts) || !Number.isFinite(dur) || dur < 0) {
      skipped += 1;
      continue;
    }
    if (category === "kernel") kernelCount += 1;
    else memcpyCount += 1;
    const args = asRecord(record.args);
    raw.push({
      name: typeof record.name === "string" ? record.name : "(unnamed)",
      cat: record.cat,
      ts,
      dur,
      pid: idText(record.pid),
      tid: idText(record.tid),
      device: args && args.device !== undefined ? idText(args.device) : null,
      stream: args && args.stream !== undefined ? idText(args.stream) : null,
      category,
    });
  }
  if (raw.length === 0) return { group: null, kernelCount, memcpyCount, truncated: 0, skipped };
  raw.sort((a, b) => a.ts - b.ts);
  const kept = raw.slice(0, limit);
  const truncated = raw.length - kept.length;
  const base = kept[0]?.ts ?? 0;
  const lanes = new Map<string, { label: string; items: ChartItem[] }>();
  let endMs = 0;
  kept.forEach((event, index) => {
    const laneKey = `${event.device ?? event.pid}|${event.stream ?? event.tid}`;
    const startMs = (event.ts - base) / 1000;
    const durMs = event.dur / 1000;
    endMs = Math.max(endMs, startMs + durMs);
    const lane = lanes.get(laneKey) ?? { label: `device ${event.device ?? event.pid} · stream ${event.stream ?? event.tid}`, items: [] };
    lane.items.push({
      key: `trace:${index}`,
      category: event.category,
      startMs,
      endMs: startMs + durMs,
      label: event.name,
      row: 0,
      part: null,
      ref: { kind: "trace", index },
      details: [
        [t("類型"), t("{cat}（trace）", { cat: event.cat })],
        [t("名稱"), event.name],
        [t("開始（相對 trace 第一筆 GPU 活動）"), formatMs(startMs)],
        [t("長度（trace dur）"), formatMs(durMs)],
        [t("device／stream"), `${event.device ?? event.pid} · ${event.stream ?? event.tid}`],
      ],
    });
    lanes.set(laneKey, lane);
  });
  const laneList: ChartLane[] = [...lanes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, lane]) => {
      const rowEnds: number[] = [];
      for (const item of lane.items) {
        let row = rowEnds.findIndex((end) => end <= item.startMs);
        if (row === -1) {
          row = rowEnds.length;
          rowEnds.push(item.endMs ?? item.startMs);
        } else rowEnds[row] = item.endMs ?? item.startMs;
        item.row = row;
      }
      return { key, label: lane.label, caption: t("trace 時鐘（GPU 活動）"), marker: false, rows: Math.max(1, rowEnds.length), items: lane.items };
    });
  return {
    group: {
      key: "trace",
      domain: "profiler trace clock",
      title: t("trace 時鐘"),
      derived: false,
      lanes: laneList,
      endMs,
      itemCount: kept.length,
    },
    kernelCount,
    memcpyCount,
    truncated,
    skipped,
  };
}
