// 圖片列（顯示用的純函式）：一個 render 參照＋它的評估＋「比較」這一步的狀態。
// 比較的狀態只由研究文件推得：有評估＝完成；規劃器的下一步正是比較這張圖時，attach＝執行中、retry＝失敗、start＝等待；
// 任務已結束還沒有比較＝沒有比較（不會再做）。
import type { ApiErrorBody } from "@/api/generated/contracts";
import type { EvaluationRef, PromptStudy, PromptStudyTask, RenderRef } from "../types";
import { planTask } from "./planner";
import { evaluationsOf, rendersOf } from "./study";

export type CompareStatus = "done" | "running" | "failed" | "queued" | "skipped" | "none";

export interface ImageRow {
  /** 生成 run 的 id（列的 key）。 */
  id: string;
  render: RenderRef;
  evaluation: EvaluationRef | null;
  compare: CompareStatus;
  /** 比較的 run（完成、執行中或失敗的那個）；還沒有時為 null。 */
  compareRunId: string | null;
  compareError: ApiErrorBody | null;
  /** 同一張圖（相同候選、seed、分組與輪次）之後又重新生成過：這是較早沒有成功（失敗、取消或中斷）的嘗試。 */
  retried: boolean;
}

function sameImage(a: RenderRef, b: RenderRef): boolean {
  return a.version_id === b.version_id && a.variant === b.variant && a.seed === b.seed && a.split === b.split && a.round === b.round;
}

export function imageRows(study: PromptStudy, task: PromptStudyTask): ImageRow[] {
  const evaluations = evaluationsOf(task);
  const next = task.state === "running" ? planTask(study, task) : null;
  const renders = rendersOf(task);
  return renders.map((render, index) => {
    const evaluation = evaluations.find((item) => item.render_run_id === render.run_id) ?? null;
    let compare: CompareStatus = "none";
    let compareRunId: string | null = evaluation?.run_id ?? null;
    let compareError: ApiErrorBody | null = null;
    if (evaluation) {
      compare = "done";
    } else if (render.state === "succeeded") {
      if (next?.kind === "compare" && next.renderRunId === render.run_id) {
        compare = next.action === "attach" ? "running" : next.action === "retry" ? "failed" : "queued";
        compareRunId = next.runId;
        compareError = next.action === "retry" ? next.error : null;
      } else {
        compare = task.state === "running" ? "queued" : "skipped";
      }
    }
    const retried = render.state !== "succeeded" && render.state !== "unknown" && renders.slice(index + 1).some((other) => sameImage(other, render));
    return { id: render.run_id, render, evaluation, compare, compareRunId, compareError, retried };
  });
}
