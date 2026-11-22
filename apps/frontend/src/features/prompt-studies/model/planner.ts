// 任務的下一步（純函式）：只由研究文件裡已記錄的結果參照推導（重新整理頁面後算出來的也一樣），沒有隱藏狀態。
// 每一步只對應一個 run（分析、修訂、生成、比較、雙順序比較各一個 run），或一個純計算（更新目前最佳、結束任務）。
//   attach＝run 已建立但結果還沒寫回：先讀回，絕不重送；retry＝上一次失敗：使用者明確按「重試這一步」才建立新的 run；
//   需要新 run 的步驟先檢查預算（圖片、視覺操作，與主控相同的算法），用完就結束任務（失敗、取消的生成也計入）。
// 有界搜尋的每輪決定不另存：依各輪的評估（只看該輪以前的）與雙順序比較結果重播，所以重播結果與當時的決定相同。
import type { ApiErrorBody, FileRef } from "@/api/generated/contracts";
import type {
  CandidateRef,
  EvaluationRef,
  EvaluationSplit,
  PromptComparison,
  PromptStudy,
  PromptStudyTask,
  PromptStudyVersion,
  PromptVariant,
  RenderRef,
  StopReason,
  Verification,
} from "../types";
import { candidateOf, uniqueCandidates } from "./compile";
import { REVISION_INSTRUCTION } from "./scene";
import { seedOccurrences } from "./seeds";
import { describeStepData, finishText, stepData, type DescribeOptions, type FinishNote } from "./stepText";
import { evaluationLoss, improvementEligible, rankCandidates, representativePair, selectInitial, worstEvaluation, type RankedCandidate } from "./search";
import {
  captionOf,
  evaluationsOf,
  findVersion,
  imagesUsed,
  pairwiseOf,
  pendingRun,
  rendersOf,
  sameCandidate,
  versionIndex,
  versionLabel,
  versionRefsOf,
  visionOpsUsed,
} from "./study";
import { t } from "@/i18n";

export type StepAction = "start" | "attach" | "retry";

export interface StageStep {
  action: StepAction;
  /** attach：要讀回的 run；retry：上一次失敗的 run（可能為 null）。 */
  runId: string | null;
  error: ApiErrorBody | null;
}

export interface ImageSpec {
  split: EvaluationSplit;
  round: number;
  versionId: string;
  variant: PromptVariant;
  prompt: string;
  seed: number;
}

export type RunStep =
  | ({ kind: "analyze" } & StageStep)
  | ({ kind: "revise"; round: number | null; fromVersionId: string; instruction: string; comparison: PromptComparison | null } & StageStep)
  | ({ kind: "render"; spec: ImageSpec } & StageStep)
  | ({ kind: "compare"; spec: ImageSpec; renderRunId: string; image: FileRef } & StageStep)
  | ({ kind: "pairwise"; round: number; seed: number; incumbent: CandidateRef; challenger: CandidateRef; incumbentImage: FileRef; challengerImage: FileRef } & StageStep);

export type PlannedStep =
  | RunStep
  | { kind: "progress"; best: CandidateRef | null; verification: Verification }
  | { kind: "finish"; state: "succeeded" | "failed"; stopReason: StopReason; best: CandidateRef | null; verification: Verification; note: FinishNote }
  | { kind: "blocked"; reason: string }
  | { kind: "done" };

export function isRunStep(step: PlannedStep): step is RunStep {
  return step.kind === "analyze" || step.kind === "revise" || step.kind === "render" || step.kind === "compare" || step.kind === "pairwise";
}

/** 這一步會建立新的 run（start／retry）；attach 只讀回。 */
export function createsRun(step: PlannedStep): boolean {
  return isRunStep(step) && step.action !== "attach";
}

/** 這一步是不是視覺模型操作（計入上限）。 */
export function usesVision(step: PlannedStep): boolean {
  return step.kind === "analyze" || step.kind === "revise" || step.kind === "compare" || step.kind === "pairwise";
}

/** 這一步預期的 run 元件組合 id（讀回時核對，避免把無關的 run 當成結果）。 */
export function expectedPipeline(step: RunStep): string | null {
  switch (step.kind) {
    case "analyze":
      return "prompt-study-analyze";
    case "revise":
      return "prompt-study-revise";
    case "compare":
      return "prompt-study-compare";
    case "pairwise":
      return "prompt-study-pairwise";
    case "render":
      return null;
  }
}

const START: StageStep = { action: "start", runId: null, error: null };

/**
 * 還沒有 run 的步驟：上一次在送出前就失敗（例如元件不在、RUN_ACTIVE、連線中斷）時 task.error 仍在
 * （任何一步成功都會清掉）——下一步就是這一步，要使用者明確重試。
 */
function fresh(task: PromptStudyTask): StageStep {
  return task.error ? { action: "retry", runId: null, error: task.error } : START;
}

/** 分析、修訂、比較、雙順序的狀態：最後一個沒有結果參照的 run＝讀回或（已知失敗時）重試。 */
function pendingAction(task: PromptStudyTask): StageStep {
  const pending = pendingRun(task);
  if (!pending) return fresh(task);
  return pending.failed ? { action: "retry", runId: pending.runId, error: task.error } : { action: "attach", runId: pending.runId, error: null };
}

interface Budget {
  maxImages: number;
  maxVisionOps: number | null;
  best: CandidateRef | null;
  failWhenEmpty: boolean;
}

function finish(state: "succeeded" | "failed", stopReason: StopReason, best: CandidateRef | null, verification: Verification, note: FinishNote): PlannedStep {
  return { kind: "finish", state, stopReason, best, verification, note };
}

/** 新 run 前的預算檢查：用完就結束任務（有最佳候選時算成功；手動生成一律失敗）。 */
function withinBudget(task: PromptStudyTask, step: RunStep, budget: Budget): PlannedStep {
  if (step.action === "attach") return step;
  const state = budget.best && !budget.failWhenEmpty ? "succeeded" : "failed";
  if (step.kind === "render" && imagesUsed(task) >= budget.maxImages) {
    return finish(state, "budget", budget.best, task.verification, { reason: "image_budget", used: imagesUsed(task), max: budget.maxImages });
  }
  if (usesVision(step) && budget.maxVisionOps !== null) {
    const cost = step.kind === "pairwise" ? 2 : 1;
    if (visionOpsUsed(task) + cost > budget.maxVisionOps) return finish(state, "budget", budget.best, task.verification, { reason: "vision_budget", used: visionOpsUsed(task), max: budget.maxVisionOps });
  }
  return step;
}

function sameImage(render: RenderRef, spec: ImageSpec): boolean {
  return render.split === spec.split && render.round === spec.round && render.version_id === spec.versionId && render.variant === spec.variant && render.seed === spec.seed;
}

/**
 * 一張圖（spec）的下一步：還沒有成功的生成 → 生成（讀回進行中的／重試失敗的）；已生成但沒有評估 → 比較；都有 → null。
 * occurrence：同一 spec 重複出現的第幾張（手動生成可重複 seed）。
 */
function imageStep(task: PromptStudyTask, spec: ImageSpec, occurrence = 0): RunStep | null {
  const attempts = rendersOf(task).filter((render) => sameImage(render, spec));
  const successes = attempts.filter((render) => render.state === "succeeded");
  const done = successes[occurrence];
  if (done) {
    if (evaluationsOf(task).some((evaluation) => evaluation.render_run_id === done.run_id)) return null;
    if (!done.image) return { kind: "render", spec, action: "retry", runId: done.run_id, error: { code: "IMAGE_MISSING", message: t("生成成功但沒有圖片輸出") } };
    return { kind: "compare", spec, renderRunId: done.run_id, image: done.image, ...pendingAction(task) };
  }
  const latest = attempts[attempts.length - 1];
  if (latest?.state === "unknown") return { kind: "render", spec, action: "attach", runId: latest.run_id, error: null };
  if (latest && latest.state !== "succeeded") return { kind: "render", spec, action: "retry", runId: latest.run_id, error: latest.error };
  return { kind: "render", spec, ...fresh(task) };
}

// ---------------------------------------------------------------- 分析原圖、手動修訂

export function planAnalyze(task: PromptStudyTask): PlannedStep {
  if (task.state !== "running") return { kind: "done" };
  if (versionRefsOf(task).length > 0 && captionOf(task)) return finish("succeeded", "completed", null, "analysis_only", { reason: "analysis_done" });
  return { kind: "analyze", ...pendingAction(task) };
}

export function planRefine(study: PromptStudy, task: PromptStudyTask): PlannedStep {
  if (task.state !== "running") return { kind: "done" };
  if (task.request.kind !== "refine" || !(task.base_version_id != null && task.base_version_id !== "")) return { kind: "blocked", reason: t("任務設定無法解讀（缺少修訂指示或起點版本）") };
  if (!findVersion(study, task.base_version_id)) return { kind: "blocked", reason: t("找不到修訂的起點版本") };
  if (versionRefsOf(task).length > 0) return finish("succeeded", "completed", null, "analysis_only", { reason: "revision_done" });
  return { kind: "revise", round: null, fromVersionId: task.base_version_id, instruction: task.request.instruction, comparison: null, ...pendingAction(task) };
}

// ---------------------------------------------------------------- 生成比對（手動）

export function renderImageBudget(task: PromptStudyTask): number {
  return task.request.kind === "render" ? task.request.variants.length * task.request.seeds.length : 0;
}

export function planRender(study: PromptStudy, task: PromptStudyTask): PlannedStep {
  if (task.state !== "running") return { kind: "done" };
  const request = task.request;
  if (request.kind !== "render") return { kind: "blocked", reason: t("任務設定無法解讀") };
  const version = findVersion(study, task.base_version_id);
  if (!version) return { kind: "blocked", reason: t("找不到這個任務的版本") };
  const candidates = uniqueCandidates(version.candidates.items.filter((candidate) => request.variants.includes(candidate.variant)));
  if (candidates.length === 0) return { kind: "blocked", reason: t("這個版本沒有要生成的候選") };
  const budget: Budget = { maxImages: renderImageBudget(task), maxVisionOps: null, best: null, failWhenEmpty: true };
  for (const candidate of candidates) {
    for (const { seed, occurrence } of seedOccurrences(request.seeds)) {
      const spec: ImageSpec = { split: "manual", round: 0, versionId: version.version_id, variant: candidate.variant, prompt: candidate.prompt, seed };
      const step = imageStep(task, spec, occurrence);
      if (step) return withinBudget(task, step, budget);
    }
  }
  return finish("succeeded", "completed", null, "rendered", { reason: "renders_compared" });
}

// ---------------------------------------------------------------- 有界搜尋

export interface SearchProgress {
  /** 已決定的輪數。 */
  decidedRounds: number;
  incumbent: RankedCandidate | null;
  /** 全部搜尋評估的排名（顯示用）。 */
  ranked: RankedCandidate[];
  noImprovement: number;
  stoppedEarly: boolean;
  /** 每輪的版本與決定（顯示用）。 */
  rounds: RoundView[];
}

export interface RoundView {
  round: number;
  versionId: string | null;
  decided: boolean;
  incumbent: CandidateRef | null;
  challenger: CandidateRef | null;
  improved: boolean;
  note: string;
}

function versionOrder(study: PromptStudy): (versionId: string) => number {
  return (versionId) => {
    const index = versionIndex(study, versionId);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
}

function reconstructConfig(task: PromptStudyTask) {
  return task.request.kind === "reconstruct" ? task.request : null;
}

/** 早一輪已評估過、文字完全相同的 prompt（同 seed）：沿用，不重新生成。 */
function reusable(study: PromptStudy, evaluations: readonly EvaluationRef[], promptSha: string, seed: number, round: number): boolean {
  return evaluations.some((item) => item.split === "search" && item.round < round && item.seed === seed && candidateOf(findVersion(study, item.version_id), item.variant)?.prompt_sha256 === promptSha);
}

/** 這一輪需要評估的候選（去掉文字相同、前幾輪已評估過的）；沒有版本時為 null。 */
function roundVersion(study: PromptStudy, task: PromptStudyTask, round: number): PromptStudyVersion | null {
  if (round === 0) return findVersion(study, task.base_version_id);
  const ref = versionRefsOf(task)[round - 1];
  return ref ? findVersion(study, ref.version_id) : null;
}

interface Replay {
  progress: SearchProgress;
  /** 還沒決定的輪需要的下一個 run（或結束）；全部決定完時為 null。 */
  next: PlannedStep | null;
}

/** 依結果參照重播各輪：回傳目前的狀態與下一步。 */
function replay(study: PromptStudy, task: PromptStudyTask): Replay | null {
  const config = reconstructConfig(task);
  if (!config) return null;
  const evaluations = evaluationsOf(task);
  const order = versionOrder(study);
  const ranked = rankCandidates(evaluations, config.search_seeds, order);
  const rounds: RoundView[] = [];
  let incumbent: RankedCandidate | null = null;
  let noImprovement = 0;
  let decided = 0;
  let stoppedEarly = false;
  const budget = (): Budget => ({ maxImages: config.max_images, maxVisionOps: config.max_vision_operations, best: incumbent?.ref ?? null, failWhenEmpty: false });
  const progress = (): SearchProgress => ({ decidedRounds: decided, incumbent, ranked, noImprovement, stoppedEarly, rounds });
  for (let round = 0; round < config.max_rounds; round += 1) {
    const version = roundVersion(study, task, round);
    if (!version) {
      if (!incumbent) return { progress: progress(), next: finish("failed", "dependency_failed", null, task.verification, { reason: "no_revision_base" }) };
      const worst = worstEvaluation(incumbent);
      const comparison = worst ? { ...worst.comparison, differences: worst.comparison.differences.slice(0, 3) } : null;
      rounds.push({ round, versionId: null, decided: false, incumbent: incumbent.ref, challenger: null, improved: false, note: t("等待修訂") });
      return {
        progress: progress(),
        next: withinBudget(task, { kind: "revise", round, fromVersionId: incumbent.ref.version_id, instruction: REVISION_INSTRUCTION, comparison, ...pendingAction(task) }, budget()),
      };
    }
    for (const candidate of uniqueCandidates(version.candidates.items)) {
      for (const seed of config.search_seeds) {
        if (reusable(study, evaluations, candidate.prompt_sha256, seed, round)) continue;
        const step = imageStep(task, { split: "search", round, versionId: version.version_id, variant: candidate.variant, prompt: candidate.prompt, seed });
        if (step) {
          rounds.push({ round, versionId: version.version_id, decided: false, incumbent: incumbent?.ref ?? null, challenger: null, improved: false, note: t("評估中") });
          return { progress: progress(), next: withinBudget(task, step, budget()) };
        }
      }
    }
    // 這一輪的評估都完成：只用這一輪以前的評估重播當時的決定
    const known = rankCandidates(
      evaluations.filter((item) => item.round <= round),
      config.search_seeds,
      order,
    );
    if (round === 0) {
      const initial = selectInitial(known);
      if (!initial) return { progress: progress(), next: finish("failed", "dependency_failed", null, task.verification, { reason: "no_initial_candidate" }) };
      incumbent = ranked.find((item) => sameCandidate(item.ref, initial.ref)) ?? initial;
      rounds.push({ round, versionId: version.version_id, decided: true, incumbent: initial.ref, challenger: null, improved: true, note: t("初始輪：選出平均誤差最低的完整候選") });
    } else {
      const current: RankedCandidate | null = incumbent;
      if (!current) return { progress: progress(), next: finish("failed", "dependency_failed", null, task.verification, { reason: "no_current_best" }) };
      const base: RankedCandidate = known.find((item) => sameCandidate(item.ref, current.ref)) ?? current;
      const challenger: RankedCandidate | undefined = known.find((item) => item.ref.version_id === version.version_id && !sameCandidate(item.ref, base.ref) && improvementEligible(base, item));
      if (challenger) {
        const record = pairwiseOf(task).find((item) => item.round === round && sameCandidate(item.challenger, challenger.ref));
        if (!record) {
          const pair = representativePair(base, challenger);
          const incumbentRender = pair ? rendersOf(task).find((item) => item.run_id === pair.incumbent.render_run_id) : null;
          const challengerRender = pair ? rendersOf(task).find((item) => item.run_id === pair.challenger.render_run_id) : null;
          if (!pair || !incumbentRender?.image || !challengerRender?.image) return { progress: progress(), next: { kind: "blocked", reason: t("找不到同一個 seed 的代表圖，無法做雙順序比較") } };
          rounds.push({ round, versionId: version.version_id, decided: false, incumbent: base.ref, challenger: challenger.ref, improved: false, note: t("等待雙順序比較") });
          return {
            progress: progress(),
            next: withinBudget(
              task,
              { kind: "pairwise", round, seed: pair.seed, incumbent: base.ref, challenger: challenger.ref, incumbentImage: incumbentRender.image, challengerImage: challengerRender.image, ...pendingAction(task) },
              budget(),
            ),
          };
        }
        if (record.confirmed) {
          incumbent = ranked.find((item) => sameCandidate(item.ref, challenger.ref)) ?? challenger;
          noImprovement = 0;
        } else {
          noImprovement += 1;
        }
        rounds.push({
          round,
          versionId: version.version_id,
          decided: true,
          incumbent: incumbent?.ref ?? null,
          challenger: challenger.ref,
          improved: record.confirmed,
          note: record.confirmed ? t("兩個順序都支持挑戰者：換成新的最佳候選") : t("位置交換後結果不一致、平手或不確定：保留目前最佳"),
        });
      } else {
        noImprovement += 1;
        rounds.push({ round, versionId: version.version_id, decided: true, incumbent: current.ref, challenger: null, improved: false, note: t("這一輪沒有比目前最佳低至少 0.05 的完整候選") });
      }
    }
    decided += 1;
    if (noImprovement >= config.stop_after_no_improvement) {
      stoppedEarly = true;
      break;
    }
  }
  return { progress: progress(), next: null };
}

/** 搜尋目前的狀態（排名、最佳、各輪決定），面板與規劃共用。 */
export function searchProgress(study: PromptStudy, task: PromptStudyTask): SearchProgress | null {
  return replay(study, task)?.progress ?? null;
}

function holdoutStep(study: PromptStudy, task: PromptStudyTask, progress: SearchProgress): { step: RunStep | null; selected: RankedCandidate[] } {
  const config = reconstructConfig(task);
  const selected: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const item of progress.incumbent ? [progress.incumbent, ...progress.ranked] : progress.ranked) {
    if (!item.complete) continue;
    const candidate = candidateOf(findVersion(study, item.ref.version_id), item.ref.variant);
    if (!candidate || seen.has(candidate.prompt_sha256)) continue;
    seen.add(candidate.prompt_sha256);
    selected.push(item);
    if (selected.length === 2) break;
  }
  for (const item of selected) {
    const prompt = candidateOf(findVersion(study, item.ref.version_id), item.ref.variant)?.prompt ?? "";
    for (const seed of config?.holdout_seeds ?? []) {
      const step = imageStep(task, { split: "holdout", round: 0, versionId: item.ref.version_id, variant: item.ref.variant, prompt, seed });
      if (step) return { step, selected };
    }
  }
  return { step: null, selected };
}

const VERIFICATION_RANK: Record<Verification, number> = { analysis_only: 0, rendered: 1, search_evaluated: 2, holdout_evaluated: 3 };

export function planReconstruct(study: PromptStudy, task: PromptStudyTask): PlannedStep {
  if (task.state !== "running") return { kind: "done" };
  const config = reconstructConfig(task);
  if (!config) return { kind: "blocked", reason: t("任務設定無法解讀") };
  if (!findVersion(study, task.base_version_id)) return { kind: "blocked", reason: t("找不到搜尋的起點版本") };
  const result = replay(study, task);
  if (!result) return { kind: "blocked", reason: t("任務設定無法解讀") };
  const { progress } = result;
  const best = progress.incumbent?.ref ?? null;
  // 先把目前最佳與驗證程度寫回任務（純計算），再做下一個 run
  const wanted: Verification = progress.decidedRounds > 0 ? "search_evaluated" : task.verification;
  if (best && (!sameCandidate(task.best, best) || VERIFICATION_RANK[wanted] > VERIFICATION_RANK[task.verification])) {
    return { kind: "progress", best, verification: VERIFICATION_RANK[wanted] > VERIFICATION_RANK[task.verification] ? wanted : task.verification };
  }
  if (result.next) return result.next;
  if (!progress.incumbent) return finish("failed", "dependency_failed", null, task.verification, { reason: "no_candidate" });
  const holdout = holdoutStep(study, task, progress);
  if (holdout.step) return withinBudget(task, holdout.step, { maxImages: config.max_images, maxVisionOps: config.max_vision_operations, best, failWhenEmpty: false });
  return finish(
    "succeeded",
    progress.stoppedEarly ? "no_improvement" : "completed",
    best,
    "holdout_evaluated",
    progress.stoppedEarly ? { reason: "stopped_early" } : { reason: "search_done" },
  );
}

/** 依任務種類規劃下一步。 */
export function planTask(study: PromptStudy, task: PromptStudyTask): PlannedStep {
  switch (task.kind) {
    case "analyze":
      return planAnalyze(task);
    case "refine":
      return planRefine(study, task);
    case "render":
      return planRender(study, task);
    case "reconstruct":
      return planReconstruct(study, task);
  }
}

// ---------------------------------------------------------------- 文字

/** One line about the next step (beside the buttons and in the progress strip); the words for steps live in stepText.ts. */
export function describeStep(study: PromptStudy, step: PlannedStep, options: DescribeOptions = {}): string {
  switch (step.kind) {
    case "analyze":
    case "revise":
    case "render":
    case "compare":
    case "pairwise":
      return describeStepData(study, stepData(step), options);
    case "progress":
      return t("更新目前最佳：{value}", { value: step.best ? `${versionLabel(study, step.best.version_id)} ${step.best.variant}` : "—" });
    case "finish":
      return t("結束任務：{message}", { message: finishText(step.note) });
    case "blocked":
      return t("無法繼續：{reason}", { reason: step.reason });
    case "done":
      return t("任務已結束");
  }
}

/** 評估的誤差（給清單用）。 */
export { evaluationLoss };
