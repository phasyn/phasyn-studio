// take 記下渲染當時各插件貢獻的內容版本（StudioTake.prompt_plugin_revs：引用 → 登錄表的 rev）。之後任何一個貢獻的
// rev 與登錄表目前的不同（規則的比對條件或 inject 改了、或這個貢獻已經不在登錄表裡），這個 take 就是「設定已變更」。
// 沒有這個欄位的舊 take 只比對引用清單；登錄表還沒讀到時無法比較，不當成變更（讀到之後再判斷）。
import type { StudioPluginRef } from "@/api/generated/contracts";
import { resolveRef, type PluginRegistry } from "./registry";
import { uniqueRefs } from "./refs";

export type PluginRevs = Record<StudioPluginRef, string>;

/** 這個引用目前在登錄表的 rev；不在登錄表裡為 null。 */
export function currentRev(registry: PluginRegistry, ref: StudioPluginRef): string | null {
  const resolved = resolveRef(registry, ref);
  return resolved.kind === "missing" ? null : resolved.entry.rev;
}

/** 渲染時要記在 take 上的 rev（登錄表沒讀到，或沒有任何引用對得到貢獻時為 null：不寫這個欄位）。 */
export function selectionRevs(registry: PluginRegistry, refs: readonly StudioPluginRef[] | null | undefined): PluginRevs | null {
  if (registry.status !== "ready") return null;
  const revs: PluginRevs = {};
  for (const ref of uniqueRefs(refs)) {
    const rev = currentRev(registry, ref);
    if (rev !== null) revs[ref] = rev;
  }
  return Object.keys(revs).length > 0 ? revs : null;
}

/** take 記下的 rev 與登錄表目前的不同的引用（登錄表還沒讀到，或 take 沒有記錄時為空）。 */
export function changedRevs(registry: PluginRegistry, revs: Readonly<Record<string, string | undefined>> | null | undefined): StudioPluginRef[] {
  if (registry.status !== "ready" || !revs) return [];
  return Object.entries(revs).flatMap(([ref, rev]) => (rev !== undefined && currentRev(registry, ref) !== rev ? [ref] : []));
}
