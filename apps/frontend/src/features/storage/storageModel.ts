// The 儲存空間 page's pure parts: the five cleanup categories, the request a dry run sends, which planned items the
// owner keeps selected, the one deletion request that follows the confirmation, and the result counts.
import type { StorageCategory, StorageCleanRequest, StorageCleanResult, StorageItem, StorageWork } from "@/api/generated/contracts";
import { formatBytes } from "@/lib/format";
import { formatDateTime } from "@/i18n/format";
import { t } from "@/i18n";

export interface CategorySpec {
  id: StorageCategory;
  label: string;
  /** What it deletes and what it keeps (the checkbox description). */
  description: string;
  /** Selected when the page opens. */
  defaultOn: boolean;
  /** A cost the confirmation repeats. */
  warning?: string;
}

export const CATEGORY_SPECS: readonly CategorySpec[] = [
  {
    id: "runs",
    label: t("沒有引用的 run"),
    description: t("沒有任何專案（take、素材庫、時間軸、匯出）、草稿、反推研究或釘選項目引用的已結束 run，連同它產生的影片、圖片與主控紀錄副本。"),
    defaultOn: true,
  },
  {
    id: "files",
    label: t("沒有引用的檔案"),
    description: t("主控與 Node 上沒有任何專案、run 或計畫引用的檔案（例如刪除專案後留下的上傳檔）。"),
    defaultOn: true,
  },
  {
    id: "remote_cache",
    label: t("Node 的下載副本"),
    description: t("Node 為了執行而從其他 Node 下載的副本（files/remote）：來源仍有同一份檔案，需要時會重新下載。"),
    defaultOn: true,
  },
  {
    id: "latents",
    label: t("已解碼 take 的 latent"),
    description: t("影片已解碼完成的 take 保留的中間 latent。"),
    defaultOn: false,
    warning: t("刪除後無法從 latent 重新解碼或細修這些 take；影片本身保留。"),
  },
  {
    id: "recordings",
    label: t("舊的效能紀錄"),
    description: t("超過指定天數、已結束的效能紀錄（主控副本與 Node 本機紀錄）。"),
    defaultOn: false,
    warning: t("刪除後無法再比較或匯出這些紀錄。"),
  },
];

export const DEFAULT_CATEGORIES: readonly StorageCategory[] = CATEGORY_SPECS.filter((spec) => spec.defaultOn).map((spec) => spec.id);

export function categorySpec(id: StorageCategory): CategorySpec {
  return CATEGORY_SPECS.find((spec) => spec.id === id) ?? { id, label: id, description: "", defaultOn: false };
}

export interface CleanForm {
  categories: readonly StorageCategory[];
  minAgeHours: number;
  recordingsDays: number;
  includeStandalone: boolean;
}

export const DEFAULT_FORM: CleanForm = { categories: DEFAULT_CATEGORIES, minAgeHours: 24, recordingsDays: 30, includeStandalone: false };

/** The dry run of the form (categories in the table's order; numbers clamped to what the contract accepts). */
export function planRequest(form: CleanForm): StorageCleanRequest {
  const categories = CATEGORY_SPECS.map((spec) => spec.id).filter((id) => form.categories.includes(id));
  return {
    categories,
    dry_run: true,
    options: {
      min_age_hours: Math.min(87600, Math.max(1, Number.isFinite(form.minAgeHours) ? form.minAgeHours : 24)),
      recordings_older_than_days: Math.min(3650, Math.max(1, Math.round(Number.isFinite(form.recordingsDays) ? form.recordingsDays : 30))),
      include_standalone_runs: form.includeStandalone,
    },
  };
}

/**
 * The one deletion that follows the confirmation: the plan's own categories and options, and exactly the planned
 * items still selected (in the plan's order). Null when nothing is selected.
 */
export function applyRequest(plan: StorageCleanResult, selected: ReadonlySet<string>): StorageCleanRequest | null {
  const items = plan.items.filter((item) => item.status === "planned" && selected.has(item.item_id)).map((item) => item.item_id);
  if (items.length === 0) return null;
  return { categories: plan.categories, dry_run: false, options: plan.options, ...(plan.scope ? { scope: plan.scope } : {}), items };
}

export interface Tally {
  count: number;
  bytes: number;
}

/** Count and known size of items, per category. */
export function tallyByCategory(items: readonly StorageItem[]): Map<StorageCategory, Tally> {
  const out = new Map<StorageCategory, Tally>();
  for (const item of items) {
    const tally = out.get(item.category) ?? { count: 0, bytes: 0 };
    tally.count += 1;
    tally.bytes += item.size_bytes ?? 0;
    out.set(item.category, tally);
  }
  return out;
}

export function selectedItems(plan: StorageCleanResult, selected: ReadonlySet<string>): StorageItem[] {
  return plan.items.filter((item) => selected.has(item.item_id));
}

/** Result counts by status (deleted counts what is gone, missing included). */
export function resultCounts(result: StorageCleanResult): { gone: number; bytes: number; kept: number; skipped: number; failed: number } {
  let gone = 0;
  let bytes = 0;
  let kept = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of result.items) {
    if (item.status === "deleted" || item.status === "missing") {
      gone += 1;
      if (item.status === "deleted") bytes += item.size_bytes ?? 0;
    } else if (item.status === "kept") kept += 1;
    else if (item.status === "skipped") skipped += 1;
    else if (item.status === "failed") failed += 1;
  }
  return { gone, bytes, kept, skipped, failed };
}

/** The statuses a result row shows. */
export function statusLabel(status: StorageItem["status"]): string {
  switch (status) {
    case "planned":
      return t("將刪除");
    case "deleted":
      return t("已刪除");
    case "missing":
      return t("已不存在");
    case "kept":
      return t("保留");
    case "skipped":
      return t("未變更");
    case "failed":
      return t("失敗");
  }
}

/** Parses NODE_ID/FILE_ID for a file pin (null when it is not two UUIDs). */
export function parseFileKey(text: string): { node_id: string; file_id: string } | null {
  const match = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/iu.exec(text);
  return match?.[1] !== undefined && match[2] !== undefined ? { node_id: match[1].toLowerCase(), file_id: match[2].toLowerCase() } : null;
}

export function isRunId(text: string): boolean {
  return /^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/iu.test(text);
}

/** What the automatic cleanup of a Node's work directories does, for the tooltip of its cell. */
export function workCleanupText(work: StorageWork): string {
  if (!work.enabled) return t("自動清理已關閉：已結束元件程序的工作目錄會留在磁碟上");
  const rule = t("已結束的元件程序，工作目錄閒置 {hours} 小時後自動刪除；執行中的不會動", { hours: work.ttl_hours });
  const last = work.last_sweep;
  if (!last) return t("{rule}。這次 Node 啟動後還沒清理過", { rule });
  return t("{rule}。上次清理 {time}：刪除 {removed} 個，釋放 {freed}", { rule, time: formatDateTime(last.at), removed: last.removed, freed: formatBytes(last.freed_bytes) });
}
