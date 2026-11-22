import type { TimelineClip, TimelineMotion } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { activeTransition } from "../model/clipEffects";
import { clipDuration, processedDuration, toProcessingFrame, windowBounds, MOTION_CHANNELS, type TimelineResult } from "./model";
import { curveSlice } from "./curves";
import { mapClipKeyframes } from "./animation";

/** Preserve the exact easing interval when an edit cuts through an animated property. */
export function sliceMotion(motion: TimelineMotion, from: number, to: number): TimelineMotion {
  const result: TimelineMotion = { ...motion, keyframes: {} };
  for (const key of MOTION_CHANNELS) {
    const points = motion.keyframes[key];
    if (points?.length != null && Boolean(points.length)) result.keyframes[key] = curveSlice(points, from, to, motion[key]);
  }
  return result;
}
/** Keep full source/effect data; only change the presented output window. */
export function sliceClip(clip: TimelineClip, from: number, to: number, id: string): TimelineResult<TimelineClip> {
  const duration = clipDuration(clip);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > duration || from >= to) return { ok: false, error: t("裁切範圍必須位於片段內") };
  const transition = activeTransition(clip.effects);
  if (transition && to < duration && to > duration - transition.frames) return { ok: false, error: t("請先移除切點上的轉場") };
  const value = structuredClone(clip);
  value.clip_id = id;
  value.start_frame += from;
  if (from !== 0 || to !== duration) value.output_window = { start_frame: toProcessingFrame(clip, from), end_frame: toProcessingFrame(clip, to) };
  if (to < duration && value.effects) delete value.effects.transition_out;
  return { ok: true, value };
}
/** Restore hidden output first. Extending past the processing window requires exact source handles. */
export function resizeClip(clip: TimelineClip, edge: "in" | "out", delta: number): TimelineResult<TimelineClip> {
  const duration = clipDuration(clip);
  if (!Number.isSafeInteger(delta)) return { ok: false, error: t("裁切位移必須是整數影格") };
  if (delta === 0) return { ok: true, value: clip };
  if ((edge === "in" && delta > 0) || (edge === "out" && delta < 0)) return sliceClip(clip, edge === "in" ? delta : 0, edge === "out" ? duration + delta : duration, clip.clip_id);
  const window = windowBounds(clip);
  const from = window.start_frame + (edge === "in" ? delta : 0);
  const to = window.end_frame + (edge === "out" ? delta : 0);
  const complete = processedDuration(clip);
  if (from >= 0 && to <= complete) return { ok: true, value: { ...clip, start_frame: clip.start_frame + (edge === "in" ? delta : 0), output_window: { start_frame: from, end_frame: to } } };
  const fx = clip.effects;
  if ((fx?.hold?.start ?? 0) || (fx?.hold?.end != null && Boolean(fx.hold.end)) || (fx?.fade?.video_in != null && Boolean(fx.fade.video_in)) || (fx?.fade?.video_out != null && Boolean(fx.fade.video_out)) || (fx?.fade?.audio_in != null && Boolean(fx.fade.audio_in)) || (fx?.fade?.audio_out != null && Boolean(fx.fade.audio_out)) || fx?.impact || (fx?.camera?.shake_px != null && Boolean(fx.camera.shake_px)) || activeTransition(fx)) return { ok: false, error: t("延長前請先調整停格、淡入淡出、震動或轉場效果") };
  const before = Math.max(0, -from); const after = Math.max(0, to - complete);
  const sourceBefore = before * (fx?.speed_percent ?? 100) / 100;
  const sourceAfter = after * (fx?.speed_percent ?? 100) / 100;
  if (!Number.isInteger(sourceBefore) || !Number.isInteger(sourceAfter) || before % (fx?.frame_step ?? 1) !== 0) return { ok: false, error: t("這個切點無法保留變速或動畫拍數的取樣相位；請選擇對齊的影格") };
  let value: TimelineClip = { ...structuredClone(clip), start_frame: clip.start_frame + (edge === "in" ? delta : 0), in_frame: clip.in_frame - sourceBefore, out_frame: clip.out_frame + sourceAfter, output_window: { start_frame: from + before, end_frame: to + before } };
  if (before) {
    value = mapClipKeyframes(value, (keys) => keys.map((point) => ({ ...point, frame: point.frame + before })));
    if (value.effects?.title) value.effects.title = { ...value.effects.title, start_frame: value.effects.title.start_frame + before, end_frame: (value.effects.title.end_frame ?? complete) + before };
  }
  return processedDuration(value) === complete + before + after ? { ok: true, value } : { ok: false, error: t("這個切點無法保留變速片段的精確長度") };
}
