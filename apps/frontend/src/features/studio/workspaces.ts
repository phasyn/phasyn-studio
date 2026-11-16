// Video Studio 的工作區分頁（/studio/:workspace）：工具列分頁與頁面內容都由這份清單產生。三個工作區共用同一個剪輯狀態
// （editor/EditorProvider）：「鏡頭」寫 prompt、渲染與挑 take；「編輯」是唯一能改時間軸的地方；「渲染」看佇列與輸出。
// 每個工作區是獨立的 chunk（React.lazy）：開啟專案時就先載入目前的工作區（與讀取專案並行），切換分頁時才載入其他的。
// badge＝"renders" 的分頁旁顯示這個專案進行中的渲染／匯出數量；en＝寬螢幕時膠囊上的英文副標。
import { Clapperboard, Scissors, Wand2, type LucideIcon } from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { t } from "@/i18n";

export interface StudioWorkspace {
  id: string;
  label: string;
  /** 英文副標（工具列的步驟流程膠囊在寬螢幕顯示；只是裝飾，不朗讀）。 */
  en?: string;
  icon: LucideIcon;
  hint: string;
  Component: LazyExoticComponent<ComponentType>;
  /** Starts loading the workspace's chunk (opening a project does this while the project is read). */
  preload: () => Promise<unknown>;
  badge?: "renders";
}

function lazyWorkspace(load: () => Promise<ComponentType>): Pick<StudioWorkspace, "Component" | "preload"> {
  const loadModule = () => load().then((Component) => ({ default: Component }));
  return { Component: lazy(loadModule), preload: loadModule };
}

export const STUDIO_WORKSPACES: readonly StudioWorkspace[] = [
  {
    id: "generate",
    label: t("鏡頭"),
    en: "Generate",
    icon: Wand2,
    hint: t("生成鏡頭、Prompt 與 take"),
    ...lazyWorkspace(() => import("./components/ShotWorkspace").then((m) => m.ShotWorkspace)),
  },
  {
    id: "edit",
    label: t("編輯"),
    en: "Edit",
    icon: Scissors,
    hint: t("剪輯、轉場、效果、調色、音訊、字幕與匯出"),
    ...lazyWorkspace(() => import("./editor/EditWorkspace").then((m) => m.EditWorkspace)),
  },
  {
    id: "render",
    label: t("渲染"),
    en: "Render",
    icon: Clapperboard,
    hint: t("渲染佇列、階段進度與輸出"),
    badge: "renders",
    ...lazyWorkspace(() => import("./components/RenderWorkspace").then((m) => m.RenderWorkspace)),
  },
];

/** 已經移除的工作區 → 接手它功能的工作區（舊連結照常開啟，並保留網址參數）。 */
const MOVED_WORKSPACES: Readonly<Record<string, string>> = { effects: "edit" };

export function findWorkspace(id: string | undefined): StudioWorkspace | null {
  return STUDIO_WORKSPACES.find((workspace) => workspace.id === id) ?? null;
}

/** 不認得的工作區要導向哪裡：搬走的導向接手的工作區，其他導向「編輯」。 */
export function fallbackWorkspace(id: string | undefined): string {
  return (id !== undefined ? MOVED_WORKSPACES[id] : undefined) ?? "edit";
}

/** 專案在某個工作區的網址。 */
export function projectHref(workspace: string, projectId: string): string {
  return `/studio/${workspace}?project=${encodeURIComponent(projectId)}`;
}
