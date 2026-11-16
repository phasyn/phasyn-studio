// 把一步的進展寫回研究文件（純函式；結果參照的形狀照契約 PromptTaskResult）：
//   建立 run → run_id 加進任務（生成另外寫一個 state=unknown 的 render 參照，代表已送出、結果未知）；
//   失敗 → task.error（details.run_id 指著那個 run；生成的參照改成 failed／cancelled／interrupted）；
//   成功 → 寫入 caption／version（同時新增不可變的版本）／render／evaluation／pairwise 參照，清掉 task.error。
// 每個函式回傳新的文件，由呼叫端保存（revision 樂觀並行；主控另外檢查 append-only 與預算）。
// task.message holds a structured note (taskNote.ts), never finished text, so the study reads in its viewer's language.
import type { ApiErrorBody, FileRef } from "@/api/generated/contracts";
import type {
  CandidateRef,
  PromptCandidates,
  PromptComparison,
  PromptConfirmation,
  PromptPairwise,
  PromptScene,
  PromptScore,
  PromptStudy,
  PromptStudyTask,
  PromptStudyVersion,
  PromptTaskResult,
  RenderRef,
  StopReason,
  TaskPhase,
  Verification,
} from "../types";
import type { RunStep } from "./planner";
import { stepData, type FinishNote } from "./stepText";
import { addVersion, findTask, findVersion, localId, updateTask } from "./study";
import { encodeTaskNote } from "./taskNote";

export function phaseOf(step: RunStep): TaskPhase {
  switch (step.kind) {
    case "analyze":
      return "analyze";
    case "revise":
      return "revise";
    case "render":
      return step.spec.split === "holdout" ? "holdout" : "render";
    case "compare":
      return step.spec.split === "holdout" ? "holdout" : "compare";
    case "pairwise":
      return "pairwise";
  }
}

function withRef(task: PromptStudyTask, ref: PromptTaskResult): PromptStudyTask {
  return { ...task, result_refs: [...task.result_refs, ref] };
}

function mapRender(task: PromptStudyTask, runId: string, change: (ref: RenderRef) => RenderRef): PromptStudyTask {
  return { ...task, result_refs: task.result_refs.map((ref) => (ref.kind === "render" && ref.run_id === runId ? change(ref) : ref)) };
}

/** run 已建立：run_id 加進任務；生成另外寫一個 state=unknown 的 render 參照（已送出、結果未知，計入預算）。 */
export function recordRunCreated(study: PromptStudy, taskId: string, step: RunStep, runId: string, now: string): PromptStudy {
  const message = encodeTaskNote({ kind: "step", step: stepData(step) });
  return updateTask(
    study,
    taskId,
    (task) => {
      const base: PromptStudyTask = { ...task, run_ids: task.run_ids.includes(runId) ? task.run_ids : [...task.run_ids, runId], phase: phaseOf(step), error: null, message };
      if (step.kind !== "render") return base;
      return withRef(base, {
        kind: "render",
        version_id: step.spec.versionId,
        variant: step.spec.variant,
        seed: step.spec.seed,
        split: step.spec.split,
        round: step.spec.round,
        run_id: runId,
        state: "unknown",
        image: null,
        image_asset: null,
        error: null,
      });
    },
    now,
  );
}

export type FailedRunState = "failed" | "cancelled" | "interrupted" | "unknown";

/** 這一步失敗（沒有 run 時 runId 為 null）：task.error 記錯誤與 run；生成的參照改成對應狀態。 */
export function recordRunFailed(study: PromptStudy, taskId: string, step: RunStep, runId: string | null, error: ApiErrorBody, runState: FailedRunState, now: string): PromptStudy {
  return updateTask(
    study,
    taskId,
    (task) => {
      const recorded: ApiErrorBody = { ...error, details: { ...(error.details ?? {}), run_id: runId, step: step.kind } };
      const next: PromptStudyTask = { ...task, error: recorded, message: encodeTaskNote({ kind: "failed", code: error.code }) };
      return step.kind === "render" && runId ? mapRender(next, runId, (ref) => ({ ...ref, state: runState, error })) : next;
    },
    now,
  );
}

export type StepResult =
  | { kind: "analysis"; caption: string; scene: PromptScene; candidates: PromptCandidates; vision: Record<string, unknown> | null; versionId: string }
  | { kind: "revision"; scene: PromptScene; candidates: PromptCandidates; vision: Record<string, unknown> | null; versionId: string; note: string }
  | { kind: "image"; image: FileRef; asset: Record<string, unknown> | null }
  | { kind: "evaluation"; comparison: PromptComparison; score: PromptScore }
  | { kind: "pairwise"; ab: PromptPairwise; ba: PromptPairwise; confirmation: PromptConfirmation };

function compileProvenance(candidates: PromptCandidates): Record<string, unknown> {
  return { compiler_version: candidates.compiler_version, compiler_sha256: candidates.compiler_sha256, scene_sha256: candidates.scene_sha256 };
}

/** 這一步成功：寫入結果參照（分析與修訂另外新增不可變的版本）。前提資料不見時原樣回傳（不猜）。 */
export function recordStepResult(study: PromptStudy, taskId: string, step: RunStep, runId: string, result: StepResult, now: string): PromptStudy {
  const task = findTask(study, taskId);
  if (!task) return study;
  let next = study;
  let change: (task: PromptStudyTask) => PromptStudyTask;
  if (result.kind === "analysis") {
    const version: Omit<PromptStudyVersion, "number"> = {
      version_id: result.versionId,
      parent_version_id: null,
      origin: "analysis",
      scene: result.scene,
      intentional_changes: [],
      candidates: result.candidates,
      provenance: { kind: "vision", task_id: taskId, run_ids: [runId], vision: result.vision, compile: compileProvenance(result.candidates) },
      note: "",
      created_at: now,
    };
    next = addVersion(study, version);
    change = (current) => withRef(withRef(current, { kind: "caption", run_id: runId, caption: result.caption }), { kind: "version", version_id: result.versionId, run_id: runId });
  } else if (result.kind === "revision") {
    if (step.kind !== "revise") return study;
    const parent = findVersion(study, step.fromVersionId);
    if (!parent) return study;
    const version: Omit<PromptStudyVersion, "number"> = {
      version_id: result.versionId,
      parent_version_id: parent.version_id,
      origin: "refinement",
      scene: result.scene,
      intentional_changes: parent.intentional_changes,
      candidates: result.candidates,
      provenance: { kind: "vision", task_id: taskId, run_ids: [runId], vision: result.vision, compile: compileProvenance(result.candidates) },
      note: result.note,
      created_at: now,
    };
    next = addVersion(study, version);
    change = (current) => withRef(current, { kind: "version", version_id: result.versionId, run_id: runId });
  } else if (result.kind === "image") {
    change = (current) => {
      const updated = mapRender(current, runId, (ref) => ({ ...ref, state: "succeeded", image: result.image, image_asset: result.asset, error: null }));
      return updated.verification === "analysis_only" ? { ...updated, verification: "rendered" } : updated;
    };
  } else if (result.kind === "evaluation") {
    if (step.kind !== "compare") return study;
    change = (current) => ({
      ...withRef(current, {
        kind: "evaluation",
        version_id: step.spec.versionId,
        variant: step.spec.variant,
        seed: step.spec.seed,
        split: step.spec.split,
        round: step.spec.round,
        render_run_id: step.renderRunId,
        run_id: runId,
        comparison: result.comparison,
        score: result.score,
      }),
      // 任務的凍結 rubric：第一次評分時由 prompt.scene_score 算出，之後每次比較都帶 rubric_sha256 核對
      rubric: current.rubric ?? result.score.rubric,
    });
  } else {
    if (step.kind !== "pairwise") return study;
    change = (current) =>
      withRef(current, {
        kind: "pairwise",
        round: step.round,
        run_id: runId,
        seed: step.seed,
        incumbent: step.incumbent,
        challenger: step.challenger,
        ab: result.ab,
        ba: result.ba,
        confirmed: result.confirmation.confirmed,
      });
  }
  return updateTask(next, taskId, (current) => ({ ...change(current), error: null, message: "" }), now);
}

/** 純計算的進度（目前最佳、驗證程度）。 */
export function recordProgress(study: PromptStudy, taskId: string, best: CandidateRef | null, verification: Verification, now: string): PromptStudy {
  return updateTask(study, taskId, (task) => ({ ...task, best, verification }), now);
}

/** 結束任務（之後不可再改）：狀態、停止原因、最佳候選、驗證程度、結束時間。 */
export function recordFinish(
  study: PromptStudy,
  taskId: string,
  input: { state: "succeeded" | "failed" | "cancelled" | "interrupted"; stopReason: StopReason; best?: CandidateRef | null; verification?: Verification; note: FinishNote },
  now: string,
): PromptStudy {
  return updateTask(
    study,
    taskId,
    (task) =>
      task.state !== "running"
        ? task
        : {
            ...task,
            state: input.state,
            stop_reason: input.stopReason,
            best: input.best === undefined ? task.best : input.best,
            verification: input.verification ?? task.verification,
            phase: "done",
            message: encodeTaskNote({ kind: "finish", finish: input.note }),
            finished_at: now,
          },
    now,
  );
}

export function newVersionId(): string {
  return localId("v");
}
