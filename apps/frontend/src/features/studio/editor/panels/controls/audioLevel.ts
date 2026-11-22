// One volume for a clip. Its loudness is motion.gain_db; older documents may also carry effects.volume_db, which the
// mixer adds on top. The Audio group shows the sum as one control and writes it to motion.gain_db alone. Pure.
import type { TimelineClip } from "@/api/generated/contracts";
import { MOTION_LIMITS } from "../../model";

const [GAIN_MIN, GAIN_MAX] = MOTION_LIMITS.gain_db;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface FoldedVolume {
  /** The clip as the volume control reads and writes it: the legacy volume folded into its gain and its gain keys. */
  clip: TimelineClip;
  /** Legacy volume that could not be folded in (a sum would leave the allowed range): still added on top; else 0. */
  legacy: number;
}

/**
 * Folds effects.volume_db into motion.gain_db (the fixed value and every key) and drops it: the same loudness in one
 * field. Nothing is written until the volume is edited: the caller patches the folded clip on that edit.
 */
export function foldLegacyVolume(clip: TimelineClip): FoldedVolume {
  const legacy = clip.effects?.volume_db ?? 0;
  if (legacy === 0) return { clip, legacy: 0 };
  const gain = round(clip.motion.gain_db + legacy);
  const keys = clip.motion.keyframes.gain_db?.map((key) => ({ ...key, value: round(key.value + legacy) }));
  const fits = (value: number) => value >= GAIN_MIN && value <= GAIN_MAX;
  if (!fits(gain) || Boolean(keys?.some((key) => !fits(key.value)))) return { clip, legacy };
  const { volume_db: _volume, ...effects } = clip.effects ?? {};
  const keyframes = keys ? { ...clip.motion.keyframes, gain_db: keys } : clip.motion.keyframes;
  return { clip: { ...clip, effects, motion: { ...clip.motion, gain_db: gain, keyframes } }, legacy: 0 };
}
