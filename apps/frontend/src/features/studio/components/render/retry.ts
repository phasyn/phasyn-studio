// Why the shots a run did not finish cannot be rendered again right now, as one batch (the failure card's 「只重新渲染
// 失敗的 n 個」 and the stopped line's 「重新渲染未完成的 n 個」). The reasons are the ones the render buttons give
// (hooks/useRenderBlock.ts): an empty prompt, a shot that is rendering, another run on the Controller, an engine that
// cannot tell yet, a submission in flight. A route problem is reported by the render itself, as the project panel's
// batch render does. Pure.
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { engineBlock, renderDisabledReason } from "../../hooks/useRenderBlock";
import { shotStatus } from "../../model/project";
import { engineUnavailable, type Engine } from "../../model/routes";

export interface RetryContext {
  project: StudioProject;
  engine: Engine;
  runBlockedReason: string | null;
  busy: "render" | "export" | null;
}

export function retryDisabledReason(shots: readonly StudioShot[], context: RetryContext): string | null {
  const empty = shots.find((shot) => !shot.prompt.trim());
  const rendering = shots.find((shot) => shotStatus(shot, context.project) === "rendering");
  const problem =
    (empty ? t("「{title}」還沒有 prompt", { title: empty.title }) : null) ??
    (rendering ? t("「{title}」正在渲染", { title: rendering.title }) : null) ??
    context.runBlockedReason;
  return renderDisabledReason({ problem, preflight: engineBlock(engineUnavailable(context.engine)) }, context.busy);
}
