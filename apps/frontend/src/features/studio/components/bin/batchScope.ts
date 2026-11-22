// What 批次渲染 sends (pure). Without a multi-selection: the shots on the timeline that need (re)rendering and have a
// prompt, in film order. With one: the selected shots that have a prompt and are not rendering. A candidate whose row
// reported why it cannot be rendered (blockReports.ts) is blocked: it stays out of the run and is counted instead.
// Also the words the button and its confirmation (BatchRenderDialog) share: why a shot is in the batch, where the DiT
// lanes send it, the compact estimate and the finish time (also in 渲染變體's footer, BatchVariantsDialog).
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import { t, tServer } from "@/i18n";
import { formatDateTime, formatList } from "@/i18n/format";
import { completionText } from "../../model/eta";
import { lanesProblem, MIN_LANES, readyLanes } from "../../model/lanes";
import { activeTake, changedSinceTake, latestTake, needsRender, shotStatus, type ShotStatus } from "../../model/project";
import type { StudioRoute } from "../../model/routes";

export interface BatchScope {
  /** The scope is the multi-selection (otherwise the shots on the timeline that need rendering). */
  selection: boolean;
  candidates: StudioShot[];
  /** Selected shots that cannot be candidates: no prompt yet, or rendering now. */
  skipped: number;
}

/** `selected` = the multi-selection in list order, or null without one. */
export function batchCandidates(project: StudioProject, placed: readonly StudioShot[], selected: readonly StudioShot[] | null): BatchScope {
  if (selected === null) return { selection: false, candidates: placed.filter((shot) => needsRender(shot, project) && shot.prompt.trim() !== ""), skipped: 0 };
  const candidates = selected.filter((shot) => shot.prompt.trim() !== "" && shotStatus(shot, project) !== "rendering");
  return { selection: true, candidates, skipped: selected.length - candidates.length };
}

export interface BlockedShot {
  shot: StudioShot;
  reason: string;
}

/** The candidates that will be sent and the ones that are blocked (with the reason their row reported). */
export function splitBlocked(candidates: readonly StudioShot[], reasons: ReadonlyMap<string, string>): { renderable: StudioShot[]; blocked: BlockedShot[] } {
  const renderable: StudioShot[] = [];
  const blocked: BlockedShot[] = [];
  for (const shot of candidates) {
    const reason = reasons.get(shot.shot_id);
    if (reason === undefined) renderable.push(shot);
    else blocked.push({ shot, reason });
  }
  return { renderable, blocked };
}

export interface BatchReason {
  /** The shot's status (model/project shotStatus): empty, stale, failed, cancelled or interrupted; ready only in a selection. */
  status: ShotStatus;
  /**
   * A few words after the status label: what changed since the take in use (stale), the last render's error code, or
   * that rendering a selected shot that is up to date only adds a take (so it may be one to leave out).
   */
  detail: string | null;
  /** The whole story for a tooltip (the last render's error with its message); null when the detail says it all. */
  title: string | null;
}

/** Why a candidate is in the batch, by the rules that put it there (shotStatus, changedSinceTake); no new judgement. */
export function batchReason(shot: StudioShot, project: StudioProject): BatchReason {
  const status = shotStatus(shot, project);
  if (status === "ready") return { status, detail: t("再渲染會多一個 take"), title: null };
  if (status === "stale") {
    const active = activeTake(shot);
    const changes = active ? changedSinceTake(active, shot, project) : [];
    if (changes.length === 0) return { status, detail: null, title: null };
    const list = formatList(changes);
    return { status, detail: list, title: t("已變更：{changes}", { changes: list }) };
  }
  const error = status === "failed" || status === "cancelled" || status === "interrupted" ? latestTake(shot)?.error : undefined;
  return error ? { status, detail: error.code, title: `${error.code} ${tServer(error.message)}` } : { status, detail: null, title: null };
}

/**
 * The batch's lanes in words: where the shots go, or why the DiT lanes would refuse them, so neither the button nor its
 * confirmation promises a split the render then refuses (a lane without a speed record is measured, not refused).
 */
export function lanesLine(routes: readonly StudioRoute[], lanes: readonly string[], count: number): string {
  if (lanes.length < MIN_LANES) return t("把 {pendingCount} 個鏡頭放進同一個 run 依序渲染", { pendingCount: count });
  const problem = lanesProblem(routes, lanes);
  if (problem != null && problem !== "") return t("DiT 分流有問題，按下會被擋下：{problem}", { problem });
  const ready = readyLanes(routes, lanes).length;
  if (ready === 0) return t("分流的 {count} 條元件組合都未就緒，按下會被擋下", { count: lanes.length });
  return ready < lanes.length
    ? t("把 {pendingCount} 個鏡頭放進同一個 run，分流到就緒的 {ready} 條元件組合（{skipped} 條未就緒，會略過）", { pendingCount: count, ready, skipped: lanes.length - ready })
    : t("把 {pendingCount} 個鏡頭放進同一個 run，分流到 {lanesCount} 條元件組合", { pendingCount: count, lanesCount: lanes.length });
}

/** The estimate folded into the batch button: 「約 14 分」, 「約 45 秒」, 「約 1 小時 5 分」 (range and record count go to its tooltip). */
export function compactEta(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return t("約 {seconds} 秒", { seconds: Math.max(1, Math.round(seconds)) });
  if (minutes < 60) return t("約 {minutes} 分", { minutes });
  return t("約 {hours} 小時 {minutes} 分", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** A finish time that is not today also shows its date (a long batch started in the evening ends the next morning). */
const FINISH_DATE: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** 「預計 14:32 完成」, with the date when that is not today. */
export function finishText(atMs: number, nowMs: number): string {
  if (new Date(atMs).toDateString() === new Date(nowMs).toDateString()) return completionText(atMs);
  return t("預計 {date} 完成", { date: formatDateTime(atMs, FINISH_DATE) });
}
