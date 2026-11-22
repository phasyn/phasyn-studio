// 插件管理視窗的狀態（由 PluginManagerHost 持有，所以關閉再開啟仍保留篩選、選取與進行中的安裝）與它的 context。
import { createContext, use } from "react";
import type { StudioPluginId, StudioPluginRef } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { ContributionKindFilter } from "../model/contributions";
import type { KindFilter, PluginSortKey, SourceFilter } from "../model/listing";
import type { PluginRegistry } from "../model/registry";
import type { InstallFlow } from "./install/useInstallFlow";

/** 視窗所在的專案：它選用的插件貢獻與寫回的方法（一般的專案編輯，會進入自動保存）。 */
export interface PluginProjectBinding {
  projectId: string;
  title: string;
  /** StudioProject.prompt_plugins。 */
  refs: readonly StudioPluginRef[];
  onRefsChange: (refs: StudioPluginRef[]) => void;
}

export type NoticeTone = "success" | "info" | "warning" | "danger";

export interface ManagerNotice {
  tone: NoticeTone;
  text: string;
  serial: number;
}

export type ProjectStatusFilter = "all" | "active" | "attention";

export interface InstalledView {
  kind: KindFilter;
  source: SourceFilter;
  query: string;
  sort: PluginSortKey;
  descending: boolean;
  selectedId: StudioPluginId | null;
  /** 右欄顯示選取的包，還是進行中的安裝（預覽、失敗）。 */
  pane: "plugin" | "install";
}

export interface ProjectView {
  kind: ContributionKindFilter;
  status: ProjectStatusFilter;
  query: string;
  selectedRef: StudioPluginRef | null;
}

export interface ManagerValue {
  registry: PluginRegistry;
  project: PluginProjectBinding | null;
  install: InstallFlow;
  /** 開啟選檔對話框。 */
  pickFile: () => void;
  /** 現在不能安裝的原因（設定檔關閉、登錄表還沒讀到）；可以時為 null。 */
  installBlocked: string | null;
  notice: ManagerNotice | null;
  notify: (tone: NoticeTone, text: string) => void;
  clearNotice: () => void;
  installed: InstalledView;
  setInstalled: (patch: Partial<InstalledView>) => void;
  projectView: ProjectView;
  setProjectView: (patch: Partial<ProjectView>) => void;
  /** 切到「已安裝」並選取這個包。 */
  showPlugin: (pluginId: StudioPluginId) => void;
  /** 要求移除這個包（開啟確認框）。 */
  requestRemove: (pluginId: StudioPluginId) => void;
}

export const ManagerContext = createContext<ManagerValue | null>(null);

export function useManager(): ManagerValue {
  const value = use(ManagerContext);
  if (!value) throw new Error(t("useManager 必須在插件管理視窗內使用"));
  return value;
}
