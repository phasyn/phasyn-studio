// Runs and their steps → log lines. Pure.
import { instanceKey, runSteps, type RunStepView, type WireRun } from "@/api/types";
import { formatMs, shortId } from "@/lib/format";
import { runDisplayName } from "@/lib/runName";
import { runPath } from "@/app/paths";
import { t } from "@/i18n";
import { durationMs, errorLine, joinParts, sortLines, type LogLevel, type LogLine, type LogSource, type Part } from "./lines";

export interface RunLineOptions {
  /** `instanceKey(node_id, component_id)` → provider_id（步驟來源的類型圖示）。 */
  providers?: ReadonlyMap<string, string>;
}

const STEP_DONE: Partial<Record<RunStepView["state"], { level: LogLevel; verb: string }>> = {
  succeeded: { level: "success", verb: t("成功") },
  failed: { level: "error", verb: t("失敗") },
  cancelled: { level: "warning", verb: t("已取消") },
  interrupted: { level: "warning", verb: t("已中斷") },
  skipped: { level: "info", verb: t("已略過") },
  unknown: { level: "info", verb: t("結束（狀態未知）") },
};

const RUN_DONE: Record<Exclude<WireRun["state"], "running">, { level: LogLevel; verb: string }> = {
  succeeded: { level: "success", verb: t("成功") },
  failed: { level: "error", verb: t("失敗") },
  cancelled: { level: "warning", verb: t("已取消") },
  interrupted: { level: "warning", verb: t("已中斷") },
};

function stepLines(run: WireRun, label: string, step: RunStepView, providers: ReadonlyMap<string, string> | undefined): LogLine[] {
  const lines: LogLine[] = [];
  const providerId = step.node_id && step.component_id ? providers?.get(instanceKey(step.node_id, step.component_id)) : undefined;
  const source: LogSource = {
    kind: "step",
    label: step.component_id ?? step.step_id,
    ...(providerId ? { providerId } : {}),
    to: runPath(run.run_id),
  };
  const context = joinParts([
    t("run「{label}」{run_id}", { label, run_id: shortId(run.run_id) }),
    step.node_id && `node ${shortId(step.node_id)}`,
    step.call_id && `call ${step.call_id}`,
    step.recording_id && `recording ${step.recording_id}`,
  ]);
  const idBase = `run:${run.run_id}:step:${step.step_id}`;
  if (step.started_at) {
    lines.push({
      id: `${idBase}:started`,
      at: step.started_at,
      level: "info",
      source,
      message: joinParts([t("{step_id} 開始", { step_id: step.step_id }), step.component_id, step.state === "waiting" && t("等待資源")]),
      detail: context,
    });
  }
  const done = STEP_DONE[step.state];
  if (step.finished_at && done) {
    const duration = durationMs(step.started_at, step.finished_at);
    const succeeded = step.state === "succeeded";
    let level = done.level;
    const parts: Part[] = [`${step.step_id} ${done.verb}`, succeeded ? duration !== null && formatMs(duration) : errorLine(step.error)];
    if (step.remote_outcome_unknown) {
      parts.push(t("遠端結果未知"));
      if (level !== "error") level = "warning";
    }
    lines.push({
      id: `${idBase}:finished`,
      at: step.finished_at,
      level,
      source,
      message: joinParts(parts),
      detail: joinParts([context, !succeeded && duration !== null && t("耗時 {duration}", { duration: formatMs(duration) })]),
    });
  }
  return lines;
}

/** 單一 run 的紀錄列（未排序；hook 以 run 物件為單位快取）。 */
export function linesFromRun(run: WireRun, options: RunLineOptions = {}): LogLine[] {
  const providers = options.providers;
  const label = runDisplayName(run);
  const to = runPath(run.run_id);
  // 來源欄用 run_id 縮寫：Studio 的 label 前綴都相同（「Studio：<專案>…」），截斷後會分不出是哪一個 run；完整 label 放在訊息。
  const source: LogSource = { kind: "run", label: shortId(run.run_id), to };
  const pipeline = run.request.pipeline;
  const lines: LogLine[] = [
    {
      id: `run:${run.run_id}:created`,
      at: run.created_at,
      level: "info",
      source,
      message: t("建立 run「{label}」・{stepsCount} 個步驟", { label, stepsCount: pipeline.steps.length }),
      detail: joinParts([`run ${run.run_id}`, `pipeline ${pipeline.pipeline_id}`, run.request.origin?.source_run_id && t("來源 run {source_run_id}", { source_run_id: run.request.origin.source_run_id })]),
    },
  ];
  for (const step of runSteps(run)) lines.push(...stepLines(run, label, step, providers));
  if (run.state !== "running" && run.finished_at) {
    const done = RUN_DONE[run.state];
    const duration = durationMs(run.created_at, run.finished_at);
    const succeeded = run.state === "succeeded";
    lines.push({
      id: `run:${run.run_id}:finished`,
      at: run.finished_at,
      level: done.level,
      source,
      message: joinParts([t("run「{label}」{verb}", { label, verb: done.verb }), succeeded ? duration !== null && formatMs(duration) : errorLine(run.error)]),
      detail: joinParts([
        `run ${run.run_id}`,
        !succeeded && duration !== null && t("耗時 {duration}", { duration: formatMs(duration) }),
        run.state === "interrupted" && t("主控重新啟動造成中斷；不會恢復，重新執行會建立新的 run"),
      ]),
    });
  }
  return lines;
}

/**
 * run 列表 → 紀錄：建立、每個步驟的開始／結束、run 結束。
 * 耗時只由真實的 started_at／finished_at（或 created_at／finished_at）計算；缺值時不顯示數字。
 */
export function linesFromRuns(runs: readonly WireRun[], options: RunLineOptions = {}): LogLine[] {
  return sortLines(runs.flatMap((run) => linesFromRun(run, options)));
}
