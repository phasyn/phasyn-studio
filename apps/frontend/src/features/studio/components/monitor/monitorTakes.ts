import { takeLabel } from "../../model/takeLabel";
// Which takes the monitor shows and how (pure): the take strip's usable takes and the ones that wait under 「其他」,
// the take in A, the B it is compared with and how the comparison is laid out, why a take cannot become the active
// one or lend the shot its settings, and the words of a take card (its accessible name and tooltip).
import type { StudioLibraryItem, StudioShot, StudioTake } from "@/api/generated/contracts";
import { t, tServer } from "@/i18n";
import { formatList, joinInline } from "@/i18n/format";
import { formatTimestamp } from "@/lib/format";
import { activeTake } from "../../model/project";
import type { TakeDifference } from "../../model/takeDiff";
import { takeNumber } from "../../model/takeDownload";
import { takeSettings, type VariantBadge } from "../../model/variants";

/** Takes that ended without a video: grouped behind 「其他」 at the end of the strip. */
const ENDED: ReadonlySet<StudioTake["state"]> = new Set(["failed", "cancelled", "interrupted"]);

export const TAKE_END_LABELS: Readonly<Record<string, string>> = { failed: t("失敗"), cancelled: t("已取消"), interrupted: t("已中斷") };

/** An A/B comparison: one picture split by a line (A left, B right) or the two side by side. */
export type CompareMode = "split" | "side";
export const COMPARE_MODES: readonly CompareMode[] = ["split", "side"];

export function isPlayable(take: StudioTake | null | undefined): take is StudioTake {
  return take?.state === "succeeded" && Boolean(take.asset);
}

export function isEnded(take: StudioTake): boolean {
  return ENDED.has(take.state);
}

/**
 * Whether a take waits behind 「其他」: it ended without a video, or its run was archived (archived runs are hidden by
 * default wherever takes are listed) and it is not the shot's active take. A take that renders never waits there.
 */
export function isOtherTake(shot: StudioShot, take: StudioTake, archived: ReadonlySet<string>): boolean {
  if (isEnded(take)) return true;
  return take.state === "succeeded" && archived.has(take.run_id) && activeTake(shot)?.take_id !== take.take_id;
}

/** The shot's takes in take order: the ones shown at once, and the ones behind 「其他」. */
export function takeGroups(shot: StudioShot, archived: ReadonlySet<string>): { usable: StudioTake[]; others: StudioTake[] } {
  const others = shot.takes.filter((take) => isOtherTake(shot, take, archived));
  return { usable: shot.takes.filter((take) => !others.includes(take)), others };
}

/** The take A shows: the one picked in the strip, else the active take, else the newest. */
export function viewedTake(shot: StudioShot, takeId: string | null): StudioTake | null {
  return shot.takes.find((take) => take.take_id === takeId) ?? activeTake(shot) ?? shot.takes.at(-1) ?? null;
}

/** The pinned B take while it exists and has a video (B stays pinned while A moves). */
export function pinnedCompare(shot: StudioShot, takeId: string | null): StudioTake | null {
  const take = (takeId != null && takeId !== "") ? shot.takes.find((item) => item.take_id === takeId) : undefined;
  return isPlayable(take) ? take : null;
}

/** What the monitor compares: A and the pinned B, both with video and not the same take; otherwise null. */
export function shownCompare(viewed: StudioTake | null, pinned: StudioTake | null): StudioTake | null {
  return isPlayable(viewed) && pinned && pinned.take_id !== viewed.take_id ? pinned : null;
}

/** What 「A/B 比較」 pins as B: the active take while A shows another one, else the newest other take with video. */
export function defaultCompare(shot: StudioShot, viewed: StudioTake | null): StudioTake | null {
  const active = activeTake(shot);
  if (isPlayable(active) && active.take_id !== viewed?.take_id) return active;
  return shot.takes.findLast((take) => isPlayable(take) && take.take_id !== viewed?.take_id) ?? null;
}

/** Why `take` cannot be made the shot's active take now; null when it can. */
export function activateBlockedReason(shot: StudioShot, take: StudioTake | null): string | null {
  if (!take) return t("還沒有 take");
  if (activeTake(shot)?.take_id === take.take_id) return t("已是使用中的 take");
  if (take.state === "rendering") return t("這個 take 還在渲染");
  return isPlayable(take) ? null : t("只有完成的 take 可以設為使用中");
}

/**
 * Why 「套用這個 take 的設定」 cannot copy `take`'s seed, references and route to the shot now; null when it can.
 * `routeKnown`: the route is still a saved route (a shot moved to a deleted one could not render).
 */
export function applyBlockedReason(shot: StudioShot, take: StudioTake | null, library: readonly StudioLibraryItem[], routeKnown: (routeId: string) => boolean): string | null {
  if (!take) return t("還沒有 take");
  if (take.state === "rendering") return t("這個 take 還在渲染");
  if (!isPlayable(take)) return t("只有完成的 take 可以套用設定");
  if (take.route !== shot.route && !routeKnown(take.route)) return t("這個 take 的路線「{route}」已不在清單上，無法套用它的設定", { route: take.route });
  const settings = takeSettings(take, shot, library, () => "");
  if (settings.problem !== null) return settings.problem;
  if (settings.patch !== null) return null;
  return activeTake(shot)?.take_id === take.take_id ? t("這個 take 已是使用中，設定也和鏡頭相同") : t("這個 take 的 seed、參考與路線已和鏡頭相同；要用它請按「設為使用中」");
}

export interface CardWords {
  /** Accessible name: number, state, marks, when, what differs. */
  label: string;
  /** Tooltip: seed and time, state or failure, every difference from the active take. */
  tooltip: string;
}

export interface CardFacts {
  shot: StudioShot;
  take: StudioTake;
  active: boolean;
  /** Pinned as B. */
  compared: boolean;
  /** Its run is archived. */
  archived: boolean;
  /** 「3 分鐘前」; null before the clock's first tick. */
  relative: string | null;
  /** The render's stage while it renders (「DiT 第 3／8 步」). */
  stage: string | null;
  /** Differences from the active take; null when there is nothing to compare with (this is the active take, or there is none). */
  differences: readonly TakeDifference[] | null;
  /** The active take's number (for 「和使用中的 take 2 不同」). */
  activeNumber: number | null;
  /** A variant take: what it has that the shot does not (model/variants.ts); null for another take. */
  variant: VariantBadge | null;
}

function stateWords({ take, active, stage }: CardFacts): string | null {
  if (take.state === "rendering") return stage ?? t("渲染中");
  if (isEnded(take)) return TAKE_END_LABELS[take.state] ?? take.state;
  return active ? t("使用中") : null;
}

function differenceLines(facts: CardFacts): string[] {
  const { differences, activeNumber } = facts;
  if (!differences || activeNumber === null) return [];
  if (differences.length === 0) return [t("設定與使用中的 take {number} 相同", { number: activeNumber })];
  return [
    t("和使用中的 take {number} 不同：", { number: activeNumber }),
    ...differences.flatMap((item) => [`• ${item.detail}`, ...item.more.map((line) => `  ${line}`)]),
  ];
}

/** The variant line of a card: 「變體：…」 for its name, 「和鏡頭不同：…」 for its tooltip. */
function variantWords(variant: VariantBadge | null): { label: string | null; line: string | null } {
  if (!variant) return { label: null, line: null };
  if (variant.same) return { label: t("變體：{text}", { text: variant.text }), line: t("變體：設定與鏡頭目前相同") };
  return { label: t("變體：{text}", { text: variant.text }), line: t("變體，和鏡頭不同：{text}", { text: variant.text }) };
}

export function cardWords(facts: CardFacts): CardWords {
  const { shot, take, compared, archived, relative, differences } = facts;
  const number = takeNumber(shot, take);
  const state = stateWords(facts);
  const tags = differences && differences.length > 0 ? t("與使用中不同：{list}", { list: formatList(differences.map((item) => item.label)) }) : null;
  const marks = [compared ? t("比較的 B") : null, archived ? t("已封存") : null];
  const variant = variantWords(facts.variant);
  const label = joinInline([t("take {number}", { number }), state, ...marks, variant.label, relative, tags].filter((part) => part !== null));
  const reason = take.error && isEnded(take) ? tServer(take.error.message) : null;
  const failure = reason === null ? null : t("{state}：{reason}", { state: TAKE_END_LABELS[take.state] ?? take.state, reason });
  const lines = [
    takeLabel(number, take.seed),
    formatTimestamp(take.created_at),
    variant.line,
    archived ? t("已封存") : null,
    ...(take.state === "rendering" && (state != null && state !== "") ? [state] : []),
    ...((failure != null && failure !== "") ? [failure, take.error?.code ?? ""] : []),
    ...differenceLines(facts),
    isPlayable(take) ? t("Alt＋點按：放到 B 比較") : null,
  ];
  return { label, tooltip: lines.filter((line): line is string => Boolean(line)).join("\n") };
}
