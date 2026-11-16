// What the speed-feel tool reads for one timeline clip (pure): the take the clip shows (its source's file, at the
// sequence's frame rate) and the original the take was made from (the @Video1 reference the take recorded, else the
// shot's; compareTarget.originalOf). Clip frame j shows source frame first + j, generated from the original at
// refStart + (first + j)/fps: the alignment of the swap check. A clip that is retimed, held or stepped does not map frames
// one to one and is refused, like anything unknown: a reason, never a guess.
import type { StudioProject, StudioShot, StudioTake, StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { t } from "@/i18n";
import { clipDuration, windowBounds } from "../editor/model";
import { FRAME_STEP_LABELS } from "../model/clipEffects";
import { originalOf } from "../swap/compareTarget";

/** Clips shorter than this are not analysed (the rules look at peaks at least 4 frames apart and 10 frames between hits). */
const MIN_SPEED_FEEL_FRAMES = 12;

export interface SpeedFeelTarget {
  ok: true;
  /** Cache key: the take's file, the original's file and window start, the frame rate and the source range. */
  key: string;
  clipId: string;
  takeUrl: string;
  originalUrl: string;
  /** Seconds of the original that source frame 0 belongs to (the @Video1 window start). */
  refStart: number;
  /** The sequence's frame rate (source frames are counted at this rate). */
  fps: number;
  /** Source frames the clip shows: [first, end). */
  first: number;
  end: number;
  /** Frames of the source at the sequence's rate. */
  sourceFrames: number;
}

export type SpeedFeelTargetResult = SpeedFeelTarget | { ok: false; reason: string };

interface ClipShot {
  shot: StudioShot;
  take: StudioTake;
  /** The take's file the clip shows, and its frames at the sequence's rate. */
  file: NonNullable<TimelineSource["file"]>;
  sourceFrames: number;
}

/** The shot and take a video clip plays, with its file; a reason for anything else. */
function clipShot(project: StudioProject, timeline: StudioTimeline, clip: TimelineClip): ClipShot | string {
  if (timeline.tracks.find((track) => track.track_id === clip.track_id)?.kind !== "video") return t("速度感只用在視訊軌上的片段");
  const source = timeline.sources.find((item) => item.source_id === clip.source_id);
  if (!source?.shot_id) return t("這個片段不是鏡頭的 take：速度感要和鏡頭的 @Video1 參考影片比對");
  const shot = project.shots.find((item) => item.shot_id === source.shot_id);
  if (!shot) return t("找不到這個片段的鏡頭");
  const take = shot.takes.find((item) => item.take_id === source.take_id);
  if (!take || !source.file) return t("這段還沒有完成的 take");
  return { shot, take, file: source.file, sourceFrames: source.duration_frames };
}

/** Whether the clip plays a shot's take that has a @Video1 reference (where the tool is offered). */
export function hasMotionReference(project: StudioProject, timeline: StudioTimeline, clip: TimelineClip): boolean {
  const owned = clipShot(project, timeline, clip);
  return typeof owned !== "string" && typeof originalOf(project, owned.shot, owned.take) !== "string";
}

/** Why the clip's frames cannot be read one to one (retiming, holds, frame stepping); null when they can. */
export function retimingReason(clip: TimelineClip): string | null {
  const effects = clip.effects;
  const speed = effects?.speed_percent ?? 100;
  if (speed !== 100) return t("這個片段有變速（{speed}%）：請先把速度改回 100% 再用速度感", { speed });
  const step = effects?.frame_step ?? 1;
  if (step !== 1) return t("這個片段用了「{label}」：請先改回一拍一再用速度感", { label: FRAME_STEP_LABELS[step as keyof typeof FRAME_STEP_LABELS] ?? String(step) });
  if ((effects?.hold?.start ?? 0) > 0 || (effects?.hold?.end ?? 0) > 0) return t("這個片段有停格：請先移除停格再用速度感");
  return null;
}

export function speedFeelTarget(project: StudioProject, timeline: StudioTimeline, clipId: string): SpeedFeelTargetResult {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  if (!clip) return { ok: false, reason: t("找不到這個片段（可能已經刪除，或被復原拿掉了）") };
  const owned = clipShot(project, timeline, clip);
  if (typeof owned === "string") return { ok: false, reason: owned };
  const original = originalOf(project, owned.shot, owned.take);
  if (typeof original === "string") return { ok: false, reason: original };
  if (!Number.isFinite(original.start) || original.start < 0) return { ok: false, reason: t("@Video1 的起點不正確（{start} 秒）", { start: original.start }) };
  const retimed = retimingReason(clip);
  if (retimed) return { ok: false, reason: retimed };
  const fps = timeline.fps.den > 0 ? timeline.fps.num / timeline.fps.den : 0;
  if (!(fps > 0)) return { ok: false, reason: t("時間軸的影格率不正確") };
  const length = clipDuration(clip);
  if (length < MIN_SPEED_FEEL_FRAMES) return { ok: false, reason: t("片段只有 {frames} 影格，至少要 {min} 影格才能分析", { frames: length, min: MIN_SPEED_FEEL_FRAMES }) };
  // Without retiming or holds, processing frame p shows source frame in_frame + p
  const first = clip.in_frame + windowBounds(clip).start_frame;
  const end = first + length;
  const { file } = owned;
  return {
    ok: true,
    key: [file.file_id, original.fileId, original.start.toFixed(4), fps.toFixed(4), first, end].join("|"),
    clipId: clip.clip_id,
    takeUrl: mediaUrl(file.node_id, file.file_id),
    originalUrl: original.url,
    refStart: original.start,
    fps,
    first,
    end,
    sourceFrames: owned.sourceFrames,
  };
}
