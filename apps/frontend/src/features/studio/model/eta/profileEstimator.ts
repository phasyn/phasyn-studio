// A SegmentEtaEstimator backed by cost profiles: a segment's request facts → predicted work (h3Work) → per-step
// estimates along its route (estimateSteps). Pure apart from the async interface; the caller supplies the profiles
// (fitted by the controller) and the routes (from the catalog, with each component's state, device and facts).
import type { ComponentState, CostProfile } from "@/api/generated/contracts";
import type { StudioRoute } from "../routes";
import { estimateSteps, selectProfile, type Estimate, type EstimateStep } from "./estimate";
import { h3Work, resolveH3Constants, type H3SegmentRequest } from "./h3Work";
import { worseRisk, type EtaRisk, type SegmentEta, type SegmentEtaEstimator, type SegmentEtaInput } from "./segment";
import type { H3Stage } from "./stages";
import { profileFit, type ProfileFit } from "./wire";

/** The modelled stages each H3 provider runs; other providers (mux, frame, concat…) are fixed-cost steps (per-call overhead). */
export const PROVIDER_STAGES: Readonly<Record<string, readonly H3Stage[]>> = {
  "h3.conditioning": ["encode"],
  "h3.reference": ["encode_image", "encode_video", "encode_keyframe", "encode_audio"],
  "h3.video_encode": ["encode_image", "encode_video", "encode_keyframe"],
  "h3.audio_encode": ["encode_audio"],
  "h3.dit": ["denoise"],
  "h3.video_decode": ["decode_video"],
  "h3.audio_decode": ["decode_audio"],
};

export interface EtaRouteStep {
  stepId: string;
  nodeId: string;
  componentId: string;
  /** From the catalog; null when the component is not in it. */
  providerId: string | null;
  resourceGroup: string | null;
  /** Steps whose outputs this step consumes. */
  dependsOn: readonly string[];
  deviceId?: string | null;
  loadDigest?: string | null;
  sourceRevision?: string | null;
  warm?: boolean | null;
  loaded?: boolean;
  /** The component descriptor's facts (unknown JSON; `cost_model` is read from it). */
  facts?: unknown;
}

export interface EtaRoute {
  /** Default output canvas when a segment does not give one. */
  width?: number;
  height?: number;
  steps: readonly EtaRouteStep[];
}

const LOADED: ReadonlySet<ComponentState> = new Set(["ready", "busy"]);

/** The estimator's view of a Studio route: each step's dependencies, device lane, load state and facts (from the catalog). */
export function etaRoute(route: StudioRoute): EtaRoute {
  return {
    steps: route.steps.map(({ step, providerId, slot }) => {
      const component = slot.component;
      return {
        stepId: step.step_id,
        nodeId: step.node_id,
        componentId: step.component_id,
        providerId,
        resourceGroup: component?.device.resource_group ?? null,
        deviceId: component?.device.id ?? null,
        dependsOn: [...new Set(Object.values(step.inputs).flatMap((binding) => ("from_step" in binding ? [binding.from_step] : [])))],
        loaded: component ? LOADED.has(component.state) : undefined,
        facts: component?.facts ?? undefined,
      };
    }),
  };
}

type Sized<T> = Omit<T, "width" | "height"> & { width: number; height: number };

/** The items with their sizes known; null when any size is unknown (the segment then gets no estimate). */
function knownSizes<T extends { width: number | null; height: number | null }>(items: readonly T[]): Sized<T>[] | null {
  const out: Sized<T>[] = [];
  for (const item of items) {
    if (item.width === null || item.height === null) return null;
    out.push({ ...item, width: item.width, height: item.height });
  }
  return out;
}

/** The request facts of a segment; null when they are not enough to compute its work (prompt length, canvas, reference sizes). */
export function segmentRequest(input: SegmentEtaInput, route: EtaRoute): H3SegmentRequest | null {
  const text =
    input.textTokens !== undefined ? { tokens: input.textTokens, approximate: input.textTokensApproximate === true } : input.promptCharacters !== undefined ? { characters: input.promptCharacters } : null;
  const width = input.width ?? route.width;
  const height = input.height ?? route.height;
  if (!text || width === undefined || height === undefined) return null;
  const images = knownSizes(input.images ?? []);
  const videos = knownSizes(input.videos ?? []);
  const audios = input.audios ?? [];
  if (!images || !videos || (input.characters > 0 && images.length !== input.characters)) return null;
  const task = input.task ?? (input.keyframe ? "fl2va" : images.length + videos.length + audios.length > 0 ? "ref2va" : "t2va");
  return { task, width, height, frames: input.frames, steps: input.steps, text, images, videos, audios, keyframe: input.keyframe === true, referenceVideoShortEdge: input.referenceVideoShortEdge, referenceImageShortEdge: input.referenceImageShortEdge };
}

/** Estimate of one segment on its route; null without enough request facts. */
export function estimateSegment(input: SegmentEtaInput, route: EtaRoute, fits: readonly ProfileFit[]): Estimate | null {
  const request = segmentRequest(input, route);
  if (!request) return null;
  const ditStep = route.steps.find((step) => step.providerId === "h3.dit");
  const teStep = route.steps.find((step) => step.providerId === "h3.conditioning");
  const work = h3Work(request, resolveH3Constants({ dit: ditStep?.facts, te: teStep?.facts }));
  // A later segment of the same run finds its components loaded and warm
  const continues = input.continuesBatch === true;
  const steps: EstimateStep[] = route.steps.map((step) => {
    const stages = step.providerId ? (PROVIDER_STAGES[step.providerId] ?? []) : [];
    return {
      stepId: step.stepId,
      nodeId: step.nodeId,
      componentId: step.componentId,
      resourceGroup: step.resourceGroup,
      dependsOn: step.dependsOn,
      work: work.stages.filter((item) => stages.includes(item.stage)),
      profile: selectProfile(fits, { nodeId: step.nodeId, componentId: step.componentId, deviceId: step.deviceId, loadDigest: step.loadDigest, sourceRevision: step.sourceRevision }),
      warm: continues ? true : step.warm,
      loaded: continues ? true : step.loaded,
    };
  });
  return estimateSteps(steps);
}

/**
 * The interface value: p50 with the p10–p90 band, the worst memory risk, and each known step's p50 with the critical
 * path (so a running render can converge on its finished steps); unknown (or nothing known) → null.
 */
export function toSegmentEta(estimate: Estimate | null): SegmentEta | null {
  if (!estimate?.total || estimate.basis === "unknown") return null;
  const risk = estimate.risks.reduce<EtaRisk | null>((worst, item) => worseRisk(worst, item.code === "OOM_RISK" ? "oom" : "beyond_measured"), null);
  const steps = Object.fromEntries(estimate.steps.flatMap((step) => (step.seconds ? [[step.stepId, step.seconds.p50] as const] : [])));
  return {
    seconds: estimate.total.p50,
    low: estimate.total.p10,
    high: estimate.total.p90,
    basis: estimate.basis,
    ...(estimate.samples === null ? {} : { samples: estimate.samples }),
    ...(risk ? { risk } : {}),
    steps,
    criticalPath: estimate.criticalPath,
  };
}

/** Estimator over a fixed set of profiles (wire objects from GET /api/cost-profiles) and routes, keyed by route id. */
export function profileEstimator(id: string, profiles: readonly CostProfile[], routes: Readonly<Record<string, EtaRoute>>): SegmentEtaEstimator {
  const fits = profiles.map(profileFit);
  return {
    id,
    estimate: (segments) =>
      Promise.resolve(
        segments.map((segment) => {
          const route = segment.routeId ? routes[segment.routeId] : undefined;
          return route ? toSegmentEta(estimateSegment(segment, route, fits)) : null;
        }),
      ),
  };
}
