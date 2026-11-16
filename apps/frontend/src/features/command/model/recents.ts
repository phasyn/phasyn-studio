// "Recently opened" entries: validation, ordering and merging with live items. Pure; the browser store that keeps
// them is in useCommandSources (lib/persistentStore).
import { isRecord } from "@/lib/json";
import type { CommandItem, CommandKind } from "./items";

export interface RecentEntry {
  to: string;
  title: string;
  kind: CommandKind;
  /** 開啟時間（epoch ms）。 */
  at: number;
}

export const RECENTS_KEY = "phasyn.command.recents.v1";
export const RECENTS_MAX = 8;

const KINDS = new Set<string>(["page", "component", "pipeline", "run", "project"]);
const APP_PATH = /^\/(image|studio|admin|records|inference)(\/|\?|#|$)/;

/** 只接受本產品的站內路徑（/image、/studio、/admin、/records、/inference），避免儲存內容被竄改成外部或奇怪的位址。 */
export function isAppPath(to: string): boolean {
  return APP_PATH.test(to) && !to.includes("\\") && !/\s/.test(to);
}

/** 容錯解析（已解析的 JSON）：非陣列、欄位錯誤的項目一律略過；依 to 去重、保序、最多 RECENTS_MAX 筆。 */
export function parseRecents(parsed: unknown): RecentEntry[] {
  if (!Array.isArray(parsed)) return [];
  const out: RecentEntry[] = [];
  for (const value of parsed as unknown[]) {
    if (!isRecord(value)) continue;
    const { title, kind, at } = value;
    const to = typeof value.to === "string" && isAppPath(value.to) ? value.to : null;
    if (to === null || out.some((entry) => entry.to === to)) continue;
    if (typeof title !== "string" || title.trim().length === 0) continue;
    out.push({
      to,
      title: title.trim().slice(0, 200),
      kind: typeof kind === "string" && KINDS.has(kind) ? (kind as CommandKind) : "page",
      at: typeof at === "number" && Number.isFinite(at) ? at : 0,
    });
    if (out.length >= RECENTS_MAX) break;
  }
  return out;
}

/** 新項目放最前面；同一個 to 只保留一筆。 */
export function addRecent(list: readonly RecentEntry[], entry: RecentEntry, max = RECENTS_MAX): RecentEntry[] {
  if (!isAppPath(entry.to)) return [...list];
  return [entry, ...list.filter((item) => item.to !== entry.to)].slice(0, max);
}

export function recentEntryOf(item: CommandItem, at: number): RecentEntry {
  return { to: item.to, title: item.title, kind: item.kind, at };
}

/** 最近開啟 → 面板項目：目前資料裡找得到同一個 to 就用最新的標題與狀態，否則用當時記下的標題。 */
export function recentItems(recents: readonly RecentEntry[], live: readonly CommandItem[]): CommandItem[] {
  const byTo = new Map<string, CommandItem>();
  for (const item of live) if (!byTo.has(item.to)) byTo.set(item.to, item);
  return recents.map((entry) => {
    const current = byTo.get(entry.to);
    if (current) return { ...current, id: `recent:${entry.to}`, group: "recent" };
    return {
      id: `recent:${entry.to}`,
      group: "recent",
      kind: entry.kind,
      title: entry.title,
      subtitle: entry.to,
      ident: entry.to,
      keywords: [],
      to: entry.to,
    };
  });
}
