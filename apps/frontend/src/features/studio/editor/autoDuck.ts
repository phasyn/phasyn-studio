// Auto-duck with baked keys: lowers the clips of one audio track wherever another track has clips (a voice-over, sound
// effects), by writing ordinary gain_db keyframes onto each lowered clip. The keys are plain clip automation, so they
// can be edited afterwards and export needs nothing new. Ranges come from the trigger track's switched-on clips; ranges
// closer together than one attack plus one release are merged, so the music does not pump between two nearby lines.
import type { StudioTimeline, TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { clipEnabled, clipEnd, processedDuration, toProcessingFrame, trackClips } from "./model";

/** Gain automation bounds (contract MOTION_BOUNDS.gain_db) and the per-channel key limit (contract maxItems). */
export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 12;
export const MAX_KEYS = 128;
/** Defaults: -10 dB is about 0.32 of the level, the depth the earlier tour videos used. */
export const DUCK_DEFAULTS = { amountDb: -10, attackSeconds: 0.2, releaseSeconds: 0.5 } as const;
export const DUCK_AMOUNT_RANGE = { min: -40, max: -1 } as const;

export interface DuckSettings {
  /** dB to lower by, negative (DUCK_AMOUNT_RANGE). */
  amountDb: number;
  /** Ramp down before each trigger range starts, in frames (at least 1). */
  attackFrames: number;
  /** Ramp back up after each trigger range ends, in frames (at least 1). */
  releaseFrames: number;
}

export type DuckOutcome = { ok: true; clips: TimelineClip[]; ranges: number } | { ok: false; reason: "no-target-clips" | "no-trigger-clips" | "too-many-keys" };

/** The trigger track's switched-on clips as merged [start, end) timeline ranges. */
export function triggerRanges(timeline: StudioTimeline, triggerTrackId: string, settings: DuckSettings): [number, number][] {
  const gap = settings.attackFrames + settings.releaseFrames;
  const ranges: [number, number][] = [];
  for (const clip of trackClips(timeline, triggerTrackId)) {
    if (!clipEnabled(clip)) continue;
    const start = clip.start_frame;
    const end = clipEnd(clip);
    const last = ranges.at(-1);
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}

/** The ducked level at a timeline frame (piecewise linear between the breakpoints, flat outside them). */
function envelope(points: readonly (readonly [number, number])[], base: number, at: number): number {
  let previous: readonly [number, number] | undefined;
  for (const point of points) {
    const [x1, y1] = point;
    if (at <= x1) {
      if (!previous) return y1;
      const [x0, y0] = previous;
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (at - x0)) / (x1 - x0);
    }
    previous = point;
  }
  return previous ? previous[1] : base;
}

/** gain_db keys for one clip, or [] when no trigger range reaches it. Throws nothing; the caller checks MAX_KEYS. */
export function duckKeys(clip: TimelineClip, ranges: readonly (readonly [number, number])[], settings: DuckSettings): TimelineKeyframe[] {
  const start = clip.start_frame;
  const end = clipEnd(clip);
  const base = clip.motion.gain_db;
  const low = Math.max(GAIN_DB_MIN, Math.min(GAIN_DB_MAX, base + settings.amountDb));
  // Breakpoints in timeline frames for the ranges whose ramps touch this clip
  const points: [number, number][] = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    const rampIn = rangeStart - settings.attackFrames;
    const rampOut = rangeEnd + settings.releaseFrames;
    if (rampOut <= start || rampIn >= end) continue;
    points.push([rampIn, base], [rangeStart, low], [rangeEnd, low], [rampOut, base]);
  }
  if (points.length === 0) return [];
  // Keep the breakpoints inside the clip and pin the level at its two edges, so a range that started before the clip
  // (or ends after it) still lowers the part the clip shows
  const frames = new Set<number>([start, end]);
  for (const [frame] of points) if (frame > start && frame < end) frames.add(frame);
  const processed = processedDuration(clip);
  const keys: TimelineKeyframe[] = [];
  for (const frame of [...frames].sort((a, b) => a - b)) {
    const local = toProcessingFrame(clip, frame - start);
    if (local < 0 || local > processed) continue;
    const value = Math.round(envelope(points, base, frame) * 100) / 100;
    const previous = keys.at(-1);
    if (previous?.frame === local) continue;
    keys.push({ frame: local, value, interpolation: "linear" });
  }
  return keys;
}

/** Ducked copies of the target track's switched-on clips; their earlier gain_db keys are replaced. */
export function duckTrack(timeline: StudioTimeline, targetTrackId: string, triggerTrackId: string, settings: DuckSettings): DuckOutcome {
  const targets = trackClips(timeline, targetTrackId).filter(clipEnabled);
  if (targets.length === 0) return { ok: false, reason: "no-target-clips" };
  const ranges = triggerRanges(timeline, triggerTrackId, settings);
  if (ranges.length === 0) return { ok: false, reason: "no-trigger-clips" };
  const clips: TimelineClip[] = [];
  for (const clip of targets) {
    const keys = duckKeys(clip, ranges, settings);
    if (keys.length > MAX_KEYS) return { ok: false, reason: "too-many-keys" };
    const { gain_db: _previous, ...others } = clip.motion.keyframes;
    const keyframes = keys.length > 0 ? { ...others, gain_db: keys } : others;
    clips.push({ ...clip, motion: { ...clip.motion, keyframes } });
  }
  return { ok: true, clips, ranges: ranges.length };
}

/** Seconds to whole frames at the timeline rate, at least one frame (an instant step would click). */
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.max(1, Math.round(seconds * fps));
}
