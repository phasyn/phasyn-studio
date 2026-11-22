// Spreading the shots of a render over several routes ("lanes") by predicted DiT time. A lane is a saved pipeline
// whose DiT runs on another GPU or machine. Once a project has lanes, every Studio render of its shots uses them: in a
// batch each shot goes to the lane that would finish it first, a single shot goes to the fastest lane, a lane whose DiT
// has no speed record yet gets one shot of a batch to measure it, and a lane that is not ready is skipped. The choice
// is made before the run is sent and written into each shot's route, so the placement of every step stays fixed and
// visible; nothing is balanced while the run executes. Pure apart from the estimator call.
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import type { WireStep } from "@/api/types";
import { findStage, selectProfile, shotEtaInput, STAGE_UNITS, type ProfileFit, type SegmentEtaEstimator, type SegmentEtaInput } from "./eta";
import { findRoute, routeName, type StudioRoute } from "./routes";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export const MIN_LANES = 2;
export const MAX_LANES = 8;

/** Node and component of the route's DiT step as one key; null when the route has no DiT step. */
export function ditPlacement(route: StudioRoute | null | undefined): string | null {
  const dit = route?.steps.find((item) => item.step.step_id === route.ditStepId)?.step;
  return dit ? `${dit.node_id.toLowerCase()}/${dit.component_id}` : null;
}

/**
 * The steps that wait for no other step (each branch's conditioning) first, then the rest, both in their order. The
 * controller starts ready steps in step order, so no long DiT call gets ahead of a later branch's conditioning on a
 * GPU the two share.
 */
export function rootsFirst<T extends Pick<WireStep, "inputs">>(steps: readonly T[]): T[] {
  const isRoot = (step: T) => !Object.values(step.inputs).some((binding) => "from_step" in binding);
  return [...steps.filter(isRoot), ...steps.filter((step) => !isRoot(step))];
}

/** Routes that could be a lane: every route with a DiT step (one that is not ready is listed with its reason). */
export function laneRoutes(routes: readonly StudioRoute[]): StudioRoute[] {
  return routes.filter((route) => ditPlacement(route) !== null);
}

/**
 * Why these routes cannot be lanes together (the dialog and the render show it); null when they can. Readiness is not
 * part of it: a lane that is not ready is skipped when a render is sent.
 */
export function lanesProblem(routes: readonly StudioRoute[], laneIds: readonly string[]): string | null {
  if (laneIds.length < MIN_LANES) return t("至少選兩條元件組合才能分流");
  if (laneIds.length > MAX_LANES) return t("最多選 {max} 條元件組合", { max: MAX_LANES });
  const lanes: StudioRoute[] = [];
  for (const id of laneIds) {
    const route = findRoute(routes, id);
    if (!route) return t("找不到元件組合「{id}」：它可能已被刪除或改名", { id });
    if (ditPlacement(route) === null) return t("元件組合「{label}」沒有 DiT 步驟", { label: route.label });
    lanes.push(route);
  }
  if (new Set(lanes.map((route) => route.capability)).size > 1) {
    return t("分流的元件組合必須是同一種任務（{tasks}）", { tasks: formatList(lanes.map((route) => `${route.label} (${route.capability})`)) });
  }
  if (new Set(lanes.map(ditPlacement)).size !== lanes.length) return t("有兩條元件組合用的是同一顆 DiT；分流的每一條要各用不同的 DiT");
  return null;
}

/** The lanes that are ready now, in their order. */
export function readyLanes(routes: readonly StudioRoute[], laneIds: readonly string[]): StudioRoute[] {
  return laneIds.flatMap((id) => {
    const route = findRoute(routes, id);
    return (route?.ready === true) ? [route] : [];
  });
}

/**
 * The route to check a shot against before a render is sent (can it render at all?): its own route, or the first ready
 * lane when its route is a lane that is not ready. The render itself may still pick a faster lane.
 */
export function laneRouteFor(routes: readonly StudioRoute[], laneIds: readonly string[], shot: StudioShot): string {
  if (laneIds.length < MIN_LANES || !laneIds.includes(shot.route) || (findRoute(routes, shot.route)?.ready === true)) return shot.route;
  return readyLanes(routes, laneIds)[0]?.id ?? shot.route;
}

/**
 * How many recordings the cost profiles hold of a lane's DiT time: the fitted denoise stage of the profile the
 * estimator would use for its DiT step (selectProfile, as profileEstimator does); 0 = no speed record yet.
 */
export function ditRecords(route: StudioRoute, fits: readonly ProfileFit[]): number {
  const dit = route.steps.find((item) => item.step.step_id === route.ditStepId);
  if (!dit) return 0;
  const match = selectProfile(fits, { nodeId: dit.step.node_id, componentId: dit.step.component_id, deviceId: dit.slot.component?.device.id ?? null });
  return match.kind === "none" ? 0 : (findStage(match.profile, "denoise", STAGE_UNITS.denoise)?.samples ?? 0);
}

export interface LaneReport {
  routeId: string;
  label: string;
  shotIds: string[];
  /** Predicted DiT seconds of the shots on this lane, one after the other (0 when nothing was estimated). */
  seconds: number;
  /** The lane's DiT has no speed record yet, so nothing on it is estimated: the shots it gets measure it (placeShots). */
  measuring: boolean;
}

export interface LaneMove {
  shotId: string;
  from: string;
  to: string;
}

export type LaneSplit =
  | { problem: null; shots: StudioShot[]; lanes: LaneReport[]; moves: LaneMove[]; skipped: string[] }
  | { problem: string; shots: null; lanes: null; moves: null; skipped: null };

/**
 * The DiT seconds of every movable shot on every ready lane (null where unknown), as the estimator predicts them for
 * a loaded, warm component, and which lanes have a speed record. A lane has none when the estimator gives its DiT no
 * time for any shot whose DiT work it can compute (reference sizes and step count known): the cost profiles hold no
 * fitted denoise time for it. Without such a shot nothing speaks against the lane, and it counts as measured.
 */
async function laneTimes(
  project: StudioProject,
  shots: readonly StudioShot[],
  movable: readonly number[],
  lanes: readonly StudioRoute[],
  estimator: SegmentEtaEstimator,
  signal?: AbortSignal,
): Promise<{ seconds: (number | null)[][]; measured: boolean[] }> {
  const seconds: (number | null)[][] = movable.map(() => lanes.map(() => null));
  const asked: { row: number; lane: number; input: SegmentEtaInput }[] = [];
  movable.forEach((shotIndex, row) => {
    const shot = shots[shotIndex];
    if (!shot) return;
    lanes.forEach((route, lane) => {
      const input = shotEtaInput(project, { ...shot, route: route.id }, route, true);
      if (input) asked.push({ row, lane, input });
    });
  });
  const etas = asked.length > 0 ? await estimator.estimate(asked.map((item) => item.input), signal) : [];
  asked.forEach((item, index) => {
    const step = lanes[item.lane]?.ditStepId;
    const value = (step != null && step !== "") ? etas[index]?.steps?.[step] : undefined;
    const row = seconds[item.row];
    if (row && typeof value === "number" && Number.isFinite(value) && value > 0) row[item.lane] = value;
  });
  const workKnown = (input: SegmentEtaInput) => input.steps !== null && Number.isFinite(input.steps) && input.steps > 0;
  const measured = lanes.map((_route, lane) => {
    const known = asked.filter((item) => item.lane === lane && workKnown(item.input));
    return known.length === 0 || known.some((item) => seconds[item.row]?.[lane] !== null);
  });
  return { seconds, measured };
}

/**
 * The lane of each shot (in order) and the predicted DiT seconds each lane gets, from seconds[shot][lane] (null =
 * unknown), which lanes have a speed record and each shot's own lane (null when its route is not a ready lane).
 *
 * A lane without a speed record cannot be weighed, so the render measures it: when there are more shots than such
 * lanes, the first shots go one to each of them in lane order; otherwise none does. Every other shot goes to the
 * measured lane that would finish it first (a tie goes to the lane named first); a shot without a time stays on its
 * own lane when that is a measured one, otherwise it goes to the first measured lane. With no measured lane nothing is
 * weighed: the first shots go one to each lane and the rest stay on their own lane, or go to the first.
 */
function placeShots(seconds: readonly (readonly (number | null)[])[], measured: readonly boolean[], own: readonly (number | null)[]): { picks: number[]; busy: number[] } {
  const busy = measured.map(() => 0);
  const unmeasured = measured.flatMap((known, lane) => (known ? [] : [lane]));
  const timed = measured.flatMap((known, lane) => (known ? [lane] : []));
  const first = timed.length === 0 || seconds.length > unmeasured.length ? unmeasured.length : 0;
  // In shot order: each pick adds to the busy time the next shots are weighed against
  const picks = seconds.map((row, shot) => {
    const home = own[shot] ?? null;
    if (shot < first) return unmeasured[shot] ?? 0;
    if (timed.length === 0) return home ?? 0;
    if (timed.some((lane) => (row[lane] ?? null) === null)) return home !== null && timed.includes(home) ? home : (timed[0] ?? 0);
    let pick = timed[0] ?? 0;
    let best = Number.POSITIVE_INFINITY;
    for (const lane of timed) {
      const finish = (busy[lane] ?? 0) + (row[lane] ?? 0);
      if (finish < best) {
        best = finish;
        pick = lane;
      }
    }
    busy[pick] = best;
    return pick;
  });
  return { picks, busy };
}

/**
 * The shots with their routes spread over the ready lanes. A shot whose own route is one of the lanes (ready or not)
 * goes to the ready lane that would finish its DiT call first (list scheduling in shot order; a tie goes to the lane
 * named first); every other shot keeps its route. A ready lane whose DiT has no speed record yet is measured instead:
 * it gets one of the first shots when there are more shots than such lanes (placeShots), and the next render weighs it
 * by that recording. A shot whose work cannot be estimated (a reference of unknown size) stays on its lane when that
 * lane is a measured ready one, otherwise it goes to the first measured lane. With one ready lane nothing is
 * estimated. The DiT seconds are the estimator's p50 for a loaded, warm component (cost profiles the controller fits
 * from its own recordings).
 */
export async function splitLanes(
  project: StudioProject,
  shots: readonly StudioShot[],
  routes: readonly StudioRoute[],
  laneIds: readonly string[],
  estimator: SegmentEtaEstimator,
  signal?: AbortSignal,
): Promise<LaneSplit> {
  const fail = (problem: string): LaneSplit => ({ problem, shots: null, lanes: null, moves: null, skipped: null });
  const problem = lanesProblem(routes, laneIds);
  if (problem != null && problem !== "") return fail(problem);
  const lanes = readyLanes(routes, laneIds);
  const skipped = laneIds.flatMap((id) => {
    const route = findRoute(routes, id);
    return route && !route.ready ? [route.label] : [];
  });
  if (lanes.length === 0) return fail(t("分流的元件組合都未就緒：{labels}", { labels: formatList(skipped.map((label) => routeName(label).name)) }));
  const movable = shots.flatMap((shot, index) => (laneIds.includes(shot.route) ? [index] : []));
  // With one ready lane there is nothing to weigh
  const { seconds, measured } =
    lanes.length > 1 ? await laneTimes(project, shots, movable, lanes, estimator, signal) : { seconds: movable.map(() => [null]), measured: [true] };
  const own = movable.map((shotIndex) => {
    const lane = lanes.findIndex((route) => route.id === shots[shotIndex]?.route);
    return lane >= 0 ? lane : null;
  });
  const { picks, busy } = placeShots(seconds, measured, own);

  const report: LaneReport[] = lanes.map((route, lane) => ({ routeId: route.id, label: route.label, shotIds: [], seconds: busy[lane] ?? 0, measuring: measured[lane] === false }));
  const out = [...shots];
  const moves: LaneMove[] = [];
  movable.forEach((shotIndex, row) => {
    const shot = shots[shotIndex];
    const lane = picks[row] ?? 0;
    const route = lanes[lane];
    const entry = report[lane];
    if (!shot || !route || !entry) return;
    entry.shotIds.push(shot.shot_id);
    if (shot.route !== route.id) {
      out[shotIndex] = { ...shot, route: route.id };
      moves.push({ shotId: shot.shot_id, from: shot.route, to: route.id });
    }
  });
  return { problem: null, shots: out, lanes: report, moves, skipped };
}

/**
 * The notice after a render with lanes, in plain words: how many shots went to each lane (by route name) and the lanes
 * skipped; then, when a lane without a speed record got a shot, that the next render uses the speed it measures, or,
 * when it got none, when it will.
 */
export function laneSummary(split: { lanes: readonly LaneReport[]; skipped: readonly string[] }): string {
  const part = (lane: LaneReport) => {
    const values = { label: routeName(lane.label).name, count: lane.shotIds.length };
    return lane.measuring ? t("{label} {count} 個鏡頭（還沒有速度紀錄，先渲染 {count} 個鏡頭量測）", values) : t("{label} {count} 個鏡頭", values);
  };
  const used = split.lanes.filter((lane) => lane.shotIds.length > 0);
  const parts = t("分流：{parts}", { parts: formatList(used.map(part)) });
  const summary = split.skipped.length > 0 ? t("{parts}（略過未就緒：{labels}）", { parts, labels: formatList(split.skipped.map((label) => routeName(label).name)) }) : parts;
  if (used.some((lane) => lane.measuring)) return t("{summary}。量到速度後，下次渲染會照實測的速度分配。", { summary });
  const idle = split.lanes.filter((lane) => lane.measuring);
  if (idle.length === 0) return summary;
  return t("{summary}。{labels} 還沒有速度紀錄，這次沒有分到鏡頭：批次渲染多個鏡頭時，會先分 1 個鏡頭給它量測。", {
    summary,
    labels: formatList(idle.map((lane) => routeName(lane.label).name)),
  });
}
