// Clip effects (contract MediaClipEffects, the `effects` field of timeline clips): types, limits, labels, the frame
// formulas shared with the backend (phasyn_media.effects) and the title-layer key. Type-only imports, so the editor's
// domain modules can use it without reaching UI or I/O code.
import type { MediaClipEffects, MediaClipTitle } from "@/api/generated/contracts";
import { t } from "@/i18n";

export type Effects = MediaClipEffects;
export type Title = MediaClipTitle;
export type Fade = NonNullable<Effects["fade"]>;
export type Color = NonNullable<Effects["color"]>;
export type Hold = NonNullable<Effects["hold"]>;
export type Camera = NonNullable<Effects["camera"]>;
export type Impact = NonNullable<Effects["impact"]>;
export type ImpactStyle = Impact["style"];
export type TransitionKind = NonNullable<Effects["transition_out"]>["kind"];
export type Transition = Extract<NonNullable<Effects["transition_out"]>, { frames: number }>;
/** A transition that moves or uncovers the pictures: it has a direction (and an easing, a wipe also a softness). */
export type MovingTransition = Extract<Transition, { direction: string }>;
export type MovingKind = MovingTransition["kind"];
export type TransitionDirection = MovingTransition["direction"];
export type TransitionEasing = NonNullable<MovingTransition["easing"]>;
/** What a transition command may set besides kind and length; a kind keeps those of them it can have. */
export interface TransitionOptions {
  direction?: string;
  easing?: TransitionEasing;
  softness?: number;
}
export type TitlePosition = Title["position"];
export type TitleSize = Title["size"];

export const SPEED_MIN = 50;
export const SPEED_MAX = 200;
export const VOLUME_MIN_DB = -60;
export const VOLUME_MAX_DB = 12;
export const FADE_MAX_FRAMES = 1000;
export const TRANSITION_MAX_FRAMES = 240;
export const DEFAULT_TRANSITION_FRAMES = 12;
export const TITLE_MAX_LENGTH = 200;
export const HOLD_MAX_FRAMES = 240;
export const FRAME_STEP_MAX = 4;
export const FRAME_STEPS = [1, 2, 3, 4] as const;
export const ZOOM_MIN = 100;
export const ZOOM_MAX = 200;
export const SHAKE_MAX_PX = 64;
export const SHAKE_MAX_FRAMES = 1000;
export const IMPACT_MAX_FRAMES = 12;
export const IMPACT_STYLES = ["negative", "white", "black"] as const satisfies readonly ImpactStyle[];
/** Shake frequencies (radians per frame), the same as _SHAKE_X_RATE / _SHAKE_Y_RATE in phasyn_media.effects. */
export const SHAKE_X_RATE = 2.39;
export const SHAKE_Y_RATE = 3.17;
export const COLOR_DEFAULTS: Required<Omit<Color, "invert">> = { brightness: 0, contrast: 1, saturation: 1 };
export const FADE_KEYS = ["video_in", "video_out", "audio_in", "audio_out"] as const;

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  cut: t("直接切換"),
  crossfade: t("交叉溶接"),
  dip_to_black: t("淡入黑場"),
  dip_to_white: t("淡入白場"),
  push: t("推移"),
  slide: t("滑入"),
  whip: t("甩鏡"),
  wipe: t("擦除"),
  zoom: t("縮放轉場"),
};
/** The transitions a cut can take, in the order the menus and Effect Controls offer them. */
export const TRANSITION_KINDS = ["crossfade", "dip_to_black", "dip_to_white", "push", "slide", "whip", "wipe", "zoom"] as const satisfies readonly Exclude<TransitionKind, "cut">[];
/** The directions each moving kind can take, the default first (phasyn_components.timeline_edit.model). */
const EDGE_DIRECTIONS = ["left", "right", "up", "down"] as const;
const ZOOM_DIRECTIONS = ["in", "out"] as const;
export const TRANSITION_DIRECTIONS: Record<MovingKind, readonly TransitionDirection[]> = {
  push: EDGE_DIRECTIONS,
  slide: EDGE_DIRECTIONS,
  whip: EDGE_DIRECTIONS,
  wipe: EDGE_DIRECTIONS,
  zoom: ZOOM_DIRECTIONS,
};
export const TRANSITION_EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out"] as const satisfies readonly TransitionEasing[];
/** A moving transition without an easing eases in and out; a wipe without a softness has a 5 % soft edge. */
export const DEFAULT_TRANSITION_EASING: TransitionEasing = "ease_in_out";
export const DEFAULT_WIPE_SOFTNESS = 0.05;
export const WIPE_SOFTNESS_MAX = 0.5;
export const TRANSITION_DIRECTION_LABELS: Record<TransitionDirection, string> = {
  left: t("向左"),
  right: t("向右"),
  up: t("向上"),
  down: t("向下"),
  in: t("推近"),
  out: t("拉遠"),
};
/** Where a transition sits on its cut (Premiere's alignment; MediaClipTransitionCut.alignment). */
export type TransitionAlignment = NonNullable<Transition["cut"]>["alignment"];
/** The alignments, in the order Effect Controls and the transition's menu offer them. */
export const TRANSITION_ALIGNMENTS = ["center", "start", "end"] as const satisfies readonly TransitionAlignment[];
export const TRANSITION_ALIGNMENT_LABELS: Record<TransitionAlignment, string> = {
  center: t("置中於切點"),
  start: t("從切點開始"),
  end: t("在切點結束"),
};
export const TRANSITION_EASING_LABELS: Record<TransitionEasing, string> = {
  linear: t("線性"),
  ease_in: t("緩入"),
  ease_out: t("緩出"),
  ease_in_out: t("緩入緩出"),
};
export const IMPACT_STYLE_LABELS: Record<ImpactStyle, string> = { negative: t("黑白負片"), white: t("全白"), black: t("全黑") };
export const FRAME_STEP_LABELS: Record<(typeof FRAME_STEPS)[number], string> = {
  1: t("一拍一（原樣）"),
  2: t("一拍二"),
  3: t("一拍三"),
  4: t("一拍四"),
};

// ---------------------------------------------------------------------------------------------- frames

/** Clip frames after retiming: max(1, floor(frames × 100 / speed_percent)) (phasyn_media.effects.retimed_frames). */
export function retimedFrames(frames: number, speedPercent = 100): number {
  if (frames <= 0) return 0;
  return Math.max(1, Math.floor((frames * 100) / speedPercent));
}

/** The source frame (after trimming) the retimed frame k shows: floor(k × speed_percent / 100). */
export function sourceFrameAt(outputFrame: number, speedPercent = 100): number {
  return Math.floor((outputFrame * speedPercent) / 100);
}

/** Frames a clip takes on the sequence: retimed frames plus the holds at its head and tail (clip_frames). */
export function clipFramesOut(frames: number, effects: Effects | undefined): number {
  if (frames <= 0) return 0;
  return retimedFrames(frames, effects?.speed_percent ?? 100) + (effects?.hold?.start ?? 0) + (effects?.hold?.end ?? 0);
}

/**
 * The source frame (after trimming, from 0) behind output frame k of a clip, holds included: the head hold shows frame
 * 0, the tail hold the last frame, and in between every frame_step frames show their first frame at the clip's speed
 * (the same as FFmpeg's tpad / framestep / setpts).
 */
export function clipSourceFrame(effects: Effects | undefined, sourceFrames: number, k: number): number {
  const retimed = retimedFrames(sourceFrames, effects?.speed_percent ?? 100);
  const start = effects?.hold?.start ?? 0;
  const local = Math.max(0, Math.min(retimed - 1, k - start));
  const step = effects?.frame_step ?? 1;
  return sourceFrameAt(Math.floor(local / step) * step, effects?.speed_percent ?? 100);
}

/** dB → linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

// ---------------------------------------------------------------------------------------------- normalization

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clampInt(value: number | undefined, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Drops default values and clamps numbers to the contract's ranges; undefined when nothing is left (= no effects).
 * It never changes intent: only fields equal to their default go away.
 */
export function normalizeEffects(effects: Effects | undefined | null): Effects | undefined {
  if (!effects) return undefined;
  const out: Effects = {};
  const speed = clampInt(effects.speed_percent ?? 100, SPEED_MIN, SPEED_MAX);
  if (speed !== 100) out.speed_percent = speed;
  const volume = roundTo(Math.min(VOLUME_MAX_DB, Math.max(VOLUME_MIN_DB, effects.volume_db ?? 0)), 2);
  if (volume !== 0) out.volume_db = volume;
  if (effects.mute) out.mute = true;
  const fade: Fade = {};
  for (const key of FADE_KEYS) {
    const value = clampInt(effects.fade?.[key] ?? 0, 0, FADE_MAX_FRAMES);
    if (value > 0) fade[key] = value;
  }
  if (Object.keys(fade).length > 0) out.fade = fade;
  const color: Color = {
    brightness: roundTo(Math.min(1, Math.max(-1, effects.color?.brightness ?? 0)), 3),
    contrast: roundTo(Math.min(3, Math.max(0, effects.color?.contrast ?? 1)), 3),
    saturation: roundTo(Math.min(3, Math.max(0, effects.color?.saturation ?? 1)), 3),
  };
  if (effects.color?.invert) color.invert = true;
  if (color.brightness !== 0 || color.contrast !== 1 || color.saturation !== 1 || color.invert) out.color = color;
  const hold: Hold = {};
  const holdStart = clampInt(effects.hold?.start ?? 0, 0, HOLD_MAX_FRAMES);
  const holdEnd = clampInt(effects.hold?.end ?? 0, 0, HOLD_MAX_FRAMES);
  if (holdStart > 0) hold.start = holdStart;
  if (holdEnd > 0) hold.end = holdEnd;
  if (Object.keys(hold).length > 0) out.hold = hold;
  const step = clampInt(effects.frame_step ?? 1, 1, FRAME_STEP_MAX);
  if (step !== 1) out.frame_step = step;
  const camera: Camera = {};
  const zoom = clampInt(effects.camera?.zoom_percent ?? 100, ZOOM_MIN, ZOOM_MAX);
  const shakePx = clampInt(effects.camera?.shake_px ?? 0, 0, SHAKE_MAX_PX);
  const shakeFrames = clampInt(effects.camera?.shake_frames ?? 0, 0, SHAKE_MAX_FRAMES);
  if (zoom !== 100) camera.zoom_percent = zoom;
  if (shakePx > 0 && shakeFrames > 0) {
    camera.shake_px = shakePx;
    camera.shake_frames = shakeFrames;
  }
  if (Object.keys(camera).length > 0) out.camera = camera;
  const impact = effects.impact;
  if (impact && IMPACT_STYLES.includes(impact.style)) out.impact = { frames: clampInt(impact.frames, 1, IMPACT_MAX_FRAMES), style: impact.style };
  const title = effects.title;
  if (title && title.text.trim()) {
    const start = clampInt(title.start_frame, 0, 100_000);
    const end = title.end_frame === null ? null : Math.max(start + 1, clampInt(title.end_frame, 1, 100_000));
    out.title = { ...title, text: title.text.slice(0, TITLE_MAX_LENGTH), start_frame: start, end_frame: end };
  }
  const transition = effects.transition_out;
  if (transition && transition.kind !== "cut") {
    const softness = "softness" in transition && transition.softness !== undefined ? Math.min(WIPE_SOFTNESS_MAX, Math.max(0, transition.softness)) : undefined;
    out.transition_out = transitionOf(transition.kind, clampInt(transition.frames, 1, TRANSITION_MAX_FRAMES), { ...transition, softness });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The outgoing transition in effect (cut or unset = null). */
export function activeTransition(effects: Effects | undefined): Transition | null {
  const transition = effects?.transition_out;
  return transition && transition.kind !== "cut" ? transition : null;
}

/** Whether a transition moves or uncovers the pictures (push, slide, whip, wipe, zoom). */
export function isMoving(transition: Transition): transition is MovingTransition {
  return "direction" in transition;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

/**
 * A complete transition of `kind` (not cut) and `frames`. A moving kind takes its direction, easing and (a wipe)
 * softness from `hints` where a hint is one of its values, so a push changed into a slide keeps its direction;
 * otherwise it goes left (a zoom: in). The twin of transition_value in phasyn_components.timeline_edit.model.
 */
export function transitionOf(kind: Exclude<TransitionKind, "cut">, frames: number, hints: TransitionOptions = {}): Transition {
  const easing = pick(hints.easing, TRANSITION_EASINGS);
  const withEasing = easing ? { easing } : {};
  switch (kind) {
    case "crossfade":
    case "dip_to_black":
    case "dip_to_white":
      return { kind, frames };
    case "zoom":
      return { kind, frames, direction: pick(hints.direction, ZOOM_DIRECTIONS) ?? "in", ...withEasing };
    case "wipe": {
      const softness = hints.softness;
      const soft = softness !== undefined && Number.isFinite(softness) && softness >= 0 && softness <= WIPE_SOFTNESS_MAX ? { softness } : {};
      return { kind, frames, direction: pick(hints.direction, EDGE_DIRECTIONS) ?? "left", ...soft, ...withEasing };
    }
    case "push":
    case "slide":
    case "whip":
      return { kind, frames, direction: pick(hints.direction, EDGE_DIRECTIONS) ?? "left", ...withEasing };
  }
}

/**
 * Progress 0…1 through a transition's easing: the keyframe easings over a whole interval (ease-in t², ease-out
 * t(2 − t), ease-in-out t²(3 − 2t)), the same curves the export compiles (phasyn_media.composition_curves.eased).
 */
export function easeProgress(easing: TransitionEasing, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (easing) {
    case "linear":
      return x;
    case "ease_in":
      return x * x;
    case "ease_out":
      return x * (2 - x);
    case "ease_in_out":
      return x * x * (3 - 2 * x);
  }
}

// ---------------------------------------------------------------------------------------------- title layer

/** What a title layer was laid out from; a different title.image_key means the layer must be produced again. */
export function titleKey(title: Pick<Title, "text" | "position" | "size" | "style">, width: number, height: number): string {
  if (!title.style) return JSON.stringify(["title.v1", title.text, title.position, title.size, width, height]);
  const { font_family, font_size, font_weight, color, align, x, y } = title.style;
  return JSON.stringify(["title.v2", title.text, title.position, title.size, width, height, font_family, font_size, font_weight, color, align, x, y]);
}

export type TitleLayerState = "missing" | "stale" | "fresh";

export function titleLayerState(title: Title, width: number, height: number): TitleLayerState {
  if (!title.image) return "missing";
  return title.image_key === titleKey(title, width, height) ? "fresh" : "stale";
}
