// The Program monitor's video layers as an adjustment layer reads them. Every video layer registers the canvas it draws
// into while it is mounted and says when it drew; an adjustment layer composites the tracks under it from those canvases
// onto a canvas of its own, the way the monitor's DOM composites them (ProgramViewer's Layer): per track, its clips added
// (plus-lighter) with their own motion and their transition's place, mask, wash and opacity; the tracks bottom to top
// with their blend mode, over black, the export's empty canvas. The DOM and a 2D canvas composite by the same Compositing
// and Blending rules, so the adjustment layer works on what the monitor shows under it. Captions are drawn over every
// track and are never under an adjustment layer (as in the export).
import type { StudioTimeline, TimelineClip, TimelineTrack } from "@/api/generated/contracts";
import { clipEnabled, clipEnd, motionAt, trackClips } from "../model";
import type { LookMask } from "../transitionLook";
import { transitionAt, washFilter } from "./layerMix";

export interface LayerStack {
  /** A video layer's canvas while it is mounted; the returned function removes it. */
  register: (clipId: string, canvas: HTMLCanvasElement) => () => void;
  /** The canvas of a clip's layer, when it is mounted. */
  canvas: (clipId: string) => HTMLCanvasElement | undefined;
  /** A layer of the track at `order` (its place among the monitor's tracks, bottom first) drew a new picture. */
  drawn: (order: number) => void;
  /** Hears the place of each track that drew; the returned function stops. */
  listen: (listener: (order: number) => void) => () => void;
}

export function createLayerStack(): LayerStack {
  const canvases = new Map<string, HTMLCanvasElement>();
  const listeners = new Set<(order: number) => void>();
  return {
    register: (clipId, canvas) => {
      canvases.set(clipId, canvas);
      return () => {
        if (canvases.get(clipId) === canvas) canvases.delete(clipId);
      };
    },
    canvas: (clipId) => canvases.get(clipId),
    drawn: (order) => {
      for (const listener of listeners) listener(order);
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** What an adjustment layer reads at a frame: the visible video tracks under it, bottom to top. */
export interface BelowLayer {
  timeline: StudioTimeline;
  tracks: readonly TimelineTrack[];
  frame: number;
  /** The sequence size: transitions move pictures by fractions of it. */
  width: number;
  height: number;
}

const BLEND: Record<NonNullable<TimelineClip["blend_mode"]>, GlobalCompositeOperation> = { normal: "source-over", multiply: "multiply", screen: "screen", add: "lighter" };

/** Two scratch canvases of a target's size (a track's group and one layer), kept with the target. */
const scratches = new WeakMap<HTMLCanvasElement, readonly [CanvasRenderingContext2D, CanvasRenderingContext2D]>();

function scratch(target: HTMLCanvasElement): readonly [CanvasRenderingContext2D, CanvasRenderingContext2D] | null {
  let found = scratches.get(target);
  if (!found) {
    const make = () => document.createElement("canvas").getContext("2d");
    const group = make();
    const layer = make();
    if (!group || !layer) return null;
    found = [group, layer];
    scratches.set(target, found);
  }
  for (const context of found) {
    if (context.canvas.width !== target.width || context.canvas.height !== target.height) {
      context.canvas.width = target.width;
      context.canvas.height = target.height;
    }
  }
  return found;
}

function reset(context: CanvasRenderingContext2D): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.filter = "none";
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

type Stop = readonly [position: number, alpha: number];

const lerp = (left: Stop, right: Stop, position: number) => left[1] + ((right[1] - left[1]) * (position - left[0])) / (right[0] - left[0]);

/**
 * The alpha of a CSS gradient's stops (in order) just after (`side` 1) or just before (`side` -1) a position: linear
 * between stops, the end stop's beyond them; at stops on one position the one on that side.
 */
function stopAlpha(stops: readonly Stop[], position: number, side: 1 | -1): number {
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return 1;
  if (side > 0) {
    const index = stops.findLastIndex(([at]) => at <= position);
    const left = stops[index];
    const right = stops[index + 1];
    return !left ? first[1] : !right ? left[1] : lerp(left, right, position);
  }
  const index = stops.findIndex(([at]) => at >= position);
  const left = stops[index - 1];
  const right = stops[index];
  return !right ? last[1] : !left ? right[1] : lerp(left, right, position);
}

/** A moving transition's mask on a layer, in the layer's own box: the CSS mask of ProgramViewer's Layer as compositing. */
function applyMask(layer: CanvasRenderingContext2D, mask: LookMask): void {
  const { width, height } = layer.canvas;
  if (mask.kind === "edge") {
    // CSS linear-gradient(to <edge>): positions run from the opposite edge; a canvas takes stops inside 0…1 only
    const line = { right: [0, 0, width, 0], left: [width, 0, 0, 0], bottom: [0, 0, 0, height], top: [0, height, 0, 0] }[mask.to];
    const gradient = layer.createLinearGradient(line[0] ?? 0, line[1] ?? 0, line[2] ?? 0, line[3] ?? 0);
    const inside = mask.stops.filter(([position]) => position > 0 && position < 1);
    const stops: Stop[] = [[0, stopAlpha(mask.stops, 0, 1)], ...inside, [1, stopAlpha(mask.stops, 1, -1)]];
    for (const [position, alpha] of stops) gradient.addColorStop(position, `rgba(0, 0, 0, ${clamp01(alpha)})`);
    layer.globalCompositeOperation = "destination-in";
    layer.fillStyle = gradient;
    layer.fillRect(0, 0, width, height);
  } else {
    // 1 − gain inside the centred rectangle, 1 around it
    const side = { width: mask.size * width, height: mask.size * height };
    layer.globalCompositeOperation = "destination-out";
    layer.globalAlpha = clamp01(mask.gain);
    layer.fillRect((width - side.width) / 2, (height - side.height) / 2, side.width, side.height);
  }
  reset(layer);
}

/** One clip's layer added to its track's group, as the Layer's two boxes place it (the inner: its motion; the outer: its transition). */
function addLayer(group: CanvasRenderingContext2D, layer: CanvasRenderingContext2D, picture: HTMLCanvasElement, clip: TimelineClip, below: BelowLayer): void {
  const { width, height } = layer.canvas;
  const motion = motionAt(clip, below.frame);
  const mix = transitionAt(clip, below.timeline.clips, below.frame, below.width, below.height);
  reset(layer);
  layer.clearRect(0, 0, width, height);
  // translate(x %, y %) rotate() scale() about the centre of the box
  layer.translate(width / 2 + motion.x * width, height / 2 + motion.y * height);
  layer.rotate((motion.rotation * Math.PI) / 180);
  layer.scale(motion.scale, motion.scale);
  layer.globalAlpha = clamp01(motion.opacity);
  layer.drawImage(picture, -width / 2, -height / 2, width, height);
  reset(layer);
  const look = mix.look;
  if (look?.mask) applyMask(layer, look.mask);
  group.save();
  group.globalCompositeOperation = "lighter";
  group.globalAlpha = clamp01(mix.alpha * (look?.opacity ?? 1));
  if (mix.wash !== 0 || mix.white) group.filter = washFilter(mix);
  if (look && (look.x !== 0 || look.y !== 0 || look.scale !== 1)) {
    group.translate(width / 2 + look.x * width, height / 2 + look.y * height);
    group.scale(look.scale, look.scale);
    group.translate(-width / 2, -height / 2);
  }
  group.drawImage(layer.canvas, 0, 0);
  group.restore();
}

/**
 * Draws onto `target` (at its own size, the preview's) what the monitor shows under an adjustment layer: the tracks of
 * `below`, bottom to top, from the canvases of their mounted layers. A layer that is not mounted (no picture yet, a
 * failed one) adds nothing.
 */
export function composeBelow(target: HTMLCanvasElement, stack: LayerStack, below: BelowLayer): void {
  const context = target.getContext("2d");
  const scratchPair = scratch(target);
  if (!context || !scratchPair) return;
  const [group, layer] = scratchPair;
  reset(context);
  context.fillStyle = "#000";
  context.fillRect(0, 0, target.width, target.height);
  for (const track of below.tracks) {
    const clips = trackClips(below.timeline, track.track_id).filter((clip) => below.frame >= clip.start_frame && below.frame < clipEnd(clip) && clipEnabled(clip));
    const mode = clips[0]?.blend_mode ?? "normal";
    const pictures = clips.flatMap((clip) => {
      const picture = stack.canvas(clip.clip_id);
      return picture ? [{ clip, picture }] : [];
    });
    if (pictures.length === 0) continue;
    reset(group);
    group.clearRect(0, 0, target.width, target.height);
    for (const { clip, picture } of pictures) addLayer(group, layer, picture, clip, below);
    context.globalCompositeOperation = BLEND[mode];
    context.drawImage(group.canvas, 0, 0);
  }
  reset(context);
}
