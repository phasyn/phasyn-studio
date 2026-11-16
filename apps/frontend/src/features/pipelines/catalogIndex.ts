// 目錄查詢：(node_id, component_id) → descriptor；元件選單選項（含 kind、就緒狀態與載入 revision）。
import { componentEntries, providerFor, type NodeView, type ProviderIndex } from "@/api/catalog";
import type { Catalog, ComponentDescriptor, ProviderInfo } from "@/api/generated/contracts";
import { statusSpec } from "@/components/common/statusSpec";
import { componentVariant } from "@/lib/h3Variant";
import { isTestProvider } from "./instancePickerModel";
import type { DescriptorLookup } from "./pipelineModel";
import { t } from "@/i18n";

export function makeLookup(catalog: Catalog | undefined): DescriptorLookup {
  const map = new Map(componentEntries(catalog).map((entry) => [entry.key, entry.descriptor]));
  return (nodeId, componentId) => map.get(`${nodeId}::${componentId}`) ?? null;
}

export interface ComponentOption {
  value: string;
  node: NodeView;
  descriptor: ComponentDescriptor;
  provider: ProviderInfo | null;
  kind: string | null;
}

export function optionValue(nodeId: string, componentId: string): string {
  return `${nodeId}::${componentId}`;
}

export function parseOptionValue(value: string): { nodeId: string; componentId: string } | null {
  const index = value.indexOf("::");
  if (index <= 0) return null;
  return { nodeId: value.slice(0, index), componentId: value.slice(index + 2) };
}

export function componentOptions(catalog: Catalog | undefined, providers: ProviderIndex): ComponentOption[] {
  return componentEntries(catalog).map((entry) => {
    const provider = providerFor(providers, entry.descriptor);
    return { value: entry.key, node: entry.node, descriptor: entry.descriptor, provider, kind: provider?.kind ?? null };
  });
}

/** 例：「就緒 · 載入 #3」「已停止 · 未載入」「離線（過時）」。 */
export function readinessText(option: Pick<ComponentOption, "descriptor" | "node">): string {
  const state = statusSpec("component", option.descriptor.state).label;
  const loaded = option.descriptor.settings.loaded_revision === null ? t("未載入") : t("載入 #{loaded_revision}", { loaded_revision: option.descriptor.settings.loaded_revision });
  const stale = option.node.stale ? t(" · Node 離線（過時）") : "";
  const restart = option.descriptor.settings.restart_required ? t(" · 需 restart") : "";
  return `${state} · ${loaded}${restart}${stale}`;
}

/** 依 Node 分組（<optgroup>）。 */
export function groupOptions(options: readonly ComponentOption[]): Array<{ node: NodeView; options: ComponentOption[] }> {
  const groups = new Map<string, { node: NodeView; options: ComponentOption[] }>();
  for (const option of options) {
    const group = groups.get(option.node.node_id) ?? { node: option.node, options: [] };
    group.options.push(option);
    groups.set(option.node.node_id, group);
  }
  return [...groups.values()];
}

/** 測試／合成元件（test.*，或 provider 清單標示 synthetic）：不是正式生成元件，範本不列出。 */
export function isSyntheticOption(option: Pick<ComponentOption, "descriptor" | "provider">): boolean {
  return isTestProvider(option.descriptor.provider_id) || option.provider?.synthetic === true;
}

/** 預設選擇的順序：0＝就緒（ready／busy，Node 在線）、1＝Node 在線、2＝其他（離線 Node 的過時快照）。 */
export function readinessRank(option: Pick<ComponentOption, "descriptor" | "node">): number {
  if (option.node.stale) return 2;
  return option.descriptor.state === "ready" || option.descriptor.state === "busy" ? 0 : 1;
}

/**
 * 範本某一步（或正式解碼）可選的元件，第一個就是預設：依 kinds 的順序（第一個是建議），同 kind 時就緒 → 在線 → 其他。
 * 測試／合成元件不列出。`outputType`：元件還要宣告一個該 type_id 的輸出埠，用來分辨同一個 kind 的不同用途
 * （影像與聲音的參考編碼都是 reference.encode，差別只在輸出）。
 * `variant`：H3 元件需要的 checkpoint variant（fl2va／ref2va，例如參考生成的 DiT 必須是 ref2va）。符合的排在最前面
 * （優先於就緒狀態：兩個 DiT 都停止時，不能因為目錄順序而預設選到錯的那個）；不符合的仍然列出，由使用者決定。
 */
export function slotCandidates(options: readonly ComponentOption[], kinds: readonly string[], outputType?: string, variant?: string): ComponentOption[] {
  const variantRank = (option: ComponentOption): number => (variant === undefined || componentVariant(option.descriptor) === variant ? 0 : 1);
  return options
    .filter(
      (option) =>
        option.kind !== null &&
        kinds.includes(option.kind) &&
        !isSyntheticOption(option) &&
        (outputType === undefined || option.descriptor.outputs.some((port) => port.type_id === outputType)),
    )
    .sort((a, b) => variantRank(a) - variantRank(b) || kinds.indexOf(a.kind ?? "") - kinds.indexOf(b.kind ?? "") || readinessRank(a) - readinessRank(b));
}

/** 某 kind 的元件：就緒者優先、離線 Node 殿後。 */
export function optionsOfKind(options: readonly ComponentOption[], kind: string): ComponentOption[] {
  return options
    .filter((option) => option.kind === kind)
    .sort((a, b) => Number(a.descriptor.state !== "ready") - Number(b.descriptor.state !== "ready") || Number(a.node.stale) - Number(b.node.stale));
}
