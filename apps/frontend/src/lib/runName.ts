// What a run is called in the UI, one rule for every place that names it (run list and its selection checkboxes and
// delete dialog, records tree, run page, activity log): the run's label, else its pipeline's label, else "run" and the
// short run id.
import type { RunRequestBody, WireRun } from "@/api/types";
import { shortId } from "./format";

/** The parts of a run its name is built from. */
export interface NamedRun {
  run_id: WireRun["run_id"];
  request: Pick<RunRequestBody, "label"> & { pipeline: Pick<RunRequestBody["pipeline"], "label"> };
}

/** A run known only by its id: `run` and the first 8 characters of the id. */
export function runIdName(runId: string): string {
  return `run ${shortId(runId)}`;
}

/** The run's own label, else its pipeline's label (blank ones skipped); "" when neither has text. */
function givenName(run: NamedRun): string {
  return ((run.request.label?.trim()) ?? "") || run.request.pipeline.label.trim();
}

/** The name the UI shows for a run. */
export function runDisplayName(run: NamedRun): string {
  return givenName(run) || runIdName(run.run_id);
}

/**
 * The run's name followed by its short id, for text that has to tell runs apart (the accessible name of a per-run
 * control, a destructive confirmation): many runs share a label or a pipeline. A run named by its id carries it once.
 */
export function runDisplayNameWithId(run: NamedRun): string {
  const name = givenName(run);
  return name ? `${name} ${shortId(run.run_id)}` : runIdName(run.run_id);
}
