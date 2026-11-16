// The render-time estimate of shots about to be rendered together (one shot, variations of a shot, or a batch): their
// estimator inputs as they would render now, through the estimator in context. When a shot cannot be estimated (no
// route, unknown reference sizes or lengths) there is no estimate at all — never a partial sum.
import { useMemo } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { etaRisks, shotsEtaInputs, type SegmentEtaInput } from "../model/eta";
import { useStudio } from "../studioContext";
import { usePlanEta, type PlanEtaState } from "./usePlanEta";

const NONE: readonly SegmentEtaInput[] = [];

export function useRenderEta(shots: readonly StudioShot[]): PlanEtaState {
  const { project, engine } = useStudio();
  const inputs = useMemo(() => shotsEtaInputs(project, shots, engine.routes), [project, shots, engine.routes]);
  const complete = inputs.every((input): input is SegmentEtaInput => input !== null);
  const state = usePlanEta(complete ? inputs : NONE);
  return complete ? state : { pending: false, eta: null, risks: etaRisks([]), missing: "facts" };
}
