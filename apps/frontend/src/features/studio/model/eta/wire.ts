// The only place that reads the cost-profile wire fields (GET /api/cost-profiles, contract CostProfileList): turns each
// profile into the estimator's own model and drops what it cannot use (an unknown work unit, a negative or non-finite
// time per unit, a stage without samples). A contract rename touches this file only.
import type { CostProfile, CostProfileList, CostProfileStage } from "@/api/generated/contracts";
import { WORK_UNITS, type WorkUnit } from "./stages";

/** Out-of-memory limits of a stage, compared in `unit` (null = the provider did not say). */
export interface StageRisk {
  unit: string | null;
  /** Largest measure that succeeded; null = none seen. */
  maxSucceeded: number | null;
  /** Smallest measure that ran out of memory (GPU_OOM／HOST_OOM); null = none seen. */
  minFailed: number | null;
}

/** One fitted (stage, work_unit) of a profile. */
export interface StageFit {
  stage: string;
  unit: WorkUnit;
  msPerUnit: number;
  /** Warm calls the fit is based on. */
  samples: number;
  /** Leave-one-out quantiles of log(actual / predicted); null with fewer than two samples. */
  residual: { q10: number; q90: number } | null;
  risk: StageRisk | null;
  updatedAt: string;
}

/** A cost profile: one (node, device, component, load settings, code revision) setup. */
export interface ProfileFit {
  nodeId: string;
  deviceId: string | null;
  componentId: string;
  providerId: string;
  loadDigest: string | null;
  sourceRevision: string | null;
  /** Median load time; null = no load recorded. */
  loadMs: number | null;
  /** Median of a warm call's wall time beyond its stages' compute; null = unknown. */
  overheadMs: number | null;
  /** What the first call after a load costs on top of a warm one; null = unknown. */
  coldMs: number | null;
  /** Calls behind the fit: the warm ones, or the cold ones when there is no warm call yet (see coldFit). */
  samples: number;
  /** Fitted from cold calls only (no warm call recorded yet): the first call's extra is already in it; approximate. */
  coldFit: boolean;
  /** Newest warm call; null when there is none. */
  updatedAt: string | null;
  stages: readonly StageFit[];
}

const UNITS = new Set<string>(WORK_UNITS);
const finite = (value: number | null): number | null => (value !== null && Number.isFinite(value) ? value : null);
const nonNegative = (value: number | null): number | null => {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
};

function stageFit(stage: CostProfileStage): StageFit | null {
  const msPerUnit = nonNegative(stage.theta_ms_per_unit);
  if (!UNITS.has(stage.work_unit) || msPerUnit === null || !(stage.samples >= 1)) return null;
  const q10 = finite(stage.residual_q10);
  const q90 = finite(stage.residual_q90);
  const maxSucceeded = nonNegative(stage.max_succeeded_risk);
  const minFailed = nonNegative(stage.min_failed_risk);
  return {
    stage: stage.stage,
    unit: stage.work_unit,
    msPerUnit,
    samples: stage.samples,
    residual: q10 !== null && q90 !== null ? { q10, q90 } : null,
    risk: maxSucceeded === null && minFailed === null ? null : { unit: stage.risk_unit, maxSucceeded, minFailed },
    updatedAt: stage.updated_at,
  };
}

export function profileFit(profile: CostProfile): ProfileFit {
  return {
    nodeId: profile.node_id,
    deviceId: profile.device_id,
    componentId: profile.component_id,
    providerId: profile.provider_id,
    loadDigest: profile.load_digest,
    sourceRevision: profile.source_revision,
    loadMs: nonNegative(profile.load_ms),
    overheadMs: nonNegative(profile.overhead_ms),
    coldMs: nonNegative(profile.cold_ms),
    samples: Math.max(0, profile.samples),
    coldFit: profile.warm_samples === 0 && profile.cold_samples > 0,
    updatedAt: profile.updated_at,
    stages: profile.stages.flatMap((stage) => stageFit(stage) ?? []),
  };
}

/** Every profile of these lists (for example one list per component). */
export function profileFits(lists: readonly CostProfileList[]): ProfileFit[] {
  return lists.flatMap((list) => list.items.map(profileFit));
}

/** The fit of one stage in one unit (the fitter's key); undefined when the profile has none. */
export function findStage(fit: ProfileFit, stage: string, unit: WorkUnit): StageFit | undefined {
  return fit.stages.find((item) => item.stage === stage && item.unit === unit);
}
