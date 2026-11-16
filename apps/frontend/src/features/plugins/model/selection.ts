// 專案選用的插件貢獻（StudioProject.prompt_plugins）的編輯：加入、移除、套用推薦組合、整包啟用或停用。純函式，
// 回傳新的引用陣列（依選取順序），由呼叫端寫回專案。同一組（例如 style）同時只能選一個：加入同組的另一條會取代原本那條。
import type { StudioPlugin, StudioPluginRef } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { pluginUnusableReason, ruleLabel } from "./evaluate";
import { pluginRefs, pluginUsable, refsOfPlugin, registryLimits, resolveRef, type PluginRegistry, type RegistryPreset } from "./registry";
import { uniqueRefs } from "./refs";

export interface AddCheck {
  /** 不能加入的原因；可以加入時為 null。 */
  reason: string | null;
  /** 加入後會被取代的同組規則；沒有時為 null。 */
  replaces: StudioPluginRef | null;
}

/** 已選取的規則裡與這條同組的那一條。 */
function groupMember(registry: PluginRegistry, refs: readonly StudioPluginRef[], ref: StudioPluginRef): StudioPluginRef | null {
  const group = registry.rules.get(ref)?.rule.group;
  if (!group) return null;
  return refs.find((other) => other !== ref && registry.rules.get(other)?.rule.group === group) ?? null;
}

/** 這個貢獻現在能不能加進專案。 */
export function addCheck(registry: PluginRegistry, refs: readonly StudioPluginRef[], ref: StudioPluginRef): AddCheck {
  const resolved = resolveRef(registry, ref);
  if (resolved.kind === "missing") return { reason: t("找不到插件「{id}」", { id: ref }), replaces: null };
  const unusable = pluginUnusableReason(resolved.entry.plugin);
  if (unusable) return { reason: unusable, replaces: null };
  const replaces = groupMember(registry, refs, ref);
  const limit = registryLimits(registry)?.max_project_plugins;
  if (replaces === null && limit !== undefined && !refs.includes(ref) && refs.length >= limit) {
    return { reason: t("一個專案最多選 {limit} 個插件項目", { limit }), replaces: null };
  }
  return { reason: null, replaces };
}

/** 加入一個貢獻（同組的規則在原位置被取代）；不能加入時原樣回傳。 */
export function withRef(registry: PluginRegistry, refs: readonly StudioPluginRef[], ref: StudioPluginRef): StudioPluginRef[] {
  const current = uniqueRefs(refs);
  if (current.includes(ref)) return current;
  const check = addCheck(registry, current, ref);
  if (check.reason !== null) return current;
  return check.replaces === null ? [...current, ref] : current.map((other) => (other === check.replaces ? ref : other));
}

export function withoutRef(refs: readonly StudioPluginRef[], ref: StudioPluginRef): StudioPluginRef[] {
  return uniqueRefs(refs).filter((other) => other !== ref);
}

/** 加入時會被取代的規則的說明（給選單與 tooltip）。 */
export function replaceNote(registry: PluginRegistry, replaces: StudioPluginRef): string {
  const entry = registry.rules.get(replaces);
  return t("同一組只能選一個：會取代「{label}」", { label: entry ? ruleLabel(entry) : replaces });
}

function ruleRefs(registry: PluginRegistry, refs: readonly StudioPluginRef[]): StudioPluginRef[] {
  return refs.filter((ref) => !registry.generation.has(ref));
}

/** 目前選用的規則是不是正好等於這個推薦組合（順序不計；生成設定不算在內）。 */
export function presetActive(registry: PluginRegistry, refs: readonly StudioPluginRef[], preset: RegistryPreset): boolean {
  const selected = new Set(ruleRefs(registry, uniqueRefs(refs)));
  return preset.refs.length > 0 && selected.size === preset.refs.length && preset.refs.every((ref) => selected.has(ref));
}

export interface PresetPlan {
  /** 套用後的引用：推薦組合的規則，後面接著原本選用的生成設定。 */
  refs: StudioPluginRef[];
  /** 不能套用的原因；可以時為 null。 */
  reason: string | null;
}

/** 套用推薦組合：規則換成這一組（原本選的其他規則拿掉），已選用的生成設定保留。 */
export function presetPlan(registry: PluginRegistry, refs: readonly StudioPluginRef[], preset: RegistryPreset): PresetPlan {
  const kept = uniqueRefs(refs).filter((ref) => registry.generation.has(ref));
  const next = uniqueRefs([...preset.refs, ...kept]);
  const unusable = pluginUnusableReason(preset.plugin);
  if (unusable) return { refs: next, reason: unusable };
  const missing = preset.refs.find((ref) => {
    const entry = registry.rules.get(ref);
    return !entry || !pluginUsable(entry.plugin);
  });
  if (missing !== undefined) return { refs: next, reason: t("推薦組合裡的「{id}」無法套用", { id: missing }) };
  const limit = registryLimits(registry)?.max_project_plugins;
  if (limit !== undefined && next.length > limit) return { refs: next, reason: t("套用後會有 {count} 個插件項目，超過上限 {limit} 個", { count: next.length, limit }) };
  return { refs: next, reason: null };
}

export interface PluginEnablePlan {
  refs: StudioPluginRef[];
  /** 這次會加入的引用。 */
  added: StudioPluginRef[];
  /** 加不進去的引用（同組已經選了別的，或超過上限）。 */
  skipped: StudioPluginRef[];
}

/** 把一個包可以同時使用的貢獻都加進專案：不取代已經選好的同組規則，也不超過上限。 */
export function enablePluginPlan(registry: PluginRegistry, refs: readonly StudioPluginRef[], plugin: StudioPlugin): PluginEnablePlan {
  let next = uniqueRefs(refs);
  const added: StudioPluginRef[] = [];
  const skipped: StudioPluginRef[] = [];
  for (const ref of pluginRefs(plugin)) {
    if (next.includes(ref)) continue;
    const check = addCheck(registry, next, ref);
    if (check.reason !== null || check.replaces !== null) {
      skipped.push(ref);
      continue;
    }
    next = [...next, ref];
    added.push(ref);
  }
  return { refs: next, added, skipped };
}

/** 把一個包的貢獻全部從專案拿掉（含已不在包裡、但帶著它前綴的引用）。 */
export function withoutPlugin(plugin: StudioPlugin, refs: readonly StudioPluginRef[]): StudioPluginRef[] {
  const owned = new Set(refsOfPlugin(plugin, refs));
  return uniqueRefs(refs).filter((ref) => !owned.has(ref));
}
