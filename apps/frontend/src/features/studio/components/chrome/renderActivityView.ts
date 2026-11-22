// How the running render (model/renderActivity.ts) reads in the Studio's chrome: the toolbar capsule and its popover,
// the status bar line, the tab title and the notification at its end. The three kinds of figure stay apart: counted
// (items, pipeline steps), measured (the DiT steps from step evidence, inside the activity's text) and estimated (time
// left and the share of time behind us, from the cost profiles; always written with 「約」 or said to be an estimate).
// An unknown time left is said to be unknown, with its reason. Pure.
import { parseRunStep, type RunState, type RunStepView } from "@/api/types";
import { formatTime } from "@/i18n/format";
import { completionText, formatEtaClock, missingEtaDetail, missingEtaReason, queueCompletion } from "../../model/eta";
import { runBranchSuffixes, runStepIds, splitRunStepId } from "../../model/pipelines";
import { componentLoadText, progressHeadline, stepLabel, stepsComponentLoad, type ProviderLookup } from "../../model/progress";
import type { ActivityItem, ActivityItemState, ActivityKind, RenderActivity } from "../../model/renderActivity";
import { projectHref } from "../../workspaces";
import { t } from "@/i18n";

/**
 * The progress the arc, the status bar's edge and the tab title show: the estimated share of the run's time that is
 * behind us when the cost profiles give a time left, otherwise the counted share of finished pipeline steps (steps,
 * not time); null when the run has no steps to count yet.
 */
export type RunFigure = { kind: "estimated"; share: number } | { kind: "counted"; share: number; done: number; total: number };

export function runFigure(activity: RenderActivity): RunFigure | null {
  const { elapsedShare, stepsDone, stepsTotal } = activity;
  if (elapsedShare !== null) return { kind: "estimated", share: elapsedShare };
  return stepsTotal > 0 ? { kind: "counted", share: stepsDone / stepsTotal, done: stepsDone, total: stepsTotal } : null;
}

/** An estimated share as a whole percentage; a run still running never reads 100. */
const percentOf = (share: number) => Math.min(99, Math.max(0, Math.round(share * 100)));

/** 「約 38%」 (estimated) or 「5／14 步」 (counted). */
export function figureText(figure: RunFigure): string {
  if (figure.kind === "estimated") return t("約 {percent}%", { percent: percentOf(figure.share) });
  return t("{done}／{total} 步", { done: figure.done, total: figure.total });
}

/** What the figure is, for a tooltip or an accessible description. */
export function figureDetail(figure: RunFigure): string {
  return figure.kind === "estimated"
    ? t("約 {percent}%＝已經過的時間 ÷（已經過＋預估剩餘），依本機成本紀錄估算", { percent: percentOf(figure.share) })
    : t("已完成 {done}／{total} 個 pipeline 步驟（步驟數，不代表耗時）", { done: figure.done, total: figure.total });
}

/** Which of the run's items is being worked on (1-based) when it has several; null for a run of one item. */
export function itemPosition(activity: RenderActivity): number | null {
  if (activity.total < 2) return null;
  const index = activity.current ? activity.items.indexOf(activity.current) : -1;
  return index >= 0 ? index + 1 : Math.min(activity.finished + 1, activity.total);
}

/** What the run produces, in a few words: the shot, 「批次 3 個鏡頭」, 「… ・4 個變體」, 「序列匯出」 or 「代理」. */
export function activitySubject(activity: RenderActivity): string {
  if (activity.kind === "export") return t("序列匯出");
  if (activity.kind === "proxy") return t("代理");
  const shot = activity.items.find((item) => item.shot)?.shot ?? null;
  const title = (shot?.title ?? "") || t("未命名鏡頭");
  if (activity.variations) return t("{value}・{takesCount} 個變體", { value: title, takesCount: activity.total });
  return activity.total > 1 ? t("批次 {takesCount} 個鏡頭", { takesCount: activity.total }) : title;
}

/** The name of one item in the popover: the shot's title, 「變體 2」, or the export or proxy itself. */
function itemLabel(activity: RenderActivity, item: ActivityItem): string {
  if (activity.kind === "export") return t("序列");
  if (activity.kind === "proxy") return t("代理");
  if (activity.variations) return t("變體 {entry}", { entry: activity.items.indexOf(item) + 1 });
  return (item.shot?.title ?? "") || t("未命名鏡頭");
}

/** What the run is doing now in one line (「鏡頭 2／3・DiT 第 3／8 步」), or 「準備中」 between steps. */
export function activityLine(activity: RenderActivity): string {
  return activity.text || t("準備中");
}

/** Nothing can be said about the time left yet: the clock has not ticked or the first estimate is being worked out. */
const notYet = (activity: RenderActivity) => activity.remaining === null || activity.now === null || activity.estimating;

/** The whole run's time left: 「剩餘約 9:23・預計 07:03 完成」, 「估算中…」 or why there is no estimate. */
export function remainingText(activity: RenderActivity): string {
  const { remaining, now } = activity;
  if (remaining?.seconds != null && now !== null) {
    return t("剩餘約 {left}・{completion}", { left: formatEtaClock(remaining.seconds), completion: completionText(now + remaining.seconds * 1000) });
  }
  if (notYet(activity)) return t("估算中…");
  return t("剩餘時間：尚無預估（{reason}）", { reason: missingEtaReason(remaining?.missing ?? "none") });
}

/** The capsule's time left: 「剩 9:23」 right after the percentage, 「剩約 9:23」 on its own; null when unknown. */
export function leftText(activity: RenderActivity, afterPercent: boolean): string | null {
  const seconds = activity.remaining?.seconds ?? null;
  if (seconds === null) return null;
  const left = formatEtaClock(seconds);
  return afterPercent ? t("剩 {left}", { left }) : t("剩約 {left}", { left });
}

/** The steps of one item's branch, in pipeline order (every step for a run of one branch). */
function branchSteps(activity: RenderActivity, suffix: string): RunStepView[] {
  const { run } = activity;
  const suffixes = runBranchSuffixes(run);
  return runStepIds(run)
    .filter((id) => splitRunStepId(run, id, suffixes).suffix === suffix)
    .map((id) => parseRunStep(id, run.steps[id]));
}

const busy = (step: RunStepView) => step.state === "running" || step.state === "waiting";

/** One item as a row shows it: the item, the state it shows and the steps of its branch. */
interface RowFacts {
  item: ActivityItem;
  state: ActivityItemState;
  steps: readonly RunStepView[];
}

/** What one item is doing: its state, or the running step (「DiT 第 3／8 步」, 「影片解碼執行中」). */
function itemStage(activity: RenderActivity, { item, state, steps }: RowFacts, lookup: ProviderLookup): string {
  // A component that loads on use: 「載入模型中（約 N 秒）」 or why it waits for the model
  const load = state === "running" || state === "waiting" ? stepsComponentLoad(steps) : null;
  if (load) return componentLoadText(load);
  switch (state) {
    case "waiting":
      return t("等待中");
    case "succeeded":
      return t("完成");
    case "failed":
      return t("失敗");
    case "cancelled":
      return t("已取消");
    case "interrupted":
      return t("已中斷");
    case "running":
      break;
  }
  // The DiT reads as everywhere in the Studio (model/progress.ts runActivity)
  if (item.dit?.state === "running") return `DiT ${progressHeadline(item.dit)}`;
  const running = steps.find((step) => step.state === "running");
  if (running) return t("{suffix}{stepLabel}執行中", { suffix: "", stepLabel: stepLabel(activity.run, running.step_id, lookup) });
  return steps.some((step) => step.state === "waiting") ? t("等待資源") : t("準備中");
}

/** 「14:32」: a moment on the local clock. */
const clock = (atMs: number) => formatTime(atMs, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** When the item's branch ended: the latest end time of its steps (measured); null when none reports one. */
function endedAt(steps: readonly RunStepView[]): number | null {
  const ends = steps.flatMap((step) => {
    const at = (step.finished_at != null && step.finished_at !== "") ? Date.parse(step.finished_at) : Number.NaN;
    return Number.isFinite(at) ? [at] : [];
  });
  return ends.length > 0 ? Math.max(...ends) : null;
}

export interface ItemTime {
  text: string;
  /** The tooltip: what the figure is (estimate, measurement) and, for an estimate, when the item should finish. */
  title: string;
}

/**
 * The time an item shows: a running item its estimated time left (「剩約 2:57」), a waiting one the time it should take
 * (「約 6:40」), a finished one the moment it ended (「08:20 完成」, measured); nothing for one that failed or stopped.
 * `completion` is the item's predicted end (items run one after another), null when it or one before it has no estimate.
 */
function itemTime(activity: RenderActivity, { item, state, steps }: RowFacts, completion: number | null): ItemTime | null {
  if (state === "succeeded") {
    const at = endedAt(steps);
    return at === null ? null : { text: t("{time} 完成", { time: clock(at) }), title: t("實際完成的時刻（run 的步驟時間）") };
  }
  if (state !== "running" && state !== "waiting") return null;
  if (item.remainingSeconds !== null) {
    const left = formatEtaClock(item.remainingSeconds);
    const running = state === "running";
    const what = running ? t("預估剩餘時間：依本機成本紀錄，已完成的步驟用實際時間") : t("預估這一項需要的時間：依本機成本紀錄");
    return {
      text: running ? t("剩約 {left}", { left }) : t("約 {left}", { left }),
      title: completion === null ? what : `${what}\n${completionText(completion)}`,
    };
  }
  if (notYet(activity)) return { text: t("估算中…"), title: "" };
  return { text: t("尚無預估"), title: missingEtaDetail(activity.remaining?.missing ?? "none") };
}

/** One row of the popover. */
export interface ItemView {
  label: string;
  /**
   * The activity's state of the item, except that an item whose first steps ran ahead (a later shot's text conditioning
   * runs while an earlier shot denoises) and which runs nothing now is waiting for its turn, not running.
   */
  state: ActivityItemState;
  stage: string;
  time: ItemTime | null;
  steps: RunStepView[];
}

export function itemView(activity: RenderActivity, item: ActivityItem, completion: number | null, lookup: ProviderLookup): ItemView {
  const steps = branchSteps(activity, item.suffix);
  const state = item.state === "running" && item !== activity.current && !steps.some(busy) ? "waiting" : item.state;
  const facts = { item, state, steps };
  return { label: itemLabel(activity, item), state, stage: itemStage(activity, facts, lookup), time: itemTime(activity, facts, completion), steps };
}

/** Predicted end of each item (in order; items run one after another), null where it or an earlier one is unknown. */
export function itemCompletions(activity: RenderActivity): (number | null)[] {
  const { now } = activity;
  if (now === null) return activity.items.map(() => null);
  const left = activity.items.map((item) => (item.state === "running" || item.state === "waiting" ? item.remainingSeconds : 0));
  return queueCompletion(left, now).map((moment) => moment.at);
}

/** What else stops when the run is cancelled (every shot of a batch, every variation); nothing to add for one item. */
export function cancelScope(activity: RenderActivity): string | undefined {
  if (activity.kind !== "render" || activity.total < 2) return undefined;
  return activity.variations
    ? t("這個 run 的 {count} 個變體都會停止；已經完成的保留。", { count: activity.total })
    : t("這個 run 的 {count} 個鏡頭都會停止；已經完成的保留。", { count: activity.total });
}

/** The render workspace with this run selected (and the selected shot kept). */
export function runHref(projectId: string, runId: string, shot: string | null): string {
  return `${projectHref("render", projectId)}${(shot != null && shot !== "") ? `&shot=${encodeURIComponent(shot)}` : ""}&run=${encodeURIComponent(runId)}`;
}

/** The tab title's progress while the run is running: the figure, or that it is working. */
export function tabProgress(activity: RenderActivity): string {
  const figure = runFigure(activity);
  if (figure) return figureText(figure);
  if (activity.kind === "export") return t("匯出中");
  return activity.kind === "proxy" ? t("代理媒體正在建立") : t("渲染中");
}

/** How the run ended, as the tab title and the notification say it (「✓ 渲染完成」, 「✕ 渲染失敗」…). */
export function endText(kind: ActivityKind, state: Exclude<RunState, "running">): string {
  if (state === "cancelled") return t("已取消");
  if (state === "interrupted") return t("已中斷");
  const ok = state === "succeeded";
  if (kind === "export") return ok ? t("✓ 匯出完成") : t("✕ 匯出失敗");
  if (kind === "proxy") return ok ? t("✓ 代理完成") : t("✕ 代理失敗");
  return ok ? t("✓ 渲染完成") : t("✕ 渲染失敗");
}
