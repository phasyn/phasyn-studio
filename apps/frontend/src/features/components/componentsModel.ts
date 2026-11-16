// 元件頁的純函式：篩選、表格欄位、基本資料（顯示名稱／資料夾／自動啟動／使用上限）的修改、使用某個 instance 的元件組合。
import type { ComponentEntry } from "@/api/catalog";
import type { ComponentDescriptor, ComponentMetaPatch } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import type { ColumnSpec } from "@/components/workbench/columnWidths";
import { folderDisplayPath, folderOf, parseFolderInput } from "@/components/workbench/componentFolders";
import { toErrorInfo } from "@/lib/errors";
import { valuesEqual } from "@/lib/json";
import { limitsText, parseLimits } from "./limitsModel";
import { t } from "@/i18n";

export interface ComponentFilters {
  q: string;
  state: string;
}

export function hasActiveFilters(filters: ComponentFilters): boolean {
  return filters.q.trim() !== "" || filters.state !== "";
}

export function matchesFilters(entry: ComponentEntry, filters: ComponentFilters): boolean {
  if (filters.state && entry.descriptor.state !== filters.state) return false;
  const q = filters.q.trim().toLowerCase();
  if (!q) return true;
  const d = entry.descriptor;
  const folder = folderOf(d);
  // The folder matches by its value and by the name shown on screen (a default category is shown translated)
  return [d.component_id, d.label, d.provider_id, d.runtime_id, d.device.id, d.device.resource_group, folder, folderDisplayPath(folder)].some((text) => text.toLowerCase().includes(q));
}

/**
 * 元件表的欄位（寬度可調，依表格存在這台瀏覽器）；預設總寬約 848 px。1600 px 寬的三欄版面中欄約 690 px：instance、
 * provider、device、狀態與 revision 放得下，其餘向右捲動。
 */
export const COMPONENT_COLUMNS: readonly ColumnSpec[] = [
  { id: "instance", label: "instance", defaultWidth: 236, minWidth: 140 },
  { id: "provider", label: "provider", defaultWidth: 136, minWidth: 80 },
  { id: "device", label: "device", defaultWidth: 112, minWidth: 72 },
  { id: "state", label: t("狀態"), defaultWidth: 112, minWidth: 72 },
  { id: "revision", label: "revision", defaultWidth: 80, minWidth: 64 },
  { id: "call", label: t("目前呼叫"), defaultWidth: 84, minWidth: 64 },
  { id: "error", label: t("最近錯誤"), defaultWidth: 88, minWidth: 64 },
];

/** 基本資料的編輯草稿（文字原樣保留，送出前才正規化）。limits 是 JSON 文字（空白＝沒有使用上限）。 */
export interface MetaDraft {
  label: string;
  folder: string;
  autostart: boolean;
  limits: string;
}

type MetaFields = Pick<ComponentDescriptor, "label" | "folder" | "autostart" | "limits">;

export function metaDraftOf(descriptor: MetaFields): MetaDraft {
  return { label: descriptor.label, folder: descriptor.folder ?? "", autostart: descriptor.autostart, limits: limitsText(descriptor.limits) };
}

export interface MetaPlan {
  /** 只含有變更的欄位；沒有變更或有錯誤時為 null。 */
  patch: ComponentMetaPatch | null;
  labelError: string | null;
  folderError: string | null;
  limitsError: string | null;
  /** 與伺服器值不同（正規化後比較；含有錯誤的修改）。 */
  dirty: boolean;
}

/** 伺服器上的資料夾正規化（與輸入同一套規則）；不合法的舊值保持原樣比較。 */
function serverFolder(folder: string | null): string | null {
  const parsed = parseFolderInput(folder ?? "");
  return parsed.error ? folder : parsed.value;
}

/**
 * 草稿 → PATCH …/meta 的內容（minProperties 1：只送有變的欄位）。與伺服器值比較前兩邊都正規化（名稱去掉前後空白、
 * 資料夾每層去掉空白）：伺服器的值有多餘空白時，未修改的草稿不會一直顯示「未儲存」，也不會在改別的欄位時順便改寫它。
 */
export function buildMetaPatch(descriptor: MetaFields, draft: MetaDraft): MetaPlan {
  const patch: ComponentMetaPatch = {};
  const label = draft.label.trim();
  const labelError = label === "" ? t("顯示名稱不能是空的") : null;
  const labelChanged = label !== descriptor.label.trim();
  if (!labelError && labelChanged) patch.label = label;
  const folder = parseFolderInput(draft.folder);
  const folderChanged = folder.error ? draft.folder !== (descriptor.folder ?? "") : folder.value !== serverFolder(descriptor.folder);
  if (!folder.error && folderChanged) patch.folder = folder.value;
  const autostartChanged = draft.autostart !== descriptor.autostart;
  if (autostartChanged) patch.autostart = draft.autostart;
  // limits：解析後與伺服器值比較（格式或縮排不同不算修改）
  const limits = parseLimits(draft.limits);
  const limitsChanged = limits.ok ? !valuesEqual(limits.value, descriptor.limits) : draft.limits !== limitsText(descriptor.limits);
  if (limits.ok && limitsChanged) patch.limits = limits.value;
  const limitsError = limits.ok ? null : limits.error;
  const changed = Object.keys(patch).length > 0;
  const hasError = labelError !== null || folder.error !== null || limitsError !== null;
  return {
    patch: changed && !hasError ? patch : null,
    labelError,
    folderError: folder.error,
    limitsError,
    dirty: labelChanged || folderChanged || autostartChanged || limitsChanged,
  };
}

export interface PipelineUse {
  pipelineId: string;
  label: string;
  stepIds: string[];
}

/** 引用某個 instance 的元件組合（刪除前列出：刪除後這些步驟會顯示「未知元件」）。 */
export function pipelinesUsing(pipelines: readonly WirePipeline[], nodeId: string, componentId: string): PipelineUse[] {
  return pipelines.flatMap((pipeline) => {
    const stepIds = pipeline.steps.filter((step) => step.node_id === nodeId && step.component_id === componentId).map((step) => step.step_id);
    return stepIds.length > 0 ? [{ pipelineId: pipeline.pipeline_id, label: pipeline.label || pipeline.pipeline_id, stepIds }] : [];
  });
}

/** 刪除／基本資料寫入失敗是因為這個 instance 已不在 Node 上（契約錯誤碼 NOT_FOUND）。 */
export function isInstanceGone(error: unknown): boolean {
  return toErrorInfo(error).code === "NOT_FOUND";
}

/** 刪除只允許已停止或錯誤；其他狀態回傳原因。 */
export function deleteBlockReason(entry: Pick<ComponentEntry, "descriptor" | "node">): string | null {
  if (entry.node.stale) return t("Node 離線或狀態過時：無法刪除");
  const state = entry.descriptor.state;
  if (state === "stopped" || state === "error") return null;
  return t("先停止元件才能刪除");
}
