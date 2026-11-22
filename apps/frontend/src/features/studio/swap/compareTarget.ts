// Which frames of a finished swap segment are compared with which moment of the original (pure).
// The take's frame k (k/fps seconds into the take) was generated from the @Video1 reference at start_seconds + k/fps,
// so it is compared with the original at that moment. The reference is the one the take recorded when it was sent
// (StudioTake.references); an older take without that record uses the shot's current @Video1 reference and its library
// item (start_seconds ?? 0). The range is what the film keeps: the segment's switched-on video clips on the timeline,
// from the first clip's source in to the last clip's source out. Anything unknown is a reason, never a guess.
import type { StudioProject, StudioShot, StudioTake, StudioTimeline } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { clipEnabled, sourceBoundary } from "../editor/model";
import { shotClips } from "../editor/sources";
import { H3_FPS } from "../model/frames";
import { activeTake } from "../model/project";
import { t } from "@/i18n";

export interface CompareTargetReady {
  ok: true;
  /** Cache key: the take, the original file and its window start, and the kept range. */
  key: string;
  takeId: string;
  takeCreatedAt: string;
  takeUrl: string;
  originalUrl: string;
  /** Seconds of the original that the take's frame 0 belongs to (the @Video1 window start). */
  refStart: number;
  /** The take's frame rate. */
  fps: number;
  /** Kept take frames [first, end). */
  first: number;
  end: number;
  /** Video clips the range spans (more than one: from the first clip's in to the last clip's out). */
  clips: number;
}

export type CompareTarget = CompareTargetReady | { ok: false; reason: string };

const VIDEO_ALIAS = "Video1";

/** The @Video1 reference a take was made from (the speed-feel tool reads it too); a reason when there is none. */
export function originalOf(project: StudioProject, shot: StudioShot, take: StudioTake): { url: string; fileId: string; start: number } | string {
  // What the take was actually sent with
  if (take.references) {
    const sent = take.references.find((ref) => ref.kind === "video" && ref.alias === VIDEO_ALIAS);
    if (!sent) return t("這個 take 渲染時沒有 @Video1 參考影片，沒有原片可以對照");
    return { url: mediaUrl(sent.file.node_id, sent.file.file_id), fileId: sent.file.file_id, start: sent.start_seconds ?? 0 };
  }
  const ref = (shot.references ?? []).find((item) => item.kind === "video" && item.alias === VIDEO_ALIAS);
  if (!ref) return t("這段沒有 @Video1 參考影片，沒有原片可以對照");
  const item = (project.library ?? []).find((entry) => entry.item_id === ref.item_id);
  if (!item) return t("@Video1 參考的素材已經不在素材庫裡");
  return { url: mediaUrl(item.file.node_id, item.file.file_id), fileId: item.file.file_id, start: ref.start_seconds ?? 0 };
}

export function compareTarget(project: StudioProject, shot: StudioShot, timeline: StudioTimeline): CompareTarget {
  const take = activeTake(shot);
  const asset = take?.state === "succeeded" && (take.asset?.complete === true) ? take.asset : null;
  if (!take || !asset) return { ok: false, reason: t("這段還沒有完成的 take") };
  const original = originalOf(project, shot, take);
  if (typeof original === "string") return { ok: false, reason: original };
  if (!Number.isFinite(original.start) || original.start < 0) return { ok: false, reason: t("@Video1 的起點不正確（{start} 秒）", { start: original.start }) };
  const fps = asset.fps && asset.fps.den > 0 && asset.fps.num > 0 ? asset.fps.num / asset.fps.den : H3_FPS;
  const videoTracks = new Set(timeline.tracks.filter((track) => track.kind === "video").map((track) => track.track_id));
  const clips = shotClips(timeline, shot.shot_id).filter((clip) => videoTracks.has(clip.track_id) && clipEnabled(clip));
  if (clips.length === 0) return { ok: false, reason: t("這段不在時間軸上（或片段已關閉），沒有保留的範圍可以比對") };
  const timelineFps = timeline.fps.den > 0 ? timeline.fps.num / timeline.fps.den : 0;
  if (!(timelineFps > 0)) return { ok: false, reason: t("時間軸的影格率不正確") };
  // Source frames at the timeline's rate → seconds of the take → the take's own frames
  const inSeconds = Math.min(...clips.map((clip) => sourceBoundary(clip, "in"))) / timelineFps;
  const outSeconds = Math.max(...clips.map((clip) => sourceBoundary(clip, "out"))) / timelineFps;
  const first = Math.max(0, Math.ceil(inSeconds * fps - 1e-6));
  const end = Math.min(asset.frame_count > 0 ? asset.frame_count : Infinity, Math.floor(outSeconds * fps + 1e-6));
  if (end - first < 2) return { ok: false, reason: t("保留的範圍不到 2 影格，無法比對") };
  return {
    ok: true,
    key: [take.take_id, original.fileId, original.start.toFixed(4), first, end].join("|"),
    takeId: take.take_id,
    takeCreatedAt: take.created_at,
    takeUrl: mediaUrl(asset.file.node_id, asset.file.file_id),
    originalUrl: original.url,
    refStart: original.start,
    fps,
    first,
    end,
    clips: clips.length,
  };
}

/** Frames read per clip at most for the metrics (each one is a seek in the browser). */
export const MAX_SAMPLES = 48;
/** Steps that divide half a second at 24 fps, so the filmstrip's pictures are among the measured samples. */
const STEPS = [1, 2, 3, 4, 6, 12] as const;
/** Filmstrip pictures at most (every half second; every second beyond this). */
const STRIP_LIMIT = 32;

export interface SamplePlan {
  /** Frames between two measured samples (the same for both clips). */
  step: number;
  /** Take frames measured, in order. */
  metric: number[];
  /** Take frames shown in the filmstrip, and the seconds between two of them. */
  strip: number[];
  stripEvery: number;
}

/**
 * The frames to read: every frame of a short range, otherwise every step-th (the smallest of STEPS that keeps at most
 * MAX_SAMPLES), and the filmstrip every half second. Times stay exact: take frame k is read at (k + 0.5)/fps (the middle
 * of its display interval) and the original at refStart + (k + 0.5)/fps.
 */
export function samplePlan(first: number, end: number, fps: number): SamplePlan {
  const count = Math.max(0, end - first);
  const step = STEPS.find((value) => Math.ceil(count / value) <= MAX_SAMPLES) ?? Math.max(1, Math.min(Math.round(fps), 12 * Math.ceil(count / (MAX_SAMPLES * 12))));
  const metric: number[] = [];
  for (let frame = first; frame < end; frame += step) metric.push(frame);
  const interval = count / (fps / 2) > STRIP_LIMIT ? fps : fps / 2;
  const strip: number[] = [];
  for (let index = 0; index < STRIP_LIMIT; index += 1) {
    const frame = first + Math.round(index * interval);
    if (frame >= end) break;
    strip.push(frame);
  }
  return { step, metric, strip, stripEvery: interval / fps };
}
