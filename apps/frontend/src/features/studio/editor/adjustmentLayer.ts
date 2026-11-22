// A new adjustment layer (adjustment.ts says what one is): its generated source and its clip, placed over everything
// that plays where it starts. The Controller's add_adjustment command (phasyn_components.timeline_edit.adjustment)
// puts it in the same place. Pure.
import type { StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { defaultMotion, MAX_TIMELINE_FRAMES, MAX_TIMELINE_TRACKS, newTrack, type AllocateId, type TimelineResult } from "./model";
import { freeLayerTrack, textLayerFrames } from "./textLayer";
import { timelineProblem } from "./validation";

/** What a new adjustment layer, its source and a track made for it are called. */
export const ADJUSTMENT_NAME = t("調整圖層");
/** How long a new adjustment layer is. */
const ADJUSTMENT_SECONDS = 5;
const OUTSIDE = t("調整圖層起點超出時間軸範圍");
const NO_TRACK = t("請先在未鎖定的影像軌保留調整圖層空間，或移除不用的軌道");

/** The generated source and the clip of an adjustment layer of `frames` frames at `at` on a track. */
function adjustmentParts(at: number, frames: number, trackId: string, size: { width: number; height: number }, allocate: AllocateId): { source: TimelineSource; clip: TimelineClip } {
  const source: TimelineSource = { source_id: allocate("adjust"), name: ADJUSTMENT_NAME, kind: "adjustment", file: null, width: size.width, height: size.height, duration_frames: MAX_TIMELINE_FRAMES, has_audio: false };
  const clip: TimelineClip = { clip_id: allocate("clip"), name: ADJUSTMENT_NAME, source_id: source.source_id, track_id: trackId, start_frame: at, in_frame: 0, out_frame: frames, motion: defaultMotion() };
  return { source, clip };
}

/**
 * An adjustment layer at `at`, five seconds long (what is left of the sequence near its end), as one undoable document
 * transaction: on the lowest unlocked video track above the first one and above every video track that shows something
 * in its range, so it lies over everything that plays there; on a new track at the top when there is none.
 */
export function createAdjustmentLayer(timeline: StudioTimeline, at: number, width: number, height: number, allocate: AllocateId): TimelineResult<{ timeline: StudioTimeline; clipId: string }> {
  if (!Number.isSafeInteger(at) || at < 0 || at >= MAX_TIMELINE_FRAMES) return { ok: false, error: OUTSIDE };
  const frames = textLayerFrames(timeline, at, ADJUSTMENT_SECONDS);
  const existing = freeLayerTrack(timeline, at, frames);
  const track = existing ?? (timeline.tracks.length < MAX_TIMELINE_TRACKS ? newTrack(allocate("track"), "video", ADJUSTMENT_NAME) : null);
  if (!track) return { ok: false, error: NO_TRACK };
  const { source, clip } = adjustmentParts(at, frames, track.track_id, { width, height }, allocate);
  const next: StudioTimeline = { ...timeline, sources: [...timeline.sources, source], tracks: existing ? timeline.tracks : [...timeline.tracks, track], clips: [...timeline.clips, clip] };
  const problem = timelineProblem(next);
  return (problem != null && problem !== "") ? { ok: false, error: problem } : { ok: true, value: { timeline: next, clipId: clip.clip_id } };
}
