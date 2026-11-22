// How a shot is generated (its 方式), derived from what the shot already stores — its first-frame setting (continuity),
// its route's purpose (參考生成, 首幀, 文字, 表演驅動, 音訊驅動; model/providerTraits.ts) and, while the route cannot tell,
// its references — so the project document needs no field for it. The edit tools' routes (延展, 重繪, 控制) are no 方式.
// Choosing a 方式 sets the route and the first-frame setting together (modeChange): the two can no longer disagree,
// which is what made "continue from the previous shot" fail with a technical message before.
// Route ranking for a 方式 (rankModeRoutes), best first:
//   1. routes that can render it now (ready; continuing also needs the frame extractor on the DiT's machine);
//   2. the route this shot last rendered successfully with in that task (switching back restores it);
//   3. the project's default route;
//   4. a route whose DiT runs on the same machine as the shot's current route (the work stays where it was);
//   5. a route that is not an experiment or research variant;
//   6. the order the component combinations were saved in.
// Pure: no requests, no estimates, no text for people (the components word it).
import type { Catalog, StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { predecessor } from "./continuity";
import type { ShotPatch } from "./project";
import type { RoutePurpose } from "./providerTraits";
import { findRoute, routeContinuity, type ComponentSlot, type RouteTask, type StudioRoute } from "./routes";

/** performance: a performance video drives a character image; audio: a voice or sound track drives it (studio_creative routes). */
export type GenerationMode = "references" | "continue" | "image" | "text" | "performance" | "audio";

/** The order the 方式 choice lists them. */
export const GENERATION_MODES: readonly GenerationMode[] = ["references", "continue", "image", "text", "performance", "audio"];

/** The route purpose each 方式 renders with (providerTraits.ts). */
export const MODE_PURPOSE: Readonly<Record<GenerationMode, RoutePurpose>> = {
  references: "reference", continue: "first-frame", image: "first-frame", text: "text", performance: "performance", audio: "audio",
};

/** The 方式 a route renders without a first frame; null for first-frame routes and the edit tools' routes. */
const PURPOSE_MODE: Partial<Record<RoutePurpose, GenerationMode>> = { reference: "references", text: "text", performance: "performance", audio: "audio" };

/**
 * Why the 方式 cannot be read, or cannot render as stored: the routes are still loading (the route's task is unknown);
 * the route is not one of the saved combinations; a first-frame route without a first frame; a first frame on a route
 * that cannot take one.
 */
export type ModeIssue = "loading" | "route-missing" | "needs-first-frame" | "route-mismatch" | "edit-route";

export interface ModeReading {
  /** null when nothing the shot stores tells it. */
  mode: GenerationMode | null;
  issue: ModeIssue | null;
}

type Continuity = StudioShot["continuity"];

function firstFrameOf(continuity: Continuity): "none" | "previous_last" | "image" {
  return continuity?.mode ?? "none";
}

/** A route that can take a first frame: fl2va with an image input. */
function takesFirstFrame(route: StudioRoute): boolean {
  return route.purpose === "first-frame" && route.capability === "fl2va" && route.imageInput !== null;
}

/** The shot's 方式: its first frame decides when it has one, else its route's task; the references stand in while the route cannot tell. */
export function readMode(shot: Pick<StudioShot, "continuity" | "references">, route: StudioRoute | null, engineReady: boolean): ModeReading {
  const first = firstFrameOf(shot.continuity);
  if (first !== "none") {
    const mode = first === "image" ? "image" : "continue";
    if (!engineReady) return { mode, issue: null };
    return { mode, issue: !route ? "route-missing" : takesFirstFrame(route) ? null : "route-mismatch" };
  }
  if (route) {
    if (!route.renderable) return { mode: null, issue: "edit-route" };
    const mode = PURPOSE_MODE[route.purpose];
    return mode ? { mode, issue: null } : { mode: null, issue: "needs-first-frame" };
  }
  return { mode: (shot.references?.length ?? 0) > 0 ? "references" : null, issue: engineReady ? "route-missing" : "loading" };
}

/**
 * Whether the shot's first-frame setting can render on routes of `task`: a first frame renders only on fl2va, and fl2va
 * needs one (the render plan refuses the other pairs, which is why choosing a 方式 sets both together). A route chosen
 * for several shots at once goes only to the shots this holds for.
 */
export function shotFitsTask(shot: Pick<StudioShot, "continuity">, task: RouteTask): boolean {
  return (firstFrameOf(shot.continuity) !== "none") === (task === "fl2va");
}

/** Whether a shot's first-frame setting can render on this route: a shot route at all, and a first frame exactly on first-frame routes. */
export function shotFitsRoute(shot: Pick<StudioShot, "continuity">, route: StudioRoute): boolean {
  return route.renderable && (firstFrameOf(shot.continuity) !== "none") === (route.purpose === "first-frame");
}

/** The route can render this 方式 (its purpose, and an image input for a first frame). */
export function routeFitsMode(route: StudioRoute, mode: GenerationMode): boolean {
  if (!route.renderable) return false;
  return MODE_PURPOSE[mode] === "first-frame" ? takesFirstFrame(route) : route.purpose === MODE_PURPOSE[mode];
}

/** The route can render this 方式 now: ready, and for continuing also the frame extractor on its DiT's machine. */
export function routeReadyForMode(route: StudioRoute, mode: GenerationMode, catalog: Catalog | undefined): boolean {
  return mode === "continue" ? routeContinuity(route, catalog).ready : route.ready;
}

/** The take rendered this 方式: by its route when that route still exists, else by its H3 task (old takes: a first frame means fl2va). */
function takeFitsMode(take: StudioTake, mode: GenerationMode, routes: readonly StudioRoute[]): boolean {
  const route = findRoute(routes, take.route);
  if (route) return routeFitsMode(route, mode);
  const task = take.task ?? (take.continuity ? "fl2va" : "t2va");
  return MODE_PURPOSE[mode] === (task === "ref2va" ? "reference" : task === "fl2va" ? "first-frame" : "text");
}

export interface RankContext {
  project: Pick<StudioProject, "defaults">;
  shot: Pick<StudioShot, "route" | "takes">;
  routes: readonly StudioRoute[];
  catalog: Catalog | undefined;
}

/** The routes that can render `mode`, best first (see the ranking at the top of this file). */
export function rankModeRoutes(mode: GenerationMode, { project, shot, routes, catalog }: RankContext): StudioRoute[] {
  const current = findRoute(routes, shot.route);
  const lastUsed = [...shot.takes].reverse().find((take) => take.state === "succeeded" && takeFitsMode(take, mode, routes))?.route ?? null;
  const key = (route: StudioRoute): number[] => [
    routeReadyForMode(route, mode, catalog) ? 0 : 1,
    route.id === lastUsed ? 0 : 1,
    route.id === project.defaults.route ? 0 : 1,
    (current?.mainNodeId != null && current.mainNodeId !== "") && route.mainNodeId === current.mainNodeId ? 0 : 1,
    route.experimental ? 1 : 0,
  ];
  const compare = (a: readonly number[], b: readonly number[]) => a.reduce((result, value, index) => result || value - (b[index] ?? 0), 0);
  return routes
    .map((route, index) => ({ route, index, rank: key(route) }))
    .filter(({ route }) => routeFitsMode(route, mode))
    .sort((a, b) => compare(a.rank, b.rank) || a.index - b.index)
    .map(({ route }) => route);
}

/** Same first-frame setting (a missing one is none). */
export function sameContinuity(a: Continuity, b: Continuity): boolean {
  const mode = firstFrameOf(a);
  if (mode !== firstFrameOf(b)) return false;
  return mode !== "image" || (a?.mode === "image" && b?.mode === "image" && a.item_id === b.item_id);
}

export type ModeChange =
  /** patch is empty when the shot already renders this way; route is the route the shot uses afterwards. */
  | { ok: true; patch: ShotPatch; route: StudioRoute }
  /** no-route: no saved combination can render it; no-previous: nothing to continue from (detail says why); needs-image: pick an image first. */
  | { ok: false; reason: "no-route" | "no-previous" | "needs-image"; detail: string | null };

/**
 * What choosing `mode` changes on the shot, as one patch: the route (kept when it already fits, otherwise the best
 * ranked one) and the first-frame setting (continue: the previous shot's last frame; image: imageItemId; references and
 * text: none). Nothing else changes; the references stay on the shot even where they are not sent.
 */
export function modeChange(project: StudioProject, shot: StudioShot, mode: GenerationMode, context: Omit<RankContext, "project" | "shot">, imageItemId?: string): ModeChange {
  if (mode === "continue") {
    const found = predecessor(project, shot.shot_id);
    if (!found.previous) return { ok: false, reason: "no-previous", detail: found.problem };
  }
  if (mode === "image" && !(imageItemId != null && imageItemId !== "")) return { ok: false, reason: "needs-image", detail: null };
  const current = findRoute(context.routes, shot.route);
  // A route the owner keeps off its machine is not kept: the best ranked one (a ready route elsewhere) replaces it
  const route = current && routeFitsMode(current, mode) && current.placement === null ? current : rankModeRoutes(mode, { ...context, project, shot })[0];
  if (!route) return { ok: false, reason: "no-route", detail: null };
  const continuity: Continuity =
    mode === "continue" ? { mode: "previous_last" } : mode === "image" && (imageItemId != null && imageItemId !== "") ? { mode: "image", item_id: imageItemId } : { mode: "none" };
  const patch: ShotPatch = {};
  if (route.id !== shot.route) patch.route = route.id;
  if (!sameContinuity(shot.continuity, continuity)) patch.continuity = continuity;
  return { ok: true, patch, route };
}

/** The components a route cannot use now, each once; `extra` adds slots outside the combination (a continuation's frame extractor). */
export function unusableSlots(route: StudioRoute, extra: readonly ComponentSlot[] = []): ComponentSlot[] {
  const seen = new Map<string, ComponentSlot>();
  for (const slot of [...route.steps.map((item) => item.slot), ...extra]) if (!slot.usable) seen.set(`${slot.nodeId}:${slot.componentId}`, slot);
  return [...seen.values()];
}

/**
 * Why a route cannot render, in the terms a person acts on: "start" when every problem is a component that exists but is
 * not running (the engine sheet starts it), "setup" for anything else (a missing component, a wiring or checkpoint
 * problem); null when it is ready.
 */
export function routeBlock(route: StudioRoute, extra: readonly ComponentSlot[] = []): "start" | "setup" | null {
  const slots = unusableSlots(route, extra);
  const structural = route.problems.some((problem) => !route.steps.some((item) => item.slot.reason === problem));
  if (slots.length === 0 && !structural) return null;
  return !structural && slots.every((slot) => slot.component !== null) ? "start" : "setup";
}
