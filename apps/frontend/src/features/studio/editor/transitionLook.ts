// How the Program monitor draws one picture of a moving transition (push, slide, whip, wipe, zoom) at a frame: where it
// is (moved and scaled about the canvas centre), how opaque it is, what hides part of it and how much a whip blurs it.
// The pictures of a transition are added (plus-lighter), as the export sums them in premultiplied alpha; the shares
// are the export's (phasyn_media.composition_video._moving_mix): the picture that comes in front hides the one behind
// it under its canvas rectangle, a wipe is a moving soft edge. Pure.
import { DEFAULT_TRANSITION_EASING, DEFAULT_WIPE_SOFTNESS, easeProgress, type MovingTransition } from "../model/clipEffects";

/** A zoom travels through this factor, and a whip blurs this share of its travel at the middle (as the export). */
const ZOOM_FACTOR = 2;
const WHIP_BLUR = 0.035;
/** Stops of a smooth wipe edge in a CSS gradient (piecewise linear, within 1 % of the export's smooth step). */
const EDGE_STOPS = 9;

export type TransitionSide = "out" | "in";

/** What hides part of a picture, in its own (untransformed) box: a gradient along the travel, or a centred rectangle. */
export type LookMask =
  /** Opacity along the gradient line `to` an edge (positions 0…1 from the opposite edge). */
  | { kind: "edge"; to: "left" | "right" | "top" | "bottom"; stops: readonly (readonly [position: number, alpha: number])[] }
  /** 1 − gain inside a centred rectangle `size` of the box wide and high, 1 outside it. */
  | { kind: "centre"; size: number; gain: number };

export interface MovingLook {
  /** Offset in fractions of the canvas (right and down) and scale about its centre. */
  x: number;
  y: number;
  scale: number;
  opacity: number;
  mask: LookMask | null;
  /** A whip's Gaussian blur along its travel, sigma in sequence pixels. */
  blur: { x: number; y: number } | null;
}

const EDGES = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] } as const;
const GRADIENT_TO = { left: "left", right: "right", up: "top", down: "bottom" } as const;

/** The smooth step x²(3 − 2x) of `value` clamped to 0…1: a wipe's soft edge, and a dip's wash in the Program monitor. */
export function smoothStep(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

/** The share of the incoming picture along a wipe's travel (p = 0 where the edge starts), a smooth step `soft` wide. */
function wipeStops(edge: number, soft: number, incoming: boolean): [number, number][] {
  const stops: [number, number][] = [];
  for (let index = 0; index < EDGE_STOPS; index += 1) {
    const share = smoothStep(1 - index / (EDGE_STOPS - 1));
    stops.push([edge - soft / 2 + (soft * index) / (EDGE_STOPS - 1), incoming ? share : 1 - share]);
  }
  return stops;
}

/**
 * One picture of a moving transition at `progress` (k / frames on the k-th overlap frame, as a cross-fade's weights).
 * `width` and `height` are the sequence's: a wipe's hard edge is one sequence pixel wide and a whip's blur scales with
 * the distance the pictures travel.
 */
export function movingLook(transition: MovingTransition, side: TransitionSide, progress: number, width: number, height: number): MovingLook {
  const e = easeProgress(transition.easing ?? DEFAULT_TRANSITION_EASING, progress);
  const still: MovingLook = { x: 0, y: 0, scale: 1, opacity: 1, mask: null, blur: null };
  const outgoing = side === "out";
  if (transition.kind === "zoom") {
    const inward = transition.direction === "in";
    // Seen from the moving picture, the rectangle of the other one is always 1 / ZOOM_FACTOR of its own box
    const rectangle = (gain: number): LookMask => ({ kind: "centre", size: 1 / ZOOM_FACTOR, gain });
    if (inward) return outgoing ? { ...still, scale: ZOOM_FACTOR ** e, mask: rectangle(e) } : { ...still, scale: ZOOM_FACTOR ** (e - 1), opacity: e };
    return outgoing ? { ...still, scale: ZOOM_FACTOR ** -e, opacity: 1 - e } : { ...still, scale: ZOOM_FACTOR ** (1 - e), mask: rectangle(1 - e) };
  }
  const [dx, dy] = EDGES[transition.direction];
  const to = GRADIENT_TO[transition.direction];
  const travel = dx !== 0 ? width : height;
  const moved = (at: number) => ({ x: at * dx, y: at * dy });
  switch (transition.kind) {
    case "push":
      return { ...still, ...moved(outgoing ? e : e - 1) };
    case "whip": {
      const sigma = WHIP_BLUR * travel * Math.sin(Math.PI * e);
      return { ...still, ...moved(outgoing ? e : e - 1), blur: dx !== 0 ? { x: sigma, y: 0 } : { x: 0, y: sigma } };
    }
    case "slide":
      // The incoming picture covers the travel's first e: the outgoing one shows beyond it
      return outgoing ? { ...still, mask: { kind: "edge", to, stops: [[e, 0], [e, 1]] } } : { ...still, ...moved(e - 1) };
    case "wipe": {
      const soft = Math.max(transition.softness ?? DEFAULT_WIPE_SOFTNESS, 1 / travel);
      return { ...still, mask: { kind: "edge", to, stops: wipeStops(e * (1 + soft) - soft / 2, soft, !outgoing) } };
    }
  }
}
