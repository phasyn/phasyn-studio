// Shot actions shared by the shot list, its menu, the take strip and the delete dialog: open in the monitor, use a
// take or take over its settings, duplicate, move in the film, join or leave the timeline, remove. They only change
// the project document (autosaved); no file or run is deleted here. Focus moves to the shot's row (data-studio-row).
import { t } from "@/i18n";
import { useEditor } from "../editor/editorContext";
import { filmOrder } from "../editor/sources";
import { localId, MAX_SHOTS, neighbourShotId } from "../model/project";
import { takeSettings } from "../model/variants";
import { newLocalId } from "../references/ids";

/** After the next frame, focus the shot's row; `fallback` when it is gone. */
export function focusShotLater(shotId: string | null, fallback?: () => HTMLElement | null): void {
  requestAnimationFrame(() => {
    const element = (shotId != null && shotId !== "") ? document.querySelector<HTMLElement>(`[data-studio-row="${CSS.escape(shotId)}"]`) : null;
    (element ?? fallback?.() ?? null)?.focus();
  });
}

export interface ShotActions {
  /** Select the shot and show its take in the monitor (stops sequence playback). */
  openInSource: (shotId: string) => void;
  /** Make this take the active one (the timeline follows it; a fixed-seed shot adopts its seed). */
  selectTake: (shotId: string, takeId: string) => void;
  /**
   * 「套用這個 take 的設定」: copy the take's seed, references and route to its shot (model/variants.ts takeSettings) and
   * make it the active take, so the shot is no longer stale against it. What changed; null when nothing could be copied.
   */
  applyTake: (shotId: string, takeId: string) => string[] | null;
  /**
   * Duplicate shots, each with its playable active take, right after its original. The copies start off the timeline
   * (加入時間軸 places one where it is wanted), so trying a variation never lengthens the film, and a notice says so.
   * The copies' ids; none when the project cannot hold them all (a warning says why).
   */
  duplicateAll: (shotIds: readonly string[]) => string[];
  /** Duplicate one shot (duplicateAll) and select the copy; null when it cannot be made. */
  duplicate: (shotId: string) => string | null;
  /** One place earlier (-1) or later (1) in the film. */
  move: (shotId: string, delta: -1 | 1) => boolean;
  /** In front of or behind another shot in the film (drag and drop). */
  moveTo: (shotId: string, targetShotId: string, side: "before" | "after") => boolean;
  setInTimeline: (shotId: string, on: boolean) => boolean;
  /** Remove the shot from the project (its clips leave the film); the selection moves to its neighbour, which is returned. */
  remove: (shotId: string) => string | null;
}

export function useShotActions(): ShotActions {
  const editor = useEditor();
  const { project, timeline, dispatch, notify, selectShot, selectedShotId, setMonitorMode, playhead } = editor;
  const placed = () => filmOrder(project, timeline).placed;
  const duplicateAll = (shotIds: readonly string[]): string[] => {
    const sources = shotIds.filter((shotId) => project.shots.some((shot) => shot.shot_id === shotId));
    if (sources.length === 0) return [];
    if (project.shots.length + sources.length > MAX_SHOTS) {
      notify({ tone: "warning", title: t("鏡頭已達上限 {maxShots} 個", { maxShots: MAX_SHOTS }) });
      return [];
    }
    const copies = sources.map((shotId) => ({ shotId, newShotId: localId("s"), newTakeId: localId("t") }));
    for (const copy of copies) dispatch({ type: "duplicateShot", ...copy });
    notify({ tone: "success", title: t("已複製 {count} 個鏡頭", { count: copies.length }), detail: t("複本不在時間軸上；要放進影片時，在鏡頭的選單選「加入時間軸」。") });
    return copies.map((copy) => copy.newShotId);
  };
  return {
    openInSource(shotId) {
      playhead.setPlaying(false);
      selectShot(shotId);
      setMonitorMode("source");
    },
    selectTake(shotId, takeId) {
      dispatch({ type: "setActiveTake", shotId, takeId, adoptSeed: true });
    },
    applyTake(shotId, takeId) {
      const shot = project.shots.find((item) => item.shot_id === shotId);
      const take = shot?.takes.find((item) => item.take_id === takeId);
      if (!shot || !take) return null;
      const settings = takeSettings(take, shot, project.library ?? [], () => newLocalId("ref"));
      if (settings.problem !== null || settings.patch === null) return null;
      dispatch({ type: "updateShot", shotId, patch: settings.patch });
      dispatch({ type: "setActiveTake", shotId, takeId });
      return settings.changes;
    },
    duplicateAll,
    duplicate(shotId) {
      const [copy] = duplicateAll([shotId]);
      if (copy === undefined) return null;
      selectShot(copy, { fromClip: true });
      return copy;
    },
    move(shotId, delta) {
      const order = placed();
      const target = order[order.findIndex((shot) => shot.shot_id === shotId) + delta];
      return order.some((shot) => shot.shot_id === shotId) && target !== undefined && editor.rearrangeShot(shotId, target.shot_id, delta < 0 ? "before" : "after");
    },
    moveTo(shotId, targetShotId, side) {
      return shotId !== targetShotId && editor.rearrangeShot(shotId, targetShotId, side);
    },
    setInTimeline(shotId, on) {
      return editor.setShotInTimeline(shotId, on);
    },
    remove(shotId) {
      const order = placed();
      const at = order.findIndex((shot) => shot.shot_id === shotId);
      const next = (at >= 0 ? (order[at + 1] ?? order[at - 1])?.shot_id : undefined) ?? neighbourShotId(project, shotId);
      dispatch({ type: "removeShot", shotId });
      if (selectedShotId === shotId) selectShot(next);
      return next;
    },
  };
}
