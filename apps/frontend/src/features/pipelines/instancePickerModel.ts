// 步驟的元件 instance 選擇（純函式）：
//  - 相容 instance：與步驟目前元件相同 provider_id 的 instance（任何 Node），依 Node 分組，顯示資料夾與設定摘要；
//  - 元件庫：新步驟（或改用其他類型）時依 Node → 資料夾挑選。
// 測試元件（test.*）只在步驟本來就用測試元件時出現。
import { Server } from "lucide-react";
import type { ComponentEntry, NodeView } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { statusSpec } from "@/components/common/statusSpec";
import { buildFolderTree, compareFolderPaths, folderDisplayName, folderDisplayPath, folderOf, type FolderNode } from "@/components/workbench/componentFolders";
import { providerKind } from "@/components/workbench/kinds";
import type { TreeItem } from "@/components/workbench/treeModel";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";

export function isTestProvider(providerId: string | null | undefined): boolean {
  return typeof providerId === "string" && providerId.startsWith("test.");
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * 已保存 load 設定的簡短摘要：provider_options.variant、LoRA（manifest 名稱與非 1 的 scale）、量化方案、
 * 非 native 的計算精度、offload 模式。只列有設定的欄位，不猜預設值。
 */
export function settingsSummary(descriptor: Pick<ComponentDescriptor, "settings">): string[] {
  const load: Record<string, unknown> = isRecord(descriptor.settings.stored.load) ? descriptor.settings.stored.load : {};
  const out: string[] = [];
  const options = isRecord(load.provider_options) ? load.provider_options : {};
  if (typeof options.variant === "string" && options.variant) out.push(options.variant);
  if (isRecord(options.lora)) {
    const source = typeof options.lora.manifest_path === "string" ? options.lora.manifest_path : typeof options.lora.name === "string" ? options.lora.name : "";
    const name = source ? basename(source).replace(/\.json$/i, "") : "";
    const scale = typeof options.lora.scale === "number" && options.lora.scale !== 1 ? ` ×${options.lora.scale}` : "";
    out.push(`LoRA${name ? ` ${name}` : ""}${scale}`);
  }
  const precision = isRecord(load.precision) ? load.precision : {};
  if (isRecord(precision.quantization) && typeof precision.quantization.scheme === "string" && precision.quantization.scheme !== "none") {
    out.push(precision.quantization.scheme);
  }
  if (typeof precision.compute_dtype === "string" && precision.compute_dtype !== "native") out.push(precision.compute_dtype);
  if (isRecord(load.offload) && typeof load.offload.mode === "string") out.push(`offload ${load.offload.mode}`);
  return out;
}

export interface CandidateGroup {
  node: NodeView;
  entries: ComponentEntry[];
}

function byFolderThenName(a: ComponentEntry, b: ComponentEntry): number {
  return (
    compareFolderPaths(folderOf(a.descriptor), folderOf(b.descriptor)) ||
    (a.descriptor.label || a.descriptor.component_id).localeCompare(b.descriptor.label || b.descriptor.component_id, "zh-Hant") ||
    a.descriptor.component_id.localeCompare(b.descriptor.component_id)
  );
}

/** 與 providerId 相同的 instance（任何 Node），依 Node 分組（目錄順序）、組內依資料夾與名稱。 */
export function compatibleInstances(entries: readonly ComponentEntry[], providerId: string): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const entry of entries) {
    if (entry.descriptor.provider_id !== providerId) continue;
    const group = groups.get(entry.node.node_id) ?? { node: entry.node, entries: [] };
    group.entries.push(entry);
    groups.set(entry.node.node_id, group);
  }
  for (const group of groups.values()) group.entries.sort(byFolderThenName);
  return [...groups.values()];
}

/** 元件庫的候選：不含測試元件，除非步驟目前用的就是測試元件。 */
export function libraryEntries(entries: readonly ComponentEntry[], currentProviderId: string | null): ComponentEntry[] {
  const includeTest = isTestProvider(currentProviderId);
  return entries.filter((entry) => includeTest || !isTestProvider(entry.descriptor.provider_id));
}

export const libraryNodeId = (nodeId: string) => `lib-node:${nodeId}`;
export const libraryFolderId = (nodeId: string, path: string) => `lib-folder:${nodeId}:${path}`;
export const libraryInstanceId = (key: string) => `lib-instance:${key}`;

function instanceItem(entry: ComponentEntry): TreeItem {
  const d = entry.descriptor;
  const kind = providerKind(d.provider_id);
  const state = statusSpec("component", d.state);
  const summary = settingsSummary(d);
  const folder = folderOf(d);
  return {
    id: libraryInstanceId(entry.key),
    label: d.label || d.component_id,
    detail: d.component_id,
    icon: kind.icon,
    iconTone: kind.tone,
    title: [t("{value}（{component_id}）", { value: d.label || d.component_id, component_id: d.component_id }), `${d.provider_id} · ${state.label}${entry.node.stale ? t("（Node 離線，狀態可能過時）") : ""}`, t("資料夾：{d}", { d: folderDisplayPath(folder) }), ...(summary.length > 0 ? [summary.join(" · ")] : [])].join("\n"),
    dot: entry.node.stale ? "warning" : state.tone,
    dotLabel: entry.node.stale ? t("{label}（過時）", { label: state.label }) : state.label,
    muted: entry.node.stale,
    keywords: [d.component_id, d.provider_id, folder, folderDisplayPath(folder), ...summary],
  };
}

function folderItem(nodeId: string, folder: FolderNode<ComponentEntry>): TreeItem {
  return {
    id: libraryFolderId(nodeId, folder.path),
    label: folderDisplayName(folder.path),
    count: folder.total,
    title: t("{path}（{total} 個 instance）", { path: folderDisplayPath(folder.path), total: folder.total }),
    keywords: [folder.path, folderDisplayPath(folder.path)],
    children: [...folder.items.map(instanceItem), ...folder.folders.map((child) => folderItem(nodeId, child))],
  };
}

/** 元件庫樹：Node（目錄順序）→ 資料夾 → instance；沒有候選的 Node 不列出。 */
export function libraryTree(entries: readonly ComponentEntry[]): TreeItem[] {
  const nodes = new Map<string, NodeView>();
  for (const entry of entries) if (!nodes.has(entry.node.node_id)) nodes.set(entry.node.node_id, entry.node);
  return [...nodes.values()].map((node) => {
    const own = entries.filter((entry) => entry.node.node_id === node.node_id);
    return {
      id: libraryNodeId(node.node_id),
      label: node.label,
      icon: Server,
      count: own.length,
      title: `${node.label}\n${node.node_id}${node.stale ? t("\n離線（資料過時）") : ""}`,
      dot: node.stale ? "warning" : "success",
      dotLabel: node.stale ? t("離線（資料過時）") : t("線上"),
      muted: node.stale,
      keywords: [node.node_id],
      children: buildFolderTree(own, (entry) => folderOf(entry.descriptor)).map((folder) => folderItem(node.node_id, folder)),
    } satisfies TreeItem;
  });
}
