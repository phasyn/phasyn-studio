import { takeLabel } from "./takeLabel";
// What a shot's action menu offers (pure): every action comes with the reason it cannot run. The menu ends with the
// latest playable takes, so another take can be made the active one right there.
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import type { MenuAnchor } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { activeTake, MAX_SHOTS } from "./project";

/** An open shot menu. */
export interface ShotMenuState {
  shotId: string;
  anchor: MenuAnchor;
  /** Focus returns here when the menu closes (Esc, Tab, running an item). */
  returnFocus: HTMLElement | null;
  /** Focus the first or the last item on open (↑ opens on the last). */
  focus: "first" | "last";
}

export type ShotActionId = "openSource" | "openInEdit" | "duplicate" | "moveEarlier" | "moveLater" | "toggleTimeline" | "useTake" | "moreTakes" | "delete";

export interface ShotMenuEntry {
  id: ShotActionId;
  label: string;
  shortcut?: string;
  disabledReason: string | null;
  tone?: "danger";
  separatorBefore?: boolean;
  /** useTake: the take to switch to. */
  takeId?: string;
  /** useTake: the take's name without "use" (announced as "now uses X"; never cut out of the translated label). */
  target?: string;
  /** moreTakes: the newest take's run (shown in the Render workspace). */
  runId?: string;
}

/** Takes listed in the menu (newest first); the rest are in the Render workspace. */
export const MENU_TAKE_LIMIT = 5;

/** A shot that is rendering is not deleted: its result would have nowhere to land. */
export function deleteBlockedReason(shot: StudioShot): string | null {
  return shot.takes.some((take) => take.state === "rendering") ? t("這個鏡頭正在渲染；完成或在「渲染」取消後才能刪除") : null;
}

export function duplicateBlockedReason(project: StudioProject): string | null {
  return project.shots.length >= MAX_SHOTS ? t("鏡頭已達上限 {maxShots} 個", { maxShots: MAX_SHOTS }) : null;
}

/** The takes that can become the active one (succeeded, with a video), newest first, at most `limit`; total = all playable ones. */
export function takeChoices(shot: StudioShot, limit = MENU_TAKE_LIMIT): { entries: ShotMenuEntry[]; total: number } {
  const playable = shot.takes.filter((take) => Boolean(take.state === "succeeded" && take.asset));
  const current = activeTake(shot)?.take_id ?? null;
  const entries = [...playable]
    .reverse()
    .slice(0, limit)
    .map((take, index): ShotMenuEntry => {
      const label = takeLabel(shot.takes.indexOf(take) + 1, take.seed);
      const active = take.take_id === current;
      return {
        id: "useTake",
        takeId: take.take_id,
        target: label,
        label: active ? t("{label}（使用中）", { label }) : t("改用 {label}", { label }),
        disabledReason: active ? t("已是使用中的 take") : null,
        separatorBefore: index === 0,
      };
    });
  if (playable.length > limit) {
    const latest = playable.at(-1);
    entries.push({ id: "moreTakes", label: t("在「渲染」查看全部 {playableCount} 個 take", { playableCount: playable.length }), disabledReason: null, ...(latest?.run_id === undefined ? {} : { runId: latest.run_id }) });
  }
  return { entries, total: playable.length };
}

export interface ShotMenuInput {
  project: StudioProject;
  shotId: string;
  /** The shot's place in the film (0-based among the shots on the timeline); -1 when it has no clip. */
  position: number;
  /** How many shots are on the timeline. */
  placedCount: number;
  /** Display name of the Alt / Option key. */
  alt: string;
}

export function shotMenuEntries({ project, shotId, position, placedCount, alt }: ShotMenuInput): ShotMenuEntry[] {
  const shot = project.shots.find((item) => item.shot_id === shotId);
  if (!shot) return [];
  const placed = position >= 0;
  const offTimeline = placed ? null : t("這個鏡頭不在時間軸上；先加入時間軸");
  return [
    { id: "openSource", label: t("在監看器開啟"), disabledReason: null },
    { id: "openInEdit", label: t("在編輯中開啟"), disabledReason: offTimeline },
    { id: "duplicate", label: t("複製鏡頭"), disabledReason: duplicateBlockedReason(project) },
    { id: "moveEarlier", label: t("往前移"), shortcut: `${alt}+↑`, separatorBefore: true, disabledReason: offTimeline ?? (position === 0 ? t("已經是第一個鏡頭") : null) },
    { id: "moveLater", label: t("往後移"), shortcut: `${alt}+↓`, disabledReason: offTimeline ?? (position === placedCount - 1 ? t("已經是最後一個鏡頭") : null) },
    { id: "toggleTimeline", label: placed ? t("移出時間軸") : t("加入時間軸"), disabledReason: null },
    ...takeChoices(shot).entries,
    { id: "delete", label: t("刪除鏡頭…"), shortcut: "Delete", tone: "danger", separatorBefore: true, disabledReason: deleteBlockedReason(shot) },
  ];
}
