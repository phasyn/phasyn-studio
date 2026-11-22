import type { WirePipeline } from "./types";

/** Include the origin and downstream steps reached through matching output ports. */
export function downstreamOf(pipeline: WirePipeline, origin: string, accepts?: (stepId: string, port: string) => boolean): Set<string> {
  const consumers = new Map<string, Set<string>>();
  for (const step of pipeline.steps) {
    for (const binding of Object.values(step.inputs)) {
      if (!("from_step" in binding) || (accepts && !accepts(binding.from_step, binding.output))) continue;
      const next = consumers.get(binding.from_step) ?? new Set<string>();
      next.add(step.step_id);
      consumers.set(binding.from_step, next);
    }
  }
  const reached = new Set([origin]);
  for (const step of reached) {
    for (const consumer of consumers.get(step) ?? []) reached.add(consumer);
  }
  return reached;
}
