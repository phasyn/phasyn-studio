import type { StudioTimeline, TimelineClip, TimelineMotion, TimelineTrack } from "@/api/generated/contracts";
import { MAX_CLIPS, MAX_SEQUENCE_FRAMES, MAX_TRACKS, MOTION_BOUNDS } from "@/api/generated/timelineLimits";
import { clipFramesOut, clipSourceFrame } from "../model/clipEffects";
import { evaluateCurve } from "./curves";
export { evaluateCurve } from "./curves";

export type TimelineResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type AllocateId = (prefix: string) => string;
// The bounds of the timeline document come from the contract (generated); these are the names the editor uses
export const MAX_TIMELINE_FRAMES = MAX_SEQUENCE_FRAMES;
export const MAX_TIMELINE_CLIPS = MAX_CLIPS;
export const MAX_TIMELINE_TRACKS = MAX_TRACKS;
export const MOTION_CHANNELS = ["x", "y", "scale", "rotation", "opacity", "gain_db", "pan"] as const;
export type MotionChannel = (typeof MOTION_CHANNELS)[number];
export const MOTION_LIMITS: Record<MotionChannel, readonly [number, number]> = MOTION_BOUNDS;
export function defaultMotion(): TimelineMotion {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, gain_db: 0, pan: 0, keyframes: {} };
}
export function newTrack(trackId: string, kind: TimelineTrack["kind"], name: string): TimelineTrack {
  return { track_id: trackId, kind, name, locked: false, muted: false, solo: false, sync_lock: true, gain_db: 0, pan: 0 };
}
/** Effects and animation always retain their complete processing timebase. */
export function processedDuration(clip: TimelineClip): number {
  return clipFramesOut(clip.out_frame - clip.in_frame, clip.effects);
}
export function windowBounds(clip: TimelineClip): { start_frame: number; end_frame: number } {
  return clip.output_window ?? { start_frame: 0, end_frame: processedDuration(clip) };
}
export function clipDuration(clip: TimelineClip): number {
  const window = windowBounds(clip);
  return window.end_frame - window.start_frame;
}
export function toProcessingFrame(clip: TimelineClip, localFrame: number): number { return windowBounds(clip).start_frame + localFrame; }
export function toClipLocalFrame(clip: TimelineClip, processingFrame: number): number { return processingFrame - windowBounds(clip).start_frame; }
export function clipEnd(clip: TimelineClip): number { return clip.start_frame + clipDuration(clip); }
/** A clip that is switched off keeps its place but neither plays nor exports (optional contract field; absent = on). */
export function clipEnabled(clip: TimelineClip): boolean {
  return clip.enabled !== false;
}
/** The clip switched on or off (see clipEnabled; only a version 2 document can carry it). */
export function withEnabled(clip: TimelineClip, enabled: boolean): TimelineClip {
  return { ...clip, enabled };
}
/** The shots the film shows: those with at least one clip on the timeline. */
export function placedShotIds(timeline: StudioTimeline): ReadonlySet<string> {
  const shots = new Map(timeline.sources.map((source) => [source.source_id, source.shot_id]));
  return new Set(timeline.clips.flatMap((clip) => shots.get(clip.source_id) ?? []));
}
export function timelineDuration(timeline: StudioTimeline): number {
  return Math.max(0, ...timeline.clips.map(clipEnd), ...timeline.captions.map((caption) => caption.end_frame));
}
export function sourceFrameAtTimeline(clip: TimelineClip, frame: number): number {
  return clip.in_frame + clipSourceFrame(clip.effects, clip.out_frame - clip.in_frame, toProcessingFrame(clip, frame - clip.start_frame));
}
/** Source edge before frame-step sampling; output windows may land between source frames. */
export function sourceBoundary(clip: TimelineClip, edge: "in" | "out"): number {
  const window = windowBounds(clip);
  const frame = edge === "in" ? window.start_frame : window.end_frame;
  const head = clip.effects?.hold?.start ?? 0;
  const tail = processedDuration(clip) - (clip.effects?.hold?.end ?? 0);
  if (frame <= head) return clip.in_frame;
  if (frame >= tail) return clip.out_frame;
  return clip.in_frame + (frame - head) * (clip.effects?.speed_percent ?? 100) / 100;
}
export function motionAt(clip: TimelineClip, frame: number): TimelineMotion {
  const local = toProcessingFrame(clip, frame - clip.start_frame);
  const motion = { ...clip.motion };
  for (const key of MOTION_CHANNELS) motion[key] = evaluateCurve(motion.keyframes[key], local, motion[key]);
  return motion;
}
export function trackClips(timeline: StudioTimeline, trackId: string): TimelineClip[] {
  return timeline.clips.filter((clip) => clip.track_id === trackId).sort((a, b) => a.start_frame - b.start_frame);
}
/** Bottom-to-top video compositing order; audio is independent and never implicitly played by video tracks. */
export function activeClips(timeline: StudioTimeline, frame: number, kind: TimelineTrack["kind"]): TimelineClip[] {
  const tracks = timeline.tracks.filter((track) => track.kind === kind);
  const solo = tracks.some((track) => track.solo);
  return tracks.filter((track) => !track.muted && (!solo || track.solo)).flatMap((track) =>
    trackClips(timeline, track.track_id).filter((clip) => clip.start_frame <= frame && frame < clipEnd(clip)),
  );
}
export function visibleClips(timeline: StudioTimeline, frame: number): TimelineClip[] { return activeClips(timeline, frame, "video"); }
export function audibleClips(timeline: StudioTimeline, frame: number): TimelineClip[] {
  return activeClips(timeline, frame, "audio").filter((clip) => !(clip.effects?.mute === true));
}
export function selectClips(timeline: StudioTimeline, ids: readonly string[], linked = true): TimelineClip[] {
  const selected = new Set(ids);
  const links = new Set(timeline.clips.filter((clip) => Boolean(selected.has(clip.clip_id) && clip.linked_id)).map((clip) => clip.linked_id));
  return timeline.clips.filter((clip) => selected.has(clip.clip_id) || (linked && clip.linked_id !== undefined && links.has(clip.linked_id)));
}

export const timelineEnd = timelineDuration;
export const valueAt = evaluateCurve;
