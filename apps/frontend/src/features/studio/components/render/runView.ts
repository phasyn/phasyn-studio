// What the Render workspace shows of one run, worked out from the project, the run and its DiT views (pure). The
// running run's items come from the render activity (state from its steps, measured DiT share, estimated time left);
// a branch with nothing running or waiting right now (its early steps done, the GPU on another branch) shows as
// waiting, so only the item being worked on carries the generating frame. An ended run's items come from the project's
// takes, which the render tracker has already read back from the run (a branch whose steps were all skipped is not a
// success). Also: the first failure to act on, the shots that did not finish, the measured time of a step and the stage
// stepper with this workspace's time format.
import type { ApiErrorBody, StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { parseRunStep, type WireRun } from "@/api/types";
import type { StepperStep } from "@/components/workbench/Stepper";
import { elapsedMs } from "@/lib/time";
import { runBranchSuffixes, runStepIds, splitRunStepId } from "../../model/pipelines";
import { stepLabel, type BranchView, type ProviderLookup } from "../../model/progress";
import type { ActivityItemState, RenderActivity } from "../../model/renderActivity";
import { stageSteps, suffixOf, type QueueItem } from "../../model/renderQueue";
import { formatSpan } from "./time";
import { t } from "@/i18n";

/** One thing the run produces, as the overview shows it. */
export interface RunItem {
  /** The branch ("" or "_0", "_1"…). */
  suffix: string;
  shot: StudioShot | null;
  take: StudioTake | null;
  state: ActivityItemState;
  /** The branch's denoising, when the run has a DiT step for it. */
  dit: BranchView | null;
  /** What runs (or waits for resources) now in this branch when it is not the DiT, for example 「參考畫面編碼・執行中」. */
  stage: string | null;
  /** Estimated seconds left of this item (running render only); null = unknown. */
  remainingSeconds: number | null;
}

const TAKE_STATE: Record<StudioTake["state"], ActivityItemState> = {
  rendering: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

/** The step of a branch that runs or waits for resources now; null when none does. */
function activeStep(run: WireRun, suffix: string): { id: string; waiting: boolean } | null {
  const suffixes = runBranchSuffixes(run);
  for (const id of runStepIds(run)) {
    if (splitRunStepId(run, id, suffixes).suffix !== suffix) continue;
    const state = parseRunStep(id, run.steps[id]).state;
    if (state === "running" || state === "waiting") return { id, waiting: state === "waiting" };
  }
  return null;
}

/** What a running branch shows besides the DiT's own step count: the active step in words, and whether anything is active. */
function branchActivity(run: WireRun | undefined, suffix: string, lookup: ProviderLookup, dit: BranchView | null): { active: boolean; stage: string | null } {
  if (dit?.state === "running") return { active: true, stage: null };
  const step = run ? activeStep(run, suffix) : null;
  if (!run || !step) return { active: false, stage: null };
  const label = stepLabel(run, step.id, lookup);
  return { active: true, stage: step.waiting ? t("{stage}・等待資源", { stage: label }) : t("{stage}・執行中", { stage: label }) };
}

/** The items of the selected run (`live` is the render activity when this run is the one the project waits for). */
export function runItems(item: QueueItem, run: WireRun | undefined, live: RenderActivity | null, views: readonly BranchView[], lookup: ProviderLookup): RunItem[] {
  if (live) {
    return live.items.map((entry) => {
      const doing = entry.state === "running" ? branchActivity(run, entry.suffix, lookup, entry.dit) : null;
      return {
        suffix: entry.suffix,
        shot: entry.shot,
        take: entry.take,
        state: doing && !doing.active ? "waiting" : entry.state,
        dit: entry.dit,
        stage: doing?.stage ?? null,
        remainingSeconds: entry.remainingSeconds,
      };
    });
  }
  if (item.kind === "export") {
    const state = item.record ? TAKE_STATE[item.record.state] : "waiting";
    return [{ suffix: "", shot: null, take: null, state, dit: null, stage: state === "running" ? branchActivity(run, "", lookup, null).stage : null, remainingSeconds: null }];
  }
  return item.takes.map(({ shot, take }) => {
    const suffix = suffixOf(take);
    const dit = views.find((view) => view.suffix === suffix) ?? null;
    const state = TAKE_STATE[take.state];
    return { suffix, shot, take, state, dit, stage: state === "running" ? branchActivity(run, suffix, lookup, dit).stage : null, remainingSeconds: null };
  });
}

/** Measured time of one step (a running one up to `now`); null when it did not start or there is no clock. */
export function stepElapsed(run: WireRun, stepId: string, now: number | null): number | null {
  if (!(stepId in run.steps)) return null;
  const step = parseRunStep(stepId, run.steps[stepId]);
  return elapsedMs(step.started_at, step.finished_at, step.state === "running" ? now : null);
}

export interface RunFailure {
  /** The failed step (pipeline order) and its branch; null when the run failed outside any step. */
  stepId: string | null;
  suffix: string;
  /** The step's name from the one step table (STEP_ROLE_LABELS); null without a step. */
  stage: string | null;
  error: ApiErrorBody | null;
}

/** The first failure of a failed run: the first failed step in pipeline order, else the run's own error. */
export function runFailure(run: WireRun, lookup: ProviderLookup): RunFailure {
  const suffixes = runBranchSuffixes(run);
  for (const stepId of runStepIds(run)) {
    const step = parseRunStep(stepId, run.steps[stepId]);
    if (step.state !== "failed") continue;
    return { stepId, suffix: splitRunStepId(run, stepId, suffixes).suffix, stage: stepLabel(run, stepId, lookup, suffixes), error: step.error ?? run.error ?? null };
  }
  return { stepId: null, suffix: "", stage: null, error: run.error ?? null };
}

/** The project's shots of the items that ended without a video (failed, cancelled, interrupted), once each, in run order. */
export function unfinishedShots(items: readonly RunItem[], project: StudioProject): StudioShot[] {
  const ids = new Set(items.flatMap((entry) => (entry.shot && (entry.state === "failed" || entry.state === "cancelled" || entry.state === "interrupted") ? [entry.shot.shot_id] : [])));
  return project.shots.filter((shot) => ids.has(shot.shot_id)).sort((a, b) => order(items, a) - order(items, b));
}

function order(items: readonly RunItem[], shot: StudioShot): number {
  return items.findIndex((entry) => entry.shot?.shot_id === shot.shot_id);
}

const HALTED: ReadonlySet<StepperStep["state"]> = new Set(["cancelled", "interrupted", "skipped"]);

/**
 * The pipeline stages as stepper steps (model/renderQueue stageSteps). A single-branch run's step details are its
 * measured times, written in this workspace's format; the other details (「2／3」, a stopped state) stay as they are.
 */
export function stageStepperSteps(run: WireRun, lookup: ProviderLookup, now: number | null): StepperStep[] {
  const steps = stageSteps(run, lookup, now);
  if (runBranchSuffixes(run).length > 1) return steps;
  return steps.map((step) => {
    if (HALTED.has(step.state) || step.detail === undefined) return step;
    const ms = stepElapsed(run, step.id, now);
    return ms === null ? step : { ...step, detail: formatSpan(ms) };
  });
}
