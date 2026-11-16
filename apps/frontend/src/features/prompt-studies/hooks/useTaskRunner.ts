// 任務的逐步執行：每一步只建立（或讀回）一個 run，等它結束後把結果寫回研究文件，再由規劃器算下一步。
//   「執行下一步」＝一個 run（前後的純計算——更新目前最佳、結束任務——一併完成）；
//   「連續執行」＝依序執行到指定輪數、任務結束、第一個失敗或使用者停止（停止在目前的 run 結束後生效，不取消 run）。
//   失敗不自動重試：上一步失敗時要使用者明確按「重試這一步」；建立 run 的請求連線中斷＝遠端結果未知，照實記錄。
//   離開頁面只中止「等待」，run 仍在主控上；之後再執行會先讀回同一個 run 的結果，不重送。
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiErrorBody, Catalog } from "@/api/generated/contracts";
import { runSteps, type RunRequestBody, type WireRun } from "@/api/types";
import { toErrorInfo, writeOutcomeUnknown } from "@/lib/errors";
import { createRun } from "@/api/runs";
import { invalidateRuns, waitForRun } from "../api";
import { findDescriptor } from "../model/components";
import { taskSettings } from "../model/normalize";
import { buildAnalyzeRun, buildCompareRun, buildCompileRun, buildPairwiseRun, buildReviseRun, readAnalyze, readCompare, readCompile, readPairwise, readRevise, renderedImages, type OpBuild } from "../model/ops";
import { describeStep, expectedPipeline, planTask, searchProgress, type RunStep } from "../model/planner";
import { newVersionId, recordFinish, recordProgress, recordRunCreated, recordRunFailed, recordStepResult, type FailedRunState, type StepResult } from "../model/records";
import { readStepErrorText, stepErrorDetails, stepErrorWords, type ComponentRole, type StepErrorText } from "../model/stepError";
import { finishText } from "../model/stepText";
import { planRenderRun, type ImageRoute } from "../model/routes";
import { REVISION_INSTRUCTION } from "../model/scene";
import { findTask, findVersion } from "../model/study";
import type { PromptCandidates, PromptScene, PromptStudy, PromptStudyTask, SectionKey, TaskComponents } from "../types";
import type { StudyDocument } from "./useStudyDocument";
import { t } from "@/i18n";

export interface RunnerEnv {
  doc: StudyDocument;
  catalog: Catalog | undefined;
  routes: readonly ImageRoute[];
  /** 目前選的元件（分析與修訂任務用；生成與搜尋用任務凍結的元件）。 */
  components: TaskComponents;
}

export interface RunnerState {
  busy: boolean;
  mode: "step" | "loop" | "compile" | null;
  taskId: string | null;
  /** 目前這一步的說明。 */
  description: string | null;
  /** 正在等待的 run。 */
  runId: string | null;
  /** 最近一次讀到的 run（進度、預覽）。 */
  run: WireRun | null;
  stopRequested: boolean;
  /** 沒有寫進研究文件的錯誤（保存失敗、讀不到 run 狀態、建立 run 被拒等完整錯誤）。 */
  error: unknown;
  /** 停下來的原因（例如「上一步失敗：要明確重試」「已完成 2 輪」）。 */
  notice: string | null;
}

const IDLE: RunnerState = { busy: false, mode: null, taskId: null, description: null, runId: null, run: null, stopRequested: false, error: null, notice: null };

/**
 * A problem found before any run was sent (component missing, interface or parameters do not fit) or a run that
 * succeeded with output this page cannot read. A structured `text` is stored as data and worded when shown; a plain
 * message is an error passed on as it came.
 */
export class StepProblem extends Error {
  readonly code: string;
  readonly text: StepErrorText | null;
  constructor(code: string, detail: StepErrorText | string) {
    super(typeof detail === "string" ? detail : stepErrorWords(detail));
    this.name = "StepProblem";
    this.code = code;
    this.text = typeof detail === "string" ? null : detail;
  }
}

const nowIso = () => new Date().toISOString();

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function toErrorBody(error: unknown): ApiErrorBody {
  // The runner's own problems are stored as code + data (no text in the runner's language); see model/stepError.ts.
  if (error instanceof StepProblem) return error.text ? { code: error.code, message: "", details: stepErrorDetails(error.text) } : { code: error.code, message: error.message };
  const info = toErrorInfo(error);
  return { code: info.code, message: info.message, details: info.details, remote_outcome_unknown: info.remoteOutcomeUnknown || writeOutcomeUnknown(error) };
}

/** 結束但沒有成功的 run 的錯誤：run.error，或第一個失敗步驟的錯誤。 */
export function runFailure(run: WireRun): { error: ApiErrorBody; state: FailedRunState } {
  const failed = runSteps(run).find((step) => step.error !== null);
  const error = run.error ?? failed?.error ?? null;
  const state: FailedRunState = run.state === "cancelled" ? "cancelled" : run.state === "interrupted" ? "interrupted" : "failed";
  const fallback = state === "cancelled" ? "RUN_CANCELLED" : state === "interrupted" ? "RUN_INTERRUPTED" : "RUN_FAILED";
  const remote = Boolean(error?.remote_outcome_unknown) || runSteps(run).some((step) => step.remote_outcome_unknown);
  const failedStep = failed?.step_id ?? null;
  return {
    state,
    // The server's error keeps its message; without one, the fallback is stored as data and worded when shown.
    error: error
      ? { code: error.code, message: error.message, details: { failed_step: failedStep }, remote_outcome_unknown: remote }
      : { code: fallback, message: "", details: { failed_step: failedStep, ...stepErrorDetails({ kind: "run_ended", state }) }, remote_outcome_unknown: remote },
  };
}

function descriptorOf(catalog: Catalog | undefined, key: string | null, role: ComponentRole) {
  const descriptor = findDescriptor(catalog, key);
  if (!descriptor) throw new StepProblem("COMPONENT_MISSING", { kind: "component_missing", role, component: key });
  return descriptor;
}

function componentsFor(task: PromptStudyTask, env: RunnerEnv): TaskComponents {
  return (task.request.kind === "render" || task.request.kind === "reconstruct" ? taskSettings(task.request.settings)?.components : null) ?? env.components;
}

function label(study: PromptStudy, text: string): string {
  return t("圖片反推・{value}・{text}", { value: study.title || study.study_id, text });
}

function unwrap(build: OpBuild): RunRequestBody {
  if (!build.ok) throw new StepProblem("NOT_SENT", build.problem);
  return build.body;
}

/** 這一步要送出的 run。 */
function buildRunBody(study: PromptStudy, task: PromptStudyTask, step: RunStep, env: RunnerEnv): RunRequestBody {
  const components = componentsFor(task, env);
  const text = label(study, describeStep(study, step, { action: false }));
  const source = study.source.file;
  const base = findVersion(study, task.base_version_id);
  switch (step.kind) {
    case "analyze":
      return unwrap(
        buildAnalyzeRun({
          vision: descriptorOf(env.catalog, components.vision, "vision"),
          compile: descriptorOf(env.catalog, components.compile, "compile"),
          source,
          language: study.language,
          crops: study.crops,
          label: text,
        }),
      );
    case "revise": {
      const from = findVersion(study, step.fromVersionId);
      if (!from) throw new StepProblem("NOT_SENT", { kind: "base_version_missing" });
      return unwrap(
        buildReviseRun({
          vision: descriptorOf(env.catalog, components.vision, "vision"),
          compile: descriptorOf(env.catalog, components.compile, "compile"),
          source,
          scene: from.scene,
          comparison: step.comparison,
          instruction: step.instruction || (step.comparison ? REVISION_INSTRUCTION : ""),
          intentional: from.intentional_changes,
          language: study.language,
          crops: study.crops,
          label: text,
        }),
      );
    }
    case "render": {
      const settings = taskSettings(task.request.kind === "render" || task.request.kind === "reconstruct" ? task.request.settings : null);
      if (!settings) throw new StepProblem("NOT_SENT", { kind: "settings_unreadable" });
      const route = env.routes.find((item) => item.id === settings.route);
      if (!route) throw new StepProblem("NOT_SENT", { kind: "route_missing", route: settings.route });
      const plan = planRenderRun(route, { prompt: step.spec.prompt, settings, seed: step.spec.seed, label: text }, env.catalog);
      if (!plan.ok) throw new StepProblem("NOT_SENT", plan.problem);
      return plan.body;
    }
    case "compare":
      if (!base) throw new StepProblem("NOT_SENT", { kind: "frozen_base_missing" });
      return unwrap(
        buildCompareRun({
          vision: descriptorOf(env.catalog, components.vision, "vision"),
          score: descriptorOf(env.catalog, components.score, "score"),
          source,
          generated: step.image,
          scene: base.scene,
          intentional: base.intentional_changes,
          rubricSha256: task.rubric?.sha256 ?? null,
          language: study.language,
          label: text,
        }),
      );
    case "pairwise":
      if (!base) throw new StepProblem("NOT_SENT", { kind: "frozen_base_missing" });
      return unwrap(
        buildPairwiseRun({
          vision: descriptorOf(env.catalog, components.vision, "vision"),
          score: descriptorOf(env.catalog, components.score, "score"),
          source,
          incumbent: step.incumbentImage,
          challenger: step.challengerImage,
          scene: base.scene,
          intentional: base.intentional_changes,
          language: study.language,
          label: text,
        }),
      );
  }
}

/** run 成功後的結果；無法解讀時丟出 StepProblem（INVALID_RESULT）。 */
function parseStepResult(step: RunStep, run: WireRun): StepResult {
  const invalid = (problem: StepErrorText) => new StepProblem("INVALID_RESULT", problem);
  switch (step.kind) {
    case "analyze": {
      const parsed = readAnalyze(run);
      if (!parsed.ok) throw invalid(parsed.problem);
      return { kind: "analysis", ...parsed.value, versionId: newVersionId() };
    }
    case "revise": {
      const parsed = readRevise(run);
      if (!parsed.ok) throw invalid(parsed.problem);
      return { kind: "revision", ...parsed.value, versionId: newVersionId(), note: step.round === null ? t("修訂指示：{instruction}", { instruction: step.instruction }).slice(0, 1000) : t("有界搜尋第 {round} 輪修訂", { round: step.round + 1 }) };
    }
    case "render": {
      const images = renderedImages(run);
      const image = images.white ?? images.rgba;
      if (!image) throw invalid({ kind: "image_missing" });
      return { kind: "image", image: image.file, asset: image.asset };
    }
    case "compare": {
      const parsed = readCompare(run);
      if (!parsed.ok) throw invalid(parsed.problem);
      return { kind: "evaluation", ...parsed.value };
    }
    case "pairwise": {
      const parsed = readPairwise(run);
      if (!parsed.ok) throw invalid(parsed.problem);
      return { kind: "pairwise", ...parsed.value };
    }
  }
}

export interface ManualCompile {
  candidates: PromptCandidates;
  runId: string;
}

export function useTaskRunner(env: RunnerEnv) {
  const client = useQueryClient();
  const envRef = useRef(env);
  const [state, setState] = useState<RunnerState>(IDLE);
  const busy = useRef(false);
  const stopFlag = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    envRef.current = env;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const patch = useCallback((change: Partial<RunnerState>) => {
    if (mounted.current) setState((current) => ({ ...current, ...change }));
  }, []);

  /** 一個 run：建立（或讀回）→ 等結束 → 寫回結果。 */
  const executeStep = useCallback(
    async (taskId: string, step: RunStep, signal: AbortSignal): Promise<"ok" | "failed" | "aborted"> => {
      const { doc } = envRef.current;
      const study = doc.latest();
      const task = findTask(study, taskId);
      if (!task) throw new Error(t("找不到任務"));
      const fail = async (runId: string | null, error: ApiErrorBody, runState: FailedRunState = "failed") => {
        await doc.update((current) => recordRunFailed(current, taskId, step, runId, error, runState, nowIso()));
      };

      let runId: string;
      if (step.action === "attach" && step.runId) {
        runId = step.runId;
      } else {
        let body: RunRequestBody;
        try {
          body = buildRunBody(study, task, step, envRef.current);
        } catch (error) {
          await fail(null, toErrorBody(error));
          patch({ error });
          return "failed";
        }
        try {
          runId = (await createRun(body)).run_id;
        } catch (error) {
          // 建立被拒（例如 RUN_ACTIVE）＝沒有 run；連線中斷＝不知道有沒有建立：都記成失敗、不重送
          await fail(null, toErrorBody(error));
          patch({ error });
          return "failed";
        }
        invalidateRuns(client, runId);
        try {
          await doc.update((current) => recordRunCreated(current, taskId, step, runId, nowIso()));
        } catch (error) {
          patch({ error: new Error(t("run {runId} 已建立，但研究文件保存失敗（{message}）；run 仍會執行，可在「紀錄・執行紀錄」查看", { runId, message: toErrorInfo(error).message })) });
          return "failed";
        }
      }
      patch({ runId });

      let finished: WireRun;
      try {
        finished = await waitForRun(runId, { signal, onUpdate: (run) => patch({ run }) });
      } catch (error) {
        if (isAbort(error)) return "aborted";
        if (toErrorInfo(error).status === 404) {
          await fail(runId, { code: "RUN_NOT_FOUND", message: "", details: stepErrorDetails({ kind: "run_not_found", run_id: runId }) });
          return "failed";
        }
        patch({ error: new Error(t("無法讀取 run {runId} 的狀態（{message}）；run 仍在主控上，之後按「執行下一步」會先讀回結果", { runId, message: toErrorInfo(error).message })) });
        return "failed";
      }
      invalidateRuns(client, runId);
      const expected = expectedPipeline(step);
      if (step.action === "attach" && expected && finished.request.pipeline.pipeline_id !== expected) {
        await fail(runId, { code: "RUN_MISMATCH", message: "", details: stepErrorDetails({ kind: "run_mismatch", pipeline_id: finished.request.pipeline.pipeline_id, expected }) });
        return "failed";
      }
      if (finished.state !== "succeeded") {
        const failure = runFailure(finished);
        await fail(runId, failure.error, failure.state);
        return "failed";
      }
      let result: StepResult;
      try {
        result = parseStepResult(step, finished);
      } catch (error) {
        await fail(runId, toErrorBody(error));
        return "failed";
      }
      await doc.update((current) => recordStepResult(current, taskId, step, runId, result, nowIso()));
      return "ok";
    },
    [client, patch],
  );

  /** 執行任務：step＝一個 run；loop＝連續執行（rounds＝輪數，"all"＝到任務結束）。 */
  const run = useCallback(
    async (taskId: string, options: { mode: "step" | "loop"; rounds?: number | "all"; allowRetry?: boolean }) => {
      if (busy.current) return;
      busy.current = true;
      stopFlag.current = false;
      const abort = new AbortController();
      controller.current = abort;
      if (mounted.current) setState({ ...IDLE, busy: true, mode: options.mode, taskId });
      let allowRetry = options.allowRetry ?? false;
      let runSteps = 0;
      let notice: string | null = null;
      const decided = () => {
        const latest = envRef.current.doc.latest();
        const task = findTask(latest, taskId);
        return task ? (searchProgress(latest, task)?.decidedRounds ?? 0) : 0;
      };
      const startRounds = decided();
      try {
        for (;;) {
          const { doc } = envRef.current;
          const study = doc.latest();
          const task = findTask(study, taskId);
          if (!task) {
            notice = t("找不到任務");
            break;
          }
          const step = planTask(study, task);
          if (step.kind === "done") break;
          if (step.kind === "blocked") {
            notice = step.reason;
            break;
          }
          if (step.kind === "progress") {
            await doc.update((current) => recordProgress(current, taskId, step.best, step.verification, nowIso()));
            continue;
          }
          if (step.kind === "finish") {
            await doc.update((current) =>
              recordFinish(current, taskId, { state: step.state, stopReason: step.stopReason, best: step.best, verification: step.verification, note: step.note }, nowIso()),
            );
            notice = finishText(step.note);
            break;
          }
          // 連續執行 N 輪：輪數到了就停（保留驗證算在最後一輪內）
          if (options.mode === "loop" && typeof options.rounds === "number" && decided() - startRounds >= options.rounds) {
            const holdout = (step.kind === "render" || step.kind === "compare") && step.spec.split === "holdout";
            if (!holdout) {
              notice = t("已完成 {decided} 輪", { decided: decided() - startRounds });
              break;
            }
          }
          if (options.mode === "step" && runSteps >= 1) break;
          if (stopFlag.current) {
            notice = t("已停止（目前的 run 已經完成）");
            break;
          }
          if (step.action === "retry" && !allowRetry) {
            notice = t("上一步失敗（{value}）：確認原因後按「重試這一步」", { value: step.error?.code ?? t("錯誤") });
            break;
          }
          allowRetry = false;
          patch({ description: describeStep(study, step), runId: step.action === "attach" ? step.runId : null, run: null, error: null });
          const outcome = await executeStep(taskId, step, abort.signal);
          runSteps += 1;
          if (outcome === "aborted") {
            notice = t("已停止等待；run 仍在主控上執行，之後按「執行下一步」會先讀回它的結果");
            break;
          }
          if (outcome === "failed") break;
        }
      } catch (error) {
        patch({ error });
      } finally {
        busy.current = false;
        stopFlag.current = false;
        if (controller.current === abort) controller.current = null;
        patch({ busy: false, mode: null, stopRequested: false, description: null, runId: null, notice });
      }
    },
    [executeStep, patch],
  );

  /** 建立任務（凍結設定）後開始執行；studySettings 會一起存進研究的 settings（下次開啟沿用）。 */
  const start = useCallback(
    async (task: PromptStudyTask, options: { mode: "step" | "loop"; rounds?: number | "all" }, studySettings?: Record<string, unknown>) => {
      if (busy.current) return;
      try {
        await envRef.current.doc.update((current) => ({ ...current, settings: studySettings ?? current.settings, tasks: [...current.tasks, task] }));
      } catch (error) {
        patch({ error, notice: null });
        return;
      }
      await run(task.task_id, options);
    },
    [patch, run],
  );

  /** 停止連續執行：目前的 run 結束、結果寫回後才停（不取消 run）。 */
  const stop = useCallback(() => {
    if (!busy.current) return;
    stopFlag.current = true;
    patch({ stopRequested: true });
  }, [patch]);

  /** 結束任務（之後不可再改；已完成的圖片、比較與版本都保留）。 */
  const end = useCallback(
    async (taskId: string) => {
      if (busy.current) return;
      try {
        await envRef.current.doc.update((current) => recordFinish(current, taskId, { state: "cancelled", stopReason: "user_cancel", note: { reason: "user_ended" } }, nowIso()));
      } catch (error) {
        patch({ error });
      }
    },
    [patch],
  );

  /** 人工修改的版本：用 prompt.scene_compile 編譯候選（一個 run；不屬於任何任務）。 */
  const compile = useCallback(
    async (input: { scene: PromptScene; intentional: SectionKey[]; componentKey: string | null }): Promise<ManualCompile | null> => {
      if (busy.current) return null;
      busy.current = true;
      const abort = new AbortController();
      controller.current = abort;
      if (mounted.current) setState({ ...IDLE, busy: true, mode: "compile", description: t("編譯 core／detailed 候選（prompt.scene_compile）") });
      try {
        const { catalog, doc } = envRef.current;
        const study = doc.latest();
        const body = unwrap(
          buildCompileRun({ compile: descriptorOf(catalog, input.componentKey, "compile"), scene: input.scene, intentional: input.intentional, crops: study.crops, label: label(study, t("編譯人工修改的場景")) }),
        );
        const created = await createRun(body);
        invalidateRuns(client, created.run_id);
        patch({ runId: created.run_id });
        const finished = await waitForRun(created.run_id, { signal: abort.signal, onUpdate: (current) => patch({ run: current }) });
        invalidateRuns(client, created.run_id);
        if (finished.state !== "succeeded") {
          const failure = runFailure(finished);
          throw new StepProblem(failure.error.code, readStepErrorText(failure.error.details?.text) ?? failure.error.message);
        }
        const parsed = readCompile(finished);
        if (!parsed.ok) throw new StepProblem("INVALID_RESULT", parsed.problem);
        return { candidates: parsed.value, runId: created.run_id };
      } catch (error) {
        if (!isAbort(error)) patch({ error });
        return null;
      } finally {
        busy.current = false;
        if (controller.current === abort) controller.current = null;
        patch({ busy: false, mode: null, runId: null, description: null });
      }
    },
    [client, patch],
  );

  const clearMessages = useCallback(() => patch({ error: null, notice: null }), [patch]);

  return { state, run, start, stop, end, compile, clearMessages };
}

export type TaskRunner = ReturnType<typeof useTaskRunner>;
