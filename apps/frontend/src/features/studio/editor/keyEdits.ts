// The trims the keyboard makes at the playhead (Q, W, E and their Shift variants), expressed with the commands the
// pointer tools already use: nothing here edits a document by itself.
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { EditCommand } from "./commands";
import { clipEnd, trackClips, type TimelineResult } from "./model";
import { orderedTracks, primaryVideoTrack } from "./timelineGeometry";

/** The clip a playhead trim acts on: the selected one when the playhead is inside it, else the first targeted track's clip under the playhead. */
export function clipUnderPlayhead(timeline: StudioTimeline, frame: number, selected: TimelineClip | null, targets: ReadonlySet<string>): TimelineClip | null {
  const inside = (clip: TimelineClip) => clip.start_frame < frame && frame < clipEnd(clip);
  if (selected && inside(selected)) return selected;
  const main = primaryVideoTrack(timeline)?.track_id;
  const tracks = orderedTracks(timeline)
    .filter((track) => targets.has(track.track_id) && !track.locked)
    .sort((a, b) => Number(b.track_id === main) - Number(a.track_id === main));
  for (const track of tracks) {
    const clip = trackClips(timeline, track.track_id).find(inside);
    if (clip) return clip;
  }
  return null;
}

/** Q / W: bring the clip's previous (in) or next (out) edit to the playhead; ripple closes the gap. */
export function trimToPlayhead(clip: TimelineClip | null, frame: number, edge: "in" | "out", ripple: boolean, linked: boolean): TimelineResult<EditCommand> {
  if (!clip) return { ok: false, error: t("播放頭下沒有可以修剪的片段；請選取片段或開啟軌道目標") };
  const delta = edge === "in" ? frame - clip.start_frame : frame - clipEnd(clip);
  return { ok: true, value: { type: "trim", clipId: clip.clip_id, edge, delta, ripple, linked } };
}

/**
 * E: the selected clip's nearer edit moves to the playhead. On a cut the neighbour gives way (a rolling edit);
 * next to empty track it is a plain trim.
 */
export function extendToPlayhead(timeline: StudioTimeline, clip: TimelineClip | null, frame: number, linked: boolean): TimelineResult<EditCommand> {
  if (!clip) return { ok: false, error: t("請先選取要延伸的片段") };
  const end = clipEnd(clip);
  const edge = Math.abs(frame - clip.start_frame) <= Math.abs(frame - end) ? "in" : "out";
  const delta = edge === "in" ? frame - clip.start_frame : frame - end;
  if (delta === 0) return { ok: false, error: t("播放頭已經在這個編輯點上") };
  const ordered = trackClips(timeline, clip.track_id);
  const at = ordered.findIndex((item) => item.clip_id === clip.clip_id);
  const before = ordered[at - 1];
  const after = ordered[at + 1];
  if (edge === "in" && before && clipEnd(before) === clip.start_frame) return { ok: true, value: { type: "roll", leftId: before.clip_id, rightId: clip.clip_id, delta, linked } };
  if (edge === "out" && after && after.start_frame === end) return { ok: true, value: { type: "roll", leftId: clip.clip_id, rightId: after.clip_id, delta, linked } };
  return { ok: true, value: { type: "trim", clipId: clip.clip_id, edge, delta, linked } };
}
