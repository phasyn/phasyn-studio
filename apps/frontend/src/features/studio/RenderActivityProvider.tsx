// Works out the render this project is waiting for, once for every workspace. The run is kept fresh by the render
// tracker; the DiT step events are polled here and only here while the run renders, and the time left ticks on one
// clock, so no reader of useRenderActivity polls or ticks by itself.
import { useMemo, type ReactNode } from "react";
import { useCachedRun } from "@/api/runs";
import { pendingRunIds } from "./hooks/useRenderTracker";
import { useRunProgress } from "./hooks/useRunProgress";
import { useRunsRemaining } from "./hooks/useRunsRemaining";
import { catalogLookup } from "./model/progress";
import { renderActivity } from "./model/renderActivity";
import { RenderActivityContext } from "./renderActivityContext";
import { useStudio } from "./studioContext";

const NO_RUNS: readonly string[] = [];

/** Mounted once inside the Studio provider. */
export function RenderActivityProvider({ children }: { children: ReactNode }) {
  const { project, activeRunIds, catalog } = useStudio();
  const lookup = useMemo(() => catalogLookup(catalog), [catalog]);
  // The Controller may execute several runs at once: the activity is the oldest running one this project waits for, so
  // it does not jump to a run started later; readers that show other runs (queue, run detail) poll those themselves
  const waitingFor = useMemo(() => pendingRunIds(project), [project]);
  const runId = activeRunIds.findLast((id) => waitingFor.includes(id)) ?? null;
  const cached = useCachedRun(runId).data;
  const run = runId !== null && cached?.state === "running" ? cached : undefined;
  const progress = useRunProgress(run, { poll: true, lookup });
  const runIds = useMemo(() => (runId !== null ? [runId] : NO_RUNS), [runId]);
  const clock = useRunsRemaining(runIds);
  const views = progress.views;
  const activity = useMemo(
    () => (run ? renderActivity(project, run, views, { remaining: clock.byRun.get(run.run_id) ?? null, estimating: clock.pending, now: clock.now }, lookup) : null),
    [project, run, views, clock, lookup],
  );
  return <RenderActivityContext.Provider value={activity}>{children}</RenderActivityContext.Provider>;
}
