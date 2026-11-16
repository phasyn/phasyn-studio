// Public entry of the Studio render-time estimator (named exports only).
export {
  ETA_RISK_DETAIL,
  ETA_RISK_LABEL,
  ETA_UNAVAILABLE,
  etaRisks,
  formatEta,
  NO_ETA,
  planEta,
  worseRisk,
  type EtaBasis,
  type EtaRisk,
  type EtaRisks,
  type PlanEta,
  type SegmentEta,
  type SegmentEtaEstimator,
  type SegmentEtaInput,
} from "./segment";
export { ROW_RISK_UNIT, STAGE_UNITS, WORK_UNITS, type CostStage, type H3Stage, type WorkUnit } from "./stages";
export {
  alignedFrames,
  approximateTextTokens,
  audioRows,
  ditFlopCoefficients,
  FACT_KEYS,
  H3_DEFAULTS,
  H3_DIT_SHAPE,
  H3_TE_SHAPE,
  h3Work,
  latentFrames,
  preparedImage,
  qwenResize,
  referenceVideoCanvas,
  resolveH3Constants,
  rowsPerFrame,
  teFlopCoefficients,
  type ConstantsSource,
  type H3Constants,
  type H3SegmentRequest,
  type H3Task,
  type H3Work,
  type StageWork,
} from "./h3Work";
export { findStage, profileFit, profileFits, type ProfileFit, type StageFit, type StageRisk } from "./wire";
export {
  APPROX_BAND,
  estimateStep,
  estimateSteps,
  FEW_SAMPLES,
  FEW_SAMPLES_BAND,
  selectProfile,
  stageBand,
  WIDEN_UP_TO_SAMPLES,
  type Estimate,
  type EstimateNote,
  type EstimateRisk,
  type EstimateStep,
  type ProfileMatch,
  type ProfileTarget,
  type Quantiles,
  type StepEstimate,
} from "./estimate";
export { estimateSegment, etaRoute, PROVIDER_STAGES, profileEstimator, segmentRequest, toSegmentEta, type EtaRoute, type EtaRouteStep } from "./profileEstimator";
export { completionText, formatEtaClock, missingEtaDetail, missingEtaReason, missingEtaText, planEtaText, segmentEtaText, type EtaMissing } from "./display";
export { shotEtaInput, shotsEtaInputs, takeEtaInput } from "./studioInputs";
export { queueCompletion, runRemaining, type BranchEta, type QueueCompletion, type RunRemaining } from "./runRemaining";
