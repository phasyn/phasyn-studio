// The geometry of the keyframe lanes of Effect Controls: a lane shows the selected clip's own range, from its first
// frame at the left to its end at the right, with a little room at both ends so a key on an edge is drawn whole. The
// ruler, every lane, the playhead line and the pointer all use these functions, so they agree to the pixel. Pure.
import type { TimelineClip } from "@/api/generated/contracts";
import { formatTimecode } from "../../../../model/frames";
import { clipDuration } from "../../../model";

/** Room at both ends of a lane, in px. */
export const LANE_INSET = 10;
/** Width a ruler label needs before the next one, in px. */
const LABEL_ROOM = 64;

/** Where a sequence frame is on the lanes of a clip: 0 on its first frame, 1 on its end; null when it is not on the clip. */
export function laneFraction(clip: TimelineClip, frame: number): number | null {
  const duration = clipDuration(clip);
  const local = frame - clip.start_frame;
  return local < 0 || local > duration ? null : local / Math.max(1, duration);
}

/**
 * The CSS `left` of a lane fraction inside a lane cell. `before` is what lies left of the lanes when the position is
 * measured from the edge of the whole panel body (the width of the property column) instead of from the cell.
 */
export function laneLeft(fraction: number, before = "0px"): string {
  return `calc(${before} + ${LANE_INSET}px + (100% - ${before} - ${2 * LANE_INSET}px) * ${fraction.toFixed(5)})`;
}

/** The sequence frame under a pointer on a lane cell, kept on the clip. */
export function laneFrameAt(clip: TimelineClip, cell: { left: number; width: number }, clientX: number): number {
  const track = Math.max(1, cell.width - 2 * LANE_INSET);
  const fraction = Math.max(0, Math.min(1, (clientX - cell.left - LANE_INSET) / track));
  return clip.start_frame + Math.round(fraction * clipDuration(clip));
}

/** Frames one px of a lane cell stands for. */
export function laneFramesPerPixel(clip: TimelineClip, cell: { width: number }): number {
  return clipDuration(clip) / Math.max(1, cell.width - 2 * LANE_INSET);
}

/** A time inside a clip as the ruler writes it: the timecode without its leading zero fields ("01:12", "2:01:12"). */
export function shortTimecode(frame: number, fps: number): string {
  return formatTimecode(frame, fps).replace(/^(?:00:){1,2}/, "");
}

/** The labelled ticks of a ruler that shows `duration` frames on `width` px: the smallest round step whose labels have room. */
export function rulerTicks(duration: number, width: number, fps: number): number[] {
  const second = Math.max(1, Math.round(fps));
  const perFrame = Math.max(0, width - 2 * LANE_INSET) / Math.max(1, duration);
  // A few frames, half a second, then seconds and minutes
  const seconds = [1, 2, 5, 10, 30, 60, 300, 600].map((count) => count * second);
  const steps = [...new Set([1, 2, 5, 10, Math.max(1, Math.round(second / 2)), ...seconds])].sort((a, b) => a - b);
  const step = steps.find((candidate) => candidate * perFrame >= LABEL_ROOM) ?? Math.max(1, duration);
  const ticks: number[] = [];
  // The last label needs its room before the end of the lane
  for (let tick = 0; tick <= duration && (tick === 0 || (duration - tick) * perFrame >= LABEL_ROOM / 2); tick += step) ticks.push(tick);
  return ticks;
}
