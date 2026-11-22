// Which of the conform tab's edits to recommend (pure): the cut plan (conform.ts), the motion retime (retime.ts) or the
// whole-clip shift (sync.ts). The retime is preferred on action clips; the cut plan only where cuts dominate; the shift
// is never recommended on the gray-difference curve alone. No two edits are ever chained.
// The rule (the original "still": its motion p90 under the speed-feel tool's ORIGINAL_MOVES_P90):
// 1. a still original without a cut (nor a take's early switch at the clip's end) → nothing to adjust;
// 2. a still original with cuts → the cut plan;
// 3. an action clip → the retime;
// 4. the shift only as a fallback: shown when the retime is refused and the shift keeps the on-time cuts, never
//    recommended.
// A recommended edit that would make the take worse (the cut plan losing on-time cuts; the retime losing on-time cuts
// or lowering the motion correlation by more than 0.05 at the 2 decimals shown) is not recommended: timing cannot fix
// that take. (A retime that follows the motion better but moves cuts off time — correlation 0.77, on-time cuts 4/6 →
// 2/6 on one measured take — is a take whose cuts already fit: leave it.)
// Every edit is scored the same way:
// - on-time cuts: the matched cuts within ±3 frames now (cuts.ts timing) and as the edited clip plays (retimedTiming), a
//   take's early switch at the clip's end counted as one cut more, on time when it shows within 3 frames of the end or
//   not at all;
// - motion: the correlation of the take's motion, played through the edit's frames (a repeat adds no motion, a dropped
//   frame the two-frame difference, frames that were not read are left out), with the original's.
import type { StudioTimeline } from "@/api/generated/contracts";
import type { ConformPlanResult } from "./conform";
import { endSwitchCut, ON_TIME_FRAMES, retimedTiming, type ConformAnalysis, type CutTiming } from "./cuts";
import { measureRetime, planRetime, retimeZone, type RetimePlanResult } from "./retime";
import { correlation, planSync, type MotionSync, type SyncPlanResult } from "./sync";

export type ConformMethod = "cut" | "retime" | "shift";

export interface MethodScore {
  /** On-time cuts now and after the edit (an early switch at the clip's end counted as a cut). */
  onTime: { before: number; after: number };
  /** Correlation of the take's motion with the original's now and after the edit; null where it cannot be measured. */
  motion: { before: number | null; after: number | null };
  /** The cut timing as the edited clip plays it. */
  timing: CutTiming;
}

export type Recommendation =
  | { kind: "method"; method: "cut" | "retime" }
  /** still: nothing to adjust; synced: the take already follows the original; worse: the edit would make it worse; unavailable: it cannot be made. */
  | { kind: "none"; why: "still" | "synced" | "worse" | "unavailable" };

/** How far the motion correlation may drop, in the hundredths the tab shows, before an edit makes the take worse. */
const MOTION_TOLERANCE = 5;
/** A correlation in the hundredths the tab shows (conformView formatCorrelation), to compare drops exactly. */
const hundredths = (value: number) => Math.round(value * 100);

/** The correlation of the take's motion as `mapping` plays it (entry k: from clip frame k to k + 1) with the original's. */
export function mappedCorrelation(analysis: Pick<ConformAnalysis, "originalMotion" | "takeMotion" | "takeMotion2">, mapping: readonly number[]): number | null {
  const original: number[] = [];
  const take: number[] = [];
  for (let offset = 0; offset + 1 < mapping.length && offset < analysis.originalMotion.length; offset += 1) {
    const from = mapping[offset] ?? -1;
    const to = mapping[offset + 1] ?? -1;
    // Frames before the clip's first one or past the last one read have no measured motion
    if (from < 0 || to < from || to > analysis.takeMotion.length) continue;
    let moved = 0;
    if (to - from === 2 && analysis.takeMotion2[from] !== undefined) moved = analysis.takeMotion2[from] ?? 0;
    else for (let frame = from; frame < to; frame += 1) moved += analysis.takeMotion[frame] ?? 0;
    original.push(analysis.originalMotion[offset] ?? 0);
    take.push(moved);
  }
  return correlation(original, take);
}

/** The early switch at the clip's end as an on-time cut (1) or not (0) as `mapping` plays the take. */
function endOnTime(analysis: ConformAnalysis, mapping: readonly number[]): number {
  const switched = endSwitchCut(analysis);
  if (switched === null) return 0;
  const shows = mapping.findIndex((frame) => frame >= switched);
  return shows < 0 || analysis.length - shows <= ON_TIME_FRAMES ? 1 : 0;
}

/** The scores of an edit that plays `mapping` (entry k: the take frame clip frame k shows). */
export function methodScore(analysis: ConformAnalysis, mapping: readonly number[]): MethodScore {
  const now = Array.from({ length: analysis.length }, (_, offset) => offset);
  const timing = retimedTiming(analysis, mapping);
  return {
    onTime: { before: analysis.timing.onTime + endOnTime(analysis, now), after: timing.onTime + endOnTime(analysis, mapping) },
    motion: { before: mappedCorrelation(analysis, now), after: mappedCorrelation(analysis, mapping) },
    timing,
  };
}

export interface ChoiceInput {
  analysis: ConformAnalysis;
  /** The original barely moves (sync.ts MotionSync.still). */
  still: boolean;
  /** The scores of the edits that can be made (null: it cannot). */
  cut: MethodScore | null;
  retime: MethodScore | null;
  /** The retime found the take already in step. */
  retimeSettled: boolean;
}

/** The edit to recommend (the rule in the header). */
export function recommend({ analysis, still, cut, retime, retimeSettled }: ChoiceInput): Recommendation {
  if (still) {
    if (analysis.originalCuts.length === 0 && endSwitchCut(analysis) === null) return { kind: "none", why: "still" };
    if (!cut) return { kind: "none", why: "unavailable" };
    return cut.onTime.after < cut.onTime.before ? { kind: "none", why: "worse" } : { kind: "method", method: "cut" };
  }
  if (retime) {
    const { before, after } = retime.motion;
    const lowered = before !== null && after !== null && hundredths(after) < hundredths(before) - MOTION_TOLERANCE;
    const cutsLost = retime.onTime.after < retime.onTime.before;
    return lowered || cutsLost ? { kind: "none", why: "worse" } : { kind: "method", method: "retime" };
  }
  return { kind: "none", why: retimeSettled ? "synced" : "unavailable" };
}

/** Whether the shift is shown: the retime was refused (not settled) and the shift keeps the on-time cuts. */
export function shiftShown(still: boolean, retimeRefused: boolean, shift: MethodScore | null): boolean {
  return !still && retimeRefused && shift !== null && shift.onTime.after >= shift.onTime.before;
}

export interface ConformOptions {
  still: boolean;
  /** Each edit's plan (null where it is not offered) and the scores of those that can be made. */
  cut: ConformPlanResult | null;
  retime: RetimePlanResult | null;
  shift: SyncPlanResult | null;
  scores: Record<ConformMethod, MethodScore | null>;
  recommendation: Recommendation;
  /** The edits the tab lists, in order: the retime on an action clip, the cut plan unless it has nothing to do, the shift as the fallback. */
  listed: ConformMethod[];
}

export interface OptionsInput {
  timeline: StudioTimeline;
  clipId: string;
  analysis: ConformAnalysis;
  sync: MotionSync;
  /** The cut plan (conform.ts planConform). */
  cut: ConformPlanResult | null;
}

/** Every edit the conform tab offers for the clip, planned and scored, with the recommendation. */
export function conformOptions({ timeline, clipId, analysis, sync, cut }: OptionsInput): ConformOptions {
  const { still } = sync;
  const { length } = analysis;
  // The retime's repeats and drops stay off the clip's transitions, fades and impact frames, where it cannot split
  const zone = retimeZone(timeline, clipId);
  const measure = still ? null : measureRetime(analysis, (k) => zone(k) === null);
  const retime = measure ? planRetime({ timeline, clipId, length, measure }) : null;
  const retimeRefused = retime !== null && !retime.ok && !retime.settled;
  // The shift is only ever the retime's fallback
  const shift = retimeRefused && sync.offered !== null ? planSync({ timeline, clipId, length, lag: sync.offered }) : null;
  const scores: Record<ConformMethod, MethodScore | null> = {
    cut: (cut?.ok === true) ? methodScore(analysis, cut.plan.mapping) : null,
    retime: (retime?.ok === true) ? methodScore(analysis, retime.plan.mapping) : null,
    shift: (shift?.ok === true) ? methodScore(analysis, shift.plan.mapping) : null,
  };
  const retimeSettled = retime !== null && !retime.ok && retime.settled;
  const recommendation = recommend({ analysis, still, cut: scores.cut, retime: scores.retime, retimeSettled });
  const listed: ConformMethod[] = [];
  if (retime) listed.push("retime");
  if (cut && (cut.ok || !cut.settled)) listed.push("cut");
  if (shiftShown(still, retimeRefused, scores.shift)) listed.push("shift");
  return { still, cut, retime, shift, scores, recommendation, listed };
}

/** The listed edits that can be made. */
export function readyMethods(options: ConformOptions): ConformMethod[] {
  return options.listed.filter((method) => options.scores[method] !== null);
}

/** The edit the tab applies: the one chosen when it can be made, else the recommended one. */
export function chosenMethod(options: ConformOptions, choice: ConformMethod | null): ConformMethod | null {
  if (choice !== null && readyMethods(options).includes(choice)) return choice;
  return options.recommendation.kind === "method" ? options.recommendation.method : null;
}
