// 面板與徽章共用：以延遲的文字（useDeferredValue）分析，打字時不卡；stale＝分析的還是前一版文字。
// The rules come from the route of the shot being edited (Studio's selected shot; the advisor only edits that shot's
// prompt): the H3 checks run on H3 routes only, other routes get their own length rules (model/promptRules.ts).
// Outside the Studio provider the H3 rules apply, as before.
import { use, useDeferredValue, useMemo } from "react";
import { promptRulesFor } from "../../model/promptRules";
import { findRoute } from "../../model/routes";
import { StudioContext } from "../../studioContext";
import { analyzePrompt } from "./analyze";
import type { AnalyzeInput, Finding } from "./types";

export function useAdvisorFindings(input: AnalyzeInput): { findings: Finding[]; stale: boolean } {
  const text = useDeferredValue(input.text);
  const studio = use(StudioContext);
  const shot = studio?.project.shots.find((item) => item.shot_id === studio.selectedShotId) ?? null;
  const route = studio && shot ? findRoute(studio.engine.routes, shot.route) : null;
  const fps = studio ? studio.project.format.fps.num / studio.project.format.fps.den : Number.NaN;
  const rules = useMemo(() => input.rules ?? promptRulesFor(route, fps), [input.rules, route, fps]);
  const { mode, frames, references, library, firstFrame } = input;
  const findings = useMemo(() => analyzePrompt({ text, ...(mode === undefined ? {} : { mode }), frames, references, library, rules, ...(firstFrame === undefined ? {} : { firstFrame }) }), [text, mode, frames, references, library, rules, firstFrame]);
  return { findings, stale: text !== input.text };
}
