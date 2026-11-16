// 還原為整段 take: the pieces a shot's clip was cut into on one track (splits, speed ramps, holds, frame steps made
// for one take) become one clip that plays the shot's take from its trim start at normal speed over the same span.
// A new take moves the motion, so edits timed to the old one no longer fit it; this puts the shot back to the take as
// rendered, keeping where the span sits, the transitions at its outer edges and the look of its first piece. Pure.
import type { MediaClipEffects, StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { activeTransition } from "../model/clipEffects";
import { clipEnd, trackClips, type TimelineResult } from "./model";

/** Effects that time the clip to one take: they go when it plays the whole take again. */
const TIMING_EFFECTS = ["speed_percent", "hold", "frame_step", "impact", "camera"] as const satisfies readonly (keyof MediaClipEffects)[];

function follows(left: TimelineClip, right: TimelineClip): boolean {
  return clipEnd(left) - (activeTransition(left.effects)?.frames ?? 0) === right.start_frame;
}

/** The clip and its neighbours on the track that play the same source back to back (the pieces of one placement). */
export function takeRun(timeline: StudioTimeline, clipId: string): TimelineClip[] {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  if (!clip) return [];
  const ordered = trackClips(timeline, clip.track_id);
  let first = ordered.findIndex((item) => item.clip_id === clipId);
  let last = first;
  // A transition between two pieces is part of the edit being undone; only the run's outer edges keep theirs
  while (first > 0 && ordered[first - 1]?.source_id === clip.source_id && follows(ordered[first - 1] as TimelineClip, ordered[first] as TimelineClip)) first -= 1;
  while (last < ordered.length - 1 && ordered[last + 1]?.source_id === clip.source_id && follows(ordered[last] as TimelineClip, ordered[last + 1] as TimelineClip)) last += 1;
  return ordered.slice(first, last + 1);
}

function timed(clip: TimelineClip, inFrame: number): boolean {
  const fx = clip.effects ?? {};
  return clip.output_window !== undefined || clip.in_frame !== inFrame || TIMING_EFFECTS.some((key) => fx[key] !== undefined && JSON.stringify(fx[key]) !== JSON.stringify(key === "hold" ? { start: 0, end: 0 } : key === "speed_percent" ? 100 : key === "frame_step" ? 1 : null));
}

/** Why the clip cannot go back to its whole take (null when it can): a shot's media, not linked, not already whole. */
export function restoreTakeProblem(timeline: StudioTimeline, clipId: string, inFrame: number): string | null {
  const run = takeRun(timeline, clipId);
  const first = run[0];
  const last = run.at(-1);
  if (!first || !last) return t("找不到選取的片段");
  const source = timeline.sources.find((item) => item.source_id === first.source_id);
  if (!source?.shot_id || (source.kind !== "video" && source.kind !== "audio")) return t("只有鏡頭的 take 能還原為整段");
  if (run.some((clip) => clip.linked_id)) return t("連結的片段請先取消連結再還原");
  if (run.length === 1 && !timed(first, inFrame)) return t("這個片段已經是整段 take");
  const span = clipEnd(last) - first.start_frame;
  const available = source.duration_frames - inFrame;
  if (span > available) return t("整段 take 只有 {available} 影格，填不滿這段的 {span} 影格", { available, span });
  return null;
}

/** The run replaced by one clip: the first piece's id, place, name, look and motion; the last piece's outgoing transition. */
export function restoreTake(timeline: StudioTimeline, clipId: string, inFrame: number): TimelineResult<{ removed: string[]; clip: TimelineClip }> {
  const problem = restoreTakeProblem(timeline, clipId, inFrame);
  if (problem) return { ok: false, error: problem };
  const run = takeRun(timeline, clipId);
  const first = run[0] as TimelineClip;
  const last = run.at(-1) as TimelineClip;
  const span = clipEnd(last) - first.start_frame;
  const effects: MediaClipEffects = { ...first.effects };
  for (const key of TIMING_EFFECTS) delete effects[key];
  delete effects.transition_out;
  const outgoing = last.effects?.transition_out;
  if (outgoing) effects.transition_out = outgoing;
  const fadeIn = first.effects?.fade;
  const fadeOut = last.effects?.fade;
  if (fadeIn || fadeOut) effects.fade = { video_in: fadeIn?.video_in ?? 0, audio_in: fadeIn?.audio_in ?? 0, video_out: fadeOut?.video_out ?? 0, audio_out: fadeOut?.audio_out ?? 0 };
  const clip: TimelineClip = { ...structuredClone(first), in_frame: inFrame, out_frame: inFrame + span };
  delete clip.output_window;
  if (Object.keys(effects).length > 0) clip.effects = effects;
  else delete clip.effects;
  return { ok: true, value: { removed: run.slice(1).map((item) => item.clip_id), clip } };
}
