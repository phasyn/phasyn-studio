import type { TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { curveSlice, evaluateCurve } from "./curves";
import { MOTION_CHANNELS } from "./model";

type Effect = NonNullable<TimelineClip["effect_stack"]>[number];
type Mask = NonNullable<TimelineClip["mask"]>;
/** A parameter of one effect kind that keyframes can animate. */
type EffectParameter<K extends Effect["kind"]> = NumericChannel & { key: keyof Extract<Effect, { kind: K }> & string };
export const EFFECT_ANIMATION = {
  color: [
    { key: "brightness", label: t("亮度偏移"), min: -1, max: 1, step: 0.01 },
    { key: "contrast", label: t("對比倍率"), min: 0, max: 4, step: 0.01 },
    { key: "saturation", label: t("飽和度倍率"), min: 0, max: 4, step: 0.01 },
  ],
  blur: [{ key: "radius", label: t("模糊半徑（px）"), min: 0, max: 64, step: 0.5 }],
  chroma_key: [
    { key: "similarity", label: t("色彩相似度"), min: 0.01, max: 1, step: 0.01 },
    { key: "blend", label: t("邊緣柔化"), min: 0, max: 1, step: 0.01 },
  ],
  glow: [
    { key: "intensity", label: t("光暈強度"), min: 0, max: 4, step: 0.01 },
    { key: "radius", label: t("光暈半徑（px）"), min: 0, max: 64, step: 0.5 },
    { key: "threshold", label: t("發光門檻"), min: 0, max: 1, step: 0.01 },
  ],
  rgb_split: [
    { key: "offset", label: t("分離距離（px）"), min: 0, max: 64, step: 0.5 },
    { key: "angle", label: t("分離角度"), min: -180, max: 180, step: 1 },
  ],
  vignette: [
    { key: "amount", label: t("暗角強度"), min: 0, max: 1, step: 0.01 },
    { key: "softness", label: t("暗角柔和度"), min: 0, max: 1, step: 0.01 },
  ],
  grain: [{ key: "amount", label: t("顆粒強度"), min: 0, max: 1, step: 0.01 }],
  directional_blur: [
    { key: "length", label: t("模糊長度（px）"), min: 0, max: 128, step: 0.5 },
    { key: "angle", label: t("模糊角度"), min: -180, max: 180, step: 1 },
  ],
  sharpen: [{ key: "amount", label: t("銳利化強度"), min: 0, max: 3, step: 0.01 }],
} as const satisfies { [K in Effect["kind"]]: readonly EffectParameter<K>[] };
export const MASK_ANIMATION = [
  { key: "x", label: t("遮罩左側"), min: 0, max: 1, step: 0.01 },
  { key: "y", label: t("遮罩上緣"), min: 0, max: 1, step: 0.01 },
  { key: "width", label: t("遮罩寬度"), min: 0.01, max: 1, step: 0.01 },
  { key: "height", label: t("遮罩高度"), min: 0.01, max: 1, step: 0.01 },
  { key: "feather", label: t("遮罩羽化"), min: 0, max: 0.5, step: 0.01 },
] as const;
interface NumericChannel { key: string; label: string; min: number; max: number; step: number }
export interface AnimationChannel extends NumericChannel {
  fallback: number;
  keys: TimelineKeyframe[];
  update: (keys: TimelineKeyframe[]) => TimelineClip;
}
function effectChannels(effect: Effect, clip: TimelineClip, index: number): AnimationChannel[] {
  const specs: readonly NumericChannel[] = EFFECT_ANIMATION[effect.kind];
  const values: Partial<Record<string, unknown>> = effect;
  const keyframes: Partial<Record<string, TimelineKeyframe[]>> = effect.keyframes ?? {};
  return specs.map((spec) => ({ ...spec, key: `effect:${effect.effect_id}:${spec.key}`, label: t("效果 {index}・{property}", { index: index + 1, property: spec.label }), fallback: Number(values[spec.key]), keys: keyframes[spec.key] ?? [],
    update: (keys) => clip.effect_stack ? ({ ...clip, effect_stack: clip.effect_stack.map((item) => item.effect_id === effect.effect_id ? { ...effect, keyframes: { ...effect.keyframes, [spec.key]: keys } } : item) }) : clip,
  }));
}
/** Stable IDs preserve the selected property when its effect is reordered. */
export function compositingChannels(clip: TimelineClip): AnimationChannel[] {
  const result: AnimationChannel[] = [];
  for (const [index, effect] of (clip.effect_stack ?? []).entries()) result.push(...effectChannels(effect, clip, index));
  const mask = clip.mask;
  if (mask) for (const spec of MASK_ANIMATION) result.push({ ...spec, key: `mask:${spec.key}`, fallback: mask[spec.key], keys: mask.keyframes?.[spec.key] ?? [], update: (keys) => ({ ...clip, mask: { ...mask, keyframes: { ...mask.keyframes, [spec.key]: keys } } }) });
  return result;
}

/** An effect with every animated parameter at its value on `frame` (the fixed value where it has no keys). */
export function effectAt<T extends Effect>(effect: T, frame: number): T {
  const keyframes: Partial<Record<string, TimelineKeyframe[]>> = effect.keyframes ?? {};
  const values: Partial<Record<string, unknown>> = effect;
  const animated: Record<string, number> = {};
  for (const spec of EFFECT_ANIMATION[effect.kind]) {
    const fixed = values[spec.key];
    if (typeof fixed === "number") animated[spec.key] = evaluateCurve(keyframes[spec.key], frame, fixed);
  }
  return { ...effect, ...animated };
}
export function maskAt(mask: Mask, frame: number): Mask {
  const result = { ...mask };
  for (const spec of MASK_ANIMATION) result[spec.key] = evaluateCurve(mask.keyframes?.[spec.key], frame, mask[spec.key]);
  return result;
}
/** Slicing preserves the same curve phase for effects and masks as it does for motion. */
export function sliceCompositing(clip: TimelineClip, from: number, to: number): Pick<TimelineClip, "effect_stack" | "mask"> {
  let current = clip;
  for (const channel of compositingChannels(clip)) {
    if (channel.keys.length) {
      const live = compositingChannels(current).find((item) => item.key === channel.key);
      if (live) current = live.update(curveSlice(channel.keys, from, to, channel.fallback));
    }
  }
  return { ...(current.effect_stack ? { effect_stack: current.effect_stack } : {}), ...(current.mask ? { mask: current.mask } : {}) };
}

/** Transform complete clip curves without routing domain operations through inspector metadata. */
export function mapClipKeyframes(clip: TimelineClip, transform: (keys: TimelineKeyframe[], fallback: number) => TimelineKeyframe[]): TimelineClip {
  let current = { ...clip, motion: { ...clip.motion, keyframes: { ...clip.motion.keyframes } } };
  for (const key of MOTION_CHANNELS) {
    const keys = current.motion.keyframes[key];
    if (keys?.length != null && Boolean(keys.length)) current.motion.keyframes[key] = transform(keys, current.motion[key]);
  }
  for (const channel of compositingChannels(current)) {
    if (!channel.keys.length) continue;
    const live = compositingChannels(current).find((item) => item.key === channel.key);
    if (live) current = live.update(transform(channel.keys, channel.fallback));
  }
  return current;
}
