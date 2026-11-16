// 元件修改區左欄的資料（純函式）：「元件」分頁＝一個 Node 的資料夾樹，「元件組合」分頁＝已保存的元件組合清單。
// 執行紀錄、追蹤設定、效能紀錄、比較、語意已移到「紀錄」「推理」工作區，不在這裡列出。
import { Boxes, Folder, LayoutList, Workflow, type LucideIcon } from "lucide-react";
import type { ComponentEntry } from "@/api/catalog";
import type { WirePipeline } from "@/api/types";
import { statusSpec } from "@/components/common/statusSpec";
import { buildFolderTree, folderOf, usesDefaultFolder, type FolderNode, folderDisplayName, folderDisplayPath } from "@/components/workbench/componentFolders";
import { providerKind } from "@/components/workbench/kinds";
import { componentsHref } from "@/components/workbench/nodeTabModel";
import type { TreeItem } from "@/components/workbench/treeModel";
import { t } from "@/i18n";

export type ExplorerTab = "components" | "pipelines";

export interface AdminSection {
  id: ExplorerTab;
  path: string;
  label: string;
  icon: LucideIcon;
  hint: string;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { id: "components", path: "/admin/components", label: t("元件"), icon: Boxes, hint: t("各 Node 的元件 instance：分類、設定、啟停") },
  { id: "pipelines", path: "/admin/pipelines", label: t("元件組合"), icon: Workflow, hint: t("元件組合（pipeline）的步驟與接線") },
];

export const PIPELINES_PATH = "/admin/pipelines";
export const PIPELINE_LIST_ID = "pipelines:all";

export const componentTreeId = (nodeId: string, componentId: string) => `component:${nodeId}:${componentId}`;
export const folderTreeId = (nodeId: string, path: string) => `folder:${nodeId}:${path}`;
export const pipelineTreeId = (pipelineId: string) => `pipeline:${pipelineId}`;

export function pipelineHref(pipelineId: string): string {
  return `${PIPELINES_PATH}/${encodeURIComponent(pipelineId)}`;
}

/** 目前網址屬於哪個分頁（元件組合頁＝元件組合，其他＝元件）。 */
export function explorerSectionOf(pathname: string): ExplorerTab {
  return pathname.startsWith(PIPELINES_PATH) ? "pipelines" : "components";
}

function componentItem(entry: ComponentEntry): TreeItem {
  const { descriptor, node } = entry;
  const kind = providerKind(descriptor.provider_id);
  const state = statusSpec("component", descriptor.state);
  const folder = folderOf(descriptor);
  return {
    id: componentTreeId(node.node_id, descriptor.component_id),
    label: descriptor.component_id,
    icon: kind.icon,
    iconTone: kind.tone,
    to: componentsHref(node.node_id, descriptor.component_id),
    title: [
      descriptor.label || descriptor.component_id,
      `${descriptor.provider_id} · ${state.label}${node.stale ? t("（Node 離線，狀態可能過時）") : ""}`,
      t("資料夾：{folder}{value}", { folder: folderDisplayPath(folder), value: usesDefaultFolder(descriptor) ? t("（依 provider 預設分類）") : "" }),
    ].join("\n"),
    dot: node.stale ? "warning" : statusSpec("component", descriptor.state).tone,
    dotLabel: node.stale ? t("{label}（過時）", { label: state.label }) : state.label,
    muted: node.stale,
    keywords: [descriptor.provider_id, descriptor.label, descriptor.device.resource_group, folder, folderDisplayPath(folder)],
  };
}

function folderItem(nodeId: string, folder: FolderNode<ComponentEntry>): TreeItem {
  return {
    id: folderTreeId(nodeId, folder.path),
    label: folderDisplayName(folder.path),
    icon: Folder,
    count: folder.total,
    title: t("{path}（{total} 個 instance）", { path: folderDisplayPath(folder.path), total: folder.total }),
    keywords: [folder.path, folderDisplayPath(folder.path)],
    // 與元件表相同：資料夾自己的 instance 在前，子資料夾在後。
    children: [...folder.items.map(componentItem), ...folder.folders.map((child) => folderItem(nodeId, child))],
  };
}

/** 一個 Node 的 instance → 資料夾樹（folder 為 null 時依 provider 預設分類）。 */
export function componentFolderItems(nodeId: string, entries: readonly ComponentEntry[]): TreeItem[] {
  const own = entries.filter((entry) => entry.node.node_id === nodeId);
  return buildFolderTree(own, (entry) => folderOf(entry.descriptor)).map((folder) => folderItem(nodeId, folder));
}

/** 「全部元件組合」：清單頁。 */
export function pipelineListItem(count: number): TreeItem {
  return {
    id: PIPELINE_LIST_ID,
    label: t("全部元件組合"),
    icon: LayoutList,
    to: PIPELINES_PATH,
    count,
    title: t("已保存的元件組合清單（新增、從範本建立）"),
  };
}

/** 一個已保存的元件組合（連到編輯頁）。 */
export function pipelineItem(pipeline: WirePipeline): TreeItem {
  const label = pipeline.label || pipeline.pipeline_id;
  return {
    id: pipelineTreeId(pipeline.pipeline_id),
    label,
    icon: Workflow,
    iconTone: "action",
    to: pipelineHref(pipeline.pipeline_id),
    title: t("{label}\n{pipeline_id} · {stepsCount} 個步驟", { label, pipeline_id: pipeline.pipeline_id, stepsCount: pipeline.steps.length }),
    detail: t("{stepsCount} 步", { stepsCount: pipeline.steps.length }),
    keywords: [pipeline.pipeline_id],
  };
}

/** 「全部元件組合」（清單頁）＋每個已保存的元件組合（沒有分類資料時的平面清單）。 */
export function pipelineItems(pipelines: readonly WirePipeline[]): TreeItem[] {
  return [pipelineListItem(pipelines.length), ...pipelines.map(pipelineItem)];
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** 依網址決定左欄要標示的項目：元件頁＝選取的 instance；元件組合頁＝清單或開啟中的元件組合。 */
export function explorerSelection(pathname: string, search: URLSearchParams): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "admin") return null;
  const page = parts[1] ?? "components";
  if (page === "components") {
    const node = search.get("node");
    const component = search.get("component");
    return node && component ? componentTreeId(node, component) : null;
  }
  if (page === "pipelines") {
    if (!parts[2]) return PIPELINE_LIST_ID;
    const detail = decodeSegment(parts[2]);
    return detail && detail !== "new" ? pipelineTreeId(detail) : null;
  }
  return null;
}
