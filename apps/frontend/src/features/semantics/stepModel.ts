// 語意頁的步驟（反推 → 編修 Scene → caption → 資料集）與每一步「為什麼還不能按」的原因：
// 純函式，畫面與單元測試共用。文字照原本各區塊的說法，順序就是檢查的優先序。
import type { FileRef } from "@/api/generated/contracts";
import type { WireTypedValue } from "@/api/types";
import { t } from "@/i18n";

export type StepId = "describe" | "scene" | "caption" | "dataset";

export interface StepSpec {
  id: StepId;
  /** 分頁標籤（短）。 */
  label: string;
  /** 下一步（最後一步為 null）。 */
  next: StepId | null;
}

/** 分頁標籤不含編號（步驟列在圓點裡顯示編號，報讀時也會念「步驟 n」）。 */
export const STEPS: readonly StepSpec[] = [
  { id: "describe", label: t("反推"), next: "scene" },
  { id: "scene", label: t("編修 Scene"), next: "caption" },
  { id: "caption", label: "Caption", next: "dataset" },
  { id: "dataset", label: t("資料集"), next: null },
];

export function stepSpec(id: StepId): StepSpec {
  return STEPS.find((step) => step.id === id) ?? { id, label: id, next: null };
}

/**
 * 進入頁面時的步驟：停在網址中最後一個有 run 的步驟。
 * 從 run 明細「在語意頁查看與編輯」（只帶 describe_run）進來會直接到 Scene。
 */
export function initialStep(params: { describeRun: string | null; captionRun: string | null; exportRun: string | null }): StepId {
  if (params.exportRun) return "dataset";
  if (params.captionRun) return "caption";
  if (params.describeRun) return "scene";
  return "describe";
}

export function describeBlockReason(input: { source: WireTypedValue | null; hasDescriptor: boolean; issueCount: number }): string | null {
  if (!input.source) return t("請先上傳或選擇來源影片");
  if (!("file" in input.source)) return t("來源影片必須是檔案");
  if (!input.hasDescriptor) return t("目錄中沒有 video.describe 元件");
  if (input.issueCount > 0) return t("參數有 {issueCount} 個問題", { issueCount: input.issueCount });
  return null;
}

export function sceneSaveBlock(input: { hasDraft: boolean; issueCount: number; changed: boolean; savedCurrent: boolean }): string | null {
  if (!input.hasDraft) return t("沒有 Scene");
  if (input.issueCount > 0) return t("Scene 有 {issueCount} 個資料錯誤", { issueCount: input.issueCount });
  if (!input.changed) return t("沒有修改");
  if (input.savedCurrent) return t("目前內容已另存");
  return null;
}

/**
 * caption 的輸入 Scene：已另存且之後沒再改 → 用另存的新檔；沒有修改 → 用原 Scene；
 * 改了但還沒另存 → 擋下（不偷偷上傳未保存的草稿）。
 */
export function captionSceneInput(input: {
  sceneValue: WireTypedValue | null;
  hasOriginal: boolean;
  changed: boolean;
  saved: FileRef | null;
}): { scene: WireTypedValue | null; block: string | null } {
  if (!input.sceneValue || !input.hasOriginal) return { scene: null, block: t("先完成反推並載入 Scene") };
  if (input.saved) return { scene: { type_id: "video.scene.v1", file: input.saved }, block: null };
  if (!input.changed) return { scene: input.sceneValue, block: null };
  return { scene: null, block: t("Scene 有未另存的修改：請先「另存新 Scene」（原 Scene 保留不變）") };
}

export function captionBlockReason(input: {
  sceneBlock: string | null;
  hasScene: boolean;
  hasDescriptor: boolean;
  hasScenePort: boolean;
  issueCount: number;
}): string | null {
  if (input.sceneBlock) return input.sceneBlock;
  if (!input.hasScene) return t("沒有 Scene");
  if (!input.hasDescriptor) return t("目錄中沒有 caption.compile 元件");
  if (!input.hasScenePort) return t("此元件沒有 video.scene.v1 輸入");
  if (input.issueCount > 0) return t("參數有 {issueCount} 個問題", { issueCount: input.issueCount });
  return null;
}

export function datasetBlockReason(input: { rowCount: number; emptyCaptions: number; hasDescriptor: boolean; hasPort: boolean; issueCount: number }): string | null {
  if (input.rowCount === 0) return t("先加入至少一列");
  if (!input.hasDescriptor) return t("目錄中沒有 dataset.export 元件");
  if (!input.hasPort) return t("此元件沒有輸入埠");
  if (input.emptyCaptions > 0) return t("{emptyCaptions} 列 caption 為空（資料錯誤）", { emptyCaptions: input.emptyCaptions });
  if (input.issueCount > 0) return t("參數有 {issueCount} 個問題", { issueCount: input.issueCount });
  return null;
}

// ── 步驟列的狀態（純函式）：每一步完成、進行中、需要注意或錯誤，與一行補充；只讀 run 狀態與畫面上的草稿，不推估。

export type StepFlowStatus = "todo" | "running" | "done" | "warning" | "error";

export interface StepFlow {
  status: StepFlowStatus;
  detail: string | null;
}

const FAILED_TEXT: Record<string, string> = { failed: t("失敗"), interrupted: t("已中斷"), cancelled: t("已取消") };

/** run 的最終失敗狀態（失敗、中斷、取消）→ 錯誤；其他回傳 null。 */
function failure(state: string | null, what: string): StepFlow | null {
  const text = state ? FAILED_TEXT[state] : undefined;
  return text ? { status: "error", detail: `${what}${text}` } : null;
}

export function semanticsFlow(input: {
  /** 各步驟 run 的狀態（沒有 run 或還沒讀到時 null）。 */
  describeRun: string | null;
  captionRun: string | null;
  exportRun: string | null;
  hasScene: boolean;
  sceneIssues: number;
  /** Scene 有修改但還沒另存。 */
  sceneUnsaved: boolean;
  /** caption 可以用的 Scene 已就緒（原 Scene 或另存的新檔）。 */
  sceneReady: boolean;
  hasPair: boolean;
  rows: number;
}): Record<StepId, StepFlow> {
  const describe: StepFlow =
    input.describeRun === "running"
      ? { status: "running", detail: t("反推執行中") }
      : input.hasScene
        ? { status: "done", detail: t("已產生 Scene") }
        : (failure(input.describeRun, t("反推")) ?? (input.describeRun === "succeeded" ? { status: "warning", detail: t("沒有 Scene 輸出") } : { status: "todo", detail: null }));
  const scene: StepFlow = !input.hasScene
    ? { status: "todo", detail: null }
    : input.sceneIssues > 0
      ? { status: "error", detail: t("{sceneIssues} 個資料錯誤", { sceneIssues: input.sceneIssues }) }
      : input.sceneUnsaved
        ? { status: "warning", detail: t("有修改尚未另存") }
        : input.sceneReady
          ? { status: "done", detail: null }
          : { status: "todo", detail: null };
  const caption: StepFlow =
    input.captionRun === "running"
      ? { status: "running", detail: t("caption 產生中") }
      : input.hasPair
        ? { status: "done", detail: t("已產生 caption") }
        : (failure(input.captionRun, "caption ") ?? (input.captionRun === "succeeded" ? { status: "warning", detail: t("沒有 caption 輸出") } : { status: "todo", detail: null }));
  const dataset: StepFlow =
    input.exportRun === "running"
      ? { status: "running", detail: t("匯出中") }
      : input.exportRun === "succeeded"
        ? { status: "done", detail: t("已匯出") }
        : (failure(input.exportRun, t("匯出")) ?? { status: "todo", detail: input.rows > 0 ? t("{rows} 列尚未匯出", { rows: input.rows }) : null });
  return { describe, scene, caption, dataset };
}
