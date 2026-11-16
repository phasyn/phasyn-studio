// Image Studio's workspace state (implemented by ImageStudioProvider); panels read and write the project only through
// here, never keeping their own copy. The shell state (save state, conflict actions, notices, engine sheet) lives in the
// studio-shell context, so saving or a notice does not re-render the panels; `notify`, `flush` and `setEngineOpen` are
// repeated here as stable references.
import { createContext, useContext } from "react";
import type { Catalog } from "@/api/generated/contracts";
import type { WireRun } from "@/api/types";
import type { NoticeInput } from "@/features/studio-shell";
import type { StudioRoute } from "@/features/studio";
import type { EngineStatus } from "./model/engine";
import type { ImageProjectAction } from "./model/project";
import type { ImageRoute } from "./model/routes";
import type { ImageStudioProject } from "./types";
import { t } from "@/i18n";

export interface ImageEngine {
  /** 元件組合與元件目錄都讀到才是 ready；之前的就緒判斷不可信。 */
  status: EngineStatus;
  error: string | null;
  /** 圖片路由（含 qimg.dit 的元件組合）。 */
  routes: ImageRoute[];
  /** Video Studio 的路由（「用在影片鏡頭」判斷 ref2va／fl2va 用）。 */
  videoRoutes: StudioRoute[];
}

/** 「用在影片鏡頭」對話框的對象。 */
export interface SendTarget {
  shotId: string;
  takeId: string;
}

export interface ImageStudioContextValue {
  project: ImageStudioProject;
  /** 最新的草稿（非同步流程完成時用，例如上傳結束時判斷參考圖上限）。 */
  getProject: () => ImageStudioProject;
  dispatch: (action: ImageProjectAction) => void;
  /** 等目前草稿保存完成（切到 Video Studio、刪除前）；衝突或失敗時 reject。 */
  flush: () => Promise<void>;
  catalog: Catalog | undefined;
  engine: ImageEngine;
  /** 步驟元件 → provider（由目錄查；查不到 null）。 */
  lookup: (nodeId: string, componentId: string) => string | null;
  selectedShotId: string | null;
  /** 選取圖片（takeId：同時指定監看的 take；省略時看使用中的 take）。 */
  selectShot: (shotId: string | null, takeId?: string | null) => void;
  /** 監看中的 take（URL 的 take；沒有時用使用中的 take）。 */
  selectedTakeId: string | null;
  selectTake: (takeId: string | null) => void;
  /** 比較的 B（null＝不比較）。 */
  compareTakeId: string | null;
  setCompareTakeId: (takeId: string | null) => void;
  /** 正在送出生成請求（圖生圖含先上傳未保存的遮罩）。 */
  busy: boolean;
  /** 主控的同時執行數已滿時，生成按鈕不可用的原因（hooks/useRunSlots.ts）；還能開始新的 run 時為 null。 */
  runBlockedReason: string | null;
  /** Images whose last "Generate" sent nothing (run limit or a refused request) → the reason; cleared when one starts. */
  notSent: ReadonlyMap<string, string>;
  /** 還在生成的 run（render tracker 輪詢中的最新狀態）。 */
  runs: ReadonlyMap<string, WireRun>;
  setEngineOpen: (open: boolean) => void;
  /**
   * 生成一張圖片（批次 N 張＝同一個 run）：工具列的「生成圖片」與屬性面板的 Ctrl+Enter 共用。圖生圖有未保存的遮罩時先上傳；
   * 送出中再按不做事，不能生成時以通知說明原因。每個 run 只送一次。
   */
  generate: (shotId: string) => Promise<void>;
  /** 新增一張圖片並選取它；回傳它的 id。 */
  addShot: () => string;
  /** 完成後自動把白底版加入素材庫（這台瀏覽器的偏好；送出時記在 take）。 */
  autoLibrary: boolean;
  setAutoLibrary: (value: boolean) => void;
  archivedRunIds: ReadonlySet<string>;
  setRunArchived: (runId: string, archived: boolean) => Promise<void>;
  /** 開啟永久刪除確認（同一個批次的 take 共用一個 run，一起刪除）。 */
  deleteRuns: (runIds: string[]) => void;
  sendTarget: SendTarget | null;
  setSendTarget: (target: SendTarget | null) => void;
  /** 先保存再切到 Video Studio（同一個專案；shotId 指定鏡頭）。 */
  openVideoStudio: (shotId?: string | null) => Promise<void>;
  notify: (notice: NoticeInput) => void;
}

export const ImageStudioContext = createContext<ImageStudioContextValue | null>(null);

export function useImageStudio(): ImageStudioContextValue {
  const value = useContext(ImageStudioContext);
  if (!value) throw new Error(t("useImageStudio 必須在 ImageStudioProvider 內使用"));
  return value;
}
