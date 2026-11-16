// The In (進場) and Out (退場) animations of a text layer, as Effect Controls and the title templates apply them: plain
// keyframes on the layer's motion (position, scale, rotation, opacity) and on the radius of a blur effect, so the
// Program monitor and the export play them like any other keys. Nothing in the document marks a preset; it is
// recognised by its keys. On the channels it writes, an In owns the frames from its first key to its last (normally
// the layer's first frame to the end of the animation), an Out those from the start of its animation to the layer's
// last frame. Another preset or another length replaces exactly those keys and keeps every other key; 無 takes them
// away. Values are relative to what the text shows at rest (where the In ends, where the Out starts). Scale and
// rotation turn around the text's own anchor (its alignment point and vertical centre) instead of the middle of the
// frame: the position keys make up the difference. A preset that an edit of the layer's edges left away from its edge
// is still recognised, so it can be put back on the edge. Pure.
import type { TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { EFFECT_BOUNDS, MAX_EFFECTS, MAX_KEYFRAMES } from "@/api/generated/timelineLimits";
import { t } from "@/i18n";
import { defaultTitleStyle } from "../../model/titleLayout";
import type { ClipEffect } from "../compositing";
import { evaluateCurve, upsertCurveKey } from "../curves";
import { clipDuration, MOTION_LIMITS, windowBounds, type AllocateId, type TimelineResult } from "../model";

export type AnimationSide = "in" | "out";
export const ANIMATION_SIDES: readonly AnimationSide[] = ["in", "out"];

export type TextPresetId = "fade" | "rise" | "drop" | "slideLeft" | "slideRight" | "pop" | "shrink" | "blur" | "spin";

/** Width and height of the output frame, in pixels. */
export interface FrameSize {
  width: number;
  height: number;
}

/** The presets in the order the pickers list them, with what each side calls them (an Out plays its In backwards). */
export const TEXT_PRESETS: readonly { id: TextPresetId; in: string; out: string }[] = [
  { id: "fade", in: t("淡入"), out: t("淡出") },
  { id: "rise", in: t("上浮淡入"), out: t("下沉淡出") },
  { id: "drop", in: t("下沉淡入"), out: t("上浮淡出") },
  { id: "slideLeft", in: t("從左滑入"), out: t("向左滑出") },
  { id: "slideRight", in: t("從右滑入"), out: t("向右滑出") },
  { id: "pop", in: t("放大彈出"), out: t("縮小消失") },
  { id: "shrink", in: t("縮小進場"), out: t("放大淡出") },
  { id: "blur", in: t("模糊淡入"), out: t("模糊淡出") },
  { id: "spin", in: t("旋轉進場"), out: t("旋轉退場") },
];

/** What a side calls a preset. */
export function presetName(preset: TextPresetId, side: AnimationSide): string {
  const entry = TEXT_PRESETS.find((item) => item.id === preset);
  return entry ? entry[side] : preset;
}

/** The shortest animation (one frame would be a cut). */
export const MIN_ANIMATION_FRAMES = 2;

/** The length an animation starts with: half a second (12 frames at 24 fps). */
export function defaultAnimationFrames(fps: number): number {
  return Math.max(MIN_ANIMATION_FRAMES, Math.round(fps / 2));
}

// ---------------------------------------------------------------------------------------------------- presets

type Easing = Pick<TimelineKeyframe, "interpolation" | "bezier">;

const LINEAR: Easing = { interpolation: "linear" };
const EASE_OUT: Easing = { interpolation: "ease_out" };
/** Fast, then settling softly (an exponential ease-out): a title arriving. */
const SETTLE: Easing = { interpolation: "bezier", bezier: [0.16, 1, 0.3, 1] };
/** Quickly out towards the overshoot of a pop. */
const BURST: Easing = { interpolation: "bezier", bezier: [0.2, 0.9, 0.35, 1] };
/** Back from the overshoot, smooth at both ends. */
const RECOIL: Easing = { interpolation: "bezier", bezier: [0.45, 0, 0.55, 1] };

/** A key of a preset as its In plays it: where in the animation it is (0 = first frame, 1 = last) and its value relative to the text at rest. */
interface PresetKey {
  at: number;
  value: number;
  /** How it leads to the next key. */
  easing: Easing;
}

/**
 * What a preset animates: opacity and scale as factors of the resting value, rotation in degrees added to it, the
 * text's anchor moved by fractions of the frame's width and height, and the blur radius in pixels of a 1080-line
 * frame added to it. Every preset fades: its first and last opacity keys mark where it starts and ends.
 */
type Quantity = "opacity" | "scale" | "rotation" | "offsetX" | "offsetY" | "blur";
type PresetSpec = Partial<Record<Quantity, readonly PresetKey[]>>;

function settleFrom(value: number, rest: number, easing: Easing = SETTLE): PresetKey[] {
  return [
    { at: 0, value, easing },
    { at: 1, value: rest, easing: LINEAR },
  ];
}

const FADE_IN = settleFrom(0, 1, EASE_OUT);
/** Fully visible before the end of the animation (a pop, a spin): the shape takes the rest of it. */
function fadeInBy(at: number): PresetKey[] {
  return [
    { at: 0, value: 0, easing: EASE_OUT },
    { at, value: 1, easing: LINEAR },
    { at: 1, value: 1, easing: LINEAR },
  ];
}

const SPECS: Record<TextPresetId, PresetSpec> = {
  fade: { opacity: FADE_IN },
  rise: { opacity: FADE_IN, offsetY: settleFrom(0.06, 0) },
  drop: { opacity: FADE_IN, offsetY: settleFrom(-0.06, 0) },
  slideLeft: { opacity: FADE_IN, offsetX: settleFrom(-0.12, 0) },
  slideRight: { opacity: FADE_IN, offsetX: settleFrom(0.12, 0) },
  pop: {
    opacity: fadeInBy(0.4),
    scale: [
      { at: 0, value: 0.5, easing: BURST },
      { at: 0.6, value: 1.08, easing: RECOIL },
      { at: 1, value: 1, easing: LINEAR },
    ],
  },
  shrink: { opacity: FADE_IN, scale: settleFrom(1.25, 1) },
  blur: { opacity: FADE_IN, blur: settleFrom(16, 0) },
  spin: { opacity: fadeInBy(0.5), rotation: settleFrom(-45, 0), scale: settleFrom(0.6, 1) },
};

/** The order presets are recognised in: those that write more channels first (their opacity keys alone look like a fade). */
const RECOGNITION: readonly TextPresetId[] = ["spin", "pop", "blur", "shrink", "rise", "drop", "slideLeft", "slideRight", "fade"];

// ---------------------------------------------------------------------------------------------------- channels

type MotionKey = "x" | "y" | "scale" | "rotation" | "opacity";
type Channel = MotionKey | "blur";
const CHANNELS: readonly Channel[] = ["x", "y", "scale", "rotation", "opacity", "blur"];
type ChannelKeys = Partial<Record<Channel, TimelineKeyframe[]>>;
type Rest = Record<Channel, number>;

const LIMITS: Record<Channel, readonly [number, number]> = {
  x: MOTION_LIMITS.x,
  y: MOTION_LIMITS.y,
  scale: MOTION_LIMITS.scale,
  rotation: MOTION_LIMITS.rotation,
  opacity: MOTION_LIMITS.opacity,
  blur: EFFECT_BOUNDS.blur.radius,
};

type BlurEffect = Extract<ClipEffect, { kind: "blur" }>;

/** The id prefix of the blur effect a preset adds; such an effect is taken away again once nothing animates it. */
const OWN_BLUR = "textblur";

/** The blur effect a preset animates: the one with that id, else the first blur effect that is switched on. */
function blurEffect(clip: TimelineClip, blurId?: string | null): BlurEffect | null {
  const blurs = (clip.effect_stack ?? []).filter((effect): effect is BlurEffect => effect.kind === "blur");
  return (blurId ? blurs.find((effect) => effect.effect_id === blurId) : blurs.find((effect) => effect.enabled)) ?? null;
}

function channelKeys(clip: TimelineClip, channel: Channel, blurId?: string | null): readonly TimelineKeyframe[] {
  if (channel === "blur") return blurEffect(clip, blurId)?.keyframes?.radius ?? [];
  return clip.motion.keyframes[channel] ?? [];
}

function fixedValue(clip: TimelineClip, channel: Channel): number {
  if (channel === "blur") return blurEffect(clip)?.radius ?? 0;
  return clip.motion[channel];
}

/** The clip with other keys on a channel; a channel left without keys is dropped from the document. */
function withChannelKeys(clip: TimelineClip, channel: Channel, keys: TimelineKeyframe[], blurId?: string | null): TimelineClip {
  if (channel !== "blur") {
    const keyframes = { ...clip.motion.keyframes };
    if (keys.length > 0) keyframes[channel] = keys;
    else delete keyframes[channel];
    return { ...clip, motion: { ...clip.motion, keyframes } };
  }
  const effect = blurEffect(clip, blurId);
  if (!effect) return clip;
  const keyframes = { ...effect.keyframes };
  if (keys.length > 0) keyframes.radius = keys;
  else delete keyframes.radius;
  const next: BlurEffect = { ...effect, keyframes };
  if (Object.keys(keyframes).length === 0) delete next.keyframes;
  return { ...clip, effect_stack: clip.effect_stack?.map((item) => (item.effect_id === effect.effect_id ? next : item)) };
}

/** Every value at a keyframe-timebase frame: on its curve where the channel is animated, else its fixed value. */
function restAt(clip: TimelineClip, frame: number): Rest {
  const at = (channel: Channel) => evaluateCurve(channelKeys(clip, channel), frame, fixedValue(clip, channel));
  return { x: at("x"), y: at("y"), scale: at("scale"), rotation: at("rotation"), opacity: at("opacity"), blur: at("blur") };
}

/** Where the text's anchor (its alignment point, at the vertical centre of its lines) is from the middle of the frame, in pixels. */
function textAnchor(clip: TimelineClip, frame: FrameSize): { x: number; y: number } {
  const title = clip.effects?.title;
  if (!title) return { x: 0, y: 0 };
  const style = title.style ?? defaultTitleStyle(title);
  return { x: (style.x - 0.5) * frame.width, y: (style.y - 0.5) * frame.height };
}

// ---------------------------------------------------------------------------------------------------- keys of a preset

/** Two values this close are the same key (the document keeps them to six decimals). */
const TOLERANCE = 1e-5;

const round6 = (value: number) => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
};

function bounded(channel: Channel, value: number): number {
  const [low, high] = LIMITS[channel];
  return round6(Math.min(high, Math.max(low, value)));
}

function keyframe(frame: number, value: number, easing: Easing): TimelineKeyframe {
  if (easing.interpolation !== "bezier") return { frame, value, interpolation: easing.interpolation };
  return { frame, value, interpolation: "bezier", bezier: (easing.bezier ?? []).map(round6) };
}

/** An easing played backwards: ease-in and ease-out swap, a Bezier curve turns around its middle. */
function reversed(easing: Easing): Easing {
  switch (easing.interpolation) {
    case "ease_in":
      return { interpolation: "ease_out" };
    case "ease_out":
      return { interpolation: "ease_in" };
    case "bezier": {
      const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = easing.bezier ?? [];
      return { interpolation: "bezier", bezier: [1 - x2, 1 - y2, 1 - x1, 1 - y1] };
    }
    default:
      return easing;
  }
}

/** A preset's keys for one side: an Out plays the In backwards (each segment keeps its curve, mirrored). */
function oriented(keys: readonly PresetKey[], side: AnimationSide): PresetKey[] {
  if (side === "in") return [...keys];
  const back = [...keys].reverse();
  return back.map((key, index) => {
    const owner = back[index + 1];
    return { at: 1 - key.at, value: key.value, easing: owner ? reversed(owner.easing) : LINEAR };
  });
}

interface Placed {
  frame: number;
  value: number;
  easing: Easing;
}

/** Keys on frames from `start` to `end`; a key between them that a short animation leaves without a frame of its own is dropped. */
function placed(keys: readonly PresetKey[], start: number, end: number): Placed[] {
  const out: Placed[] = [];
  keys.forEach((key, index) => {
    const last = index === keys.length - 1;
    const frame = index === 0 ? start : last ? end : start + Math.round(key.at * (end - start));
    const previous = out.at(-1);
    if (index === 0 || last || (previous !== undefined && frame > previous.frame && frame < end)) out.push({ frame, value: key.value, easing: last ? LINEAR : key.easing });
  });
  return out;
}

/** The most segments position keys take to follow a rotation around an anchor away from the middle (one per frame below it). */
const MAX_SEGMENTS = 32;

function sampledFrames(start: number, end: number): number[] {
  const step = Math.max(1, Math.ceil((end - start) / MAX_SEGMENTS));
  const frames: number[] = [];
  for (let frame = start; frame < end; frame += step) frames.push(frame);
  frames.push(end);
  return frames;
}

/** An anchor this close to the middle of the frame (in pixels) turns in place. */
const CENTRED = 0.5;

/**
 * Position keys: the preset's own move of the anchor, plus what keeps the anchor where it should be while the scale
 * and the rotation turn the frame around its middle. Scale alone moves the anchor in proportion to itself, so keys on
 * the scale keys' frames with their curves follow it exactly; a rotation moves it on an arc, which keys on (nearly)
 * every frame follow.
 */
function positionKeys(spec: PresetSpec, side: AnimationSide, start: number, end: number, rest: Rest, anchor: { x: number; y: number }, frame: FrameSize, built: ChannelKeys): ChannelKeys {
  const track = (quantity: Quantity) => {
    const keys = spec[quantity];
    return keys ? placed(oriented(keys, side), start, end) : null;
  };
  const offsetX = track("offsetX");
  const offsetY = track("offsetY");
  const offsets = offsetX ?? offsetY;
  const scale = track("scale");
  const away = Math.hypot(anchor.x, anchor.y) >= CENTRED;
  let frames: { frame: number; easing: Easing }[];
  if (away && spec.rotation) frames = sampledFrames(start, end).map((at) => ({ frame: at, easing: LINEAR }));
  else if (away && scale) frames = scale;
  else if (offsets) frames = offsets;
  else return {};
  const offsetAt = (keys: Placed[] | null, at: number) => (keys ? evaluateCurve(keys.map((key) => keyframe(key.frame, key.value, key.easing)), at, 0) : 0);
  const turned = (factor: number, degrees: number) => {
    const angle = (degrees * Math.PI) / 180;
    return { x: factor * (anchor.x * Math.cos(angle) - anchor.y * Math.sin(angle)), y: factor * (anchor.x * Math.sin(angle) + anchor.y * Math.cos(angle)) };
  };
  const resting = turned(rest.scale, rest.rotation);
  const xs: TimelineKeyframe[] = [];
  const ys: TimelineKeyframe[] = [];
  for (const { frame: at, easing } of frames) {
    const now = turned(evaluateCurve(built.scale, at, rest.scale), evaluateCurve(built.rotation, at, rest.rotation));
    xs.push(keyframe(at, bounded("x", rest.x + offsetAt(offsetX, at) + (resting.x - now.x) / frame.width), easing));
    ys.push(keyframe(at, bounded("y", rest.y + offsetAt(offsetY, at) + (resting.y - now.y) / frame.height), easing));
  }
  const moves = (keys: readonly TimelineKeyframe[], value: number) => keys.some((key) => Math.abs(key.value - value) > TOLERANCE);
  return { ...(moves(xs, rest.x) ? { x: xs } : {}), ...(moves(ys, rest.y) ? { y: ys } : {}) };
}

/** Every key a preset writes on one side between two frames, from the values at rest. */
function presetKeys(preset: TextPresetId, side: AnimationSide, start: number, end: number, rest: Rest, anchor: { x: number; y: number }, frame: FrameSize): ChannelKeys {
  const spec = SPECS[preset];
  const out: ChannelKeys = {};
  const values: Record<"opacity" | "scale" | "rotation" | "blur", (relative: number) => number> = {
    opacity: (relative) => rest.opacity * relative,
    scale: (relative) => rest.scale * relative,
    rotation: (relative) => rest.rotation + relative,
    blur: (relative) => rest.blur + (relative * frame.height) / 1080,
  };
  for (const quantity of ["opacity", "scale", "rotation", "blur"] as const) {
    const keys = spec[quantity];
    if (keys) out[quantity] = placed(oriented(keys, side), start, end).map((key) => keyframe(key.frame, bounded(quantity, values[quantity](key.value)), key.easing));
  }
  return { ...out, ...positionKeys(spec, side, start, end, rest, anchor, frame, out) };
}

// ---------------------------------------------------------------------------------------------------- recognising

function sameBezier(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) <= TOLERANCE);
}

/** The keys a channel has between two frames are the preset's. The last one leads out of the animation: its curve is not the preset's. */
function sameKeys(actual: readonly TimelineKeyframe[], expected: readonly TimelineKeyframe[]): boolean {
  return (
    actual.length === expected.length &&
    expected.every((want, index) => {
      const have = actual[index];
      if (!have || have.frame !== want.frame || Math.abs(have.value - want.value) > TOLERANCE) return false;
      if (index === expected.length - 1) return true;
      return have.interpolation === want.interpolation && sameBezier(have.bezier, want.bezier) && have.curve_range === undefined;
    })
  );
}

/** A preset recognised on one side of a layer. */
interface PresetState {
  kind: "preset";
  preset: TextPresetId;
  /** Its first frame in the keyframe timebase; it ends `frames` later. */
  start: number;
  frames: number;
  /** It sits on its edge of the layer (an edit of the edge can leave it elsewhere). */
  aligned: boolean;
  /** The channels it wrote. */
  owned: readonly Channel[];
  /** The blur effect it animates. */
  blurId: string | null;
}

/** What one side of a layer has: no animation, keys of someone's own on its edge, or a preset. */
export type AnimationState = { kind: "none" } | { kind: "custom" } | PresetState;

/** How many keys a recognised preset owns (what taking it away removes). */
export function presetKeyCount(clip: TimelineClip, state: AnimationState): number {
  if (state.kind !== "preset") return 0;
  const end = state.start + state.frames;
  return state.owned.reduce((count, channel) => count + channelKeys(clip, channel, state.blurId).filter((key) => key.frame >= state.start && key.frame <= end).length, 0);
}

function recognised(clip: TimelineClip, side: AnimationSide, start: number, end: number, frame: FrameSize): { preset: TextPresetId; owned: Channel[] } | null {
  const rest = restAt(clip, side === "in" ? end : start);
  const anchor = textAnchor(clip, frame);
  for (const preset of RECOGNITION) {
    if (SPECS[preset].blur && !blurEffect(clip)) continue;
    const expected = presetKeys(preset, side, start, end, rest, anchor, frame);
    const owned = CHANNELS.filter((channel) => expected[channel] !== undefined);
    const inside = (channel: Channel) => channelKeys(clip, channel).filter((key) => key.frame >= start && key.frame <= end);
    if (owned.every((channel) => sameKeys(inside(channel), expected[channel] ?? []))) return { preset, owned };
  }
  return null;
}

/**
 * The preset one side of a text layer has, if any. Every preset starts and ends on an opacity key, with at most one
 * more between them. An In starts on the first opacity key of the part of the layer that plays (else, when an edit of
 * the edge left it outside, on the very first one) and ends on the next key or the one after; an Out ends on the last
 * key of the part that plays (else the very last one) and starts on the key before it or the one before that. The
 * longer one is tried first: the start of a pop or a spin alone would pass for a short fade.
 */
function presetOn(clip: TimelineClip, side: AnimationSide, frame: FrameSize): PresetState | null {
  const opacity = clip.motion.keyframes.opacity ?? [];
  const window = windowBounds(clip);
  const edges =
    side === "in" ? [opacity.find((key) => key.frame >= window.start_frame), opacity[0]] : [opacity.findLast((key) => key.frame <= window.end_frame - 1), opacity.at(-1)];
  const tried = new Set<number>();
  for (const edgeKey of edges) {
    if (!edgeKey || tried.has(edgeKey.frame)) continue;
    tried.add(edgeKey.frame);
    const at = opacity.indexOf(edgeKey);
    const candidates = side === "in" ? opacity.slice(at + 1, at + 3).reverse() : opacity.slice(Math.max(0, at - 2), at);
    for (const other of candidates) {
      const start = side === "in" ? edgeKey.frame : other.frame;
      const end = side === "in" ? other.frame : edgeKey.frame;
      const match = recognised(clip, side, start, end, frame);
      if (!match) continue;
      const aligned = side === "in" ? start === window.start_frame : end === window.end_frame - 1;
      const blurId = match.owned.includes("blur") ? (blurEffect(clip)?.effect_id ?? null) : null;
      return { kind: "preset", preset: match.preset, start, frames: end - start, aligned, owned: match.owned, blurId };
    }
  }
  return null;
}

/**
 * The animation one side of a text layer has: its preset, else 自訂 when keys of someone's own sit on the side's edge.
 * The other side's preset can reach that edge (one as long as the layer allows); its keys are not someone's own.
 */
export function detectTextAnimation(clip: TimelineClip, side: AnimationSide, frame: FrameSize): AnimationState {
  const preset = presetOn(clip, side, frame);
  if (preset) return preset;
  const window = windowBounds(clip);
  const edge = side === "in" ? window.start_frame : window.end_frame - 1;
  const other = presetOn(clip, side === "in" ? "out" : "in", frame);
  const theirs = (channel: Channel) => other !== null && other.owned.includes(channel) && edge >= other.start && edge <= other.start + other.frames;
  return CHANNELS.some((channel) => !theirs(channel) && channelKeys(clip, channel).some((key) => key.frame === edge)) ? { kind: "custom" } : { kind: "none" };
}

// ---------------------------------------------------------------------------------------------------- applying

/** The longest animation one side can take: the layer's length, less the other side's preset and a frame between them. */
export function animationLimit(clip: TimelineClip, other: AnimationState): number {
  return clipDuration(clip) - 1 - (other.kind === "preset" ? other.frames + 1 : 0);
}

/** Why a layer cannot take a blur animation (its effect stack is full); null when it can. */
export function blurUnavailable(clip: TimelineClip): string | null {
  if (blurEffect(clip)) return null;
  return (clip.effect_stack?.length ?? 0) >= MAX_EFFECTS ? t("效果已達 {count} 個上限，無法加入模糊效果", { count: MAX_EFFECTS }) : null;
}

/** The clip without the keys a recognised preset owns. */
function withoutPreset(clip: TimelineClip, state: PresetState): TimelineClip {
  const end = state.start + state.frames;
  return state.owned.reduce(
    (current, channel) => withChannelKeys(current, channel, channelKeys(current, channel, state.blurId).filter((key) => key.frame < state.start || key.frame > end), state.blurId),
    clip,
  );
}

/** A blur effect a preset added goes again once nothing animates it (it would blur nothing); so does a stack it leaves empty. */
function withoutIdleBlur(clip: TimelineClip): TimelineClip {
  const stack = clip.effect_stack;
  const idle = (effect: ClipEffect) => effect.kind === "blur" && effect.effect_id.startsWith(OWN_BLUR) && effect.radius === 0 && !effect.keyframes?.radius?.length;
  if (!stack?.some(idle)) return clip;
  const kept = stack.filter((effect) => !idle(effect));
  if (kept.length > 0) return { ...clip, effect_stack: kept };
  const { effect_stack: _stack, ...rest } = clip;
  return rest;
}

/**
 * The keys of a channel with a preset's keys between two frames, in place of whatever was there. The resting key
 * enters the curve the way any new key does, so the curve beyond the animation keeps its shape; on an In it also
 * keeps the curve that leads on from there.
 */
function written(keys: readonly TimelineKeyframe[], generated: readonly TimelineKeyframe[], side: AnimationSide, start: number, end: number): TimelineKeyframe[] {
  const boundary = side === "in" ? end : start;
  const resting = generated.find((key) => key.frame === boundary);
  if (!resting) return [...keys];
  const entered = upsertCurveKey(keys, boundary, resting.value);
  const joint = entered.find((key) => key.frame === boundary);
  const kept = entered.filter((key) => key.frame < start || key.frame > end);
  const animation = generated.map((key) => (side === "in" && joint && key.frame === boundary ? { ...joint, value: key.value } : key));
  return [...kept, ...animation].sort((a, b) => a.frame - b.frame);
}

/** Why a side cannot take an animation of that many frames. */
export function framesProblem(clip: TimelineClip, frames: number, other: AnimationState): string | null {
  const limit = animationLimit(clip, other);
  if (limit < MIN_ANIMATION_FRAMES) return other.kind === "preset" ? t("片段太短，放不下進場和退場兩段動畫") : t("片段太短，放不下動畫");
  if (!Number.isSafeInteger(frames) || frames < MIN_ANIMATION_FRAMES || frames > limit) return t("動畫長度需為 {min}–{max} 影格", { min: MIN_ANIMATION_FRAMES, max: limit });
  return null;
}

function place(
  clip: TimelineClip,
  side: AnimationSide,
  preset: TextPresetId | null,
  frames: number,
  frame: FrameSize,
  allocate: AllocateId,
  previous: PresetState | null,
  at: number | null,
): TimelineResult<TimelineClip> {
  let next = previous ? withoutPreset(clip, previous) : clip;
  if (preset === null) return { ok: true, value: withoutIdleBlur(next) };
  const other = detectTextAnimation(next, side === "in" ? "out" : "in", frame);
  const problem = framesProblem(next, frames, other);
  if (problem) return { ok: false, error: problem };
  const window = windowBounds(next);
  const start = at ?? (side === "in" ? window.start_frame : window.end_frame - 1 - frames);
  const end = start + frames;
  if (other.kind === "preset" && end >= other.start && start <= other.start + other.frames) return { ok: false, error: t("進場與退場動畫不能重疊；請縮短其中一段") };
  if (SPECS[preset].blur && !blurEffect(next)) {
    const full = blurUnavailable(next);
    if (full) return { ok: false, error: full };
    // At rest it blurs nothing: only the animation's keys do
    const blur: BlurEffect = { effect_id: allocate(OWN_BLUR), enabled: true, kind: "blur", radius: 0 };
    next = { ...next, effect_stack: [...(next.effect_stack ?? []), blur] };
  }
  const generated = presetKeys(preset, side, start, end, restAt(next, side === "in" ? end : start), textAnchor(next, frame), frame);
  for (const channel of CHANNELS) {
    const keys = generated[channel];
    if (!keys) continue;
    const merged = written(channelKeys(next, channel), keys, side, start, end);
    if (merged.length > MAX_KEYFRAMES) return { ok: false, error: t("每個屬性最多 {count} 個關鍵影格", { count: MAX_KEYFRAMES }) };
    next = withChannelKeys(next, channel, merged);
  }
  return { ok: true, value: withoutIdleBlur(next) };
}

/**
 * The layer with a preset on one side (on its edge, `frames` long), in place of the preset that side had; null takes
 * the side's preset away. Keys of someone's own outside the animation stay. `allocate` names a blur effect when the
 * preset needs one the layer does not have.
 */
export function withTextAnimation(clip: TimelineClip, side: AnimationSide, preset: TextPresetId | null, frames: number, frame: FrameSize, allocate: AllocateId): TimelineResult<TimelineClip> {
  return place(clip, side, preset, frames, frame, allocate, presetOn(clip, side, frame), null);
}

/** The layer without the presets of both sides. */
export function withoutTextAnimations(clip: TimelineClip, frame: FrameSize): TimelineClip {
  return ANIMATION_SIDES.reduce((current, side) => {
    const state = presetOn(current, side, frame);
    return state ? withoutIdleBlur(withoutPreset(current, state)) : current;
  }, clip);
}

/**
 * A text that moved (its place or alignment) takes its animations along: the presets the layer had are written again
 * around the new anchor, on the same frames. `after` is the layer with the new text; `before` the one it replaces.
 */
export function withTextAnimationsKept(before: TimelineClip, after: TimelineClip, frame: FrameSize, allocate: AllocateId): TimelineClip {
  const from = textAnchor(before, frame);
  const to = textAnchor(after, frame);
  if (Math.abs(from.x - to.x) < TOLERANCE && Math.abs(from.y - to.y) < TOLERANCE) return after;
  return ANIMATION_SIDES.reduce((current, side) => {
    const state = presetOn(before, side, frame);
    if (!state) return current;
    const moved = place(current, side, state.preset, state.frames, frame, allocate, state, state.start);
    return moved.ok ? moved.value : current;
  }, after);
}
