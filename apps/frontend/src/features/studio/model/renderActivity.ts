// The render a project is waiting for, as every workspace shows it: what the running run renders (its shots in the
// order they are rendered, or an export or a proxy), how far each item is, and the progress of the whole run. Three
// kinds of figure are kept apart, as everywhere in the Studio: counted (steps and items finished), measured (the DiT's
// denoising steps, only with step evidence) and estimated (time left from the cost profiles, with the reason when
// there is none). Pure; RenderActivityProvider feeds it and renderActivityContext.ts hands it out.
import type { StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { runSteps, type RunStepView, type WireRun } from "@/api/types";
import { isoToMs } from "@/lib/time";
import { t } from "@/i18n";
import type { RunRemaining } from "./eta";
import { branchSuffix, runBranchSuffixes, splitRunStepId } from "./pipelines";
import { runActivity, type BranchView, type ProviderLookup } from "./progress";

/** What the run produces for this project. */
export type ActivityKind = "render" | "export" | "proxy";

export type ActivityItemState = "waiting" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** One thing the run produces: a take of a shot (one per branch of a batch or of variations), or the export itself. */
export interface ActivityItem {
  /** The run's branch: "" for a single render, "_0", "_1"… in a batch. */
  suffix: string;
  /** The shot and the take this branch renders; null for an export, a proxy, or a take that left the project. */
  shot: StudioShot | null;
  take: StudioTake | null;
  state: ActivityItemState;
  /** The branch's denoising, when the run has a DiT step for it. */
  dit: BranchView | null;
  /** Measured share of the denoising that is done (0–1); null without step evidence. */
  fraction: number | null;
  /** Estimated seconds left of this item; null = unknown. */
  remainingSeconds: number | null;
}

export interface RenderActivity {
  run: WireRun;
  kind: ActivityKind;
  /** The items are variations of one shot (several seeds) instead of several shots. */
  variations: boolean;
  items: ActivityItem[];
  /** Items that ended (in any way) and all of them. */
  finished: number;
  total: number;
  /** The item being worked on now; null between items. */
  current: ActivityItem | null;
  /** Steps of the run that ended well and all of them (counted). */
  stepsDone: number;
  stepsTotal: number;
  /** What the run is doing now in one line, for example 「鏡頭 2／3・DiT 第 5／8 步」; "" when nothing is running. */
  text: string;
  /** Estimated time left of the whole run and why it may be unknown. */
  remaining: RunRemaining | null;
  /** The first estimate is still being worked out: an unknown time left means nothing yet. */
  estimating: boolean;
  /** The clock `remaining` was computed at (epoch ms); null before the first tick. */
  now: number | null;
  /** Milliseconds since the run was created; null before the first tick. */
  elapsedMs: number | null;
  /**
   * Estimated share of the run's time that is behind us: elapsed ÷ (elapsed + estimated time left), 0–1. An estimate,
   * never a measurement; null when the time left is unknown.
   */
  elapsedShare: number | null;
}

const ENDED_WELL: ReadonlySet<RunStepView["state"]> = new Set(["succeeded", "skipped"]);

/**
 * The state of a branch from its steps: a failure, a cancellation or an interruption of any step is the branch's; a
 * branch whose steps were all skipped will not be rendered (the run stopped for another reason) and counts as
 * interrupted. A branch runs only while one of its steps runs: in a batch the first steps of later branches run ahead
 * (preparation overlaps), and such a branch is still waiting for its DiT.
 */
function branchState(steps: readonly RunStepView[]): ActivityItemState {
  for (const state of ["failed", "cancelled", "interrupted"] as const) if (steps.some((step) => step.state === state)) return state;
  if (steps.length > 0 && steps.every((step) => step.state === "skipped")) return "interrupted";
  if (steps.length > 0 && steps.every((step) => ENDED_WELL.has(step.state))) return "succeeded";
  return steps.some((step) => step.state === "running") ? "running" : "waiting";
}

function kindOf(project: StudioProject, runId: string): ActivityKind {
  if (project.shots.some((shot) => shot.takes.some((take) => take.run_id === runId))) return "render";
  return project.exports.some((record) => record.run_id === runId) ? "export" : "proxy";
}

/** The project's takes of this run by branch (the first take of each output key). */
function takesByBranch(project: StudioProject, runId: string): Map<string, { shot: StudioShot; take: StudioTake }> {
  const found = new Map<string, { shot: StudioShot; take: StudioTake }>();
  for (const shot of project.shots) {
    for (const take of shot.takes) {
      const suffix = branchSuffix(take.output_key);
      if (take.run_id === runId && !found.has(suffix)) found.set(suffix, { shot, take });
    }
  }
  return found;
}

export interface ActivityClock {
  remaining: RunRemaining | null;
  estimating: boolean;
  now: number | null;
}

/** The activity of `run` for `project`: `views` are the run's DiT branches, `clock` its estimated time left. */
export function renderActivity(project: StudioProject, run: WireRun, views: readonly BranchView[], clock: ActivityClock, lookup?: ProviderLookup): RenderActivity {
  const kind = kindOf(project, run.run_id);
  const suffixes = runBranchSuffixes(run);
  const steps = runSteps(run);
  const takes = takesByBranch(project, run.run_id);
  const items = (suffixes.length > 0 ? suffixes : [""]).map((suffix): ActivityItem => {
    const own = steps.filter((step) => splitRunStepId(run, step.step_id, suffixes).suffix === suffix);
    const dit = views.find((view) => view.suffix === suffix) ?? null;
    const owner = takes.get(suffix);
    return {
      suffix,
      shot: owner?.shot ?? null,
      take: owner?.take ?? null,
      state: branchState(own),
      dit,
      fraction: dit?.state === "running" ? dit.progress.fraction : null,
      remainingSeconds: clock.remaining?.branches.get(suffix) ?? null,
    };
  });
  const shotIds = new Set(items.map((item) => item.shot?.shot_id ?? null));
  const variations = kind === "render" && items.length > 1 && shotIds.size === 1 && !shotIds.has(null);
  // The noun only shows for a run with several branches, which is a batch of shots or the variations of one
  const counted = runActivity(run, views, variations ? t("變體") : t("鏡頭"), lookup);
  const started = isoToMs(run.created_at);
  const elapsedMs = clock.now !== null && started !== null ? Math.max(0, clock.now - started) : null;
  const left = clock.remaining?.seconds ?? null;
  return {
    run,
    kind,
    variations,
    items,
    finished: items.filter((item) => item.state !== "waiting" && item.state !== "running").length,
    total: items.length,
    current: items.find((item) => item.state === "running") ?? null,
    stepsDone: counted.done,
    stepsTotal: counted.total,
    text: counted.text,
    remaining: clock.remaining,
    estimating: clock.estimating,
    now: clock.now,
    elapsedMs,
    elapsedShare: elapsedMs !== null && left !== null && elapsedMs + left * 1000 > 0 ? elapsedMs / (elapsedMs + left * 1000) : null,
  };
}
