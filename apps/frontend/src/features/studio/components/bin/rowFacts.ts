// What a shot row shows besides its title and state (pure): how many takes can be played, the route badge (only for a
// route other than the project's default), the link to the previous shot (a shot that starts from its last frame) and
// the item of the running render that renders the shot.
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { continuityMode, predecessor } from "../../model/continuity";
import type { ActivityItem, RenderActivity } from "../../model/renderActivity";
import { findRoute, ROUTE_MISSING, routeName, type Engine } from "../../model/routes";

/** Takes that can be played (finished, with a video): the ones a person can pick. */
export function playableTakeCount(shot: StudioShot): number {
  return shot.takes.filter((take) => Boolean(take.state === "succeeded" && take.asset)).length;
}

/** Per shot, the item of the running render: the one rendering now, otherwise the first one still waiting. */
export function activityByShot(activity: RenderActivity | null): ReadonlyMap<string, ActivityItem> {
  const found = new Map<string, ActivityItem>();
  for (const item of activity?.items ?? []) {
    const shotId = item.shot?.shot_id;
    if (!(shotId != null && shotId !== "") || (item.state !== "running" && item.state !== "waiting")) continue;
    const known = found.get(shotId);
    if (!known || (known.state === "waiting" && item.state === "running")) found.set(shotId, item);
  }
  return found;
}

export type RouteBadge = { tone: "warning"; text: string; title: string } | { tone: "neutral"; text: string; title: string };

/**
 * The badge of a shot whose route is not the project's default: the route's short name, its whole label in the
 * tooltip; a route that no longer exists says so. Nothing for the default route, or before the routes are read.
 */
export function routeBadge(project: StudioProject, shot: StudioShot, engine: Pick<Engine, "status" | "routes">): RouteBadge | null {
  if (engine.status !== "ready") return null;
  const route = findRoute(engine.routes, shot.route);
  if (!route) return { tone: "warning", text: t("路由不存在"), title: ROUTE_MISSING };
  if (shot.route === project.defaults.route) return null;
  return { tone: "neutral", text: routeName(route.label).name, title: t("運算路由：{label}", { label: route.label }) };
}

export interface ContinuityLink {
  /** False when the shot is set to continue but has nothing to continue from. */
  ok: boolean;
  text: string;
}

/** A shot on the timeline that starts from the previous shot's last frame: what it continues from, or why it cannot. */
export function continuityLink(project: StudioProject, shot: StudioShot, placed: boolean): ContinuityLink | null {
  if (!placed || continuityMode(shot) !== "previous_last") return null;
  const found = predecessor(project, shot.shot_id);
  if (!found.previous) return { ok: false, text: t("接續前一個鏡頭：{problem}", { problem: found.problem }) };
  return { ok: true, text: t("從前一個鏡頭「{title}」的最後一幀開始", { title: found.previous.shot.title || found.previous.shot.shot_id }) };
}
