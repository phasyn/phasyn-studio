// 生成中 take 的階段列（純函式）：文字條件 → DiT → 解碼 → 合成…對應到共用 Stepper 的步驟狀態。只讀 run 的步驟狀態，
// 不推估。步驟狀態：done／active／pending／error，已停止的 cancelled／interrupted（不是錯誤），以及沒有執行的 skipped。
import type { TakeStage } from "./outcome";
import { t } from "@/i18n";

type FlowStepState = "done" | "active" | "pending" | "error" | "cancelled" | "interrupted" | "skipped";

export interface FlowStep {
  id: string;
  label: string;
  state: FlowStepState;
  detail?: string;
}

/**
 * 生成中 take 的階段（文字條件 → DiT → 解碼 → 合成…）對應到步驟列；失敗是錯誤，取消、中斷是已停止（不是錯誤），略過
 * （run 在它開始前就停止，沒有執行）不算完成，都附上原因。
 */
export function stageSteps(stages: readonly TakeStage[]): FlowStep[] {
  return stages.map((stage) => {
    if (stage.state === "succeeded") return { id: stage.stepId, label: stage.label, state: "done" };
    if (stage.state === "skipped") return { id: stage.stepId, label: stage.label, state: "skipped", detail: t("已略過") };
    if (stage.state === "running") return { id: stage.stepId, label: stage.label, state: "active" };
    if (stage.state === "failed") return { id: stage.stepId, label: stage.label, state: "error", detail: t("失敗") };
    if (stage.state === "cancelled") return { id: stage.stepId, label: stage.label, state: "cancelled", detail: t("已取消") };
    if (stage.state === "interrupted") return { id: stage.stepId, label: stage.label, state: "interrupted", detail: t("已中斷") };
    return { id: stage.stepId, label: stage.label, state: "pending", detail: stage.state === "waiting" ? t("等待資源") : undefined };
  });
}
