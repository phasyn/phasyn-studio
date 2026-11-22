// What an adjustment layer is to the document, as Premiere Pro has them: a clip on a video track without a picture of
// its own whose colour, effect stack, mask, fades and opacity change the composite of every track below it, within its
// frames, blended back with its blend mode. It is a clip of a generated "adjustment" source (no file, the sequence size,
// the whole sequence long), so it is trimmed, moved, rippled and cut like any clip; what would need a picture, a clock
// or a sound of its own (motion, speed, holds, transitions, audio) is refused with why. The rules are the Controller's
// (phasyn_components.timeline). Pure.
import type { StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { t } from "@/i18n";

/** Why an adjustment layer takes no transition (the Controller says the same). */
export const ADJUSTMENT_TRANSITION = t("調整圖層不能有轉場；請用淡化或不透明度讓效果漸入漸出");

/** A source the composition makes itself (a text layer's, an adjustment layer's): it has no file to load or render. */
export function isGenerated(source: Pick<TimelineSource, "kind"> | null | undefined): boolean {
  return source?.kind === "text" || source?.kind === "adjustment";
}

/** Whether a clip is an adjustment layer (a clip of an adjustment source). */
export function isAdjustment(timeline: Pick<StudioTimeline, "sources">, clip: Pick<TimelineClip, "source_id"> | null | undefined): boolean {
  return clip !== null && clip !== undefined && timeline.sources.some((source) => source.source_id === clip.source_id && source.kind === "adjustment");
}

const MOTION_REST = { x: 0, y: 0, scale: 1, rotation: 0, gain_db: 0, pan: 0 } as const;
const REST_KEYS = ["x", "y", "scale", "rotation", "gain_db", "pan"] as const satisfies readonly (keyof typeof MOTION_REST)[];

/**
 * Why an adjustment clip cannot be as it is: it keeps position, scale, rotation and its sound at rest (its opacity may
 * be animated), its effects hold only colour and video fades (neutral values of the others change nothing and are
 * kept), and it takes no transition. Null when it can.
 */
export function adjustmentProblem(clip: TimelineClip): string | null {
  const { motion } = clip;
  if (REST_KEYS.some((key) => motion[key] !== MOTION_REST[key] || (motion.keyframes[key]?.length ?? 0) > 0)) {
    return t("調整圖層沒有自己的畫面與聲音：不能移動、縮放、旋轉或調整音量與聲像");
  }
  const fx = clip.effects ?? {};
  if ((fx.speed_percent ?? 100) !== 100 || (fx.hold?.start ?? 0) !== 0 || (fx.hold?.end ?? 0) !== 0) return t("調整圖層沒有自己的時間：不能變速或停格");
  const camera = fx.camera;
  const still = (camera?.zoom_percent ?? 100) === 100 && (camera?.shake_px ?? 0) === 0 && (camera?.shake_frames ?? 0) === 0;
  if ((fx.frame_step ?? 1) !== 1 || !still || fx.impact || fx.title) return t("調整圖層沒有自己的畫面：不能改變拍數，也不能使用鏡頭運動、衝擊格或文字");
  if ((fx.volume_db ?? 0) !== 0 || fx.mute === true || (fx.fade?.audio_in ?? 0) !== 0 || (fx.fade?.audio_out ?? 0) !== 0) return t("調整圖層沒有聲音：不能設定音量、靜音或聲音淡化");
  const transition = fx.transition_out;
  if (transition && transition.kind !== "cut") return ADJUSTMENT_TRANSITION;
  return null;
}
