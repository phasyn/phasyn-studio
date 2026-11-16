// 專案可以選用的貢獻（規則與生成設定）的清單：加入選單、「這個專案」分頁與鏡頭的「插件」分頁共用。純函式。
// 依種類分組：限制（constraint）、風格（style，同組只能選一個）、效果（effect）、生成設定。
import type { StudioPlugin, StudioPluginRef } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { generationLabel, pluginName, resolveSelection, ruleLabel, type SelectionProblem } from "./evaluate";
import type { PluginRegistry, RegistryGeneration, RegistryRule } from "./registry";
import { uniqueRefs } from "./refs";
import { pluginText, pluginTextHaystack } from "./text";

export type ContributionKind = "constraint" | "style" | "effect" | "generation";
export type ContributionKindFilter = "all" | ContributionKind;

export const CONTRIBUTION_KINDS: readonly ContributionKind[] = ["constraint", "style", "effect", "generation"];

const KIND_LABELS: Record<ContributionKind, () => string> = {
  constraint: () => t("限制"),
  style: () => t("風格"),
  effect: () => t("效果"),
  generation: () => t("生成設定"),
};

export function contributionKindLabel(kind: ContributionKind): string {
  return KIND_LABELS[kind]();
}

export interface Contribution {
  ref: StudioPluginRef;
  kind: ContributionKind;
  /** 已依介面語言取出的標籤與說明。 */
  label: string;
  description: string;
  plugin: StudioPlugin;
  rule: RegistryRule | null;
  generation: RegistryGeneration | null;
  /** 搜尋用（小寫）：標籤與說明的所有語言、引用、所屬的包。 */
  haystack: string;
}

function ruleContribution(entry: RegistryRule): Contribution {
  return {
    ref: entry.ref,
    kind: entry.rule.kind,
    label: ruleLabel(entry),
    description: pluginText(entry.rule.description),
    plugin: entry.plugin,
    rule: entry,
    generation: null,
    haystack: [entry.ref, pluginTextHaystack(entry.rule.label), pluginTextHaystack(entry.rule.description), pluginTextHaystack(entry.plugin.name)].join("\n").toLocaleLowerCase(),
  };
}

function generationContribution(entry: RegistryGeneration): Contribution {
  return {
    ref: entry.ref,
    kind: "generation",
    label: generationLabel(entry),
    description: pluginText(entry.generation.description),
    plugin: entry.plugin,
    rule: null,
    generation: entry,
    haystack: [entry.ref, pluginTextHaystack(entry.generation.label), pluginTextHaystack(entry.generation.description), pluginTextHaystack(entry.plugin.name)]
      .join("\n")
      .toLocaleLowerCase(),
  };
}

const listed = new WeakMap<PluginRegistry, readonly Contribution[]>();

/** 登錄表裡所有可以被專案選用的貢獻，依登錄表的順序（內建、已安裝、開發；包內依 manifest）。 */
export function listContributions(registry: PluginRegistry): readonly Contribution[] {
  let items = listed.get(registry);
  if (!items) {
    items = [...[...registry.rules.values()].map(ruleContribution), ...[...registry.generation.values()].map(generationContribution)];
    listed.set(registry, items);
  }
  return items;
}

export function findContribution(registry: PluginRegistry, ref: StudioPluginRef): Contribution | null {
  return listContributions(registry).find((item) => item.ref === ref) ?? null;
}

export function filterContributions(items: readonly Contribution[], kind: ContributionKindFilter, query: string): Contribution[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => (kind === "all" || item.kind === kind) && (needle === "" || item.haystack.includes(needle)));
}

export function countContributionKinds(items: readonly Contribution[]): Record<ContributionKindFilter, number> {
  const counts: Record<ContributionKindFilter, number> = { all: items.length, constraint: 0, style: 0, effect: 0, generation: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

export interface SelectedItem {
  ref: StudioPluginRef;
  /** 登錄表裡的貢獻；找不到時為 null。 */
  contribution: Contribution | null;
  /** 這個引用不能套用的原因；可以套用時為 null。 */
  problem: SelectionProblem | null;
}

/** 專案選用的引用逐一對到貢獻與它的問題（依選取順序）。 */
export function selectedItems(registry: PluginRegistry, refs: readonly StudioPluginRef[] | null | undefined): SelectedItem[] {
  const problems = resolveSelection(registry, refs).problems;
  return uniqueRefs(refs).map((ref) => ({
    ref,
    contribution: findContribution(registry, ref),
    problem: problems.find((problem) => problem.ref === ref) ?? null,
  }));
}

/** 顯示用：貢獻的名稱（找不到時是引用本身）。 */
export function selectedLabel(item: SelectedItem): string {
  return item.contribution?.label ?? item.ref;
}

/** tooltip 用：說明與所屬的包。 */
export function contributionTitle(item: Contribution): string {
  return [item.label, item.description, t("來自「{plugin}」", { plugin: pluginName(item.plugin) })].filter((part) => part !== "").join("\n");
}
