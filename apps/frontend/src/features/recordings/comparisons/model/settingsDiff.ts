// settings_diff 正規化：伺服器項目可能是「每筆一值」（values 陣列或以 recording_id 為鍵）或成對的
// before／after（config_diff 格式，可能附 recording ID）。統一成「路徑 × recording」的格子；
// 伺服器沒給的格子才嘗試從該 recording 的 context.settings 依路徑讀出，並標示來源，讀不到就是「未知」。
import type { RecordingContext } from "@/api/generated/contracts";
import { sameValue } from "../../model/settings";
import { t } from "@/i18n";

export type DiffCell =
  | { state: "present"; value: unknown; resolved: boolean }
  | { state: "absent"; resolved: boolean }
  | { state: "unknown" };

export interface DiffRow {
  path: string;
  cells: DiffCell[];
  /** 與基準（第 1 欄）不同的欄位；未知格不算不同。 */
  changed: boolean[];
  anyChange: boolean;
  /** 無法解讀的原始項目（顯示原文，不猜）。 */
  raw: Record<string, unknown> | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function cellFromEntry(entry: unknown): DiffCell {
  const rec = record(entry);
  if (rec && "present" in rec && typeof rec.present === "boolean") {
    return rec.present ? { state: "present", value: rec.value, resolved: false } : { state: "absent", resolved: false };
  }
  return { state: "present", value: entry, resolved: false };
}

/** 依點路徑讀值；找不到回傳 undefined（與 null 值區分）。 */
function readPath(root: unknown, path: string): { found: boolean; value: unknown } {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    const rec = record(node);
    if (!rec || !(segment in rec)) return { found: false, value: undefined };
    node = rec[segment];
  }
  return { found: true, value: node };
}

function resolveFromContext(context: RecordingContext | undefined, path: string): DiffCell {
  if (!context) return { state: "unknown" };
  const settings = context.settings;
  const roots: unknown[] = settings ? [settings, settings.effective, settings.requested, context] : [context];
  for (const root of roots) {
    const hit = readPath(root, path);
    if (hit.found) return { state: "present", value: hit.value, resolved: true };
  }
  return { state: "unknown" };
}

function pairIds(item: Record<string, unknown>, ids: readonly string[]): [string | null, string | null] {
  for (const key of ["recording_ids", "pair"]) {
    const list = item[key];
    if (Array.isArray(list) && list.length === 2) return [str(list[0]), str(list[1])];
  }
  const base = str(item.baseline_id) ?? str(item.base_id) ?? str(item.before_recording_id) ?? ids[0] ?? null;
  const other =
    str(item.after_recording_id) ?? str(item.recording_id) ?? str(item.other_id) ?? str(item.against) ?? str(item.compared_id) ?? (ids.length === 2 ? (ids[1] ?? null) : null);
  return [base, other];
}

function cellsEqual(a: DiffCell, b: DiffCell): boolean {
  if (a.state === "unknown" || b.state === "unknown") return true;
  if (a.state !== b.state) return false;
  if (a.state === "present" && b.state === "present") return sameValue(a.value, b.value);
  return true;
}

export function normalizeSettingsDiff(
  items: ReadonlyArray<Record<string, unknown>>,
  ids: readonly string[],
  contexts: ReadonlyMap<string, RecordingContext> = new Map(),
): DiffRow[] {
  const rows = new Map<string, { cells: DiffCell[]; raw: Record<string, unknown> | null }>();
  const ensure = (path: string) => {
    let row = rows.get(path);
    if (!row) {
      row = { cells: ids.map((): DiffCell => ({ state: "unknown" })), raw: null };
      rows.set(path, row);
    }
    return row;
  };
  const indexOf = (id: string | null) => (id === null ? -1 : ids.indexOf(id));

  items.forEach((item, itemIndex) => {
    const path = str(item.path) ?? t("（未命名項目 {itemIndex}）", { itemIndex: itemIndex + 1 });
    const row = ensure(path);
    const values = item.values ?? item.per_recording ?? item.by_recording;
    if (Array.isArray(values)) {
      values.forEach((entry, index) => {
        if (index < ids.length) row.cells[index] = cellFromEntry(entry);
      });
      return;
    }
    const keyed = record(values);
    if (keyed) {
      ids.forEach((id, index) => {
        row.cells[index] = id in keyed ? cellFromEntry(keyed[id]) : { state: "absent", resolved: false };
      });
      return;
    }
    if ("before" in item || "after" in item) {
      const [baseId, otherId] = pairIds(item, ids);
      const baseIndex = indexOf(baseId);
      const otherIndex = indexOf(otherId);
      if (baseIndex >= 0) {
        row.cells[baseIndex] = item.before_present === false ? { state: "absent", resolved: false } : { state: "present", value: item.before, resolved: false };
      }
      if (otherIndex >= 0) {
        row.cells[otherIndex] = item.after_present === false ? { state: "absent", resolved: false } : { state: "present", value: item.after, resolved: false };
      }
      if (baseIndex < 0 || otherIndex < 0) row.raw = item;
      return;
    }
    row.raw = item;
  });

  return [...rows.entries()]
    .map(([path, row]) => {
      const cells = row.cells.map((cell, index) => (cell.state === "unknown" ? resolveFromContext(contexts.get(ids[index] ?? ""), path) : cell));
      const base = cells[0] ?? { state: "unknown" as const };
      const changed = cells.map((cell, index) => index > 0 && !cellsEqual(cell, base));
      return { path, cells, changed, anyChange: changed.some(Boolean) || row.raw !== null, raw: row.raw };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

const CONDITION_BASE = [
  "recording.mode",
  "recording.device_sample_hz",
  "recording.trace_steps",
  "recording.gpu_event_timing",
  "environment.memory_model",
  "environment.device_id",
  "model_identity.identity_strength",
  "model_identity.sha256",
];

const CONDITION_PATTERN = /cold|warm|compile|cache|resident|capture|warmup|graph|profil|seed|shape/i;

function conditionKeys(prefix: string, value: unknown, out: Set<string>) {
  const walk = (node: unknown, path: string) => {
    const rec = record(node);
    if (rec && Object.keys(rec).length > 0) {
      for (const [key, child] of Object.entries(rec)) walk(child, `${path}.${key}`);
      return;
    }
    if (CONDITION_PATTERN.test(path)) out.add(path);
  };
  walk(value, prefix);
}

/** 量測條件列（recorder 模式、冷暖／compile／cache、裝置、模型身分強度）：全部由各 recording 的 context 讀出；沒記錄就是「未知」。 */
export function conditionRows(ids: readonly string[], contexts: ReadonlyMap<string, RecordingContext>): DiffRow[] {
  const paths = new Set(CONDITION_BASE);
  for (const context of contexts.values()) {
    conditionKeys("environment", context.environment, paths);
    conditionKeys("input_summary", context.input_summary, paths);
  }
  return [...paths]
    .map((path) => {
      const cells = ids.map((id): DiffCell => {
        const context = contexts.get(id);
        if (!context) return { state: "unknown" };
        for (const root of [context, context.settings]) {
          const hit = readPath(root, path);
          if (hit.found) return { state: "present", value: hit.value, resolved: false };
        }
        return { state: "unknown" };
      });
      const base = cells[0] ?? { state: "unknown" as const };
      const changed = cells.map((cell, index) => index > 0 && !cellsEqual(cell, base));
      return { path, cells, changed, anyChange: changed.some(Boolean), raw: null };
    })
    .filter((row) => row.cells.some((cell) => cell.state !== "unknown"));
}
