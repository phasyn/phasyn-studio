// What a swap proved on its DiT: every segment take that succeeded is a request that fitted — its character count,
// its length, its picture and the preprocessed area of its character images. The swap panel offers to record that as
// the DiT's `limits.swap` when it goes beyond what the DiT declares, so a trial past the conservative default becomes
// the limit the wizard uses next time (the swap limits are data: , limits.swap). Only what ran is
// recorded and nothing is extrapolated; a route with an experimental reference video short edge is left out, because
// its limits belong to another entry. Pure.
import type { ComponentDescriptor, StudioProject } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import { findRoute, type StudioRoute } from "../model/routes";
import { maxFramesFor, referenceVideoShortEdge, routeDit, routeImageEdge } from "./limits";
import { MAX_SWAP_CHARACTERS, parseSwapLimits, swapCapacityJson, type ByCharacters, type SwapCapacity } from "./limitSpec";
import { preparedArea } from "./referenceImage";
import { t } from "@/i18n";

/** The longest note limits.swap keeps (limitSpec checks the same bound). */
const NOTE_MAX = 500;

/** One finished request: what the DiT ran without failing. */
interface Fit {
  characters: number;
  frames: number;
  pixels: number;
  /** Preprocessed area of its character images (px²); null when an image size is unknown. */
  area: number | null;
  format: string;
}

export interface SwapMeasurement {
  /** The DiT the segments ran on (the route's denoise step). */
  nodeId: string;
  componentId: string;
  label: string;
  component: ComponentDescriptor | null;
  /** Finished segment takes behind the measurement. */
  takes: number;
  /** The reference image short edge of the route (px). */
  imageEdge: number;
  /** Pictures the takes rendered (W×H), in the order first seen. */
  formats: string[];
  capacity: SwapCapacity;
}

/** Highest value per character count, where a fit with n characters also counts for fewer. */
function byCount(fits: readonly Fit[], max: number, value: (fit: Fit) => number | null): Record<number, number> {
  const table: Record<number, number> = {};
  for (let count = 1; count <= max; count += 1) {
    const values = fits.filter((fit) => fit.characters >= count).map(value).filter((item): item is number => item !== null);
    if (values.length > 0) table[count] = Math.max(...values);
  }
  return table;
}

/** A table only when it says more than its largest value: equal values for every count are one number. */
function distinct(table: Record<number, number>): ByCharacters | null {
  const values = Object.values(table);
  return values.length > 1 && new Set(values).size > 1 ? table : null;
}

function capacityOf(fits: readonly Fit[]): SwapCapacity {
  const maxCharacters = Math.min(MAX_SWAP_CHARACTERS, Math.max(...fits.map((fit) => fit.characters)));
  const frames = byCount(fits, maxCharacters, (fit) => fit.frames);
  const areas = byCount(fits, maxCharacters, (fit) => fit.area);
  return {
    maxCharacters,
    maxFrames: Math.max(...fits.map((fit) => fit.frames)),
    maxFramesByCharacters: distinct(frames),
    referenceAreaByCharacters: Object.keys(areas).length > 0 ? areas : null,
    maxOutputPixels: Math.max(...fits.map((fit) => fit.pixels)),
    beyondLimit: "untested",
    note: null,
  };
}

/**
 * The measurement of each DiT the project's succeeded swap takes ran on (usually one). A take counts when it is a
 * ref2va render with a reference video on a route whose DiT is known and whose reference video uses the official
 * short edge.
 */
export function swapMeasurements(project: StudioProject, routes: readonly StudioRoute[]): SwapMeasurement[] {
  const items = new Map((project.library ?? []).map((item) => [item.file.file_id, item]));
  const groups = new Map<string, { route: StudioRoute; fits: Fit[]; formats: string[] }>();
  for (const shot of project.shots) {
    for (const take of shot.takes) {
      if (take.state !== "succeeded" || take.task !== "ref2va") continue;
      const references = take.references ?? [];
      if (!references.some((ref) => ref.kind === "video")) continue;
      const route = findRoute(routes, take.route);
      const dit = routeDit(route);
      if (!route || !dit || referenceVideoShortEdge(route) !== null) continue;
      const step = route.steps.find((item) => item.step.step_id === route.ditStepId)?.step;
      if (!step) continue;
      const images = references.filter((ref) => ref.kind === "image");
      if (images.length === 0) continue;
      const sizes = images.map((ref) => ({ width: items.get(ref.file.file_id)?.width ?? null, height: items.get(ref.file.file_id)?.height ?? null }));
      const format = `${String(take.width)}×${String(take.height)}`;
      const key = `${step.node_id}/${step.component_id}`;
      const group = groups.get(key) ?? { route, fits: [], formats: [] };
      group.fits.push({ characters: images.length, frames: take.frames, pixels: take.width * take.height, area: preparedArea(sizes, routeImageEdge(route)), format });
      if (!group.formats.includes(format)) group.formats.push(format);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(({ route, fits, formats }) => {
    const dit = routeDit(route);
    const step = route.steps.find((item) => item.step.step_id === route.ditStepId)?.step;
    return {
      nodeId: step?.node_id ?? "",
      componentId: step?.component_id ?? "",
      label: dit?.label ?? "",
      component: dit?.component ?? null,
      takes: fits.length,
      imageEdge: routeImageEdge(route),
      formats,
      capacity: capacityOf(fits),
    };
  });
}

/** The DiT's declared capacity on the official reference video path; null when it declares none (or an invalid one). */
function declared(component: ComponentDescriptor | null): SwapCapacity | null {
  const parsed = parseSwapLimits(component?.limits);
  return parsed.kind === "ok" ? parsed.spec : null;
}

/** Whether the measurement says something the DiT does not declare yet: no limits at all, more characters, longer segments or larger images. */
export function measurementIsNew(measurement: SwapMeasurement): boolean {
  const known = declared(measurement.component);
  if (!known) return true;
  const found = measurement.capacity;
  if (found.maxCharacters > known.maxCharacters) return true;
  for (let count = 1; count <= found.maxCharacters; count += 1) {
    if (maxFramesFor(found, count) > maxFramesFor(known, count)) return true;
    const area = found.referenceAreaByCharacters?.[count];
    const knownArea = known.referenceAreaByCharacters?.[count];
    if (area !== undefined && knownArea !== undefined && area > knownArea) return true;
  }
  return false;
}

function mergeTables(a: ByCharacters | null, b: ByCharacters | null): ByCharacters | null {
  if (!a) return b;
  if (!b) return a;
  const out: Record<number, number> = { ...a };
  for (const [key, value] of Object.entries(b)) out[Number(key)] = Math.max(out[Number(key)] ?? 0, value);
  return out;
}

/** Frames per character count as a full table (1..max), from the per-count limit. */
function framesTable(capacity: SwapCapacity, max: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (let count = 1; count <= max; count += 1) out[count] = maxFramesFor(capacity, count);
  return out;
}

/**
 * The DiT's `limits` with the measurement recorded under `swap`: merged with what it already declares (each value the
 * larger one, the picture size the smaller one, so a value is never claimed for a bigger picture than it ran with),
 * the rest of `limits` untouched, and a dated note of what ran. `date` is YYYY-MM-DD.
 */
export function recordedLimits(measurement: SwapMeasurement, date: string): Record<string, unknown> {
  const limits: unknown = measurement.component?.limits;
  const rest = isRecord(limits) ? { ...limits } : {};
  const known = declared(measurement.component);
  const found = measurement.capacity;
  // Stored text: the pictures joined with a neutral separator, not the interface's list format
  const line = t("{date} 一鍵換角：{takes} 段跑完（{formats}，參考圖短邊 {edge}）", { date, takes: measurement.takes, formats: measurement.formats.join(" / "), edge: measurement.imageEdge });
  let capacity: SwapCapacity = { ...found, note: line };
  if (known) {
    const maxCharacters = Math.max(known.maxCharacters, found.maxCharacters);
    const frames = mergeTables(framesTable(known, maxCharacters), framesTable(found, maxCharacters));
    const frameValues = Object.values(frames ?? {});
    capacity = {
      maxCharacters,
      maxFrames: Math.max(known.maxFrames, found.maxFrames),
      maxFramesByCharacters: frames && new Set(frameValues).size > 1 ? frames : null,
      referenceAreaByCharacters: mergeTables(known.referenceAreaByCharacters, found.referenceAreaByCharacters),
      maxOutputPixels: known.maxOutputPixels === null ? found.maxOutputPixels : Math.min(known.maxOutputPixels, found.maxOutputPixels ?? known.maxOutputPixels),
      beyondLimit: known.beyondLimit,
      note: [known.note, line].filter(Boolean).join(t("；")).slice(-NOTE_MAX),
    };
  }
  // The official path's values are replaced as a whole; entries for other reference video short edges stay as they are
  const edges = isRecord(rest["swap"]) ? rest["swap"]["by_reference_short_edge"] : undefined;
  return { ...rest, swap: { ...swapCapacityJson(capacity), ...(edges === undefined ? {} : { by_reference_short_edge: edges }) } };
}
