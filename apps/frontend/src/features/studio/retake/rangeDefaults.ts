// Where a range edit (retake, candidate, gap) starts: what the owner already selected. The timeline's In/Out marks win,
// then the selected clip, then the clip of the shot the dialog was opened for, then the clip under the playhead, and
// last the gap around the playhead. The frame fields of the dialog only adjust this.
import type { StudioProject, StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { clipEnd } from "../editor/model";

export type RangeMode = "replace_range" | "fill_gap";
/** Why the range is what it is (shown next to it, so the owner sees it follows their selection). */
export type RangeOrigin = "marks" | "selection" | "shot" | "playhead" | "gap" | "given";

export interface EditRange {
  start: number;
  /** Exclusive. */
  end: number;
  mode: RangeMode;
  origin: RangeOrigin;
}

/** The shot a clip shows: its pinned candidate's origin, or the shot its source follows. */
export function clipShot(timeline: StudioTimeline, clip: TimelineClip | null | undefined): string | null {
  const source = clip ? timeline.sources.find((item) => item.source_id === clip.source_id) : undefined;
  return (source?.candidate_origin ?? source)?.shot_id ?? null;
}

/** The shot a take belongs to. */
export function takeShot(project: StudioProject, takeId: string | undefined): string | null {
  if (takeId === undefined) return null;
  return project.shots.find((shot) => shot.takes.some((take) => take.take_id === takeId))?.shot_id ?? null;
}

export interface RangeContext {
  timeline: StudioTimeline;
  selectedClip: TimelineClip | null;
  /** The shot the dialog was opened for (the Shot monitor's take), if any. */
  shotId: string | null;
  playhead: number;
}

export function defaultRange({ timeline, selectedClip, shotId, playhead }: RangeContext, track: string): EditRange {
  const clips = timeline.clips.filter((clip) => clip.track_id === track).sort((a, b) => a.start_frame - b.start_frame);
  const area = timeline.work_area;
  if (area && area.end_frame > area.start_frame) {
    const left = clips.filter((clip) => clipEnd(clip) <= area.start_frame).at(-1);
    const right = clips.find((clip) => clip.start_frame >= area.end_frame);
    const gap = left !== undefined && right !== undefined && clipEnd(left) === area.start_frame && right.start_frame === area.end_frame;
    return { start: area.start_frame, end: area.end_frame, mode: gap ? "fill_gap" : "replace_range", origin: "marks" };
  }
  const whole = (clip: TimelineClip, origin: RangeOrigin): EditRange => ({ start: clip.start_frame, end: clipEnd(clip), mode: "replace_range", origin });
  if (selectedClip?.track_id === track) return whole(selectedClip, "selection");
  if (shotId !== null) {
    const own = clips.filter((clip) => clipShot(timeline, clip) === shotId);
    const nearest = own.find((clip) => clip.start_frame <= playhead && clipEnd(clip) > playhead) ?? own[0];
    if (nearest) return whole(nearest, "shot");
  }
  const current = clips.find((clip) => clip.start_frame <= playhead && clipEnd(clip) > playhead);
  if (current) return whole(current, "playhead");
  const left = clips.filter((clip) => clipEnd(clip) <= playhead).at(-1);
  const right = clips.find((clip) => clip.start_frame > playhead);
  return { start: left ? clipEnd(left) : playhead, end: right?.start_frame ?? playhead + 1, mode: "fill_gap", origin: "gap" };
}

/** The track to start on: the selected clip's, the one holding the shot's clip, else the editor's video target. */
export function defaultTrack({ timeline, selectedClip, shotId }: RangeContext, preferred: string, usable: (trackId: string) => boolean): string {
  if (selectedClip && usable(selectedClip.track_id)) return selectedClip.track_id;
  if (shotId !== null) {
    const clip = timeline.clips.find((item) => usable(item.track_id) && clipShot(timeline, item) === shotId);
    if (clip) return clip.track_id;
  }
  if (usable(preferred)) return preferred;
  return timeline.tracks.find((row) => usable(row.track_id) && timeline.clips.some((clip) => clip.track_id === row.track_id))?.track_id
    ?? timeline.tracks.find((row) => usable(row.track_id))?.track_id ?? "";
}
