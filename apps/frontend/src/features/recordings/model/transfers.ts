// 搬運（transfer）彙整：summary.transfer_totals 的逐類別列，以及由已載入事件重算的對照。
// 規則：每個實際 copy 只有一個計數 owner；同 transfer_id 取最後狀態；
// no-op 不算 copy；network 只以 consumer 的接收量合計，producer／sender 只作對照、不相加；
// completed 未知時為 null（「未確認完成」），不是 0；不同類別的 bytes 不相加成「總頻寬」。
import type { RecordingEvent, RecordingSummary, TransferData } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export const TRANSFER_CATEGORIES = [
  "weight_h2d",
  "weight_d2h",
  "activation_h2d",
  "activation_d2h",
  "device_copy",
  "peer_copy",
  "host_copy",
  "network",
  "disk_read",
  "disk_write",
  "pin",
  "unpin",
  "diagnostic_readback",
] as const;

export const CATEGORY_HELP: Record<string, string> = {
  weight_h2d: t("權重 host → device"),
  weight_d2h: t("權重 device → host（丟棄 device 副本不算 D2H）"),
  activation_h2d: t("activation／輸入 host → device"),
  activation_d2h: t("activation／輸出 device → host"),
  device_copy: t("同 device 內複製"),
  peer_copy: t("device 之間（peer）複製"),
  host_copy: t("host 記憶體內複製"),
  network: t("跨 Node HTTP 檔案傳輸（consumer 接收量為唯一合計）"),
  disk_read: t("程式讀檔（邏輯 bytes，不是實體 NVMe I/O）"),
  disk_write: t("程式寫檔（邏輯 bytes）"),
  pin: t("pin host 記憶體（不是 H2D）"),
  unpin: t("取消 pin"),
  diagnostic_readback: t("診斷用讀回（debug 選項造成的額外 D2H）"),
};

/** 篩選選項：activation_* 合併為一組，其餘逐類別。 */
export const CATEGORY_FILTERS: readonly { id: string; label: string; match: (category: string) => boolean }[] = [
  { id: "all", label: t("全部類別"), match: () => true },
  { id: "weight_h2d", label: "weight_h2d", match: (c) => c === "weight_h2d" },
  { id: "weight_d2h", label: "weight_d2h", match: (c) => c === "weight_d2h" },
  { id: "activation", label: "activation_*", match: (c) => c.startsWith("activation_") },
  { id: "device_copy", label: "device_copy", match: (c) => c === "device_copy" },
  { id: "peer_copy", label: "peer_copy", match: (c) => c === "peer_copy" },
  { id: "host_copy", label: "host_copy", match: (c) => c === "host_copy" },
  { id: "network", label: "network", match: (c) => c === "network" },
  { id: "disk_read", label: "disk_read", match: (c) => c === "disk_read" },
  { id: "disk_write", label: "disk_write", match: (c) => c === "disk_write" },
  { id: "pin", label: t("pin／unpin"), match: (c) => c === "pin" || c === "unpin" },
  { id: "diagnostic_readback", label: "diagnostic_readback", match: (c) => c === "diagnostic_readback" },
];

/** undefined＝summary 沒有此欄位（未回報）；null＝明確未知。 */
export type Reported = number | null | undefined;

export interface TransferTotalsRow {
  category: string;
  submittedCount: Reported;
  submittedBytes: Reported;
  completedCount: Reported;
  completedBytes: Reported;
  logicalBytes: Reported;
  noOpCount: Reported;
  pendingCount: Reported;
  hostMsSum: Reported;
  gpuEventMsSum: Reported;
  effectiveGbps: Reported;
  owner: string | null;
  byteBasis: string | null;
  extra: Record<string, unknown>;
}

const KNOWN_TOTAL_KEYS = new Set([
  "submitted_count",
  "submitted_bytes",
  "completed_count",
  "completed_bytes",
  "logical_bytes",
  "no_op_count",
  "pending_count",
  "host_ms_sum",
  "gpu_event_ms_sum",
  "effective_gbps",
  "owner",
  "byte_basis",
]);

function reported(record: Record<string, unknown>, key: string): Reported {
  if (!(key in record)) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return formatList(value);
  return null;
}

export function transferTotalsRows(summary: RecordingSummary): TransferTotalsRow[] {
  const order = new Map<string, number>(TRANSFER_CATEGORIES.map((category, index) => [category, index]));
  return Object.entries(summary.transfer_totals)
    .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined)
    .map(([category, totals]) => ({
      category,
      submittedCount: reported(totals, "submitted_count"),
      submittedBytes: reported(totals, "submitted_bytes"),
      completedCount: reported(totals, "completed_count"),
      completedBytes: reported(totals, "completed_bytes"),
      logicalBytes: reported(totals, "logical_bytes"),
      noOpCount: reported(totals, "no_op_count"),
      pendingCount: reported(totals, "pending_count"),
      hostMsSum: reported(totals, "host_ms_sum"),
      gpuEventMsSum: reported(totals, "gpu_event_ms_sum"),
      effectiveGbps: reported(totals, "effective_gbps"),
      owner: textField(totals, "owner"),
      byteBasis: textField(totals, "byte_basis"),
      extra: Object.fromEntries(Object.entries(totals).filter(([key]) => !KNOWN_TOTAL_KEYS.has(key))),
    }))
    .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || a.category.localeCompare(b.category));
}

export interface TransferEventRow {
  streamId: string;
  seq: number;
  data: TransferData;
}

export interface EventTransferAggregate {
  category: string;
  /** 計入合計的邏輯 transfer 數（同 transfer_id 只算一次，取最後狀態）。 */
  transfers: number;
  submittedCount: number;
  submittedBytes: number;
  /** 任一計入項 completed 未知 → null（不是 0）。 */
  completedCount: number | null;
  completedBytes: number | null;
  /** 已確認完成部分的觀測和（僅供對照；completed 為 null 時不代表總量）。 */
  observedCompletedBytes: number;
  noOpCount: number;
  owners: string[];
  byteBases: string[];
  /** 計入合計的列（每個 transfer_id 的最後狀態）。 */
  counted: TransferEventRow[];
  /** 只作對照、不計入合計：network 的 producer／runtime 端紀錄。 */
  reference: TransferEventRow[];
}

/**
 * 由事件重算逐類別合計（與 Controller 彙整同語意），供展開 sender／receiver 對照。
 * events 應依讀取順序（stream 內 seq 遞增）傳入；同 transfer_id 以較後者為準。
 */
export function aggregateTransferEvents(events: readonly { streamId: string; event: RecordingEvent }[]): Map<string, EventTransferAggregate> {
  const latest = new Map<string, TransferEventRow>();
  const reference = new Map<string, TransferEventRow[]>();
  const noOps = new Map<string, number>();
  for (const { streamId, event } of events) {
    if (event.kind !== "transfer") continue;
    const data = event.data;
    const row: TransferEventRow = { streamId, seq: event.seq, data };
    if (!data.actual_copy || data.completion_status === "no_op") {
      noOps.set(data.category, (noOps.get(data.category) ?? 0) + 1);
      continue;
    }
    if (data.category === "network" && data.owner !== "consumer") {
      const list = reference.get(data.category) ?? [];
      list.push(row);
      reference.set(data.category, list);
      continue;
    }
    latest.set(`${data.category}|${data.transfer_id}`, row);
  }
  const result = new Map<string, EventTransferAggregate>();
  const ensure = (category: string): EventTransferAggregate => {
    let aggregate = result.get(category);
    if (!aggregate) {
      aggregate = {
        category,
        transfers: 0,
        submittedCount: 0,
        submittedBytes: 0,
        completedCount: 0,
        completedBytes: 0,
        observedCompletedBytes: 0,
        noOpCount: noOps.get(category) ?? 0,
        owners: [],
        byteBases: [],
        counted: [],
        reference: reference.get(category) ?? [],
      };
      result.set(category, aggregate);
    }
    return aggregate;
  };
  for (const row of latest.values()) {
    const aggregate = ensure(row.data.category);
    aggregate.transfers += 1;
    aggregate.submittedCount += row.data.submitted_count;
    aggregate.submittedBytes += row.data.submitted_bytes;
    aggregate.observedCompletedBytes += row.data.completed_bytes ?? 0;
    if (row.data.completed_bytes === null || row.data.completed_count === null) {
      aggregate.completedBytes = null;
      aggregate.completedCount = null;
    } else {
      if (aggregate.completedBytes !== null) aggregate.completedBytes += row.data.completed_bytes;
      if (aggregate.completedCount !== null) aggregate.completedCount += row.data.completed_count;
    }
    if (!aggregate.owners.includes(row.data.owner)) aggregate.owners.push(row.data.owner);
    if (!aggregate.byteBases.includes(row.data.byte_basis)) aggregate.byteBases.push(row.data.byte_basis);
    aggregate.counted.push(row);
  }
  for (const category of new Set([...reference.keys(), ...noOps.keys()])) ensure(category);
  return result;
}

/** 依 transfer_id 對照 network 的 consumer（計數）與 producer（對照）紀錄。 */
export function pairNetworkRows(aggregate: EventTransferAggregate): { transferId: string; consumer: TransferEventRow | null; senders: TransferEventRow[] }[] {
  const pairs = new Map<string, { transferId: string; consumer: TransferEventRow | null; senders: TransferEventRow[] }>();
  for (const row of aggregate.counted) {
    pairs.set(row.data.transfer_id, { transferId: row.data.transfer_id, consumer: row, senders: [] });
  }
  for (const row of aggregate.reference) {
    const pair = pairs.get(row.data.transfer_id) ?? { transferId: row.data.transfer_id, consumer: null, senders: [] };
    pair.senders.push(row);
    pairs.set(row.data.transfer_id, pair);
  }
  return [...pairs.values()];
}
