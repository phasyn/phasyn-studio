// Edits of several shots at once: the shot list's multi-selection bar (時長, 路線) and the engine sheet's 路線 tab while
// the list has a multi-selection. Every shot whose value differs gets the new one; the dispatches of one event reach the
// autosave together, so it is one document edit, saved once, and a notice says how many shots changed. A route goes
// only to the shots whose first-frame setting can render on it (model/generationMode.ts shotFitsTask): the others keep
// theirs, because the 方式 sets the route and the first frame together and a mismatch could not render, and the notice
// says how many kept theirs.
import type { StudioShot } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { formatDuration } from "../model/frames";
import { shotFitsTask } from "../model/generationMode";
import { routeName, type RouteTask, type StudioRoute } from "../model/routes";
import { useStudio } from "../studioContext";

export interface ShotsEdit {
  /** Every shot gets this length (frames). */
  setFrames: (shots: readonly StudioShot[], frames: number) => void;
  /** Every shot whose first frame fits the route moves to it. */
  setRoute: (shots: readonly StudioShot[], route: StudioRoute) => void;
}

/** Why none of these shots can use routes of `task` (their first-frame setting needs the other kind); null when one can. */
export function taskUnfitReason(shots: readonly StudioShot[], task: RouteTask): string | null {
  if (shots.some((shot) => shotFitsTask(shot, task))) return null;
  return task === "fl2va"
    ? t("選取的鏡頭都沒有首幀，用不了首幀路線：先在生成列把方式改成「接續上一鏡」或「首幀圖片」")
    : t("選取的鏡頭都用首幀，只能用首幀路線：先在生成列把方式改成「參考素材」或「只用文字」");
}

export function useShotsEdit(): ShotsEdit {
  const { dispatch, notify } = useStudio();
  return {
    setFrames(shots, frames) {
      const changing = shots.filter((shot) => shot.frames !== frames);
      for (const shot of changing) dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { frames } });
      if (changing.length > 0) notify({ tone: "success", title: t("已把 {count} 個鏡頭的時長改成 {duration}", { count: changing.length, duration: formatDuration(frames) }) });
    },
    setRoute(shots, route) {
      const fitting = shots.filter((shot) => shotFitsTask(shot, route.capability));
      const changing = fitting.filter((shot) => shot.route !== route.id);
      for (const shot of changing) dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { route: route.id } });
      if (changing.length === 0) return;
      const kept = shots.length - fitting.length;
      notify({
        tone: "success",
        title: t("已把 {count} 個鏡頭改用「{route}」", { count: changing.length, route: routeName(route.label).name }),
        detail: kept > 0 ? t("另外 {count} 個鏡頭的方式不能用這條路線，維持原本的路線", { count: kept }) : undefined,
      });
    },
  };
}
