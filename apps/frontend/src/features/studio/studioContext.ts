// Video Studio's workspace state (implemented by StudioProvider); panels read and write the project only through here.
// The shell state (save state, conflict actions, notices, engine sheet) lives in the studio-shell context, so saving or
// a notice does not re-render the workspaces; `notify` and `setEngineOpen` are repeated here as stable references.
import { createContext, use } from "react";
import type { Catalog, StudioProject, StudioShot, StudioTimeline, StudioTimelineCommand, TimelineSource } from "@/api/generated/contracts";
import type { PluginRegistry } from "@/features/plugins";
import type { NoticeInput } from "@/features/studio-shell";
import type { PlayheadStore } from "./hooks/playhead";
import type { ExportOptions } from "./model/pipelines";
import type { ProjectAction } from "./model/project";
import type { Engine } from "./model/routes";
import type { ShotVariant, ShotVariants } from "./model/variants";
import { t } from "@/i18n";

/**
 * 「鏡頭」工作區的監看器目前顯示什麼（不是使用者切換的模式，由最後操作的地方決定）：source＝選取鏡頭的 take（可 A/B）；
 * program＝節目（時間軸在播放頭的合成畫面，與「編輯」的節目監看器相同）。切回 source 會停止序列播放。
 */
export type MonitorMode = "source" | "program";

/** What the editor (mounted inside the provider) wants to hear about shots; null while no editor is mounted. */
export interface ShotListener {
  /** A shot was selected outside the timeline (shot list, links): select its clip. */
  selected: (shotId: string | null) => void;
  /** A shot was just added by the user: it joins the end of the film. */
  added: (shot: StudioShot) => void;
}

export interface StudioContextValue {
  project: StudioProject;
  createProxy: (timeline: StudioTimeline, source: TimelineSource) => Promise<void>;
  dispatch: (action: ProjectAction) => void;
  /**
   * Counts how often the project document was loaded from outside (a reload, a version saved elsewhere, a command
   * the Controller ran) instead of being continued from this page's own saves.
   */
  documentGeneration: number;
  /** Saves now and waits for it (before deleting runs or leaving the page); rejects on conflict or failure. */
  flush: () => Promise<void>;
  /**
   * Runs timeline commands on the Controller (all or none): the pending edits are saved first and the project
   * continues from the document the Controller answers. Rejects with the Controller's reason when a command is
   * refused; nothing is saved then.
   */
  adoptMedia: (shotId: string, runId: string, output: string, parent: string | null) => Promise<void>;
  attachRunTake: (shotId: string, runId: string, output: string) => Promise<void>;
  runTimelineCommands: (commands: StudioTimelineCommand[]) => Promise<void>;
  catalog: Catalog | undefined;
  /** 渲染引擎：Studio 路由（＝元件組合）與各步驟元件狀態、序列匯出元件。 */
  engine: Engine;
  /** 主控的插件登錄表（讀取中、讀不到或已讀到）；專案選用的插件貢獻由它定義。 */
  plugins: PluginRegistry;
  selectedShotId: string | null;
  /** Selects a shot (the URL's shot=); fromClip = the selection comes from a timeline clip, which is already selected. */
  selectShot: (shotId: string | null, options?: { fromClip?: boolean }) => void;
  /** The editor registers what it wants to hear about shots; returns the function that removes it. */
  listenShots: (listener: ShotListener) => () => void;
  playhead: PlayheadStore;
  monitorMode: MonitorMode;
  setMonitorMode: (mode: MonitorMode) => void;
  sourceTakeId: string | null;
  setSourceTakeId: (takeId: string | null) => void;
  compareTakeId: string | null;
  setCompareTakeId: (takeId: string | null) => void;
  busy: "render" | "export" | null;
  /** 主控上正在執行的 run（最新的在前；最多 max_active_runs 個，hooks/useRunSlots.ts）。 */
  activeRunIds: readonly string[];
  /** 主控的同時執行數已滿時，渲染／匯出按鈕不可用的原因（還能開始新的 run 時為 null）。 */
  runBlockedReason: string | null;
  setEngineOpen: (open: boolean) => void;
  /** 渲染一個或多個鏡頭（多個＝同一個 run 的批次）；seed -1 的鏡頭每次抽新的 seed（記在 take）。 */
  /** Several shots = one batch run; with lanes chosen for the project the shots are spread over them first (model/lanes.ts). */
  renderShots: (shotIds: string[]) => Promise<void>;
  /** 同一鏡頭用多個隨機 seed 渲染（2–8 個變體，同一個 run）。 */
  renderVariations: (shotId: string, count: number) => Promise<void>;
  /** 同一鏡頭的 2–8 個變體（各自的 seed、參考檔案與路線，model/variants.ts）在同一個 run 渲染，各成為一個 take；鏡頭本身的設定不變。 */
  renderVariants: (shotId: string, variants: readonly ShotVariant[]) => Promise<void>;
  /** 多個鏡頭的變體（每個鏡頭 2–8 個，model/variantBatch.ts）放進同一個批次 run，各成為自己鏡頭的 take；送出了回傳 true。 */
  renderVariantBatch: (groups: readonly ShotVariants[]) => Promise<boolean>;
  /** 匯出序列；options 未填用 media.concat 預設（crf 18、preset medium）；送出了回傳 true（沒送出時已用通知說明原因）。 */
  exportSequence: (options?: ExportOptions) => Promise<boolean>;
  addShot: (afterShotId?: string | null) => void;
  /** 已封存的 run（渲染佇列、Takes、素材預設隱藏；時間軸仍照常使用）。 */
  archivedRunIds: ReadonlySet<string>;
  /** 封存／取消封存一個 run（檔案與紀錄都保留）。 */
  setRunArchived: (runId: string, archived: boolean) => Promise<void>;
  /**
   * 開啟永久刪除確認：run 產生的檔案、效能紀錄與專案中的 take／匯出一起刪除。
   * removeShotId：全部刪除成功後再把這個鏡頭從專案移除（「刪除鏡頭與影片」），nextShotId 是之後要選取的鏡頭。
   */
  deleteRuns: (runIds: string[], options?: { removeShotId?: string; nextShotId?: string | null }) => void;
  notify: (notice: NoticeInput) => void;
}

export const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const value = use(StudioContext);
  if (!value) throw new Error(t("useStudio 必須在 StudioProvider 內使用"));
  return value;
}
