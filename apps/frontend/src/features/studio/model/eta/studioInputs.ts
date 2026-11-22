// Estimator inputs for Video Studio renders: a shot as it would render now (next to the render buttons), or a take as
// it was sent (a running render, from the take's settings snapshot). Mirrors the render plan's decisions — the task
// (a first frame makes it fl2va), the DiT steps in effect, the reference media and the canvas — without validating;
// the render buttons say why a render cannot be sent. Null when the route is missing or a reference's size or length
// is unknown (no estimate then, rather than a guess). Pure.
import type { StudioLibraryItem, StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { heldReference } from "../../references";
import { referenceImageShortEdge, referenceVideoShortEdge } from "../../swap/limits";
import { continuityMode } from "../continuity";
import { h3Rules } from "../providerTraits";
import { ditDefaults, findRoute, type RouteTask, type StudioRoute } from "../routes";
import { approximateTextTokens } from "./h3Work";
import type { SegmentEtaInput } from "./segment";

interface ReferenceFacts {
  kind: "image" | "video" | "audio";
  item: StudioLibraryItem | undefined;
  start: number | null;
  end: number | null;
  /** A video whose own sound is sent (it takes an extra audio track). */
  withAudio: boolean;
  /** A video held after its end (hold_last_frame): its picture and sound count as the generated length. */
  held: boolean;
}

interface SegmentValues {
  prompt: string;
  frames: number;
  width: number;
  height: number;
  steps: number | null;
  task: RouteTask;
  references: readonly ReferenceFacts[];
  continuesBatch: boolean;
}

/** Seconds of a clip actually used (its end, or the file's end, minus its start); null when unknown. */
function clipSeconds(reference: ReferenceFacts): number | null {
  const end = reference.end ?? reference.item?.duration_seconds ?? null;
  return end === null ? null : Math.max(0, end - (reference.start ?? 0));
}

function ditFacts(route: StudioRoute): unknown {
  return route.steps.find((item) => item.step.step_id === route.ditStepId)?.slot.component?.facts;
}

function segmentInput(route: StudioRoute, values: SegmentValues): SegmentEtaInput | null {
  const images: { width: number; height: number }[] = [];
  const videos: { width: number; height: number; seconds: number; withAudio: boolean }[] = [];
  const audios: { seconds: number }[] = [];
  if (values.task === "ref2va") {
    for (const reference of values.references) {
      const width = reference.item?.width ?? null;
      const height = reference.item?.height ?? null;
      if (reference.kind === "image") {
        if (width === null || height === null) return null;
        images.push({ width, height });
        continue;
      }
      const seconds = reference.held ? values.frames / h3Rules(ditFacts(route)).fps : clipSeconds(reference);
      if (seconds === null) return null;
      if (reference.kind === "audio") {
        audios.push({ seconds });
        continue;
      }
      if (width === null || height === null) return null;
      videos.push({ width, height, seconds, withAudio: reference.withAudio });
    }
  }
  const dit = route.steps.find((item) => item.step.step_id === route.ditStepId)?.step;
  return {
    routeId: route.id,
    ditNodeId: dit?.node_id ?? null,
    ditComponentId: dit?.component_id ?? null,
    frames: values.frames,
    characters: images.length,
    referenceVideoShortEdge: referenceVideoShortEdge(route),
    referenceImageShortEdge: referenceImageShortEdge(route),
    steps: values.steps ?? ditDefaults(route).steps.value,
    task: values.task,
    width: values.width,
    height: values.height,
    textTokens: approximateTextTokens(values.prompt),
    textTokensApproximate: true,
    images,
    videos,
    audios,
    keyframe: values.task === "fl2va",
    continuesBatch: values.continuesBatch,
  };
}

/** A shot as it would render now; null when it cannot be estimated (no route, a first frame on a non-fl2va route, unknown media). */
export function shotEtaInput(project: StudioProject, shot: StudioShot, route: StudioRoute | null, continuesBatch = false): SegmentEtaInput | null {
  // The estimator models H3 work only; other families have no estimate (never an H3-shaped guess)
  if (route?.family !== "h3") return null;
  const firstFrame = continuityMode(shot) !== "none";
  // The render plan refuses these combinations; there is nothing to estimate then
  if (firstFrame ? route.capability !== "fl2va" : route.capability === "fl2va") return null;
  const items = new Map((project.library ?? []).map((item) => [item.item_id, item]));
  const references = (shot.references ?? []).map((reference): ReferenceFacts => {
    const item = items.get(reference.item_id);
    return {
      kind: reference.kind,
      item,
      start: reference.start_seconds,
      end: reference.end_seconds,
      withAudio: reference.kind === "video" && reference.use_embedded_audio !== false && item?.has_audio === true,
      held: heldReference(reference),
    };
  });
  return segmentInput(route, {
    prompt: shot.prompt,
    frames: shot.frames,
    width: project.format.width,
    height: project.format.height,
    steps: shot.steps,
    task: firstFrame ? "fl2va" : route.capability,
    references,
    continuesBatch,
  });
}

/** Shots rendered together in one run, in order (a later shot on a route used before finds its components loaded and warm). */
export function shotsEtaInputs(project: StudioProject, shots: readonly StudioShot[], routes: readonly StudioRoute[]): (SegmentEtaInput | null)[] {
  const used = new Set<string>();
  return shots.map((shot) => {
    const input = shotEtaInput(project, shot, findRoute(routes, shot.route), used.has(shot.route));
    used.add(shot.route);
    return input;
  });
}

/**
 * A take as it was sent (its own settings snapshot; reference sizes from the project library).
 *
 * Assumption: a reference video with its own sound counts as sending that sound. The take snapshot
 * (`StudioTakeReference`) does not record `use_embedded_audio`, so a take sent with the video's sound switched off is
 * estimated with one extra audio encode — a slight overestimate of its time left, never an underestimate.
 */
export function takeEtaInput(project: StudioProject, take: StudioTake, route: StudioRoute | null, continuesBatch = false): SegmentEtaInput | null {
  if (route?.family !== "h3" || take.prompt === null) return null;
  const items = new Map((project.library ?? []).map((item) => [item.file.file_id, item]));
  const references = (take.references ?? []).map((reference): ReferenceFacts => {
    const item = items.get(reference.file.file_id);
    return { kind: reference.kind, item, start: reference.start_seconds, end: reference.end_seconds, withAudio: reference.kind === "video" && item?.has_audio === true, held: heldReference(reference) };
  });
  return segmentInput(route, {
    prompt: take.prompt,
    frames: take.frames,
    width: take.width,
    height: take.height,
    steps: take.steps,
    task: take.task ?? route.capability,
    references,
    continuesBatch,
  });
}
