// Words for the steps of a prompt-study task, built when they are shown so they follow the reader's language: what a
// step does (StepData: its kind and parameters, without the prompt, runs or errors) and why a task finished
// (FinishNote). The planner describes its next step with these; taskNote.ts reads the notes stored in task.message.
// Pure.
import type { CandidateRef, EvaluationSplit, PromptStudy, PromptVariant } from "../types";
import type { RunStep, StepAction } from "./planner";
import { versionLabel } from "./study";
import { t } from "@/i18n";

/** Which image a render or compare step is about. */
export interface StepSpec {
  split: EvaluationSplit;
  round: number;
  versionId: string;
  variant: PromptVariant;
  seed: number;
}

export type StepData =
  | { kind: "analyze"; action: StepAction }
  | { kind: "revise"; action: StepAction; round: number | null; fromVersionId: string; comparison: boolean }
  | { kind: "render"; action: StepAction; spec: StepSpec }
  | { kind: "compare"; action: StepAction; spec: StepSpec }
  | { kind: "pairwise"; action: StepAction; round: number; seed: number; incumbent: CandidateRef; challenger: CandidateRef };

export const STEP_ACTIONS: readonly StepAction[] = ["start", "attach", "retry"];

/** Why a task finished, with the numbers the sentence needs. */
export type FinishNote =
  | { reason: "image_budget"; used: number; max: number }
  | { reason: "vision_budget"; used: number; max: number }
  | {
      reason:
        | "analysis_done"
        | "revision_done"
        | "renders_compared"
        | "no_revision_base"
        | "no_initial_candidate"
        | "no_current_best"
        | "no_candidate"
        | "stopped_early"
        | "search_done"
        | "user_ended";
    };

export const FINISH_REASONS: readonly FinishNote["reason"][] = [
  "image_budget",
  "vision_budget",
  "analysis_done",
  "revision_done",
  "renders_compared",
  "no_revision_base",
  "no_initial_candidate",
  "no_current_best",
  "no_candidate",
  "stopped_early",
  "search_done",
  "user_ended",
];

function specOf(spec: StepSpec): StepSpec {
  return { split: spec.split, round: spec.round, versionId: spec.versionId, variant: spec.variant, seed: spec.seed };
}

function candidate(ref: CandidateRef): CandidateRef {
  return { version_id: ref.version_id, variant: ref.variant };
}

/** What `step` is, kept small enough to store (task.message holds at most 2000 characters). */
export function stepData(step: RunStep): StepData {
  switch (step.kind) {
    case "analyze":
      return { kind: "analyze", action: step.action };
    case "revise":
      return { kind: "revise", action: step.action, round: step.round, fromVersionId: step.fromVersionId, comparison: step.comparison !== null };
    case "render":
      return { kind: "render", action: step.action, spec: specOf(step.spec) };
    case "compare":
      return { kind: "compare", action: step.action, spec: specOf(step.spec) };
    case "pairwise":
      return { kind: "pairwise", action: step.action, round: step.round, seed: step.seed, incumbent: candidate(step.incumbent), challenger: candidate(step.challenger) };
  }
}

function splitText(split: EvaluationSplit): string {
  switch (split) {
    case "search":
      return t("搜尋");
    case "holdout":
      return t("保留驗證");
    case "manual":
      return t("手動");
  }
}

function actionPrefix(action: StepAction, include: boolean): string {
  if (!include || action === "start") return "";
  return action === "attach" ? t("讀回結果：") : t("重試：");
}

function imageText(study: PromptStudy, spec: StepSpec): string {
  const where = spec.split === "search" ? t("（搜尋，第 {round} 輪）", { round: spec.round + 1 }) : t("（{split}）", { split: splitText(spec.split) });
  return `${versionLabel(study, spec.versionId)} ${spec.variant} · seed ${spec.seed}${where}`;
}

export interface DescribeOptions {
  /** Start with the action (read back / retry); run labels pass false and name only the work. */
  action?: boolean;
}

/** One line about a step (next to the buttons, in the progress strip and the task log). */
export function describeStepData(study: PromptStudy, data: StepData, { action = true }: DescribeOptions = {}): string {
  const step = actionPrefix(data.action, action);
  switch (data.kind) {
    case "analyze":
      return t("{step}分析原圖（描述 → 8 區段場景 → 編譯候選）", { step });
    case "revise": {
      const prefix = data.round === null ? "" : t("第 {round} 輪：", { round: data.round + 1 });
      return t("{step}{prefix}依 {versionLabel} {value}修訂場景並編譯（鎖定區段逐字保留）", { step, prefix, versionLabel: versionLabel(study, data.fromVersionId), value: data.comparison ? t("的前三個差異") : t("與修訂指示") });
    }
    case "render":
      return t("{step}生成 {imageText}", { step, imageText: imageText(study, data.spec) });
    case "compare":
      return t("{step}與原圖比較並評分 {imageText}", { step, imageText: imageText(study, data.spec) });
    case "pairwise":
      return t("{step}第 {round} 輪 A/B＋B/A：目前最佳 {versionLabel} {variant} vs 挑戰者 {versionLabel2} {variant2} · seed {seed}", {
        step,
        round: data.round + 1,
        versionLabel: versionLabel(study, data.incumbent.version_id),
        variant: data.incumbent.variant,
        versionLabel2: versionLabel(study, data.challenger.version_id),
        variant2: data.challenger.variant,
        seed: data.seed,
      });
  }
}

/** Why the task finished, in the reader's language. */
export function finishText(note: FinishNote): string {
  switch (note.reason) {
    case "image_budget":
      return t("圖片預算用完（{task}/{maxImages}，失敗或取消的生成也計入）", { task: note.used, maxImages: note.max });
    case "vision_budget":
      return t("視覺操作次數用完（{task}/{maxVisionOps}）", { task: note.used, maxVisionOps: note.max });
    case "analysis_done":
      return t("已產生第一版場景與候選");
    case "revision_done":
      return t("已產生修訂版本");
    case "renders_compared":
      return t("指定的候選都已生成並比較");
    case "no_revision_base":
      return t("沒有可作為修訂基礎的完整候選");
    case "no_initial_candidate":
      return t("初始輪沒有完整且可判斷的候選");
    case "no_current_best":
      return t("沒有目前最佳候選");
    case "no_candidate":
      return t("沒有完整且可判斷的候選");
    case "stopped_early":
      return t("連續沒有改善，提前結束搜尋；保留驗證已完成");
    case "search_done":
      return t("全部輪次與保留驗證已完成");
    case "user_ended":
      return t("使用者結束任務");
  }
}
