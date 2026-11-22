// Render queue of a Studio project (pure functions): one item per run — a single shot, variations of one shot, a batch
// of shots, or a sequence export — plus the per-stage view of a run (the stage matrix columns and the stepper steps).
// Stages come from the user's pipeline: names follow the step component's provider, never the step id. Nothing here
// guesses a state or a duration that the run does not report.
import type { RecordingSummary, StudioExport, StudioShot, StudioTake } from "@/api/generated/contracts";
import { parseRunStep, type WireRun } from "@/api/types";
import type { StepperStep } from "@/components/workbench/Stepper";
import { elapsedMs, formatElapsed } from "@/lib/time";
import { formatEta } from "./eta/segment";
import { branchSuffix, runBranchSuffixes, runStepIds, splitRunStepId } from "./pipelines";
import { isSummaryPending, stepLabel, type ProviderLookup } from "./progress";
import type { TakeState } from "./project";
import { t } from "@/i18n";

export type QueueKind = "shot" | "variations" | "batch" | "export";

export interface QueueTake {
  shot: StudioShot;
  take: StudioTake;
}

export interface QueueItem {
  runId: string;
  kind: QueueKind;
  title: string;
  createdAt: string;
  /** Ordered by branch suffix (final, final_0, final_1…). */
  takes: QueueTake[];
  record: StudioExport | null;
  state: TakeState;
}

/** Total time of a run, a branch or a step column: 「12.060 s」 under a minute, then 「20 分 31 秒」 or 「1 小時 5 分」. */
export function formatRunTotal(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 60_000 ? formatElapsed(ms) : formatEta(ms / 1000, { approx: false });
}

/** State of a run from its takes: rendering wins, then all succeeded, otherwise the first one that did not succeed. */
export function aggregate(states: TakeState[]): TakeState {
  if (states.includes("rendering")) return "rendering";
  if (states.every((state) => state === "succeeded")) return "succeeded";
  return states.find((state) => state !== "succeeded") ?? "failed";
}

export const suffixOf = (take: StudioTake) => branchSuffix(take.output_key);
const suffixIndex = (suffix: string) => (suffix.startsWith("_") ? Number(suffix.slice(1)) : 0);

/** Queue items of the project, newest first. */
export function queueItems(shots: StudioShot[], exports: StudioExport[]): QueueItem[] {
  const map = new Map<string, QueueItem>();
  for (const shot of shots) {
    for (const take of shot.takes) {
      const item = map.get(take.run_id) ?? { runId: take.run_id, kind: "shot" as QueueKind, title: shot.title, createdAt: take.created_at, takes: [], record: null, state: take.state };
      // Split or duplicated shots share the run output with the original shot: list each output once
      if (item.takes.some((entry) => entry.take.output_key === take.output_key)) continue;
      item.takes.push({ shot, take });
      map.set(take.run_id, item);
    }
  }
  for (const item of map.values()) {
    item.state = aggregate(item.takes.map(({ take }) => take.state));
    item.takes.sort((a, b) => suffixIndex(suffixOf(a.take)) - suffixIndex(suffixOf(b.take)));
    if (item.takes.length > 1) {
      const sameShot = item.takes.every(({ shot }) => shot.shot_id === item.takes[0]?.shot.shot_id);
      item.kind = sameShot ? "variations" : "batch";
      item.title = sameShot ? t("{value}・{takesCount} 個變體", { value: item.takes[0]?.shot.title ?? "", takesCount: item.takes.length }) : t("批次 {takesCount} 個鏡頭", { takesCount: item.takes.length });
    }
  }
  for (const record of exports) {
    map.set(record.run_id, { runId: record.run_id, kind: "export", title: t("序列匯出"), createdAt: record.created_at, takes: [], record, state: record.state });
  }
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Display name of a branch: variations are「變體 n」, batches and single shots use the shot title. */
export function branchLabel(item: QueueItem, entry: QueueTake | undefined, fallback: string): string {
  if (!entry) return item.kind === "export" ? t("序列") : fallback;
  if (item.kind === "variations") return t("變體 {entry}", { entry: item.takes.indexOf(entry) + 1 });
  return entry.shot.title;
}

export function takeForSuffix(item: QueueItem, suffix: string): QueueTake | undefined {
  return item.takes.find(({ take }) => suffixOf(take) === suffix);
}

export const STEP_STATE_LABEL: Record<string, string> = {
  succeeded: t("完成"),
  running: t("執行中"),
  waiting: t("等待資源"),
  pending: t("待執行"),
  failed: t("失敗"),
  cancelled: t("已取消"),
  interrupted: t("已中斷"),
  skipped: t("略過"),
  unknown: t("未知"),
};

export interface StageColumn {
  base: string;
  label: string;
}

/** The run's template steps (pipeline order, deduplicated across branches) = the stage matrix columns. */
export function stageColumns(run: WireRun, lookup: ProviderLookup): StageColumn[] {
  const suffixes = runBranchSuffixes(run);
  const columns: StageColumn[] = [];
  for (const id of runStepIds(run)) {
    const { base } = splitRunStepId(run, id, suffixes);
    if (!columns.some((column) => column.base === base)) columns.push({ base, label: stepLabel(run, id, lookup, suffixes) });
  }
  return columns;
}

/**
 * Pipeline stages as stepper steps: each column (template step) aggregates the actual state of every branch — any
 * failure = error, any running or waiting = active, all succeeded = done; otherwise a cancelled or interrupted branch
 * = that stopped state, and a skipped one (the run stopped before it started) = skipped, each named after it with the
 * reason as detail; anything else = pending. A skipped step never ran, so it is neither done nor "not started".
 * detail: the step duration for a single branch, the succeeded count for several. Nothing is guessed or filled in.
 */
export function stageSteps(run: WireRun, lookup: ProviderLookup, now: number | null): StepperStep[] {
  const suffixes = runBranchSuffixes(run);
  const ids = runStepIds(run);
  return stageColumns(run, lookup).map((column) => {
    const steps = ids.filter((id) => splitRunStepId(run, id, suffixes).base === column.base).map((id) => parseRunStep(id, run.steps[id]));
    const states = steps.map((step) => step.state);
    const done = states.filter((state) => state === "succeeded").length;
    const halted = states.find((value): value is "cancelled" | "interrupted" => value === "cancelled" || value === "interrupted") ?? (states.includes("skipped") ? "skipped" : undefined);
    const state: StepperStep["state"] = states.includes("failed")
      ? "error"
      : states.some((value) => value === "running" || value === "waiting")
        ? "active"
        : steps.length > 0 && done === steps.length
          ? "done"
          : (halted ?? "pending");
    let detail: string | undefined;
    if (halted && state === halted) detail = STEP_STATE_LABEL[halted];
    else if (steps.length > 1) detail = t("{done}／{stepsCount}", { done, stepsCount: steps.length });
    else {
      const only = steps[0];
      const ms = only ? elapsedMs(only.started_at, only.finished_at, only.state === "running" ? now : null) : null;
      detail = ms !== null ? formatElapsed(ms) : undefined;
    }
    return { id: column.base, label: column.label, state, ...(detail === undefined ? {} : { detail }) };
  });
}

/** The controller sends a placeholder (state unknown) until the summary arrives: while running that means running, not failed. */
export function recordingState(summary: RecordingSummary, running: boolean): string {
  if (summary.state === "running" || (running && isSummaryPending(summary))) return "rendering";
  if (summary.state === "unknown") return t("未知");
  return summary.state;
}
