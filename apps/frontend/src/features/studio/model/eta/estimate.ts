// Turns the predicted work of a segment into time quantiles with this deployment's cost profiles (fitted by the
// controller from its own recordings): per step p10/p50/p90 seconds, the critical path (parallel branches take the
// longest, steps on the same Node and resource group run one after another), the total, a basis and memory risks.
// A step takes Σ(work × time per unit) over its stages, plus the profile's per-call overhead, the cold-start extra when
// it is the first call after a load and the load time when the component is not loaded.
// Pure. The interval bands are method policy (how far to trust few samples or a borrowed profile; see
// , section 9), not measured results; nothing here contains a measured time or throughput.
import type { StageWork } from "./h3Work";
import type { EtaBasis } from "./segment";
import { findStage, type ProfileFit, type StageFit } from "./wire";

/**
 * exact = fitted for this setup; similar = another setup of the same component on the same Node and device, borrowed
 * as an approximation (setup_differs: the current setup is known and has no profile; setup_unknown: the current setup
 * is not known and several were recorded, so the newest is used).
 */
export type ProfileMatch = { kind: "exact"; profile: ProfileFit } | { kind: "similar"; profile: ProfileFit; reason: "setup_differs" | "setup_unknown" } | { kind: "none" };

export interface ProfileTarget {
  nodeId: string;
  componentId: string;
  /** The component's device id; null／undefined = unknown (any device matches). */
  deviceId?: string | null;
  /** sha256 of the loaded component's effective load settings; unknown → only a sole setup counts as exact. */
  loadDigest?: string | null;
  sourceRevision?: string | null;
}

/** Fewer samples than this: a fixed band instead of the residual quantiles. */
export const FEW_SAMPLES = 5;
/** Up to this many samples the residual band is widened by (1 + 1/√n). */
export const WIDEN_UP_TO_SAMPLES = 20;
/** Band for few samples (and for the per-call overhead, which has no residual quantiles), ×p50. */
export const FEW_SAMPLES_BAND = { low: 0.85, high: 1.25 } as const;
/** Band for a profile borrowed from another setup of the same component (×p50). */
export const APPROX_BAND = { low: 0.5, high: 2 } as const;

const updatedAt = (fit: ProfileFit) => fit.updatedAt ?? fit.stages.reduce((latest, stage) => (stage.updatedAt > latest ? stage.updatedAt : latest), "");
const newest = (fits: readonly ProfileFit[]) => [...fits].sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)))[0];

/**
 * The profile fitted for this exact setup; otherwise the newest profile of another setup of the same component on the
 * same Node (and device when known), as an approximation; otherwise none. Profiles without a warm call are skipped.
 */
export function selectProfile(fits: readonly ProfileFit[], target: ProfileTarget): ProfileMatch {
  const same = fits.filter(
    (fit) => fit.samples > 0 && fit.nodeId === target.nodeId && fit.componentId === target.componentId && (target.deviceId == null || fit.deviceId == null || fit.deviceId === target.deviceId),
  );
  const borrowed = newest(same);
  if (!borrowed) return { kind: "none" };
  const revisionMatches = (fit: ProfileFit) => target.sourceRevision == null || fit.sourceRevision == null || fit.sourceRevision === target.sourceRevision;
  if (target.loadDigest != null) {
    const exact = newest(same.filter((fit) => fit.loadDigest === target.loadDigest && revisionMatches(fit)));
    return exact ? { kind: "exact", profile: exact } : { kind: "similar", profile: borrowed, reason: "setup_differs" };
  }
  if (same.length === 1) return revisionMatches(borrowed) ? { kind: "exact", profile: borrowed } : { kind: "similar", profile: borrowed, reason: "setup_differs" };
  return { kind: "similar", profile: borrowed, reason: "setup_unknown" };
}

export interface Quantiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface EstimateStep {
  stepId: string;
  nodeId: string;
  componentId: string;
  resourceGroup: string | null;
  /** Steps whose outputs this step consumes (unknown ids are ignored). */
  dependsOn: readonly string[];
  /** Modelled stages this step runs; empty = a fixed-cost step (only its profile's per-call overhead counts). */
  work: readonly StageWork[];
  profile: ProfileMatch;
  /** Ran since its last load; null／undefined = unknown (the cold extra then widens only p90). */
  warm?: boolean | null;
  /** False when the component still has to load (its load time is added). */
  loaded?: boolean;
}

export type EstimateNote =
  | { code: "NO_PROFILE"; stepId: string }
  | { code: "SETUP_DIFFERS" | "SETUP_UNKNOWN" | "COLD_FIT"; stepId: string }
  | { code: "STAGE_UNFITTED"; stepId: string; stage: string }
  | { code: "WORK_UNKNOWN"; stepId: string; stage: string }
  | { code: "OVERHEAD_UNKNOWN" | "LOAD_UNKNOWN" | "COLD_UNKNOWN"; stepId: string };

export interface EstimateRisk {
  /** OOM_RISK: at or above a size that ran out of memory; BEYOND_MEASURED: above every size that succeeded. */
  code: "OOM_RISK" | "BEYOND_MEASURED";
  stepId: string;
  componentId: string;
  stage: string;
  /** The predicted risk measure and its unit (H3 denoise: used rows, "row"). */
  measure: number;
  unit: string;
  maxSucceeded: number | null;
  minFailed: number | null;
}

export interface StepEstimate {
  stepId: string;
  /** Null when nothing of this step is known. */
  seconds: Quantiles | null;
  basis: EtaBasis;
  samples: number | null;
  /** p50 parts in seconds. */
  parts: { compute: number; overhead: number; cold: number; load: number } | null;
}

export interface Estimate {
  steps: StepEstimate[];
  /** Null when no step is known. With basis "partial" the total covers the known steps only (a lower bound). */
  total: Quantiles | null;
  /** Step ids on the longest p50 chain, in execution order. */
  criticalPath: string[];
  basis: EtaBasis;
  /** Fewest samples behind any known step. */
  samples: number | null;
  risks: EstimateRisk[];
  notes: EstimateNote[];
}

const ZERO: Quantiles = { p10: 0, p50: 0, p90: 0 };
const add = (a: Quantiles, b: Quantiles): Quantiles => ({ p10: a.p10 + b.p10, p50: a.p50 + b.p50, p90: a.p90 + b.p90 });
/** Element-wise maximum (ZERO for none). */
const maxOf = (items: readonly Quantiles[]): Quantiles => ({
  p10: Math.max(0, ...items.map((item) => item.p10)),
  p50: Math.max(0, ...items.map((item) => item.p50)),
  p90: Math.max(0, ...items.map((item) => item.p90)),
});
const scale = (p50: number, band: { low: number; high: number }): Quantiles => ({ p10: p50 * band.low, p50, p90: p50 * band.high });
const flat = (value: number): Quantiles => ({ p10: value, p50: value, p90: value });

/**
 * Band of one fitted stage (×p50): a borrowed profile and fewer than FEW_SAMPLES samples use fixed bands; otherwise the
 * leave-one-out residual quantiles, widened by (1 + 1/√n) up to WIDEN_UP_TO_SAMPLES samples.
 */
export function stageBand(stage: Pick<StageFit, "samples" | "residual">, kind: "exact" | "similar"): { low: number; high: number } {
  if (kind === "similar") return APPROX_BAND;
  if (stage.samples < FEW_SAMPLES || stage.residual === null) return FEW_SAMPLES_BAND;
  const widen = stage.samples <= WIDEN_UP_TO_SAMPLES ? 1 + 1 / Math.sqrt(stage.samples) : 1;
  return { low: Math.min(1, Math.exp(stage.residual.q10 * widen)), high: Math.max(1, Math.exp(stage.residual.q90 * widen)) };
}

/**
 * Compares a predicted risk measure with the stage's recorded limits (same unit only). A measure that includes an
 * estimate has a range: it is beyond every size that succeeded only when all of the range is (the estimate's own error
 * does not raise the warning, so a request that just succeeded is not flagged), and at risk of running out of memory as
 * soon as any of it reaches a size that failed (that call stays conservative).
 */
function riskOf(step: EstimateStep, work: StageWork, stage: StageFit): EstimateRisk | null {
  if (!work.risk || stage.risk?.unit !== work.risk.unit) return null;
  const { measure, unit, range } = work.risk;
  const { maxSucceeded, minFailed } = stage.risk;
  const base = { stepId: step.stepId, componentId: step.componentId, stage: stage.stage, measure, unit, maxSucceeded, minFailed };
  if (minFailed !== null && (range?.high ?? measure) >= minFailed) return { code: "OOM_RISK", ...base };
  if (maxSucceeded !== null && (range?.low ?? measure) > maxSucceeded) return { code: "BEYOND_MEASURED", ...base };
  return null;
}

/** One step's quantiles, basis, samples, risks and notes. */
export function estimateStep(step: EstimateStep): { estimate: StepEstimate; risks: EstimateRisk[]; notes: EstimateNote[] } {
  const notes: EstimateNote[] = [];
  const risks: EstimateRisk[] = [];
  const unknown = (): { estimate: StepEstimate; risks: EstimateRisk[]; notes: EstimateNote[] } => ({
    estimate: { stepId: step.stepId, seconds: null, basis: "unknown", samples: null, parts: null },
    risks,
    notes,
  });
  if (step.profile.kind === "none") {
    notes.push({ code: "NO_PROFILE", stepId: step.stepId });
    return unknown();
  }
  const match = step.profile;
  const fit = match.profile;
  if (match.kind === "similar") notes.push({ code: match.reason === "setup_unknown" ? "SETUP_UNKNOWN" : "SETUP_DIFFERS", stepId: step.stepId });
  // A fit from cold calls only (no warm call yet) is an approximation: the wide band, and no separate cold extra
  if (fit.coldFit) notes.push({ code: "COLD_FIT", stepId: step.stepId });
  const approximate = match.kind === "similar" || fit.coldFit;

  let compute = ZERO;
  let known = 0;
  let missing = 0;
  let samples: number | null = null;
  for (const work of step.work) {
    const stage = findStage(fit, work.stage, work.unit);
    if (!stage) {
      missing += 1;
      notes.push({ code: "STAGE_UNFITTED", stepId: step.stepId, stage: work.stage });
      continue;
    }
    const risk = riskOf(step, work, stage);
    if (risk) risks.push(risk);
    if (work.work === null) {
      missing += 1;
      notes.push({ code: "WORK_UNKNOWN", stepId: step.stepId, stage: work.stage });
      continue;
    }
    compute = add(compute, scale((work.work * stage.msPerUnit) / 1000, stageBand(stage, approximate ? "similar" : "exact")));
    known += 1;
    samples = samples === null ? stage.samples : Math.min(samples, stage.samples);
  }
  const fixedCost = step.work.length === 0;
  if (fixedCost ? fit.overheadMs === null : known === 0) {
    if (fixedCost) notes.push({ code: "OVERHEAD_UNKNOWN", stepId: step.stepId });
    return unknown();
  }
  if (fit.overheadMs === null) notes.push({ code: "OVERHEAD_UNKNOWN", stepId: step.stepId });
  // The per-call overhead has no residual quantiles: the fixed band (or the approximate one)
  const overhead = scale((fit.overheadMs ?? 0) / 1000, approximate ? APPROX_BAND : FEW_SAMPLES_BAND);
  if (fixedCost) samples = fit.samples;

  // Cold start: certain → every quantile; unknown → only p90; warm (or already in a cold-only fit) → nothing
  const cold = (fit.coldMs ?? 0) / 1000;
  const coldPart: Quantiles = step.warm === true || fit.coldFit ? ZERO : step.warm === false ? flat(cold) : { p10: 0, p50: 0, p90: cold };
  if (step.warm !== true && !fit.coldFit && fit.coldMs === null) notes.push({ code: "COLD_UNKNOWN", stepId: step.stepId });
  let load = 0;
  if (step.loaded === false) {
    if (fit.loadMs === null) notes.push({ code: "LOAD_UNKNOWN", stepId: step.stepId });
    else load = fit.loadMs / 1000;
  }
  const seconds = add(add(add(compute, overhead), coldPart), flat(load));
  const basis: EtaBasis = missing > 0 ? "partial" : approximate ? "approx" : "fitted";
  return {
    estimate: { stepId: step.stepId, seconds, basis, samples, parts: { compute: compute.p50, overhead: overhead.p50, cold: coldPart.p50, load } },
    risks,
    notes,
  };
}

/** Steps in dependency order (dependencies first; ids that are not steps are ignored; a cycle keeps the given order). */
function topological(steps: readonly EstimateStep[]): EstimateStep[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const out: EstimateStep[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (step: EstimateStep) => {
    if (state.has(step.stepId)) return;
    state.set(step.stepId, "visiting");
    for (const dep of step.dependsOn) {
      const next = byId.get(dep);
      if (next) visit(next);
    }
    state.set(step.stepId, "done");
    out.push(step);
  };
  steps.forEach(visit);
  return out;
}

const BASIS_ORDER: Record<EtaBasis, number> = { fitted: 0, approx: 1, partial: 2, unknown: 3 };

/** The whole segment: per-step estimates scheduled along dependencies and device lanes. */
export function estimateSteps(steps: readonly EstimateStep[]): Estimate {
  const results = new Map(steps.map((step) => [step.stepId, estimateStep(step)]));
  const finish = new Map<string, Quantiles>();
  const laneFree = new Map<string, { at: Quantiles; stepId: string }>();
  /** The step whose p50 finish decided this step's start (dependency or the previous step on the same lane). */
  const via = new Map<string, string | null>();
  for (const step of topological(steps)) {
    const duration = results.get(step.stepId)?.estimate.seconds ?? ZERO;
    const lane = `${step.nodeId}::${step.resourceGroup ?? `step:${step.stepId}`}`;
    const deps = step.dependsOn.flatMap((dep) => {
      const at = finish.get(dep);
      return at ? [{ at, stepId: dep }] : [];
    });
    const previous = laneFree.get(lane);
    const candidates = previous ? [...deps, previous] : deps;
    const start = maxOf(candidates.map((item) => item.at));
    const driver = candidates.reduce<{ at: Quantiles; stepId: string } | null>((best, item) => (!best || item.at.p50 > best.at.p50 ? item : best), null);
    via.set(step.stepId, driver?.stepId ?? null);
    const end = add(start, duration);
    finish.set(step.stepId, end);
    laneFree.set(lane, { at: end, stepId: step.stepId });
  }

  const estimates = steps.map((step) => results.get(step.stepId)?.estimate).filter((item): item is StepEstimate => item !== undefined);
  const known = estimates.filter((item) => item.seconds !== null);
  let last: string | null = null;
  let lastAt = -1;
  for (const [stepId, at] of finish) {
    if (at.p50 > lastAt) {
      lastAt = at.p50;
      last = stepId;
    }
  }
  const criticalPath: string[] = [];
  for (let at = last; at !== null && !criticalPath.includes(at); at = via.get(at) ?? null) criticalPath.unshift(at);
  const total = known.length === 0 ? null : maxOf([...finish.values()]);
  const worst = estimates.reduce<EtaBasis>((acc, item) => (BASIS_ORDER[item.basis] > BASIS_ORDER[acc] ? item.basis : acc), "fitted");
  const basis: EtaBasis = known.length === 0 ? "unknown" : worst === "unknown" ? "partial" : worst;
  const sampleCounts = known.flatMap((item) => (item.samples === null ? [] : [item.samples]));
  return {
    steps: estimates,
    total,
    criticalPath,
    basis,
    samples: sampleCounts.length > 0 ? Math.min(...sampleCounts) : null,
    risks: [...results.values()].flatMap((item) => item.risks),
    notes: [...results.values()].flatMap((item) => item.notes),
  };
}
