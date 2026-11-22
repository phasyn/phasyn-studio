import type { StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { MAX_CAPTIONS, MAX_FPS, MAX_GAIN_DB, MAX_MARKERS, MAX_SEQUENCE_SECONDS, MAX_SOURCE_FRAMES, MAX_SOURCES, MAX_SPEED_PERCENT, MIN_FPS, MIN_GAIN_DB, MIN_SPEED_PERCENT } from "@/api/generated/timelineLimits";
import { t } from "@/i18n";
import { activeTransition, titleLayerState } from "../model/clipEffects";
import { ADJUSTMENT_TRANSITION, adjustmentProblem } from "./adjustment";
import { curveProblem } from "./curves";
import { compositingProblem } from "./compositing";
import { clipDuration, processedDuration, windowBounds, clipEnd, MAX_TIMELINE_CLIPS, MAX_TIMELINE_FRAMES, MAX_TIMELINE_TRACKS, MOTION_CHANNELS, MOTION_LIMITS, timelineDuration, trackClips } from "./model";

/** What ties a source to media: a shot, a take, a library item or a proxy (a generated source has none of them). */
const LINKED_FIELDS = ["shot_id", "take_id", "library_id", "proxy", "proxy_run_id", "proxy_error", "proxy_source_sha256"] as const satisfies readonly (keyof TimelineSource)[];
const integer = (n: number, low: number, high: number) => Number.isSafeInteger(n) && n >= low && n <= high;
const bounded = (n: number, low: number, high: number) => Number.isFinite(n) && n >= low && n <= high;
const unique = (ids: readonly string[]) => ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) && new Set(ids).size === ids.length;
function clipProblem(clip: TimelineClip): string | null {
  const duration = processedDuration(clip);
  const window = windowBounds(clip);
  if (!integer(window.start_frame, 0, duration - 1) || !integer(window.end_frame, window.start_frame + 1, duration)) return t("裁切範圍必須位於片段內");
  if (!integer(clip.start_frame, 0, MAX_TIMELINE_FRAMES) || !integer(clip.in_frame, 0, MAX_SOURCE_FRAMES - 1) || !integer(clip.out_frame, clip.in_frame + 1, MAX_SOURCE_FRAMES) || !integer(duration, 1, MAX_TIMELINE_FRAMES)) return t("片段範圍必須是有效的整數影格");
  for (const key of MOTION_CHANNELS) {
    const [low, high] = MOTION_LIMITS[key];
    if (!bounded(clip.motion[key], low, high)) return t("動態參數超出允許範圍");
    const keys = clip.motion.keyframes[key] ?? [];
    if (curveProblem(keys, duration, low, high)) return t("關鍵影格必須依時間排列、不重複且位於片段範圍內");
  }
  if (!bounded(clip.motion.pan, -1, 1)) return t("聲像超出允許範圍");
  const fx = clip.effects;
  if (!integer(fx?.speed_percent ?? 100, MIN_SPEED_PERCENT, MAX_SPEED_PERCENT) || !bounded(fx?.volume_db ?? 0, -60, 12) || !integer(fx?.hold?.start ?? 0, 0, 240) || !integer(fx?.hold?.end ?? 0, 0, 240) || !integer(fx?.frame_step ?? 1, 1, 4)) return t("片段效果超出允許範圍");
  const fade = fx?.fade;
  if ([fade?.video_in ?? 0, fade?.video_out ?? 0, fade?.audio_in ?? 0, fade?.audio_out ?? 0].some((value) => !integer(value, 0, 1000)) || (fade?.video_in ?? 0) + (fade?.video_out ?? 0) > duration || (fade?.audio_in ?? 0) + (fade?.audio_out ?? 0) > duration || (fade?.video_out ?? 0) >= duration) return t("淡入淡出範圍超過片段長度");
  if (fx?.impact && (!integer(fx.impact.frames, 1, Math.min(12, duration)))) return t("衝擊格範圍超過片段長度");
  const style = fx?.title?.style;
  if (style && (!(["sans", "serif", "mono"] as const).includes(style.font_family) || !bounded(style.font_size, 8, 300) || !([400, 700] as readonly number[]).includes(style.font_weight) || !/^#[0-9a-f]{6}$/i.test(style.color) || !(["left", "center", "right"] as const).includes(style.align) || !bounded(style.x, 0, 1) || !bounded(style.y, 0, 1))) return t("文字樣式超出允許範圍");
  if (fx?.title && (!fx.title.text.trim() || fx.title.text.length > 200)) return t("標題內容需為 1–200 個字元");
  if (fx?.title && (!integer(fx.title.start_frame, 0, duration - 1) || (fx.title.end_frame !== null && !integer(fx.title.end_frame, fx.title.start_frame + 1, duration)))) return t("文字範圍超過片段長度");
  const color = fx?.color;
  const camera = fx?.camera;
  if (!bounded(color?.brightness ?? 0, -1, 1) || !bounded(color?.contrast ?? 1, 0, 3) || !bounded(color?.saturation ?? 1, 0, 3) || !integer(camera?.zoom_percent ?? 100, 100, 200) || !integer(camera?.shake_px ?? 0, 0, 64) || !integer(camera?.shake_frames ?? 0, 0, 1000)) return t("片段效果超出允許範圍");
  return compositingProblem(clip);
}
/** Structural/edit invariants. FileRef and full JSON shape remain owned by the wire schema. */
export function timelineProblem(timeline: StudioTimeline): string | null {
  // Version 2 adds optional fields only (a clip switched off, shots placed once); both are read the same way
  const version: number = timeline.version;
  if ((version !== 1 && version !== 2) || !integer(timeline.fps.num, 1, Number.MAX_SAFE_INTEGER) || !integer(timeline.fps.den, 1, Number.MAX_SAFE_INTEGER)) return t("序列影格率無效");
  if (timeline.fps.num / timeline.fps.den < MIN_FPS || timeline.fps.num / timeline.fps.den > MAX_FPS) return t("序列影格率無效");
  if (timeline.clips.length > MAX_TIMELINE_CLIPS || timeline.tracks.length > MAX_TIMELINE_TRACKS || timeline.sources.length > MAX_SOURCES || timeline.captions.length > MAX_CAPTIONS || timeline.markers.length > MAX_MARKERS) return t("時間軸項目數超過上限");
  if (!unique(timeline.clips.map((x) => x.clip_id)) || !unique(timeline.tracks.map((x) => x.track_id)) || !unique(timeline.sources.map((x) => x.source_id)) || !unique(timeline.captions.map((x) => x.caption_id)) || !unique(timeline.markers.map((x) => x.marker_id))) return t("時間軸識別碼無效或重複");
  const area = timeline.work_area;
  if (area && (!integer(area.start_frame, 0, MAX_TIMELINE_FRAMES - 1) || !integer(area.end_frame, area.start_frame + 1, MAX_TIMELINE_FRAMES))) return t("序列出點必須晚於入點");
  const total = timelineDuration(timeline);
  if (total > MAX_TIMELINE_FRAMES || total * timeline.fps.den / timeline.fps.num > MAX_SEQUENCE_SECONDS) return t("時間軸不得超過 100000 影格或一小時");
  if (!bounded(timeline.master_gain_db, MIN_GAIN_DB, MAX_GAIN_DB)) return t("音量超出允許範圍");
  // A source may be far longer than the sequence (24 hours): a clip shows only a part of it
  for (const source of timeline.sources) if (!integer(source.duration_frames, 1, MAX_SOURCE_FRAMES)) return t("素材長度無效");
  for (const source of timeline.sources) {
    const linked = source.file !== null || source.has_audio || LINKED_FIELDS.some((field) => source[field] !== undefined);
    if (source.kind === "adjustment" && linked) return t("調整圖層素材不能引用媒體檔案、代理、鏡頭或音訊");
  }
  const adjustments = new Set(timeline.sources.filter((source) => source.kind === "adjustment").map((source) => source.source_id));
  for (const clip of timeline.clips) {
    const track = timeline.tracks.find((item) => item.track_id === clip.track_id);
    const source = timeline.sources.find((item) => item.source_id === clip.source_id);
    if (!track || !source) return t("片段參照的素材或軌道不存在");
    if (source.kind === "adjustment" && track.kind !== "video") return t("調整圖層只能放在影像軌");
    if ((track.kind === "video" && source.kind === "audio") || (track.kind === "audio" && !source.has_audio)) return t("素材種類與軌道不相容");
    if (source.kind === "text" && (source.file !== null || source.has_audio || clip.effects?.title?.start_frame !== 0 || (clip.effects.title.end_frame !== null && clip.effects.title.end_frame !== processedDuration(clip)))) return t("獨立文字圖層必須保留完整片段文字，且不能引用媒體檔案或音訊");
    if (clip.out_frame > source.duration_frames) return t("裁切範圍超過原始素材長度");
    if (processedDuration(clip) * timeline.fps.den / timeline.fps.num > MAX_SEQUENCE_SECONDS) return t("時間軸不得超過 100000 影格或一小時");
    const problem = (source.kind === "adjustment" ? adjustmentProblem(clip) : null) ?? clipProblem(clip);
    if (problem != null && problem !== "") return problem;
  }
  for (const track of timeline.tracks) {
    if (!bounded(track.gain_db, -60, 12) || !bounded(track.pan, -1, 1)) return t("軌道混音參數超出允許範圍");
    const clips = trackClips(timeline, track.track_id);
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];
      if (!clip) continue;
      const next = clips[i + 1];
      const previous = clips[i - 1];
      const transition = activeTransition(clip.effects);
      const incoming = previous ? activeTransition(previous.effects)?.frames ?? 0 : 0;
      // An adjustment layer has no picture of its own for a transition to dissolve (its own transition is refused above)
      if (transition && next && adjustments.has(next.source_id)) return ADJUSTMENT_TRANSITION;
      if (transition && (!next || !integer(transition.frames, 1, 240) || transition.frames > Math.min(clipDuration(clip), clipDuration(next)) || clipEnd(clip) - next.start_frame !== transition.frames)) return t("轉場必須與下一個片段精確重疊指定影格數");
      // The cut a transition records lies inside its overlap: the frames on its two sides make up the overlap
      if (transition?.cut && transition.cut.outgoing.frames + transition.cut.incoming.frames !== transition.frames) return t("轉場的切點與重疊長度不一致");
      if (transition && next && (clip.blend_mode ?? "normal") !== (next.blend_mode ?? "normal")) return t("同一轉場的兩個片段必須使用相同混合模式");
      if (incoming + (transition?.frames ?? 0) > clipDuration(clip)) return t("進場與出場轉場合計超過片段長度");
      if (next && next.start_frame < clipEnd(clip) && !transition) return t("同一軌道的片段不能重疊");
    }
  }
  for (const caption of timeline.captions) if (!caption.text.trim() || caption.text.length > 200 || !integer(caption.start_frame, 0, MAX_TIMELINE_FRAMES - 1) || !integer(caption.end_frame, caption.start_frame + 1, MAX_TIMELINE_FRAMES)) return t("字幕範圍無效");
  for (const marker of timeline.markers) if (!integer(marker.frame, 0, MAX_TIMELINE_FRAMES)) return t("標記位置無效");
  return null;
}

/** Export preparation must finish every clip title, including inherited titles on linked audio. */
export function timelineTitleProblem(timeline: StudioTimeline, width: number, height: number): string | null {
  for (const clip of timeline.clips) {
    const title = clip.effects?.title;
    if (!title) continue;
    const state = titleLayerState(title, width, height);
    if (state === "missing") return t("「{name}」的標題圖層尚未完成", { name: clip.name });
    if (state === "stale") return t("「{name}」的標題圖層與目前文字或輸出尺寸不符", { name: clip.name });
  }
  return null;
}
