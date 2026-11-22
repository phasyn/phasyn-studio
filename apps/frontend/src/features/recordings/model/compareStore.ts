// 「加入比較」清單：每位使用者瀏覽器內的便利狀態（最多 8 筆），跨分頁以 storage 事件同步。
// 比較頁本身只讀 URL 的 ?ids=，這份清單只是產生連結的暫存；storage 不可用時退回記憶體（lib/persistentStore）。
import { comparisonPath } from "@/app/paths";
import { createPersistentStore } from "@/lib/persistentStore";

export const MAX_COMPARE = 8;
const STORAGE_KEY = "phasyn.recordings.compare.v1";

/** 解析逗號分隔的 recording IDs：去空白、去重、保序，最多 8 筆。 */
export function parseIds(value: string | null | undefined): string[] {
  if (!(value != null && value !== "")) return [];
  const ids: string[] = [];
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_COMPARE) break;
  }
  return ids;
}

export function comparisonHref(ids: readonly string[]): string {
  return comparisonPath(ids);
}

const store = createPersistentStore<string[]>({
  key: STORAGE_KEY,
  initial: [],
  parse: (raw) => (Array.isArray(raw) ? parseIds(raw.filter((item): item is string => typeof item === "string").join(",")) : []),
});

export interface CompareSelection {
  ids: string[];
  has: (id: string) => boolean;
  full: boolean;
  add: (id: string) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
  replace: (ids: string[]) => void;
}

export function useCompareSelection(): CompareSelection {
  const ids = store.use();
  return {
    ids,
    has: (id) => ids.includes(id),
    full: ids.length >= MAX_COMPARE,
    add: (id) => { store.set((current) => (current.includes(id) || current.length >= MAX_COMPARE ? current : [...current, id])); },
    remove: (id) => { store.set((current) => current.filter((item) => item !== id)); },
    toggle: (id) => { store.set((current) => (current.includes(id) ? current.filter((item) => item !== id) : current.length < MAX_COMPARE ? [...current, id] : current)); },
    clear: () => { store.set([]); },
    replace: (next) => { store.set(parseIds(next.join(","))); },
  };
}
