// A shot that leaves the film: its clips are ripple-deleted together with their linked partners. When the ripple is
// refused (a clip on a sync-locked track spans the place), the clips are lifted instead and leave a gap, so nothing
// else moves. Only a locked track stops the removal. Deleting the shot itself also drops the sources that pointed at it.
import type { StudioTimeline } from "@/api/generated/contracts";
import { executeEdit } from "./commands";
import type { TimelineResult } from "./model";

export interface ShotClipsRemoval {
  timeline: StudioTimeline;
  /** False when the clips were lifted and left a gap. */
  rippled: boolean;
}

function shotSourceIds(timeline: StudioTimeline, shotId: string): Set<string> {
  return new Set(timeline.sources.filter((source) => source.shot_id === shotId).map((source) => source.source_id));
}

/** Take the shot's clips off the timeline; its sources stay, so the shot can be placed again. */
export function removeShotClips(timeline: StudioTimeline, shotId: string): TimelineResult<ShotClipsRemoval> {
  const sourceIds = shotSourceIds(timeline, shotId);
  const clipIds = timeline.clips.filter((clip) => sourceIds.has(clip.source_id)).map((clip) => clip.clip_id);
  if (clipIds.length === 0) return { ok: true, value: { timeline, rippled: true } };
  // An automatic removal never cuts what the person placed on a sync-locked track: it lifts instead (leaves a gap)
  const rippled = executeEdit(timeline, { type: "delete", clipIds, ripple: true, linked: true, keepSynced: true });
  if (rippled.ok) return { ok: true, value: { timeline: rippled.value, rippled: true } };
  const lifted = executeEdit(timeline, { type: "delete", clipIds, ripple: false, linked: true });
  return lifted.ok ? { ok: true, value: { timeline: lifted.value, rippled: false } } : lifted;
}

/** The timeline without the shot: its clips removed (see removeShotClips) and its unused sources dropped. */
export function withoutShot(timeline: StudioTimeline, shotId: string): TimelineResult<StudioTimeline> {
  const sourceIds = shotSourceIds(timeline, shotId);
  if (sourceIds.size === 0) return { ok: true, value: timeline };
  const removed = removeShotClips(timeline, shotId);
  if (!removed.ok) return removed;
  const used = new Set(removed.value.timeline.clips.map((clip) => clip.source_id));
  return { ok: true, value: { ...removed.value.timeline, sources: removed.value.timeline.sources.filter((source) => used.has(source.source_id) || !sourceIds.has(source.source_id)) } };
}
