// The edits of the property panels as commands of the timeline. An edit is tried on the document first, so a field
// can say under its row why a value was refused, and is then committed as one step of the edit history. Also what a
// panel asks about the selected clip before it shows it: its kind, its linked sound and whether it can be edited.
import type { StudioTimeline, TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { executeEdit, type EditCommand } from "../../commands";
import { selectClips } from "../../model";
import type { ClipKindId } from "./controlsContext";

/** What an edit needs of the editor (the object useEditor() returns fits). */
export interface EditTarget {
  timeline: StudioTimeline;
  /** Linked selection: an edit of a clip also reaches the clips linked to it. */
  linked: boolean;
  commit: (timeline: StudioTimeline) => boolean;
}

/** True when the document took the edit, false when the editor refused it (and said why itself), else the reason. */
export type EditResult = boolean | string;

export function runEdit(target: EditTarget, command: EditCommand): EditResult {
  const result = executeEdit(target.timeline, command);
  return result.ok ? target.commit(result.value) : result.error;
}

/** A changed clip as one edit: its name, effects, motion, effect stack, mask and blend mode (never its place or its range). */
export function applyClip(target: EditTarget, clip: TimelineClip): EditResult {
  const { name, effects, motion, effect_stack, mask, blend_mode } = clip;
  const patch = { name, effects, motion, effect_stack, mask, blend_mode };
  return runEdit(target, { type: "patchClip", clipId: clip.clip_id, linked: target.linked, patch });
}

/** Several changed clips as one edit (one step of the history): every clip is applied in turn, or none when one is refused. */
export function applyClips(target: EditTarget, clips: readonly TimelineClip[]): EditResult {
  let timeline = target.timeline;
  for (const clip of clips) {
    const { name, effects, motion, effect_stack, mask, blend_mode } = clip;
    const result = executeEdit(timeline, { type: "patchClip", clipId: clip.clip_id, linked: target.linked, patch: { name, effects, motion, effect_stack, mask, blend_mode } });
    if (!result.ok) return result.error;
    timeline = result.value;
  }
  return target.commit(timeline);
}

/** How a panel changes a clip. */
export interface ClipEdits {
  /** Applies a changed clip as one edit; a field shows the answer under its row. */
  apply: (clip: TimelineClip) => EditResult;
  /** The same for a control without a field (a switch, a choice, a button): a refusal is reported as a notice. True when the document took it. */
  perform: (clip: TimelineClip) => boolean;
}

export function clipEdits(target: EditTarget, warn: (reason: string) => void): ClipEdits {
  const apply = (clip: TimelineClip) => applyClip(target, clip);
  const perform = (clip: TimelineClip) => {
    const result = apply(clip);
    if (typeof result === "string") warn(result);
    return result === true;
  };
  return { apply, perform };
}

/** Why the clip cannot be edited: its track is locked, or (with linked selection) the track of a clip linked to it. */
export function lockReason(timeline: StudioTimeline, clip: TimelineClip, linked: boolean): string | null {
  const locked = (item: TimelineClip) => timeline.tracks.find((track) => track.track_id === item.track_id)?.locked === true;
  if (locked(clip)) return t("軌道已鎖定；請先解鎖再編輯");
  const partnerLocked = linked && selectClips(timeline, [clip.clip_id], true).some(locked);
  return partnerLocked ? t("連結片段的軌道已鎖定；請先解鎖，或關閉「連結的選取範圍」") : null;
}

/** What kind of clip the panels show: one on an audio track, a text layer, an adjustment layer, or any other clip on a video track. */
export function clipKind(timeline: StudioTimeline, clip: TimelineClip, source: TimelineSource | null): ClipKindId {
  if (timeline.tracks.find((track) => track.track_id === clip.track_id)?.kind === "audio") return "audio";
  return source?.kind === "text" ? "text" : source?.kind === "adjustment" ? "adjustment" : "video";
}

/** The clip on an audio track that is linked to a clip on a video track: its sound. */
export function linkedAudio(timeline: StudioTimeline, clip: TimelineClip): TimelineClip | null {
  if (!clip.linked_id) return null;
  const audio = new Set(timeline.tracks.filter((track) => track.kind === "audio").map((track) => track.track_id));
  return timeline.clips.find((item) => item.clip_id !== clip.clip_id && item.linked_id === clip.linked_id && audio.has(item.track_id)) ?? null;
}
