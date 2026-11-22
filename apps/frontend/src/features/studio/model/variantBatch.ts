// Variants of several shots at once (pure): the multi-selection's 渲染變體… applies one set of choices — the seeds, the
// file behind one @ name, the routes — to every selected shot, each shot then rendered as its own variants
// (model/variants.ts: the same axes, combinations, 2–8 takes per shot, badges and take records), and all of them go
// into one batch run. A file choice names the @ name by alias and kind, so it reaches every shot that has a reference
// of that name and kind; each shot's own file can be one of the files tried. A shot that cannot take the choices (no
// prompt, rendering, no such reference, too few or too many takes, its render check fails) is skipped with the reason.
// Also the checks the single-shot popover shares: the routes a shot's variants can try and the render check of its
// variants. Nothing here changes a shot.
import type { Catalog, StudioLibraryItem, StudioProject, StudioShot } from "@/api/generated/contracts";
import type { PluginRegistry } from "@/features/plugins";
import { t } from "@/i18n";
import { KIND_LABEL, type ReferenceKind } from "../references/materials";
import { continuityMode } from "./continuity";
import { laneRouteFor } from "./lanes";
import { MAX_TAKES, shotStatus } from "./project";
import { planRender, renderProblem, type RenderProblem } from "./renderPlan";
import { findRoute, routeContinuity, type StudioRoute } from "./routes";
import { MAX_RUN_STEPS } from "../swap/limits";
import { choicesProblem, previewShots, variantAxes, variantCount, type VariantAxes, type VariantChoices } from "./variants";

/** The routes a shot's variants can try: its own first, then the other ready ones of its task; none when there is no other. */
export function variantRoutes(shot: StudioShot, routes: readonly StudioRoute[], catalog: Catalog | undefined): StudioRoute[] {
  const own = findRoute(routes, shot.route);
  if (!own) return [];
  // Continuing from the previous shot also needs the frame extractor on the route's DiT machine
  const continuing = continuityMode(shot) === "previous_last";
  const others = routes.filter((route) => route.id !== own.id && route.capability === own.capability && (continuing ? routeContinuity(route, catalog).ready : route.ready));
  return others.length > 0 ? [own, ...others] : [];
}

export interface VariantCheckContext {
  routes: readonly StudioRoute[];
  catalog: Catalog | undefined;
  plugins: PluginRegistry;
  /** The project's DiT lanes: they move only variants that all stay on the shot's own route. */
  lanes: readonly string[];
}

/** The variants on the routes the send checks: on the lane the shot would move to while all of them keep its route. */
function onLanes(shot: StudioShot, preview: readonly StudioShot[], context: VariantCheckContext): StudioShot[] {
  const laneable = preview.every((item) => item.route === shot.route);
  return preview.map((item) => (laneable ? { ...item, route: laneRouteFor(context.routes, context.lanes, item) } : item));
}

/** The render check the send runs, on every variant of a shot (「第 2 個 take：…」); null when all of them pass. */
export function variantsProblem(project: StudioProject, shot: StudioShot, preview: readonly StudioShot[], context: VariantCheckContext): RenderProblem | null {
  for (const [index, item] of onLanes(shot, preview, context).entries()) {
    const blocked = renderProblem(project, item, context);
    if (blocked) return { ...blocked, text: t("第 {number} 個 take：{problem}", { number: index + 1, problem: blocked.text }) };
  }
  return null;
}

/** The choices of 渲染變體… for several shots: the seeds as in the popover; the file and the routes for every shot. */
export interface BatchVariantChoices extends Pick<VariantChoices, "ownSeed" | "randomSeeds" | "fixedSeeds"> {
  /** The @ name whose file varies (alias and kind), whether each shot's own file is tried and the library files to try; null = the files stay. */
  files: { alias: string; kind: ReferenceKind; own: boolean; itemIds: readonly string[] } | null;
  /** Whether each shot's own route is tried and the other routes; null = every shot's own route. */
  routes: { own: boolean; others: readonly string[] } | null;
}

export const INITIAL_BATCH_CHOICES: BatchVariantChoices = { ownSeed: false, randomSeeds: 2, fixedSeeds: [], files: null, routes: null };

/** One selected shot: its variants, or why it is skipped. */
export interface ShotVariantPlan {
  shot: StudioShot;
  /** The shot's axes; null when it is skipped. */
  axes: VariantAxes | null;
  /** The takes as they would be sent (random seeds still -1); empty when skipped. */
  preview: StudioShot[];
  skipped: string | null;
  /** Chosen routes this shot cannot try (another task, or not ready for it): they are left out of its takes. */
  unfitRoutes: string[];
}

export interface BatchVariantPlan {
  shots: ShotVariantPlan[];
  /** The takes of every shot that is not skipped. */
  takes: number;
  /** Why the run as a whole cannot be sent (no shot left, too many steps, the batch plan fails); null when it can. */
  problem: string | null;
}

/** A shot's choices from the batch's: the file by its @ name, the routes it can try. */
function shotChoices(shot: StudioShot, choices: BatchVariantChoices, options: readonly StudioRoute[]): { choices: VariantChoices; skipped: string | null; unfitRoutes: string[] } {
  let files: VariantChoices["files"] = null;
  let skipped: string | null = null;
  const pick = choices.files;
  if (pick) {
    const refs = shot.references ?? [];
    const ref = refs.find((item) => item.alias === pick.alias && item.kind === pick.kind);
    const other = refs.find((item) => item.alias === pick.alias);
    if (ref) files = { refId: ref.ref_id, itemIds: [...(pick.own ? [ref.item_id] : []), ...pick.itemIds] };
    else if (other) skipped = t("@{alias} 是{kind}，不是{wanted}", { alias: pick.alias, kind: KIND_LABEL[other.kind], wanted: KIND_LABEL[pick.kind] });
    else skipped = t("沒有{kind} @{alias}", { kind: KIND_LABEL[pick.kind], alias: pick.alias });
  }
  let routes: string[] | null = null;
  const unfitRoutes: string[] = [];
  if (choices.routes) {
    const usable = new Set(options.map((route) => route.id));
    routes = choices.routes.own ? [shot.route] : [];
    for (const id of choices.routes.others) {
      if (id === shot.route || usable.has(id)) routes.push(id);
      else unfitRoutes.push(id);
    }
  }
  return { choices: { ownSeed: choices.ownSeed, randomSeeds: choices.randomSeeds, fixedSeeds: choices.fixedSeeds, files, routes }, skipped, unfitRoutes };
}

/** Every selected shot with its variants or the reason it is skipped, and whether the whole run can be sent. */
export function batchVariantPlan(project: StudioProject, shots: readonly StudioShot[], choices: BatchVariantChoices, context: VariantCheckContext): BatchVariantPlan {
  const library: readonly StudioLibraryItem[] = project.library ?? [];
  const planned = shots.map((shot): ShotVariantPlan => {
    const skip = (skipped: string, unfitRoutes: string[] = []): ShotVariantPlan => ({ shot, axes: null, preview: [], skipped, unfitRoutes });
    if (!shot.prompt.trim()) return skip(t("還沒有 prompt"));
    if (shotStatus(shot, project) === "rendering") return skip(t("這個鏡頭正在渲染"));
    const route = findRoute(context.routes, shot.route);
    // The files of references only matter on a ref2va route (the popover offers them only there)
    if (choices.files && route?.capability !== "ref2va") return skip(t("路線不是 ref2va，不送參考素材"));
    const own = shotChoices(shot, choices, variantRoutes(shot, context.routes, context.catalog));
    if (own.skipped !== null) return skip(own.skipped, own.unfitRoutes);
    const axes = variantAxes(shot, own.choices, library);
    const count = variantCount(axes);
    const problem = choicesProblem(axes) ?? (shot.takes.length + count > MAX_TAKES ? t("這個鏡頭已有 {count} 個 take，最多 {max} 個", { count: shot.takes.length, max: MAX_TAKES }) : null);
    if (problem !== null) return skip(problem, own.unfitRoutes);
    const preview = previewShots(shot, axes);
    const blocked = variantsProblem(project, shot, preview, context);
    if (blocked) return skip(blocked.text, own.unfitRoutes);
    return { shot, axes, preview, skipped: null, unfitRoutes: own.unfitRoutes };
  });
  const branches = planned.flatMap((item) => onLanes(item.shot, item.preview, context));
  let problem: string | null = null;
  if (branches.length === 0) problem = t("沒有可以渲染變體的鏡頭");
  else {
    // The run as the batch sends it: one plan for every take (step ids, inputs, the contract's step limit)
    const result = planRender(project, branches, branches.map((_branch, index) => `preflight-${String(index)}`), { ...context, randomSeed: () => 0 });
    const steps = result.plan?.body.pipeline.steps.length ?? 0;
    if (!result.plan) problem = result.problem;
    else if (steps > MAX_RUN_STEPS) problem = t("這個 run 有 {steps} 個步驟，超過一個 run 的上限 {max}：少選幾個鏡頭、seed、檔案或路線", { steps, max: MAX_RUN_STEPS });
  }
  return { shots: planned, takes: branches.length, problem };
}
