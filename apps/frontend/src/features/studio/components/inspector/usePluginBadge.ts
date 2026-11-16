// What the Prompt tab's plugin badge says about the shot: the same judgement the render planning makes
// (applyPromptPlugins with the shot's route, the lane route when DiT lanes are chosen), so the badge agrees with what
// blocks the render. Rule findings are about the text: while the prompt is still empty they are not counted (nothing has
// been written yet); problems with the selection or the generation settings are counted at once.
import { useMemo } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { useProjectLanes } from "../../model/lanePrefs";
import { laneRouteFor } from "../../model/lanes";
import { applyPromptPlugins, pluginBlockItems } from "../../model/promptPlugins";
import { findRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";

export interface PluginBadgeState {
  /** Plugin items the project uses. */
  count: number;
  /** loading: the registry is still being read; empty: the prompt is empty (rules wait); ok / fail: checked. */
  state: "loading" | "empty" | "ok" | "fail";
  /** What does not hold (0 unless fail). */
  failed: number;
  /** Problems with the selection or the generation settings (counted even while the prompt is empty). */
  problems: readonly string[];
  /** Everything counted in `failed`, one sentence each (the professional editor's status line lists them). */
  reasons: readonly string[];
  /** Changes whenever the badge would show something else. */
  key: string;
}

/** The badge state; null when the project uses no plugin items (no badge). */
export function usePluginBadge(shot: StudioShot): PluginBadgeState | null {
  const { project, plugins, engine } = useStudio();
  const lanes = useProjectLanes(project.project_id);
  return useMemo((): PluginBadgeState | null => {
    const count = project.prompt_plugins?.length ?? 0;
    if (count === 0) return null;
    if (plugins.status === "loading") return { count, state: "loading", failed: 0, problems: [], reasons: [], key: `${count}|loading` };
    const route = findRoute(engine.routes, laneRouteFor(engine.routes, lanes, shot));
    const result = applyPromptPlugins(shot.prompt, project.prompt_plugins, { project, shot, route }, plugins);
    const typed = shot.prompt.trim() !== "";
    const failed = result.problems.length + (typed ? result.findings.length : 0);
    const state = failed > 0 ? "fail" : typed ? "ok" : "empty";
    const reasons = typed ? pluginBlockItems(result) : result.problems;
    return { count, state, failed, problems: result.problems, reasons, key: `${count}|${state}|${failed}` };
  }, [project, plugins, engine.routes, lanes, shot]);
}
