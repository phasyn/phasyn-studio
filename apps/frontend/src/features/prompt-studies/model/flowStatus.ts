// 圖片反推步驟列的狀態（純函式，畫面與測試共用）：來源與分析 → 場景與候選 → 生成比對 → 有界搜尋。
// 只讀研究文件（版本、任務的狀態與錯誤）、本頁的場景草稿與「正在執行什麼」，不推估進度：
//   running＝本頁正在執行這一步（送出 run、等待結果）；warning＝任務還沒結束但沒有在執行（要按「繼續」或上一步失敗）；
//   error＝最近一次任務失敗或中斷；done＝已有結果；todo＝還沒開始（或使用者結束了任務）。
import type { PromptStudy, PromptStudyTask } from "../types";
import { t } from "@/i18n";

export type StudyStepId = "source" | "scene" | "render" | "search";

export type StudyFlowStatus = "todo" | "running" | "done" | "warning" | "error";

export interface StudyFlowStep {
  status: StudyFlowStatus;
  /** 一行補充（tooltip 與報讀）；沒有時 null。 */
  detail: string | null;
}

export interface StudyFlowInput {
  study: Pick<PromptStudy, "versions" | "tasks" | "accepted_version_id">;
  /** 場景草稿有未儲存的修改。 */
  dirty: boolean;
  /** 場景草稿的資料問題數（只在 dirty 時計入）。 */
  sceneIssues: number;
  /** 本頁正在執行的工作：任務種類、儲存新版本時的編譯（compile）；沒有在執行時 null。 */
  busy: PromptStudyTask["kind"] | "compile" | null;
}

function latest(study: StudyFlowInput["study"], kind: PromptStudyTask["kind"]): PromptStudyTask | null {
  for (let index = study.tasks.length - 1; index >= 0; index -= 1) {
    const task = study.tasks[index];
    if (task?.kind === kind) return task;
  }
  return null;
}

/** 還沒結束的任務：上一步失敗時要明確重試，否則等使用者繼續。 */
function unfinished(task: PromptStudyTask): StudyFlowStep {
  return task.error ? { status: "warning", detail: t("已暫停（上一步失敗）") } : { status: "warning", detail: t("尚未完成：按「繼續執行」") };
}

function failed(task: PromptStudyTask | null): StudyFlowStep | null {
  if (task?.state === "failed") return { status: "error", detail: t("最近一次失敗") };
  if (task?.state === "interrupted") return { status: "error", detail: t("最近一次中斷") };
  return null;
}

/** 生成比對、有界搜尋：依最近一次任務。 */
function taskStep(task: PromptStudyTask | null, running: boolean, runningText: string): StudyFlowStep {
  if (running) return { status: "running", detail: runningText };
  if (!task) return { status: "todo", detail: null };
  if (task.state === "running") return unfinished(task);
  if (task.state === "succeeded") return { status: "done", detail: null };
  return failed(task) ?? { status: "todo", detail: t("上一個任務已結束") };
}

export function studyFlow(input: StudyFlowInput): Record<StudyStepId, StudyFlowStep> {
  const { study, busy } = input;
  const versions = study.versions.length;
  const analyze = latest(study, "analyze");
  const refine = latest(study, "refine");

  let source: StudyFlowStep;
  if (busy === "analyze") source = { status: "running", detail: t("分析執行中") };
  else if (analyze?.state === "running") source = unfinished(analyze);
  else if (versions > 0) source = { status: "done", detail: t("{versions} 個版本", { versions }) };
  else source = failed(analyze) ?? { status: "todo", detail: null };

  let scene: StudyFlowStep;
  if (versions === 0) scene = { status: "todo", detail: null };
  else if (input.dirty && input.sceneIssues > 0) scene = { status: "error", detail: t("{sceneIssues} 個資料問題", { sceneIssues: input.sceneIssues }) };
  else if (busy === "compile") scene = { status: "running", detail: t("編譯候選中") };
  else if (busy === "refine") scene = { status: "running", detail: t("修訂中") };
  else if (input.dirty) scene = { status: "warning", detail: t("場景未儲存") };
  else if (refine?.state === "running") scene = unfinished(refine);
  else scene = { status: "done", detail: study.accepted_version_id ? t("已接受候選") : null };

  return {
    source,
    scene,
    render: taskStep(latest(study, "render"), busy === "render", t("生成比對執行中")),
    search: taskStep(latest(study, "reconstruct"), busy === "reconstruct", t("搜尋執行中")),
  };
}
