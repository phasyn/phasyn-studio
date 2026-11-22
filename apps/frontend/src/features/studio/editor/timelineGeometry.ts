// Timeline geometry shared by the full and the compact timeline: sizes, track order, the mapping from a pointer
// gesture to an edit command, snapping, ruler steps and edit points. Pure.
import type { StudioTimeline, TimelineClip, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { activeTransition } from "../model/clipEffects";
import type { EditCommand } from "./commands";
import { clipDuration, clipEnd, selectClips, trackClips, type TimelineResult } from "./model";
import { cutFrame } from "./transitionCut";

/** Track header of the full timeline (patch, target, lock, sync lock, output, name, menu). */
export const TRACK_HEADER_WIDTH = 184;
/** Track header of the compact timeline (label and name only). */
export const COMPACT_HEADER_WIDTH = 104;
/** Track heights: S 40, M 64, L 96 px. */
export const TRACK_HEIGHTS = { s: 40, m: 64, l: 96 } as const;
export type TrackSize = keyof typeof TRACK_HEIGHTS;
export const TRACK_SIZES: readonly TrackSize[] = ["s", "m", "l"];
export const RULER_HEIGHT = 28;
export const CAPTION_TRACK_HEIGHT = 28;
export const MIN_ZOOM = 0.005;
/** Frame-level zoom: one frame is wide enough to read and to hit. */
export const MAX_ZOOM = 72;
export type GestureMode = "move" | "trimIn" | "trimOut" | "rippleIn" | "rippleOut" | "rollIn" | "rollOut" | "slip" | "slide" | "razor" | "rearrange";
export type PreviewCommand = Extract<EditCommand, { type: "move" | "trim" | "roll" | "slip" | "slide" | "rearrange" }>;

/** Rows from top to bottom: video tracks with the topmost layer first, then audio tracks. */
export function orderedTracks(timeline: StudioTimeline): TimelineTrack[] {
  return [...timeline.tracks.filter((track) => track.kind === "video").reverse(), ...timeline.tracks.filter((track) => track.kind === "audio")];
}

/** The track that carries the film's order: the first (bottom) video track. */
export function primaryVideoTrack(timeline: StudioTimeline): TimelineTrack | null {
  return timeline.tracks.find((track) => track.kind === "video") ?? null;
}

export function editCommand(
  timeline: StudioTimeline,
  clip: TimelineClip,
  mode: Exclude<GestureMode, "razor" | "rearrange">,
  delta: number,
  trackId: string,
  linked: boolean,
  clipIds: string[] = [clip.clip_id],
): TimelineResult<PreviewCommand> {
  if (mode === "move") return { ok: true, value: { type: "move", clipId: clip.clip_id, clipIds, startFrame: clip.start_frame + delta, trackId, linked } };
  if (mode === "slide") return { ok: true, value: { type: "slide", clipId: clip.clip_id, delta, linked } };
  if (mode === "slip") return { ok: true, value: { type: "slip", clipId: clip.clip_id, delta, linked } };
  const edge = mode.endsWith("In") ? "in" : "out";
  if (mode.startsWith("roll")) {
    const clips = trackClips(timeline, clip.track_id);
    const index = clips.findIndex((item) => item.clip_id === clip.clip_id);
    const left = edge === "in" ? clips[index - 1] : clip;
    const right = edge === "out" ? clips[index + 1] : clip;
    if (!left || clipEnd(left) - (activeTransition(left.effects)?.frames ?? 0) !== right?.start_frame) {
      return { ok: false, error: t("滾動編輯需要同軌且緊鄰的兩個片段") };
    }
    return { ok: true, value: { type: "roll", leftId: left.clip_id, rightId: right.clip_id, delta, linked } };
  }
  return { ok: true, value: { type: "trim", clipId: clip.clip_id, edge, delta, ripple: mode.startsWith("ripple"), linked } };
}

/**
 * Where a dragged block lands in a rearrange: before the first clip of its track whose middle is right of the
 * pointer, or at the end. null when that is where the block already is.
 */
export function rearrangeCommand(timeline: StudioTimeline, clipIds: string[], frame: number, linked: boolean): PreviewCommand | null {
  const first = timeline.clips.find((clip) => clip.clip_id === clipIds[0]);
  if (!first) return null;
  const moving = new Set(selectClips(timeline, clipIds, linked).map((clip) => clip.clip_id));
  const others = trackClips(timeline, first.track_id).filter((clip) => !moving.has(clip.clip_id));
  const target = others.find((clip) => clip.start_frame + clipDuration(clip) / 2 > frame) ?? null;
  const ordered = trackClips(timeline, first.track_id);
  const block = ordered.filter((clip) => moving.has(clip.clip_id));
  const last = block.at(-1);
  // Already there: the block is contiguous and the clip after it is the target (or nothing follows and it goes last)
  const contiguous = block.every((clip, index) => index === 0 || ordered[ordered.indexOf(clip) - 1] === block[index - 1]);
  const following = last ? ordered[ordered.indexOf(last) + 1] : undefined;
  if (contiguous && (following?.clip_id ?? null) === (target?.clip_id ?? null)) return null;
  return { type: "rearrange", clipIds, targetId: target?.clip_id ?? null, side: target ? "before" : "after", linked };
}

/** What an edge snaps to: the start, the playhead, the marked range, markers and the edges of the clips that stay put. */
function snapPoints(timeline: StudioTimeline, playhead: number, excluded: ReadonlySet<string> = new Set()): number[] {
  const range = timeline.work_area ? [timeline.work_area.start_frame, timeline.work_area.end_frame] : [];
  return [
    0,
    playhead,
    ...range,
    ...timeline.markers.map((marker) => marker.frame),
    ...timeline.clips.filter((item) => !excluded.has(item.clip_id)).flatMap((item) => [item.start_frame, clipEnd(item)]),
  ];
}

/** Where new material of a given length starts when it is dropped at `start`: either of its edges snaps within 8 px. */
export function snappedStart(timeline: StudioTimeline, start: number, length: number, playhead: number, pxPerFrame: number): { start: number; guide: number | null } {
  let distance = 8 / pxPerFrame;
  let best = start;
  let guide: number | null = null;
  for (const candidate of snapPoints(timeline, playhead)) {
    for (const offset of [0, length]) {
      const next = Math.abs(candidate - offset - start);
      if (next < distance && candidate - offset >= 0) {
        distance = next;
        best = candidate - offset;
        guide = candidate;
      }
    }
  }
  return { start: best, guide };
}

export function snappedDelta(
  timeline: StudioTimeline,
  clip: TimelineClip,
  mode: GestureMode,
  delta: number,
  playhead: number,
  pxPerFrame: number,
  linked: boolean,
  clipIds: string[] = [clip.clip_id],
): { delta: number; guide: number | null } {
  if (mode === "slip" || mode === "razor" || mode === "rearrange") return { delta, guide: null };
  const moving = selectClips(timeline, mode === "move" ? clipIds : [clip.clip_id], linked);
  const candidates = snapPoints(timeline, playhead, new Set(moving.map((item) => item.clip_id)));
  const edges =
    mode === "move"
      ? moving.flatMap((item) => [item.start_frame, clipEnd(item)])
      : mode === "slide"
        ? [clip.start_frame, clipEnd(clip)]
        : [mode.endsWith("In") ? clip.start_frame : clipEnd(clip)];
  let distance = 8 / pxPerFrame;
  let best = delta;
  let guide: number | null = null;
  for (const edge of edges) {
    for (const candidate of candidates) {
      const next = Math.abs(candidate - edge - delta);
      if (next < distance) {
        distance = next;
        best = candidate - edge;
        guide = candidate;
      }
    }
  }
  return { delta: best, guide };
}

/** Frames between two labelled ruler ticks: the smallest step whose label still has room. */
export function rulerStep(pxPerFrame: number, fps: number): number {
  const seconds = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 1, 2, 5, 10, 30, 60, 120, 300, 600];
  return Math.max(1, Math.round((seconds.find((value) => value * fps * pxPerFrame >= 88) ?? 600) * fps));
}

export function gestureBox(clip: TimelineClip, mode: GestureMode, delta: number): { start: number; length: number } {
  const length = clipDuration(clip);
  if (mode === "move" || mode === "slide") return { start: clip.start_frame + delta, length };
  if (mode.endsWith("In")) return { start: clip.start_frame + delta, length: Math.max(1, length - delta) };
  if (mode.endsWith("Out")) return { start: clip.start_frame, length: Math.max(1, length + delta) };
  return { start: clip.start_frame, length };
}

/** Edit points of the given tracks: every clip's start and end (the cut where a transition joins two), sorted, without duplicates. */
export function editPoints(timeline: StudioTimeline, trackIds: ReadonlySet<string>): number[] {
  const points = new Set<number>();
  for (const trackId of trackIds) {
    const ordered = trackClips(timeline, trackId);
    ordered.forEach((clip, index) => {
      const next = ordered[index + 1];
      const transition = next ? activeTransition(clip.effects) : null;
      if (!activeTransition(ordered[index - 1]?.effects)) points.add(clip.start_frame);
      points.add(next && transition ? cutFrame(next, transition) : clipEnd(clip));
    });
  }
  return [...points].sort((a, b) => a - b);
}

/** The previous / next edit point from a frame; null when there is none in that direction. */
export function adjacentEditPoint(timeline: StudioTimeline, trackIds: ReadonlySet<string>, frame: number, direction: -1 | 1): number | null {
  const points = editPoints(timeline, trackIds);
  const found = direction < 0 ? points.filter((point) => point < frame).at(-1) : points.find((point) => point > frame);
  return found ?? null;
}

/** The label of a track in its kind: V1, V2… / A1, A2… (its position, not the name the user gave it). */
export function trackLabel(track: TimelineTrack, tracks: readonly TimelineTrack[]): string {
  const index = tracks.filter((item) => item.kind === track.kind).findIndex((item) => item.track_id === track.track_id);
  return `${track.kind === "video" ? "V" : "A"}${String(index + 1)}`;
}
