// 插件管理視窗「已安裝」清單的推導：類型與來源（附數量）、搜尋、排序與狀態詞。純函式。
// 狀態欄只在需要處理時出現一個詞（已停用、不相容、無效）；其餘事實在詳情。
import type { StudioPlugin } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { joinInline } from "@/i18n/format";
import { pluginName } from "./evaluate";
import { pluginTextHaystack } from "./text";

export type PluginKind = "rules" | "generation" | "code";
export type KindFilter = "all" | PluginKind;
export type PluginSource = StudioPlugin["source"];
export type SourceFilter = "all" | PluginSource;

export const PLUGIN_KINDS: readonly PluginKind[] = ["rules", "generation", "code"];
export const PLUGIN_SOURCES: readonly PluginSource[] = ["builtin", "installed", "dev"];
export const PLUGIN_SORT_KEYS = ["name", "updated", "author", "status"] as const;
export type PluginSortKey = (typeof PLUGIN_SORT_KEYS)[number];

const KIND_LABELS: Record<PluginKind, () => string> = {
  rules: () => t("規則與風格"),
  generation: () => t("生成設定"),
  code: () => t("面板與指令"),
};

const SOURCE_LABELS: Record<PluginSource, () => string> = {
  builtin: () => t("內建"),
  installed: () => t("已安裝"),
  dev: () => t("開發"),
};

const SORT_LABELS: Record<PluginSortKey, () => string> = {
  name: () => t("名稱"),
  updated: () => t("更新時間"),
  author: () => t("作者"),
  status: () => t("狀態"),
};

export function kindLabel(kind: PluginKind): string {
  return KIND_LABELS[kind]();
}

export function sourceLabel(source: PluginSource): string {
  return SOURCE_LABELS[source]();
}

export function sortLabel(key: PluginSortKey): string {
  return SORT_LABELS[key]();
}

/** 一個包有哪幾類貢獻（讀不到內容的包沒有任何一類）。 */
export function pluginKinds(plugin: StudioPlugin): PluginKind[] {
  const { rules, presets, generation, commands, panels } = plugin.contributes;
  const kinds: PluginKind[] = [];
  if (rules.length > 0 || presets.length > 0) kinds.push("rules");
  if (generation.length > 0) kinds.push("generation");
  if (plugin.has_code || commands.length > 0 || panels.length > 0) kinds.push("code");
  return kinds;
}

/** 清單「類型」欄的文字。 */
export function kindSummary(plugin: StudioPlugin): string {
  const kinds = pluginKinds(plugin);
  return kinds.length > 0 ? joinInline(kinds.map(kindLabel)) : "—";
}

export interface StatusWord {
  word: string;
  tone: "neutral" | "warning" | "danger";
}

/** 需要處理時的狀態詞；一切正常時為 null（清單不放多餘的標籤）。 */
export function statusWord(plugin: StudioPlugin): StatusWord | null {
  switch (plugin.status) {
    case "disabled":
      return { word: t("已停用"), tone: "neutral" };
    case "incompatible":
      return { word: t("不相容"), tone: "warning" };
    case "invalid":
      return { word: t("無效"), tone: "danger" };
    default:
      return null;
  }
}

export interface PluginFilter {
  kind: KindFilter;
  source: SourceFilter;
  query: string;
}

function haystack(plugin: StudioPlugin): string {
  const { rules, presets, generation, commands, panels } = plugin.contributes;
  return [
    plugin.plugin_id,
    plugin.author?.name ?? "",
    pluginTextHaystack(plugin.name),
    pluginTextHaystack(plugin.description),
    ...rules.map((entry) => `${entry.ref}\n${pluginTextHaystack(entry.rule.label)}`),
    ...presets.map((entry) => pluginTextHaystack(entry.preset.label)),
    ...generation.map((entry) => `${entry.ref}\n${pluginTextHaystack(entry.generation.label)}`),
    ...commands.map((entry) => pluginTextHaystack(entry.title)),
    ...panels.map((entry) => pluginTextHaystack(entry.title)),
  ]
    .join("\n")
    .toLocaleLowerCase();
}

export function filterPlugins(items: readonly StudioPlugin[], filter: PluginFilter): StudioPlugin[] {
  const needle = filter.query.trim().toLocaleLowerCase();
  return items.filter((plugin) => {
    if (filter.source !== "all" && plugin.source !== filter.source) return false;
    if (filter.kind !== "all" && !pluginKinds(plugin).includes(filter.kind)) return false;
    return needle === "" || haystack(plugin).includes(needle);
  });
}

/** 需要處理的排前面。 */
const STATUS_RANK: Record<StudioPlugin["status"], number> = { invalid: 0, incompatible: 1, disabled: 2, ok: 3 };

function compareBy(key: PluginSortKey, a: StudioPlugin, b: StudioPlugin): number {
  switch (key) {
    case "updated":
      return (a.updated_at ?? a.installed_at ?? "").localeCompare(b.updated_at ?? b.installed_at ?? "");
    case "author":
      return (a.author?.name ?? "").localeCompare(b.author?.name ?? "");
    case "status":
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    default:
      return 0;
  }
}

/** 依欄位排序；相同時依名稱、再依 id（結果固定）。 */
export function sortPlugins(items: readonly StudioPlugin[], key: PluginSortKey, descending: boolean): StudioPlugin[] {
  const byName = (a: StudioPlugin, b: StudioPlugin) => pluginName(a).localeCompare(pluginName(b)) || a.plugin_id.localeCompare(b.plugin_id);
  return [...items].sort((a, b) => {
    const order = key === "name" ? byName(a, b) : compareBy(key, a, b);
    if (order !== 0) return descending ? -order : order;
    return byName(a, b);
  });
}

/** 排序欄位預設的方向：更新時間由新到舊，其餘由小到大。 */
export function defaultSortDescending(key: PluginSortKey): boolean {
  return key === "updated";
}

export function countKinds(items: readonly StudioPlugin[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: items.length, rules: 0, generation: 0, code: 0 };
  for (const plugin of items) for (const kind of pluginKinds(plugin)) counts[kind] += 1;
  return counts;
}

export function countSources(items: readonly StudioPlugin[]): Record<SourceFilter, number> {
  const counts: Record<SourceFilter, number> = { all: items.length, builtin: 0, installed: 0, dev: 0 };
  for (const plugin of items) counts[plugin.source] += 1;
  return counts;
}

/** 貢獻數量的摘要（「規則 9・推薦組合 2」）；沒有任何貢獻時為空字串。 */
export function contributionSummary(plugin: StudioPlugin): string {
  const { rules, presets, generation, commands, panels } = plugin.contributes;
  const parts = [
    rules.length > 0 ? t("規則 {count}", { count: rules.length }) : null,
    presets.length > 0 ? t("推薦組合 {count}", { count: presets.length }) : null,
    generation.length > 0 ? t("生成設定 {count}", { count: generation.length }) : null,
    commands.length > 0 ? t("指令 {count}", { count: commands.length }) : null,
    panels.length > 0 ? t("面板 {count}", { count: panels.length }) : null,
  ].filter((part): part is string => part !== null);
  return joinInline(parts);
}
