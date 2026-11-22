import { toJsonObject as record } from "@/lib/json";
// summary.part_totals → 可排序的部件列。host 時間是 inclusive（含子部件）host span；
// gpu_event_ms 是 CUDA event 區間並附 coverage；未知值保持 null，排序時一律排最後。
import type { RecordingSummary } from "@/api/generated/contracts";

export interface PartTransfer {
  category: string;
  count: number | null;
  bytes: number | null;
}

export interface PartRow {
  part: string;
  depth: number;
  calls: number | null;
  hostMsInclusive: number | null;
  /** 只有 summary 明確提供時才有；不以 inclusive 相減推算。 */
  hostMsExclusive: number | null;
  gpuEventMs: number | null;
  gpuEventCoverage: string | null;
  coverageReason: string | null;
  counters: [string, number | null][];
  transfers: PartTransfer[];
  raw: Record<string, unknown>;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}


export function partRows(summary: RecordingSummary): PartRow[] {
  return Object.entries(summary.part_totals)
    .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined)
    .map(([part, totals]) => {
      const counters = record(totals["counters"]);
      const transfers = record(totals["transfers"]);
      return {
        part,
        depth: part.split(".").length - 1,
        calls: num(totals["calls"]),
        hostMsInclusive: num(totals["host_ms_inclusive"]),
        hostMsExclusive: num(totals["host_ms_exclusive"]),
        gpuEventMs: num(totals["gpu_event_ms"]),
        gpuEventCoverage: str(totals["gpu_event_coverage"]) ?? str(totals["coverage"]),
        coverageReason: str(totals["coverage_reason"]) ?? str(totals["reason"]),
        counters: counters ? Object.entries(counters).map(([name, value]) => [name, num(value)] as [string, number | null]) : [],
        transfers: transfers
          ? Object.entries(transfers).map(([category, value]) => {
              const entry = record(value);
              return { category, count: num(entry?.["count"]), bytes: num(entry?.["bytes"]) };
            })
          : [],
        raw: totals,
      };
    });
}

export type PartSortKey = "part" | "calls" | "host" | "gpu" | "bytes";
export type SortDirection = "asc" | "desc";

/** 搬運 bytes 排序只看單一類別（不同類別不相加）。 */
export function sortPartRows(rows: readonly PartRow[], key: PartSortKey, direction: SortDirection, bytesCategory = "weight_h2d"): PartRow[] {
  const pick = (row: PartRow): number | string | null => {
    switch (key) {
      case "part":
        return row.part;
      case "calls":
        return row.calls;
      case "host":
        return row.hostMsInclusive;
      case "gpu":
        return row.gpuEventMs;
      case "bytes":
        return row.transfers.find((transfer) => transfer.category === bytesCategory)?.bytes ?? null;
    }
  };
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    if (va === null && vb === null) return a.part.localeCompare(b.part);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "string" || typeof vb === "string") return sign * String(va).localeCompare(String(vb));
    return sign * (va - vb) || a.part.localeCompare(b.part);
  });
}
