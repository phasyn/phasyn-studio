// What a take that renders is doing now and when it is expected to finish, from the render this project waits for
// (renderActivityContext) and, before that is known, the take's own cached run. Counted, measured and estimated figures
// stay apart: the stage is counted (steps), the DiT share is measured (step evidence only), the time left is an estimate
// and says why when there is none. Pure.
import type { StudioTake } from "@/api/generated/contracts";
import { runSteps } from "@/api/types";
import { t } from "@/i18n";
import { missingEtaDetail, missingEtaReason, queueCompletion } from "../../model/eta";
import { runBranchSuffixes, splitRunStepId } from "../../model/pipelines";
import { componentLoadText, progressHeadline, stepLabel, stepsComponentLoad, type ProviderLookup } from "../../model/progress";
import type { ActivityItem, RenderActivity } from "../../model/renderActivity";
import { TAKE_END_LABELS } from "./monitorTakes";
import type { TakeRender } from "./useTakeRender";

/** The activity's item that renders `take`; null when the activity is another run's or not known yet. */
export function activityItem(activity: RenderActivity | null, take: StudioTake): ActivityItem | null {
  return activity?.items.find((item) => item.take?.take_id === take.take_id) ?? null;
}

function runningStepLabel(activity: RenderActivity, item: ActivityItem, lookup: ProviderLookup): string | null {
  const run = activity.run;
  const suffixes = runBranchSuffixes(run);
  const step = runSteps(run).find((view) => view.state === "running" && splitRunStepId(run, view.step_id, suffixes).suffix === item.suffix);
  return step ? stepLabel(run, step.step_id, lookup, suffixes) : null;
}

/** A branch that waits (to start, or between two of its steps): how many branches before it are not done yet. */
function waitingStage(activity: RenderActivity, item: ActivityItem, compact: boolean): string {
  const before = activity.items.slice(0, activity.items.indexOf(item));
  const ahead = before.filter((entry) => entry.state === "waiting" || entry.state === "running").length;
  return compact || ahead === 0 ? t("等待中") : t("等待中・前面還有 {count} 個", { count: ahead });
}

/** The component of the item's branch that loads on use right now (「載入模型中」), if any. */
function itemLoad(activity: RenderActivity, item: ActivityItem): string | null {
  const run = activity.run;
  const suffixes = runBranchSuffixes(run);
  const load = stepsComponentLoad(runSteps(run).filter((view) => splitRunStepId(run, view.step_id, suffixes).suffix === item.suffix));
  return load ? componentLoadText(load) : null;
}

function itemStage(activity: RenderActivity, item: ActivityItem, lookup: ProviderLookup, compact: boolean): string {
  const load = item.state === "running" || item.state === "waiting" ? itemLoad(activity, item) : null;
  if (load !== null) return load;
  switch (item.state) {
    case "running": {
      if (item.dit?.state === "running") return `DiT ${progressHeadline(item.dit)}`;
      const label = runningStepLabel(activity, item, lookup);
      return (label != null && label !== "") ? t("{suffix}{stepLabel}執行中", { suffix: "", stepLabel: label }) : waitingStage(activity, item, compact);
    }
    case "waiting":
      return waitingStage(activity, item, compact);
    case "succeeded":
      return t("完成，正在讀回結果");
    case "cancelled":
    case "failed":
    case "interrupted":
    default:
      return TAKE_END_LABELS[item.state] ?? item.state;
  }
}

/**
 * One line about the render of `take`: 「鏡頭 2／3・DiT 第 3／8 步」 (compact: without the batch prefix and the queue
 * position, for a take card). Before the run is read it says so; it never guesses a step.
 */
export function renderStage(take: StudioTake, activity: RenderActivity | null, live: TakeRender, compact = false): string {
  const item = activityItem(activity, take);
  if (activity && item) {
    const index = activity.items.indexOf(item);
    const noun = activity.variations ? t("變體") : t("鏡頭");
    const prefix = !compact && activity.total > 1 ? t("{noun} {index}／{branches}・", { noun, index: index + 1, branches: activity.total }) : "";
    return `${prefix}${itemStage(activity, item, live.lookup, compact)}`;
  }
  if (!live.run) return t("讀取渲染進度…");
  if (live.run.state !== "running") return t("渲染已結束，正在讀回結果");
  const load = stepsComponentLoad(runSteps(live.run));
  if (load) return componentLoadText(load);
  return live.view?.state === "running" ? `DiT ${progressHeadline(live.view)}` : t("渲染中");
}

/**
 * The measured share of the DiT denoising of `take` (0–1): the running step's evidence, 1 once the DiT finished, null
 * while there is no evidence (before the DiT starts, or a component that reports no steps on the way).
 */
export function ditFraction(take: StudioTake, activity: RenderActivity | null, live: TakeRender): number | null {
  const view = activityItem(activity, take)?.dit ?? live.view;
  if (!view) return null;
  if (view.state === "succeeded") return 1;
  return view.state === "running" ? view.progress.fraction : null;
}

export type TimeLeft =
  | { kind: "known"; seconds: number; at: number }
  | { kind: "estimating" }
  | { kind: "unknown"; reason: string; detail: string };

/**
 * When `take` is expected to be done: the branches of a run render one after another, so its time left adds up the
 * branches before it (unknown when any of them is unknown, never counted as 0).
 */
export function takeTimeLeft(take: StudioTake, activity: RenderActivity | null): TimeLeft {
  const item = activityItem(activity, take);
  if (!activity || !item) {
    return { kind: "unknown", reason: t("還沒讀到這次渲染的進度"), detail: t("渲染進度讀到之後才能估算剩餘時間") };
  }
  if (activity.now === null) return { kind: "estimating" };
  const index = activity.items.indexOf(item);
  const moment = queueCompletion(
    activity.items.map((entry) => entry.remainingSeconds),
    activity.now,
  )[index];
  if (moment && moment.at !== null) return { kind: "known", seconds: Math.max(0, (moment.at - activity.now) / 1000), at: moment.at };
  if (activity.estimating) return { kind: "estimating" };
  if (moment && moment.blockedBy !== index) {
    const title = activity.items[moment.blockedBy]?.shot?.title ?? "";
    return {
      kind: "unknown",
      reason: t("排在前面的「{title}」尚無預估", { title }),
      detail: t("渲染依序執行：完成時刻要加上排在前面每一項的剩餘時間，前面有一項沒有預估就無法推算"),
    };
  }
  const missing = activity.remaining?.missing ?? "none";
  return { kind: "unknown", reason: missingEtaReason(missing), detail: missingEtaDetail(missing) };
}
