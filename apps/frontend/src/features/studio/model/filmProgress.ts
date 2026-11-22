// How far the film is rendered, one rule for every place that shows it: the status bar's 「已渲染 x／y・需更新 n」 and the
// project list's 已渲染 column. Counted over the shots placed on the timeline (the film): ready = an active take that
// matches the shot's current settings; stale = a shot with takes whose settings changed since (it needs a new render).
import type { StudioProject, StudioTimeline } from "@/api/generated/contracts";
import { placedShotIds } from "../editor/model";
import { projectTimeline } from "../editor/sources";
import { needsRender, shotStatus } from "./project";

export interface FilmProgress {
  /** Shots of the film whose active take matches their settings. */
  ready: number;
  /** Shots on the timeline. */
  total: number;
  /** Shots with takes that need a new render (settings changed, last render failed or stopped). */
  stale: number;
}

/** The film's progress; `timeline` is the live edit state where there is one (the saved timeline otherwise). */
export function filmProgress(project: StudioProject, timeline?: StudioTimeline): FilmProgress {
  const saved = projectTimeline(project);
  const film = timeline ?? (saved.ok ? saved.value : null);
  const placed = film ? placedShotIds(film) : new Set<string>();
  const shots = project.shots.filter((shot) => placed.has(shot.shot_id));
  return {
    ready: shots.filter((shot) => shotStatus(shot, project) === "ready").length,
    total: shots.length,
    stale: shots.filter((shot) => needsRender(shot, project) && shot.takes.length > 0).length,
  };
}
