// The animatable properties of a clip as keyframe channels: the motion channels of its track kind and, for a video
// clip, the parameters of its effects and its mask. Effect Controls builds its property rows on this list, and the
// edit boundary test reads every curve of a clip through it.
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { compositingChannels, type AnimationChannel } from "./animation";
import { MOTION_LIMITS, type MotionChannel } from "./model";

interface MotionSpec {
  key: MotionChannel;
  label: string;
  /** The smallest change the curve graph makes, in document units. */
  step: number;
}

const VIDEO_MOTION: readonly MotionSpec[] = [
  { key: "x", label: t("位置 X"), step: 0.01 },
  { key: "y", label: t("位置 Y"), step: 0.01 },
  { key: "scale", label: t("縮放"), step: 0.01 },
  { key: "rotation", label: t("旋轉"), step: 0.1 },
  { key: "opacity", label: t("不透明度"), step: 0.01 },
];

const AUDIO_MOTION: readonly MotionSpec[] = [
  { key: "gain_db", label: t("音量"), step: 0.1 },
  { key: "pan", label: t("聲像"), step: 0.01 },
];

function motionChannel(clip: TimelineClip, spec: MotionSpec): AnimationChannel {
  const [min, max] = MOTION_LIMITS[spec.key];
  return {
    key: spec.key,
    label: spec.label,
    min,
    max,
    step: spec.step,
    fallback: clip.motion[spec.key],
    keys: clip.motion.keyframes[spec.key] ?? [],
    update: (keys) => ({ ...clip, motion: { ...clip.motion, keyframes: { ...clip.motion.keyframes, [spec.key]: keys } } }),
  };
}

/** The channels of a clip on a video track (motion, effects, mask) or on an audio track (volume, pan). */
export function animationChannels(clip: TimelineClip, kind: "video" | "audio"): AnimationChannel[] {
  if (kind === "audio") return AUDIO_MOTION.map((spec) => motionChannel(clip, spec));
  return [...VIDEO_MOTION.map((spec) => motionChannel(clip, spec)), ...compositingChannels(clip)];
}
