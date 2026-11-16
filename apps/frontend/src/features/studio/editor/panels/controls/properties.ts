// The property model of Effect Controls: every animatable property of a clip (motion, mask and effect parameters)
// with the unit it is shown in, its fixed value and its keyframes, and the keyframe edits the rows, the lanes and the
// key strip make. Pure: every edit returns a new clip for the panel to apply.
import type { TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { AnimationChannel } from "../../animation";
import { animationChannels } from "../../animationChannels";
import { EFFECT_NAMES, type ClipEffect } from "../../compositing";
import { DEFAULT_BEZIER, evaluateCurve, upsertCurveKey } from "../../curves";
import { clipDuration, toClipLocalFrame, toProcessingFrame, windowBounds, type MotionChannel } from "../../model";
import { foldLegacyVolume } from "./audioLevel";
import { formatNumber, roundTo } from "./numbers";

/** How a document value is shown and typed: the editors' units (pixels, percent, degrees, decibels). */
export interface Unit {
  /** Shown after the number. */
  suffix: string;
  /** Decimals shown; 0 = whole numbers only. */
  decimals: number;
  /** What one press of an arrow key adds or takes away, in shown units. */
  step: number;
  toShown: (value: number) => number;
  fromShown: (shown: number) => number;
}

function scaled(factor: number, suffix: string, decimals: number, step = 1): Unit {
  return { suffix, decimals, step, toShown: (value) => value * factor, fromShown: (shown) => shown / factor };
}

export const UNITS = {
  /** The document keeps 1 for 100 %. */
  percent: scaled(100, "%", 1),
  /** A percentage that is only typed in whole numbers (contrast, saturation). */
  wholePercent: scaled(100, "%", 0),
  degrees: scaled(1, "°", 1),
  decibels: scaled(1, "dB", 1, 0.5),
  /** −100 … 100 around 0 (pan, brightness); the document keeps −1 … 1. */
  balance: scaled(100, "", 0),
  pixels: scaled(1, "px", 1, 0.5),
} as const;

/** The unit after a length or a position in time. */
export const FRAMES_SUFFIX = t("影格");

/**
 * A position: the document keeps the offset of the clip's centre as a fraction of the frame, the panel shows where
 * that centre is in pixels of the output frame (960 is the middle of a 1920 px frame), as editors expect.
 */
export function positionUnit(size: number): Unit {
  return { suffix: "px", decimals: 1, step: 1, toShown: (value) => (0.5 + value) * size, fromShown: (shown) => shown / size - 0.5 };
}

/** A document value in the unit's shown form, rounded to the decimals the field shows. */
export function shownValue(unit: Unit, value: number): number {
  return roundTo(unit.toShown(value), unit.decimals);
}

/** A typed number back in document form, inside the property's range (rounding noise of the conversion is dropped). */
export function storedValue(unit: Unit, shown: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, roundTo(unit.fromShown(shown), 6)));
}

export function formatShown(unit: Unit, value: number): string {
  const text = formatNumber(unit.toShown(value), unit.decimals);
  return unit.suffix ? `${text} ${unit.suffix}` : text;
}

/** One arrow-key step of the unit's field, in document units: the smallest change the curve graph makes. */
export function documentStep(unit: Unit): number {
  return Math.abs(unit.fromShown(unit.step) - unit.fromShown(0));
}

/** Width and height of the output frame, for positions in pixels. */
export interface FrameSize {
  width: number;
  height: number;
}

export interface ClipProperty {
  /** The channel key (animationChannels): stable while the clip keeps the effect or mask the property belongs to. */
  key: string;
  label: string;
  /** Named before the label where the property stands alone (the key strip); "" when the label says it all. */
  group: string;
  unit: Unit;
  min: number;
  max: number;
  /** The fixed value, in effect while the property has no keyframes. */
  value: number;
  keys: TimelineKeyframe[];
  withKeys: (keys: TimelineKeyframe[]) => TimelineClip;
  withValue: (value: number) => TimelineClip;
  /** Writes the fixed value into another version of the same clip (one whose keyframes were just changed). */
  fix: (clip: TimelineClip, value: number) => TimelineClip;
}

interface PropertyLook {
  /** Absent = the channel's own label. */
  label?: string;
  group: string;
  unit: Unit;
}

interface ParameterSpec {
  param: string;
  label: string;
  unit: Unit;
}

const MASK_PARAMETERS: readonly ParameterSpec[] = [
  { param: "x", label: t("左"), unit: UNITS.percent },
  { param: "y", label: t("上"), unit: UNITS.percent },
  { param: "width", label: t("寬"), unit: UNITS.percent },
  { param: "height", label: t("高"), unit: UNITS.percent },
  { param: "feather", label: t("羽化"), unit: UNITS.percent },
];

const EFFECT_PARAMETERS: Record<ClipEffect["kind"], readonly ParameterSpec[]> = {
  color: [
    { param: "brightness", label: t("亮度"), unit: UNITS.balance },
    { param: "contrast", label: t("對比"), unit: UNITS.wholePercent },
    { param: "saturation", label: t("飽和度"), unit: UNITS.wholePercent },
  ],
  blur: [{ param: "radius", label: t("半徑"), unit: UNITS.pixels }],
  chroma_key: [
    { param: "similarity", label: t("相似度"), unit: UNITS.wholePercent },
    { param: "blend", label: t("邊緣柔化"), unit: UNITS.wholePercent },
  ],
  glow: [
    { param: "intensity", label: t("強度"), unit: UNITS.wholePercent },
    { param: "radius", label: t("半徑"), unit: UNITS.pixels },
    { param: "threshold", label: t("門檻"), unit: UNITS.wholePercent },
  ],
  rgb_split: [
    { param: "offset", label: t("距離"), unit: UNITS.pixels },
    { param: "angle", label: t("角度"), unit: UNITS.degrees },
  ],
  vignette: [
    { param: "amount", label: t("強度"), unit: UNITS.wholePercent },
    { param: "softness", label: t("柔和度"), unit: UNITS.wholePercent },
  ],
  grain: [{ param: "amount", label: t("強度"), unit: UNITS.wholePercent }],
  directional_blur: [
    { param: "length", label: t("長度", undefined, { context: "blur-streak" }), unit: UNITS.pixels },
    { param: "angle", label: t("角度"), unit: UNITS.degrees },
  ],
  sharpen: [{ param: "amount", label: t("強度"), unit: UNITS.wholePercent }],
};

const VIDEO_MOTION: readonly MotionChannel[] = ["x", "y", "scale", "rotation", "opacity"];
const AUDIO_MOTION: readonly MotionChannel[] = ["gain_db", "pan"];

function motionLooks(frame: FrameSize): Record<MotionChannel, PropertyLook> {
  const motion = t("運動");
  const audio = t("音訊");
  return {
    x: { group: motion, unit: positionUnit(frame.width) },
    y: { group: motion, unit: positionUnit(frame.height) },
    scale: { group: motion, unit: UNITS.percent },
    rotation: { group: motion, unit: UNITS.degrees },
    opacity: { group: "", unit: UNITS.percent },
    gain_db: { group: audio, unit: UNITS.decibels },
    pan: { group: audio, unit: UNITS.balance },
  };
}

export function maskKey(param: string): string {
  return `mask:${param}`;
}

export function effectKey(effectId: string, param: string): string {
  return `effect:${effectId}:${param}`;
}

/** The parameters of an effect kind, in the order its rows show them. */
export function effectParameters(kind: ClipEffect["kind"]): readonly string[] {
  return EFFECT_PARAMETERS[kind].map((spec) => spec.param);
}

/** The parameters of a mask, in the order its rows show them. */
export const MASK_PARAMETER_NAMES: readonly string[] = MASK_PARAMETERS.map((spec) => spec.param);

/** An effect of the stack as its header and the key strip name it: "1. 色彩校正". */
export function effectTitle(effect: ClipEffect, index: number): string {
  return t("{index}. {name}", { index: index + 1, name: EFFECT_NAMES[effect.kind] });
}

function describe(clip: TimelineClip, channel: AnimationChannel, look: PropertyLook, fix: ClipProperty["fix"]): ClipProperty {
  return {
    key: channel.key,
    label: look.label ?? channel.label,
    group: look.group,
    unit: look.unit,
    min: channel.min,
    max: channel.max,
    value: channel.fallback,
    keys: channel.keys,
    withKeys: channel.update,
    withValue: (value) => fix(clip, value),
    fix,
  };
}

function withEffectParameter(effect: ClipEffect, param: string, value: number): ClipEffect {
  return { ...effect, [param]: value };
}

/** Every animatable property of a clip on a video or an audio track, in the order the panel lists them. */
export function clipProperties(clip: TimelineClip, kind: "video" | "audio", frame: FrameSize): ClipProperty[] {
  const channels = new Map(animationChannels(clip, kind).map((channel) => [channel.key, channel]));
  const out: ClipProperty[] = [];
  const add = (key: string, look: PropertyLook, fix: ClipProperty["fix"]) => {
    const channel = channels.get(key);
    if (channel) out.push(describe(clip, channel, look, fix));
  };
  const looks = motionLooks(frame);
  for (const key of kind === "audio" ? AUDIO_MOTION : VIDEO_MOTION) {
    add(key, looks[key], (target, value) => ({ ...target, motion: { ...target.motion, [key]: value } }));
  }
  if (kind === "audio") return out;
  for (const [index, effect] of (clip.effect_stack ?? []).entries()) {
    const group = effectTitle(effect, index);
    for (const spec of EFFECT_PARAMETERS[effect.kind]) {
      add(effectKey(effect.effect_id, spec.param), { label: spec.label, group, unit: spec.unit }, (target, value) => ({
        ...target,
        effect_stack: target.effect_stack?.map((item) => (item.effect_id === effect.effect_id ? withEffectParameter(item, spec.param, value) : item)),
      }));
    }
  }
  if (clip.mask) {
    for (const spec of MASK_PARAMETERS) {
      add(maskKey(spec.param), { label: spec.label, group: t("遮罩"), unit: spec.unit }, (target, value) =>
        target.mask ? { ...target, mask: { ...target.mask, [spec.param]: value } } : target,
      );
    }
  }
  return out;
}

export interface AudioProperties {
  /** The one volume of the clip: its gain with a legacy effect volume folded in. Its edits write the fold. */
  volume: ClipProperty;
  pan: ClipProperty;
  /** Legacy volume the gain could not take in (the sum would leave its range): still added on top; else 0. */
  legacy: number;
}

/** The sound properties of a clip on an audio track; null when the clip has no such channels. */
export function audioProperties(clip: TimelineClip, frame: FrameSize): AudioProperties | null {
  const folded = foldLegacyVolume(clip);
  const volume = clipProperties(folded.clip, "audio", frame).find((property) => property.key === "gain_db");
  const pan = clipProperties(clip, "audio", frame).find((property) => property.key === "pan");
  return volume && pan ? { volume, pan, legacy: folded.legacy } : null;
}

/** The property's name where its group is not on screen: "運動・位置 X". */
export function propertyName(property: ClipProperty): string {
  return property.group ? t("{group}・{label}", { group: property.group, label: property.label }) : property.label;
}

// ---------------------------------------------------------------------------------------------------- keyframes

/** Keys of one property (the contract's bound). */
export const KEY_LIMIT = 128;

/** The playhead in a clip's keyframe timebase. */
export interface ClipPlayhead {
  /** The frame keys are stored at (the complete processed clip, before its output window). */
  processing: number;
  /** Whether the playhead is on the clip (its last edge included: a curve cut at an edit ends on a key there). */
  inside: boolean;
}

export function playheadIn(clip: TimelineClip, frame: number): ClipPlayhead {
  const local = Math.round(frame - clip.start_frame);
  return { processing: toProcessingFrame(clip, local), inside: local >= 0 && local <= clipDuration(clip) };
}

/** The sequence frame a key of the clip sits on. */
export function sequenceFrame(clip: TimelineClip, key: TimelineKeyframe): number {
  return clip.start_frame + toClipLocalFrame(clip, key.frame);
}

/** The property's value at a keyframe-timebase frame: on its curve when it is animated, else its fixed value. */
export function valueAt(property: ClipProperty, processing: number): number {
  return evaluateCurve(property.keys, processing, property.value);
}

export function keyAt(property: ClipProperty, processing: number): TimelineKeyframe | undefined {
  return property.keys.find((key) => key.frame === processing);
}

/** The keys inside the part of the clip that plays (keys a trim left outside stay in the document, unseen). */
export function shownKeys(clip: TimelineClip, property: ClipProperty): TimelineKeyframe[] {
  const window = windowBounds(clip);
  return property.keys.filter((key) => key.frame >= window.start_frame && key.frame <= window.end_frame);
}

/** The nearest key before (−1) or after (1) a frame, among the keys inside the part of the clip that plays. */
export function neighbourKey(clip: TimelineClip, property: ClipProperty, processing: number, direction: -1 | 1): TimelineKeyframe | undefined {
  const shown = shownKeys(clip, property);
  return direction < 0 ? shown.findLast((key) => key.frame < processing) : shown.find((key) => key.frame > processing);
}

/** The key that shapes the curve under a frame: the key there, else the one before it, else the first one. */
export function governingKey(clip: TimelineClip, property: ClipProperty, processing: number): TimelineKeyframe | undefined {
  const shown = shownKeys(clip, property);
  return shown.find((key) => key.frame === processing) ?? shown.findLast((key) => key.frame < processing) ?? shown[0];
}

/** Why no key can be written while the playhead is not on the clip. */
export const KEY_OUTSIDE = t("把播放頭移到這個片段上，才能設定關鍵影格");
/** Why a property that has all the keys it can hold takes no further one. */
export const KEY_FULL = t("每個屬性最多 {count} 個關鍵影格", { count: KEY_LIMIT });

/** Why no key can be written at the playhead; null when one can. */
export function keyBlocked(property: ClipProperty, at: ClipPlayhead): string | null {
  if (!at.inside) return KEY_OUTSIDE;
  if (property.keys.length >= KEY_LIMIT && !keyAt(property, at.processing)) return KEY_FULL;
  return null;
}

/** A new value at the playhead: a key there when the property is animated, else its fixed value. */
export function withValueAt(property: ClipProperty, processing: number, value: number): TimelineClip {
  return property.keys.length > 0 ? property.withKeys(upsertCurveKey(property.keys, processing, value)) : property.withValue(value);
}

/** Removes every key; the value under the playhead stays as the fixed value, so the picture does not jump. */
export function withoutAnimation(property: ClipProperty, processing: number): TimelineClip {
  return property.fix(property.withKeys([]), valueAt(property, processing));
}

/** Removes one key; taking the last one away ends the animation with the value that key had. */
export function withoutKey(property: ClipProperty, frame: number): TimelineClip {
  const rest = property.keys.filter((key) => key.frame !== frame);
  return rest.length > 0 ? property.withKeys(rest) : withoutAnimation(property, frame);
}

/** Adds a key with the current value at the playhead, or removes the key that is there. */
export function withKeyToggled(property: ClipProperty, processing: number): TimelineClip {
  if (keyAt(property, processing)) return withoutKey(property, processing);
  return property.withKeys(upsertCurveKey(property.keys, processing, valueAt(property, processing)));
}

/**
 * One key changed (the key strip). A new interpolation or new handles restart the easing interval a cut may have left
 * on the key; choosing Bezier gives it the default handles.
 */
export function patchedKeys(keys: readonly TimelineKeyframe[], frame: number, patch: Partial<TimelineKeyframe>): TimelineKeyframe[] {
  return keys.map((key) => {
    if (key.frame !== frame) return key;
    const next = { ...key, ...patch };
    if (patch.interpolation || patch.bezier) delete next.curve_range;
    if (patch.interpolation === "bezier") next.bezier ??= [...DEFAULT_BEZIER];
    else if (patch.interpolation) delete next.bezier;
    return next;
  });
}

/** Keys in time order; null when two of them would share a frame. */
export function orderedKeys(keys: readonly TimelineKeyframe[]): TimelineKeyframe[] | null {
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  return new Set(sorted.map((key) => key.frame)).size === sorted.length ? sorted : null;
}

/** Why a key cannot be moved onto a frame another key of the property already has. */
export const KEY_COLLISION = t("同一個屬性在同一影格只能有一個關鍵影格");

/** What a drag in a lane or in the curve graph, or the fields of the key strip, change of a key. */
export type KeyChange = Partial<Pick<TimelineKeyframe, "frame" | "value">>;

/** One key with another frame, another value or both; null when it would land on another key. */
export function withKeyChanged(property: ClipProperty, frame: number, change: KeyChange): TimelineClip | null {
  const keys = orderedKeys(property.keys.map((key) => (key.frame === frame ? { ...key, ...change } : key)));
  return keys ? property.withKeys(keys) : null;
}

/** The frames of the keyframe timebase a key of the clip can be moved to: the part of the clip that plays. */
export function keyFrameRange(clip: TimelineClip): { min: number; max: number } {
  const window = windowBounds(clip);
  return { min: window.start_frame, max: window.end_frame };
}
