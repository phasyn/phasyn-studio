// The prompt and duration rules of the route a shot renders on (providerTraits.PromptRules): the H3 rules on H3 routes
// (and while the route is unknown, as before), the producer's own frame limits on declared routes, and no length at
// all on media-driven routes. The prompt advisor reads these, so its H3 checks only run where H3 renders. Pure.
import { H3_RULES, h3Rules, type PromptRules } from "./providerTraits";
import type { StudioRoute } from "./routes";
import { frameLimits } from "./studioGenerationBinding";

/** The frame rate a shot's length is counted in on its route (H3: 24 fps; other routes: the project's). */
export function shotFps(route: StudioRoute | null, project: { format: { fps: { num: number; den: number } } }): number {
  return promptRulesFor(route, project.format.fps.num / project.format.fps.den).fps;
}

export function promptRulesFor(route: StudioRoute | null, projectFps: number): PromptRules {
  if (!route || route.family === "h3") {
    const rules = h3Rules(route?.steps.find((item) => item.step.step_id === route.ditStepId)?.slot.component?.facts);
    return { h3: true, fps: rules.fps, frames: { min: rules.minFrames, max: rules.maxFrames }, apiPromptCharacters: H3_RULES.apiPromptCharacters };
  }
  const fps = Number.isFinite(projectFps) && projectFps > 0 ? projectFps : H3_RULES.fps;
  if (route.family === "creative") return { h3: false, fps, frames: null, apiPromptCharacters: null };
  const limits = frameLimits([route]);
  return { h3: false, fps, frames: { min: limits.min, max: limits.max }, apiPromptCharacters: null };
}
