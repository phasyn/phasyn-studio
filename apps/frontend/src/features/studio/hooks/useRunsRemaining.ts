// Time left of running renders, converging on their finished steps (model/eta/runRemaining.ts): each run's branches
// are its takes in the project (one per output key, from the take's settings snapshot), estimated through the
// estimator in context. Runs are read from the cache the render tracker keeps fresh (no extra requests).
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { StudioTake } from "@/api/generated/contracts";
import { runQueryOptions } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { useNow } from "@/lib/time";
import { runRemaining, takeEtaInput, type BranchEta, type RunRemaining, type SegmentEtaInput } from "../model/eta";
import { branchSuffix } from "../model/pipelines";
import { findRoute } from "../model/routes";
import { useStudio } from "../studioContext";
import { useSegmentEstimates } from "./usePlanEta";

export interface RunsRemaining {
  /** Time left by run id; a run without data is absent. */
  byRun: ReadonlyMap<string, RunRemaining>;
  /** The clock the times are computed at; null before the first tick. */
  now: number | null;
  /** The first estimates are still being worked out (an unknown time left then means nothing yet). */
  pending: boolean;
}

const branchIndex = (take: StudioTake) => {
  const suffix = branchSuffix(take.output_key);
  return suffix ? Number(suffix.slice(1)) : 0;
};

const cached = (runs: readonly { data?: WireRun }[]) => runs.map((result) => result.data);

/**
 * `clock`: a caller that already ticks (a live run view) passes its own `now`, so there is one timer and one render per
 * second; without it the hook ticks by itself while a run is running.
 */
export function useRunsRemaining(runIds: readonly string[], clock?: number | null): RunsRemaining {
  const { project, engine } = useStudio();
  const runs = useQueries({ queries: runIds.map((runId) => ({ ...runQueryOptions(runId), enabled: false })), combine: cached });
  // Each run's branches: its takes, once per output key, in branch order (later ones on a route used before run warm)
  const plans = useMemo(
    () =>
      runIds.map((runId) => {
        const takes = new Map<string, StudioTake>();
        for (const shot of project.shots) for (const take of shot.takes) if (take.run_id === runId && !takes.has(take.output_key)) takes.set(take.output_key, take);
        const used = new Set<string>();
        return [...takes.values()]
          .sort((a, b) => branchIndex(a) - branchIndex(b))
          .map((take) => {
            const input = takeEtaInput(project, take, findRoute(engine.routes, take.route), used.has(take.route));
            used.add(take.route);
            return { suffix: branchSuffix(take.output_key), input };
          });
      }),
    [runIds, project, engine.routes],
  );
  const inputs = useMemo(() => plans.flat().flatMap((branch): SegmentEtaInput[] => (branch.input ? [branch.input] : [])), [plans]);
  const estimates = useSegmentEstimates(inputs);
  const results = estimates.results;
  const ownNow = useNow(clock === undefined && runs.some((run) => run?.state === "running"));
  const now = clock === undefined ? ownNow : clock;
  const byRun = useMemo(() => {
    const out = new Map<string, RunRemaining>();
    if (now === null) return out;
    let next = 0;
    runIds.forEach((runId, index) => {
      const run = runs[index];
      const branches = (plans[index] ?? []).map((branch): BranchEta => (branch.input ? { suffix: branch.suffix, eta: results?.[next++] ?? null } : { suffix: branch.suffix, eta: null, missing: "facts" }));
      if (run) out.set(runId, runRemaining(run, branches, now));
    });
    return out;
  }, [now, plans, results, runIds, runs]);
  return { byRun, now, pending: estimates.pending && results === undefined };
}
