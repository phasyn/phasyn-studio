// 研究工作區的共用狀態（StudyWorkspace 建立，各分頁讀取）。
import type { Catalog } from "@/api/generated/contracts";
import type { StudyDocument } from "../hooks/useStudyDocument";
import type { TaskRunner } from "../hooks/useTaskRunner";
import type { ComponentChoice, ComponentRole } from "../model/components";
import type { ImageRoute } from "../model/routes";
import type { CandidateRef, GenerationSettings, PromptStudy, PromptStudyTask, TaskComponents } from "../types";
import { t } from "@/i18n";

export type TabId = "source" | "scene" | "render" | "search";

/** 分頁標籤不含編號（步驟列在圓點裡顯示編號，報讀時也會念「步驟 n」）；en＝英文副標（裝飾）。 */
export const TABS: ReadonlyArray<{ id: TabId; label: string; en: string }> = [
  { id: "source", label: t("來源與分析"), en: "Analyze" },
  { id: "scene", label: t("場景與候選"), en: "Scene" },
  { id: "render", label: t("生成比對"), en: "Render" },
  { id: "search", label: t("有界搜尋"), en: "Search" },
];

export function tabOf(value: string | null): TabId | null {
  return TABS.some((tab) => tab.id === value) ? (value as TabId) : null;
}

export interface Workspace {
  study: PromptStudy;
  doc: StudyDocument;
  runner: TaskRunner;
  catalog: Catalog | undefined;
  routes: readonly ImageRoute[];
  /** 元件組合或元件目錄還在讀取。 */
  routesLoading: boolean;
  /** 元件目錄還在讀取。 */
  catalogLoading: boolean;
  choices: Record<ComponentRole, ComponentChoice[]>;
  chosen: Record<ComponentRole, ComponentChoice | null>;
  setComponent: (role: ComponentRole, key: string) => void;
  /** 目前選擇的元件（建立任務時凍結）。 */
  components: TaskComponents;
  sourceSize: { width: number; height: number } | null;
  setSourceSize: (size: { width: number; height: number }) => void;
  /** 目前的生成設定（元件組合已補上預設）。 */
  settings: GenerationSettings;
  setSettings: (settings: GenerationSettings) => void;
  /** 建立任務時一起存進研究 settings 的內容（目前的生成設定與元件選擇；下次開啟沿用）。 */
  persistSettings: () => Record<string, unknown>;
  /** 封存的研究只能閱讀。 */
  readOnly: boolean;
  /** 尚未結束的任務。 */
  open: PromptStudyTask | null;
  goTab: (tab: TabId) => void;
  /** 到「場景與候選」看某個版本與候選。 */
  showCandidate: (ref: CandidateRef) => void;
  /** 開啟接受／套用的確認框。 */
  requestAccept: (ref: CandidateRef, taskId: string | null) => void;
  requestApply: (ref: CandidateRef, settings: GenerationSettings) => void;
}
