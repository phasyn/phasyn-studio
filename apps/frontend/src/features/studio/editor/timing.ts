import { fieldValue } from "@/lib/json";
import type { MediaClipEffects, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { HOLD_MAX_FRAMES } from "../model/clipEffects";
import { compositingChannels, mapClipKeyframes, sliceCompositing } from "./animation";
import { clipDuration, processedDuration, windowBounds, type TimelineResult } from "./model";
import { evaluateCurve, upsertCurveKey } from "./curves";
import { sliceMotion } from "./slicing";

/** A timing edit acts on the visible source. Materialize only when that is lossless. */
export function materializeClipWindow(clip: TimelineClip): TimelineResult<TimelineClip> {
  const duration = processedDuration(clip); const { start_frame: from, end_frame: to } = windowBounds(clip);
  const value = structuredClone(clip); delete value.output_window;
  if (from === 0 && to === duration) return { ok: true, value };
  const fx = clip.effects; const holdIn = fx?.hold?.start ?? 0; const holdOut = fx?.hold?.end ?? 0;
  const coreEnd = duration - holdOut;
  const fail = (): TimelineResult<TimelineClip> => ({ ok: false, error: t("這項時間調整無法保留目前裁切的效果相位；請先還原裁切或移除時間效果。") });
  const curves = [...Object.values(clip.motion.keyframes), ...compositingChannels(clip).map((channel) => channel.keys)];
  if (curves.some((keys) => keys.some((key) => key.frame < from || key.frame > to))) return fail();
  if ((fx?.camera?.shake_px != null && Boolean(fx.camera.shake_px)) && (fx.camera.shake_frames != null && Boolean(fx.camera.shake_frames))) return fail();
  if ((from > 0 && from < holdIn) || (to < duration && to > coreEnd) || from >= coreEnd || to <= holdIn) return fail();
  const a = Math.max(0, from - holdIn); const b = Math.min(coreEnd, to) - holdIn;
  const speed = fx?.speed_percent ?? 100;
  // Restarting tempo processing on a cropped source changes PCM even at exact frame boundaries.
  if (speed !== 100) return fail();
  const sourceA = a * speed / 100; const sourceB = to === duration ? clip.out_frame - clip.in_frame : b * speed / 100;
  if (!Number.isInteger(sourceA) || !Number.isInteger(sourceB) || a % (fx?.frame_step ?? 1) !== 0) return fail();
  const fadeIn = Math.max(fx?.fade?.video_in ?? 0, fx?.fade?.audio_in ?? 0);
  const fadeOut = Math.max(fx?.fade?.video_out ?? 0, fx?.fade?.audio_out ?? 0);
  if ((from > 0 && from < fadeIn) || (to < duration && to < fadeIn) || from > duration - fadeOut || (to < duration && to > duration - fadeOut)) return fail();
  if (fx?.impact && ((from > 0 && from < fx.impact.frames) || (to < duration && to < fx.impact.frames))) return fail();
  if (value.effects) {
    value.effects.hold = { start: from === 0 ? holdIn : 0, end: to === duration ? holdOut : 0 };
    value.effects.fade = { video_in: from === 0 ? fx?.fade?.video_in ?? 0 : 0, audio_in: from === 0 ? fx?.fade?.audio_in ?? 0 : 0, video_out: to === duration ? fx?.fade?.video_out ?? 0 : 0, audio_out: to === duration ? fx?.fade?.audio_out ?? 0 : 0 };
    if (from > 0) delete value.effects.impact;
    const title = value.effects.title;
    if (title) {
      const start = Math.max(from, title.start_frame); const end = Math.min(to, title.end_frame ?? duration);
      if (start >= end) delete value.effects.title;
      else value.effects.title = { ...title, start_frame: start - from, end_frame: end - from };
    }
  }
  value.in_frame = clip.in_frame + sourceA; value.out_frame = clip.in_frame + sourceB;
  value.motion = sliceMotion(clip.motion, from, to);
  Object.assign(value, sliceCompositing(clip, from, to));
  return processedDuration(value) === to - from ? { ok: true, value } : fail();
}

/** Change clip-local time effects atomically. Never round, merge or discard animation keys implicitly. */
export function changeClipTiming(clip: TimelineClip, effects: MediaClipEffects | undefined): TimelineResult<TimelineClip> {
  const prepared = materializeClipWindow(clip); if (!prepared.ok) return prepared;
  const before = prepared.value; const old = before.effects; const requested = effects ?? {};
  const changed = Object.keys({ ...clip.effects, ...requested }).filter((key) => JSON.stringify(fieldValue(clip.effects ?? {}, key)) !== JSON.stringify(fieldValue(requested, key)));
  const merged = { ...old };
  for (const name of changed) {
    if (name === "hold") {
      merged.hold = { ...old?.hold };
      for (const edge of ["start", "end"] as const) {
        if ((clip.effects?.hold?.[edge] ?? 0) !== (requested.hold?.[edge] ?? 0)) merged.hold[edge] = requested.hold?.[edge] ?? 0;
      }
    } else if (name === "fade") {
      merged.fade = { ...old?.fade };
      for (const edge of ["video_in", "video_out", "audio_in", "audio_out"] as const) {
        if ((clip.effects?.fade?.[edge] ?? 0) !== (requested.fade?.[edge] ?? 0)) merged.fade[edge] = requested.fade?.[edge] ?? 0;
      }
    } else Object.assign(merged, { [name]: fieldValue(requested, name) });
  }
  let value: TimelineClip = { ...before, effects: merged };
  const oldStart = old?.hold?.start ?? 0; const oldEnd = old?.hold?.end ?? 0;
  const nextStart = merged.hold?.start ?? 0; const nextEnd = merged.hold?.end ?? 0;
  const oldCore = processedDuration(before) - oldStart - oldEnd;
  const nextCore = processedDuration(value) - nextStart - nextEnd;
  const map = (frame: number) => frame < oldStart ? frame * nextStart / oldStart : frame <= oldStart + oldCore ? nextStart + (frame - oldStart) * nextCore / oldCore : nextStart + nextCore + (frame - oldStart - oldCore) * nextEnd / oldEnd;
  const fail = (): TimelineResult<TimelineClip> => ({ ok: false, error: t("這項時間調整無法保留關鍵影格的整數位置；請先調整關鍵影格或文字範圍。") });
  const result = { representable: true };
  value = mapClipKeyframes(value, (originalKeys, fallback) => {
    let preparedKeys = originalKeys;
    const boundaries = [
      ...(oldStart > 0 && nextStart * oldCore !== nextCore * oldStart ? [oldStart] : []),
      ...(oldEnd > 0 && nextEnd * oldCore !== nextCore * oldEnd ? [oldStart + oldCore] : []),
    ];
    for (const boundary of boundaries) {
      if (preparedKeys.some((point) => point.frame < boundary) && preparedKeys.some((point) => point.frame > boundary)) preparedKeys = upsertCurveKey(preparedKeys, boundary, evaluateCurve(preparedKeys, boundary, fallback));
    }
    const keys = preparedKeys.map((point) => ({ ...point, frame: map(point.frame) }));
    if (keys.length > 128 || keys.some((point) => !Number.isSafeInteger(point.frame)) || new Set(keys.map((point) => point.frame)).size !== keys.length) result.representable = false;
    return keys;
  });
  if (!result.representable) return fail();
  const title = value.effects?.title;
  if (title) {
    const start = map(title.start_frame); const end = title.end_frame === null ? null : map(title.end_frame);
    if (!Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end))) return fail();
    value = { ...value, effects: { ...value.effects, title: { ...title, start_frame: start, end_frame: end } } };
  }
  return clipDuration(value) > 0 ? { ok: true, value } : fail();
}

export type FixedLengthTiming = { edge: "start" | "end"; frames: number } | { reset: true };

/** Trade edge holds against frames of the visible source. Effects and animation keep sequence-local time. */
export function fixedLengthTiming(clip: TimelineClip, edit: FixedLengthTiming): TimelineResult<TimelineClip> {
  const prepared = materializeClipWindow(clip);
  if (!prepared.ok) return prepared;
  const before = prepared.value;
  const duration = clipDuration(before);
  const effects = { ...before.effects };
  const start = effects.hold?.start ?? 0;
  const end = effects.hold?.end ?? 0;
  const speed = effects.speed_percent ?? 100;
  const resetting = "reset" in edit;
  if (!resetting && (!Number.isSafeInteger(edit.frames) || edit.frames < 0 || edit.frames > HOLD_MAX_FRAMES)) {
    return { ok: false, error: t("片段效果超出允許範圍") };
  }
  const nextStart = resetting ? 0 : edit.edge === "start" ? edit.frames : start;
  const nextEnd = resetting ? 0 : edit.edge === "end" ? edit.frames : end;
  if (nextStart + nextEnd >= duration) return { ok: false, error: t("停格後必須保留至少一格可播放的素材") };

  const headDelta = nextStart - start;
  const tailDelta = nextEnd - end;
  const inFrame = before.in_frame + headDelta * speed / 100;
  // When resetting the speed, the first visible source frame anchors normal-speed playback.
  const outFrame = resetting ? inFrame + duration : before.out_frame - tailDelta * speed / 100;
  if (!Number.isSafeInteger(inFrame) || !Number.isSafeInteger(outFrame) || (!resetting && headDelta % (effects.frame_step ?? 1) !== 0)) {
    return { ok: false, error: t("這個切點無法保留變速或動畫拍數的取樣相位；請選擇對齊的影格") };
  }
  if (inFrame < 0 || outFrame <= inFrame) return { ok: false, error: t("裁切範圍超過原始素材長度") };
  if (resetting) {
    delete effects.speed_percent;
    delete effects.frame_step;
    delete effects.hold;
  } else {
    effects.hold = { start: nextStart, end: nextEnd };
  }
  const value = { ...before, in_frame: inFrame, out_frame: outFrame, effects };
  return clipDuration(value) === duration ? { ok: true, value } : { ok: false, error: t("這個切點無法保留變速片段的精確長度") };
}
