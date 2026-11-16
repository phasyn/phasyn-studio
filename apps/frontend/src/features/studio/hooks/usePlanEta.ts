// Plan estimate for a list of segments, through the estimator in context (NO_ETA unless a provider supplies one).
// Estimators are asynchronous (a data-driven one may ask the backend), so results go through React Query: the key is
// the estimator id plus the plain inputs, stale answers for old inputs are dropped by the query cache. While new inputs
// are estimated (for example as a prompt is typed) the previous answer stays on screen instead of flickering away.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { qk } from "@/api/keys";
import { etaRisks, NO_ETA, planEta, type EtaMissing, type EtaRisks, type PlanEta, type SegmentEta, type SegmentEtaEstimator, type SegmentEtaInput } from "../model/eta";

export const SegmentEtaContext = createContext<SegmentEtaEstimator>(NO_ETA);

export interface SegmentEstimates {
  /** An estimator is working on the current inputs. */
  pending: boolean;
  /** One result per input (null = no estimate for it); undefined until the first answer, or without an estimator. */
  results: readonly (SegmentEta | null)[] | undefined;
}

/** Per-segment estimates of the estimator in context (shared cache: the same inputs are estimated once). */
export function useSegmentEstimates(segments: readonly SegmentEtaInput[]): SegmentEstimates {
  const estimator = useContext(SegmentEtaContext);
  const enabled = estimator !== NO_ETA && segments.length > 0;
  const query = useQuery({
    queryKey: qk.durationEstimate(estimator.id, segments),
    queryFn: ({ signal }) => estimator.estimate(segments, signal),
    enabled,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  return { pending: enabled && query.isFetching, results: enabled ? query.data : undefined };
}

export interface PlanEtaState {
  /** An estimator is working on the current inputs. */
  pending: boolean;
  /** Null = no estimate (no estimator data, or some segment has none or only a partial one). */
  eta: PlanEta | null;
  /** Memory risks of the segments that have an estimate (reported even when the plan as a whole has none). */
  risks: EtaRisks;
  /** Why there is no estimate (null while there is one, or while the first answer is pending). */
  missing: EtaMissing | null;
}

const NO_RISKS: EtaRisks = etaRisks([]);

/** Why a plan without an estimate has none: a partial segment (some step without a cost profile) or no data at all. */
function missingOf(results: readonly (SegmentEta | null)[] | undefined): EtaMissing {
  return results?.some((item) => item?.basis === "partial") ? "partial" : "none";
}

export function usePlanEta(segments: readonly SegmentEtaInput[]): PlanEtaState {
  const { pending, results } = useSegmentEstimates(segments);
  return useMemo(() => {
    const eta = results ? planEta(results) : null;
    return { pending, eta, risks: results ? etaRisks(results) : NO_RISKS, missing: eta || (pending && !results) ? null : missingOf(results) };
  }, [pending, results]);
}
