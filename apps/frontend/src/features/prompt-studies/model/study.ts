// 研究文件的純操作：建立、版本與任務查詢、結果參照、預算用量（與主控的計算規則相同）、接受條件。不送出任何請求。
import type { ApiErrorBody } from "@/api/generated/contracts";
import { changedItems, isRecord } from "@/lib/json";
import type {
  CandidateRef,
  CaptionRef,
  EvaluationRef,
  PairwiseRef,
  PromptCrop,
  PromptLanguage,
  PromptStudy,
  PromptStudySource,
  PromptStudyTask,
  PromptStudyVersion,
  PromptTaskRequest,
  PromptVariant,
  RenderRef,
  StopReason,
  TaskKind,
  VersionRef,
} from "../types";
import { candidateOf } from "./compile";
import { t } from "@/i18n";

export const TASK_LABELS: Record<TaskKind, string> = {
  analyze: t("分析原圖"),
  refine: t("修訂場景"),
  render: t("生成比對"),
  reconstruct: t("有界搜尋"),
};

export const ORIGIN_LABELS: Record<PromptStudyVersion["origin"], string> = {
  analysis: t("圖片分析"),
  manual: t("人工修改"),
  refinement: t("模型修訂"),
};

export const STOP_TEXT: Record<StopReason, string> = {
  completed: t("完成"),
  no_improvement: t("連續沒有改善"),
  budget: t("預算用完"),
  deadline: t("超過期限"),
  user_cancel: t("使用者結束"),
  dependency_failed: t("元件失敗或不可判斷"),
  invalid_output: t("模型輸出不合格"),
  interrupted: t("已中斷"),
};

export function stopReasonText(reason: StopReason | null): string {
  return reason ? STOP_TEXT[reason] : "—";
}

/** 本地 ID（英數字開頭；controller 的 local id 規則）。 */
export function localId(prefix: string): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}${Date.now().toString(36)}${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}`.slice(0, 40);
}

export function newStudy(input: { title: string; source: PromptStudySource; language: PromptLanguage; crops: PromptCrop[]; now: string; settings?: Record<string, unknown>; id?: string }): PromptStudy {
  return {
    study_id: input.id ?? localId("ps"),
    title: input.title.trim() || t("未命名研究"),
    revision: 0,
    created_at: input.now,
    updated_at: input.now,
    language: input.language,
    source: input.source,
    crops: input.crops,
    settings: input.settings ?? {},
    versions: [],
    tasks: [],
    accepted_version_id: null,
    acceptance: null,
    archived: false,
    note: "",
  };
}

// ---------------------------------------------------------------- 版本

export function findVersion(study: PromptStudy, versionId: string | null | undefined): PromptStudyVersion | null {
  return (versionId != null && versionId !== "") ? (study.versions.find((version) => version.version_id === versionId) ?? null) : null;
}

export function versionIndex(study: PromptStudy, versionId: string): number {
  return study.versions.findIndex((version) => version.version_id === versionId);
}

/** v1、v2…（版本的 number）；已不存在的版本顯示原始 ID 開頭。 */
export function versionLabel(study: PromptStudy, versionId: string | null | undefined): string {
  if (!(versionId != null && versionId !== "")) return "—";
  const version = findVersion(study, versionId);
  return version ? `v${String(version.number)}` : t("已移除的版本 {versionId}", { versionId: versionId.slice(0, 8) });
}

export function latestVersion(study: PromptStudy): PromptStudyVersion | null {
  return study.versions[study.versions.length - 1] ?? null;
}

export function candidateLabel(study: PromptStudy, ref: CandidateRef): string {
  return `${versionLabel(study, ref.version_id)} ${ref.variant}`;
}

export function sameCandidate(a: CandidateRef | null | undefined, b: CandidateRef | null | undefined): boolean {
  return a != null && a.version_id === b?.version_id && a.variant === b.variant;
}

/** 加在最後；number 依序遞增（主控檢查 1..n）。 */
export function addVersion(study: PromptStudy, version: Omit<PromptStudyVersion, "number">): PromptStudy {
  return { ...study, versions: [...study.versions, { ...version, number: study.versions.length + 1 }] };
}

// ---------------------------------------------------------------- 任務

export function findTask(study: PromptStudy, taskId: string | null | undefined): PromptStudyTask | null {
  return (taskId != null && taskId !== "") ? (study.tasks.find((task) => task.task_id === taskId) ?? null) : null;
}

/** 尚未結束的任務（同一份研究一次只推進一個）。 */
export function openTask(study: PromptStudy): PromptStudyTask | null {
  return study.tasks.find((task) => task.state === "running") ?? null;
}

export function latestTask(study: PromptStudy, kind: TaskKind): PromptStudyTask | null {
  for (let index = study.tasks.length - 1; index >= 0; index -= 1) {
    const task = study.tasks[index];
    if (task?.kind === kind) return task;
  }
  return null;
}

export function newTask(input: { request: PromptTaskRequest; baseVersionId: string | null; now: string; id?: string }): PromptStudyTask {
  return {
    task_id: input.id ?? localId("pt"),
    kind: input.request.kind,
    state: "running",
    phase: null,
    stop_reason: null,
    base_version_id: input.baseVersionId,
    request: input.request,
    rubric: null,
    run_ids: [],
    result_refs: [],
    best: null,
    verification: "analysis_only",
    error: null,
    message: "",
    created_at: input.now,
    updated_at: input.now,
    finished_at: null,
  };
}

/** 改一個任務（updated_at 一併更新）；找不到任務或沒有變化時原樣回傳。 */
export function updateTask(study: PromptStudy, taskId: string, change: (task: PromptStudyTask) => PromptStudyTask, now: string): PromptStudy {
  const tasks = changedItems(study.tasks, (task) => {
    if (task.task_id !== taskId) return task;
    const next = change(task);
    if (next === task) return task;
    return { ...next, updated_at: now };
  });
  return tasks !== null ? { ...study, tasks } : study;
}

export const captionOf = (task: PromptStudyTask): CaptionRef | null => task.result_refs.find((ref): ref is CaptionRef => ref.kind === "caption") ?? null;
export const versionRefsOf = (task: PromptStudyTask): VersionRef[] => task.result_refs.filter((ref): ref is VersionRef => ref.kind === "version");
export const rendersOf = (task: PromptStudyTask): RenderRef[] => task.result_refs.filter((ref): ref is RenderRef => ref.kind === "render");
export const evaluationsOf = (task: PromptStudyTask): EvaluationRef[] => task.result_refs.filter((ref): ref is EvaluationRef => ref.kind === "evaluation");
export const pairwiseOf = (task: PromptStudyTask): PairwiseRef[] => task.result_refs.filter((ref): ref is PairwiseRef => ref.kind === "pairwise");

// ---------------------------------------------------------------- run 與預算

/** 結果參照引用到的 run（render、evaluation、pairwise、caption、version）。 */
export function referencedRunIds(task: PromptStudyTask): Set<string> {
  const out = new Set<string>();
  for (const ref of task.result_refs) {
    if (ref.kind === "version") {
      if (ref.run_id != null && ref.run_id !== "") out.add(ref.run_id);
    } else {
      out.add(ref.run_id);
    }
  }
  return out;
}

/** 失敗紀錄裡的 run（task.error.details.run_id）。 */
export function errorRunId(error: ApiErrorBody | null): string | null {
  const details = error?.details;
  return isRecord(details) && typeof details["run_id"] === "string" ? details["run_id"] : null;
}

/**
 * 最後一個還沒有結果參照的 run：已建立、結果還沒寫回（attach＝讀回，不重送），或已知失敗（task.error 指著它）。
 * 每一步成功時都會寫下引用它 run_id 的結果參照，所以同一時間最多一個。
 */
export function pendingRun(task: PromptStudyTask): { runId: string; failed: boolean } | null {
  const referenced = referencedRunIds(task);
  const last = task.run_ids[task.run_ids.length - 1];
  if (!(last != null && last !== "") || referenced.has(last)) return null;
  return { runId: last, failed: errorRunId(task.error) === last };
}

/** 這個任務已經用掉的生成圖片數：每個 render 參照（失敗、取消也計入；主控同一規則）。 */
export function imagesUsed(task: PromptStudyTask): number {
  return rendersOf(task).length;
}

/** 視覺操作數（主控的計算）：caption 與 evaluation 各 1、pairwise 2（A/B＋B/A）、修訂或重建任務中有 run 的版本 1。 */
export function visionOpsUsed(task: PromptStudyTask): number {
  let count = 0;
  for (const ref of task.result_refs) {
    if (ref.kind === "caption" || ref.kind === "evaluation") count += 1;
    else if (ref.kind === "pairwise") count += 2;
    else if (ref.kind === "version" && ref.run_id !== null && (task.kind === "refine" || task.kind === "reconstruct")) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------- 評估與接受

function promptSha(study: PromptStudy, ref: CandidateRef): string | null {
  return candidateOf(findVersion(study, ref.version_id), ref.variant)?.prompt_sha256 ?? null;
}

/** 兩個候選參照是不是同一段 prompt（不同版本文字相同也算；主控接受規則的別名）。 */
export function samePrompt(study: PromptStudy, a: CandidateRef, b: CandidateRef): boolean {
  const left = promptSha(study, a);
  return left !== null && left === promptSha(study, b);
}

/** 所有任務中，這段 prompt 的評估。 */
export function evaluationsForCandidate(study: PromptStudy, ref: CandidateRef): EvaluationRef[] {
  return study.tasks.flatMap((task) => evaluationsOf(task)).filter((item) => samePrompt(study, item, ref));
}

/** 誤差最低的已評分評估（同分時 seed 小的優先）。 */
export function bestEvaluation(items: readonly EvaluationRef[]): EvaluationRef | null {
  const scored = items.filter((item) => !item.score.unverified && item.score.loss !== null);
  if (scored.length === 0) return null;
  return [...scored].sort((a, b) => (a.score.loss ?? 0) - (b.score.loss ?? 0) || a.seed - b.seed)[0] ?? null;
}

/**
 * 接受的依據（主控規則）：已結束的任務中，這段 prompt 實際生成成功的 render（不同版本或種類、文字相同的候選也算）。
 * 有指定任務且其中有生成成功的圖時用那個任務；同一範圍內優先選誤差最低那張。
 */
export function acceptanceSource(study: PromptStudy, ref: CandidateRef, preferTaskId: string | null = null): { task: PromptStudyTask; render: RenderRef } | null {
  const sources: { task: PromptStudyTask; render: RenderRef }[] = [];
  for (const task of study.tasks) {
    if (task.state === "running") continue;
    for (const render of rendersOf(task)) {
      if (render.state === "succeeded" && samePrompt(study, render, ref)) sources.push({ task, render });
    }
  }
  const preferred = sources.filter((item) => item.task.task_id === preferTaskId);
  const pool = preferred.length > 0 ? preferred : sources;
  const best = bestEvaluation(pool.flatMap((item) => evaluationsOf(item.task).filter((evaluation) => evaluation.render_run_id === item.render.run_id)));
  return pool.find((item) => item.render.run_id === best?.render_run_id) ?? pool[0] ?? null;
}

/** 目前接受的候選（accepted_version_id＋acceptance.variant）。 */
export function acceptedRef(study: PromptStudy): CandidateRef | null {
  return (study.accepted_version_id != null && study.accepted_version_id !== "") && study.acceptance ? { version_id: study.accepted_version_id, variant: study.acceptance.variant } : null;
}

/** 已評分評估的平均誤差（不可判斷的不算）；沒有時為 null。 */
export function meanEvaluationLoss(items: readonly EvaluationRef[]): number | null {
  const losses = items.flatMap((item) => (item.score.unverified || item.score.loss === null ? [] : [item.score.loss]));
  return losses.length === 0 ? null : losses.reduce((sum, value) => sum + value, 0) / losses.length;
}

export function acceptBlockReason(study: PromptStudy, ref: CandidateRef | null): string | null {
  if (study.archived) return t("研究已封存：取消封存後才能接受");
  if (!ref) return t("請先選擇版本與候選");
  const version = findVersion(study, ref.version_id);
  if (!version) return t("找不到這個版本");
  if (!candidateOf(version, ref.variant)) return t("這個版本沒有 {variant} 候選", { variant: ref.variant });
  if (!acceptanceSource(study, ref)) return t("這個候選還沒有在已結束的任務中生成成功：先「生成比對」並讓任務結束");
  return null;
}

export type PromptTokenState = "accepted" | "too_long" | "unchecked" | "verified";

/** 候選 prompt 的 token 狀態：生成成功過＝TE 已接受；生成因 PROMPT_TOO_LONG 失敗＝超過上限；其餘沿用編譯時的狀態。 */
export function promptTokenState(study: PromptStudy, promptSha256: string, recorded: "unchecked" | "verified" | "too_long"): PromptTokenState {
  const renders = study.tasks.flatMap((task) => rendersOf(task)).filter((item) => promptSha(study, item) === promptSha256);
  if (renders.some((item) => item.state === "succeeded")) return "accepted";
  if (renders.some((item) => item.error?.code === "PROMPT_TOO_LONG")) return "too_long";
  return recorded;
}

export function variantOf(value: string | null | undefined): PromptVariant {
  return value === "detailed" ? "detailed" : "core";
}

/** 建立新任務前的共同檢查；可以時為 null。 */
export function taskStartBlock(study: PromptStudy): string | null {
  if (study.archived) return t("研究已封存：取消封存後才能執行");
  const open = openTask(study);
  if (open) return t("「{kind}」任務尚未結束：先完成或結束它", { kind: TASK_LABELS[open.kind] });
  return null;
}

const SPLIT_TEXT: Record<EvaluationRef["split"], string> = { search: t("搜尋"), holdout: t("保留驗證"), manual: t("手動") };

/** 「v3 core · seed 42 · 搜尋第 1 輪」。 */
export function evaluationTitle(study: PromptStudy, item: Pick<EvaluationRef, "version_id" | "variant" | "seed" | "split" | "round">): string {
  const where = item.split === "search" ? t("搜尋第 {round} 輪", { round: item.round + 1 }) : SPLIT_TEXT[item.split];
  return `${versionLabel(study, item.version_id)} ${item.variant} · seed ${String(item.seed)} · ${where}`;
}
