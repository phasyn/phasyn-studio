// Time left of a running render, converging on what already happened: a finished step leaves nothing (its actual time
// is behind us), the running step leaves its estimate minus the time it has been running (never below 0), a step not
// started yet leaves its full estimate. Only the steps on each branch's critical path count (parallel steps overlap),
// and the branches of a batch run one after another. A branch that is unfinished and has no complete step estimate
// makes the run's time left unknown — never 0, and never a partial figure such as the DiT stage alone — and says why.
// Pure.
import { parseRunStep, type WireRun } from "@/api/types";
import { runBranchSuffixes, runStepIds, splitRunStepId } from "../pipelines";
import type { EtaMissing } from "./display";
import type { SegmentEta } from "./segment";

const ENDED: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "interrupted", "skipped"]);

/** One branch of the run ("" or "_0", "_1"…) and the estimate of the segment it renders; null = none. */
export interface BranchEta {
  suffix: string;
  eta: SegmentEta | null;
  /** Why `eta` is null when that is known (facts = the request's reference sizes or lengths are unknown); default none. */
  missing?: EtaMissing;
}

export interface RunRemaining {
  /** Seconds left of the whole run; null = unknown. */
  seconds: number | null;
  /** Why `seconds` is unknown (the first such branch's reason); null when it is known. */
  missing: EtaMissing | null;
  /** Seconds left of each branch, by suffix; null = unknown. */
  branches: ReadonlyMap<string, number | null>;
}

type BranchLeft = { seconds: number; missing: null } | { seconds: null; missing: EtaMissing };

const known = (seconds: number): BranchLeft => ({ seconds, missing: null });
const unknown = (missing: EtaMissing): BranchLeft => ({ seconds: null, missing });

function branchRemaining(run: WireRun, ids: readonly string[], suffixes: readonly string[], branch: BranchEta, nowMs: number): BranchLeft {
  const views = ids.filter((id) => splitRunStepId(run, id, suffixes).suffix === branch.suffix).map((id) => parseRunStep(id, run.steps[id]));
  if (views.length > 0 && views.every((view) => ENDED.has(view.state))) return known(0);
  const eta = branch.eta;
  if (!eta || eta.basis === "unknown") return unknown(eta ? "none" : (branch.missing ?? "none"));
  // A step without its own estimate leaves the branch without a complete one (as a partial estimate does)
  if (eta.basis === "partial" || !eta.steps || !eta.criticalPath || eta.criticalPath.length === 0) return unknown("partial");
  let left = 0;
  for (const base of eta.criticalPath) {
    const typical = eta.steps[base];
    if (typical === undefined) return unknown("partial");
    const id = `${base}${branch.suffix}`;
    const view = parseRunStep(id, run.steps[id]);
    if (ENDED.has(view.state)) continue;
    if (view.state !== "running") {
      left += typical;
      continue;
    }
    const started = view.started_at ? Date.parse(view.started_at) : Number.NaN;
    const ran = Number.isFinite(started) ? Math.max(0, nowMs - started) / 1000 : 0;
    left += Math.max(0, typical - ran);
  }
  return known(left);
}

/** Seconds left of `run` (and of each branch) from the branches' estimates and its steps' states at `nowMs`. */
export function runRemaining(run: WireRun, branches: readonly BranchEta[], nowMs: number): RunRemaining {
  const suffixes = runBranchSuffixes(run);
  const ids = runStepIds(run);
  const out = new Map<string, number | null>();
  let total: number | null = branches.length > 0 ? 0 : null;
  let missing: EtaMissing | null = branches.length > 0 ? null : "none";
  for (const branch of branches) {
    const left = branchRemaining(run, ids, suffixes, branch, nowMs);
    out.set(branch.suffix, left.seconds);
    if (left.seconds === null) missing ??= left.missing;
    total = total === null || left.seconds === null ? null : total + left.seconds;
  }
  return { seconds: total, missing: total === null ? (missing ?? "none") : null, branches: out };
}

/** When a render of a queue finishes: a moment (epoch ms), or none and the index of the first item without an estimate. */
export type QueueCompletion = { at: number; blockedBy: null } | { at: null; blockedBy: number };

/**
 * Completion moments of renders that run one after another (in the given order): each one's seconds left added to all
 * before it. An unknown entry makes it and every later one unknown — unknown is never counted as 0 — and each of those
 * names that entry (blockedBy: its own index, or an earlier one's).
 */
export function queueCompletion(remaining: readonly (number | null)[], nowMs: number): QueueCompletion[] {
  let total = 0;
  let blockedBy: number | null = null;
  return remaining.map((seconds, index): QueueCompletion => {
    if (blockedBy === null && seconds === null) blockedBy = index;
    if (blockedBy !== null) return { at: null, blockedBy };
    total += seconds ?? 0;
    return { at: nowMs + total * 1000, blockedBy: null };
  });
}
