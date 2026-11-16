// The plugin items a new swap project uses, and their check against its segment prompts. By default the new project
// takes the current project's selection (a style is chosen once, in the 插件 tab, and every project made from it keeps
// it); the wizard can leave items out. The check is the render's own evaluation (applyPromptPlugins), so a selection
// that would block a segment is caught before the project is created. Pure.
import type { StudioProject } from "@/api/generated/contracts";
import { applyPromptPlugins, pluginBlockItems, type PluginRegistry } from "../model/promptPlugins";
import { newShot } from "../model/project";
import type { StudioRoute } from "../model/routes";

/** The references the new project gets: the wizard's own choice, else the current project's selection. */
export function swapPluginRefs(chosen: readonly string[] | null, project: Pick<StudioProject, "prompt_plugins">): string[] {
  return [...(chosen ?? project.prompt_plugins ?? [])];
}

/** What the wizard's last step shows about plugins. */
export interface SwapPluginsView {
  /** The current project's items, in its order, with their labels and packages. */
  items: readonly { ref: string; label: string; plugin: string }[];
  /** The references the new project gets. */
  refs: readonly string[];
  /** The first segment the selection blocks; null when every segment passes. */
  problem: { title: string; reasons: string[] } | null;
}

export interface SegmentCheckInput {
  title: string;
  prompt: string;
  frames: number;
}

/** The first segment the selection blocks, with every reason; null when all of them pass (or nothing is selected). */
export function swapPluginProblem(
  segments: readonly SegmentCheckInput[],
  refs: readonly string[],
  context: { project: StudioProject; route: StudioRoute | null },
  registry: PluginRegistry,
): { title: string; reasons: string[] } | null {
  if (refs.length === 0) return null;
  for (const segment of segments) {
    const shot = newShot(context.project, { prompt: segment.prompt, frames: segment.frames });
    const result = applyPromptPlugins(segment.prompt, refs, { project: context.project, shot, route: context.route }, registry);
    // Per-shot findings ([Shot N] viewpoint, negation, a subject no shot names) are what 逐鏡描述 fills in once the
    // project exists: the planner cannot see the viewpoint, so they block the render, not the creation
    const reasons = pluginBlockItems({ ...result, findings: result.findings.filter((finding) => finding.place === null) });
    if (reasons.length > 0) return { title: segment.title, reasons };
  }
  return null;
}
