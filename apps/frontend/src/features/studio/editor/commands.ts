import type { StudioTimeline, TimelineClip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { valuesEqual } from "@/lib/json";
import { activeTransition, transitionOf, type TransitionAlignment, type TransitionKind, type TransitionOptions } from "../model/clipEffects";
import { localId } from "../model/ids";
import { ADJUSTMENT_TRANSITION, isAdjustment } from "./adjustment";
import { clipDuration, clipEnd, MAX_TIMELINE_FRAMES, newTrack, processedDuration, selectClips, trackClips, type AllocateId, type TimelineResult } from "./model";
import { restoreTake } from "./restoreTake";
import { resizeClip, sliceClip } from "./slicing";
import { changeClipTiming, materializeClipWindow } from "./timing";
import { cutFrame, cutOf, DEFAULT_TRANSITION_ALIGNMENT, extendHead, extendTail, reconciledCut, restoreCut, retractHead, retractTail, splitAtCut, withoutTransitionOut } from "./transitionCut";
import { timelineProblem } from "./validation";

export type EditCommand =
  /**
   * options: direction, easing and softness of a moving transition; alignment: where it sits on the cut. What is left
   * out keeps the current value (a new transition is centred on the cut).
   */
  | { type: "transition"; clipId: string; kind: TransitionKind; frames: number; options?: TransitionOptions; alignment?: TransitionAlignment; linked?: boolean }
  | { type: "split"; clipIds: string[]; frame: number; linked?: boolean }
  | { type: "place"; clips: TimelineClip[]; mode: "insert" | "overwrite"; at: number; duration: number }
  /** keepSynced: a ripple refuses instead of extracting from a sync-locked track (automatic edits such as taking a shot out). */
  | { type: "delete"; clipIds: string[]; ripple?: boolean; linked?: boolean; keepSynced?: boolean }
  | { type: "rangeDelete"; startFrame: number; endFrame: number; ripple: boolean }
  | { type: "trim"; clipId: string; edge: "in" | "out"; delta: number; ripple?: boolean; linked?: boolean }
  | { type: "roll"; leftId: string; rightId: string; delta: number; linked?: boolean }
  | { type: "slide"; clipId: string; delta: number; linked?: boolean }
  | { type: "reorderTrack"; trackId: string; targetId: string }
  | { type: "slip"; clipId: string; delta: number; linked?: boolean }
  | { type: "move"; clipId: string; clipIds?: string[]; startFrame: number; trackId: string; linked?: boolean }
  /** Lift clips of one track (with their linked partners) and insert them before / after another clip of that track; targetId null = at the end. */
  | { type: "rearrange"; clipIds: string[]; targetId: string | null; side: "before" | "after"; linked?: boolean }
  | { type: "link"; clipIds: string[] }
  | { type: "unlink"; clipIds: string[] }
  /** The pieces of a shot's clip around clipId (one track, back to back) become one clip of its take from inFrame at normal speed. */
  | { type: "restoreTake"; clipId: string; inFrame: number }
  | { type: "patchClip"; clipId: string; patch: Partial<Pick<TimelineClip, "name" | "effects" | "motion" | "effect_stack" | "mask" | "blend_mode">>; linked?: boolean }
  | { type: "patchTrack"; trackId: string; patch: Partial<Omit<TimelineTrack, "track_id" | "kind">> }
  | { type: "addTrack"; kind: TimelineTrack["kind"]; name: string }
  | { type: "removeTrack"; trackId: string };

class EditRejected extends Error {}
function reject(message: string): never { throw new EditRejected(message); }
function unwrap<T>(result: TimelineResult<T>): T { return result.ok ? result.value : reject(result.error); }
function frame(value: number): void { if (!Number.isSafeInteger(value)) reject(t("編輯位置必須是整數影格")); }
function requiredClip(timeline: StudioTimeline, id: string): TimelineClip {
  return timeline.clips.find((clip) => clip.clip_id === id) ?? reject(t("找不到選取的片段"));
}
function sourceOf(timeline: StudioTimeline, clip: TimelineClip): TimelineSource | undefined {
  return timeline.sources.find((source) => source.source_id === clip.source_id);
}
function unlocked(timeline: StudioTimeline, trackId: string): TimelineTrack {
  const track = timeline.tracks.find((item) => item.track_id === trackId) ?? reject(t("找不到選取的軌道"));
  if (track.locked) reject(t("軌道已鎖定；請先解鎖再編輯"));
  return track;
}
function selection(timeline: StudioTimeline, ids: string[], linked = true): TimelineClip[] {
  if (ids.length === 0) reject(t("請先選取片段"));
  for (const id of ids) requiredClip(timeline, id);
  const selected = selectClips(timeline, ids, linked);
  for (const clip of selected) unlocked(timeline, clip.track_id);
  return selected;
}
function replace(timeline: StudioTimeline, clips: TimelineClip[]): void {
  const replacements = new Map(clips.map((clip) => [clip.clip_id, clip]));
  timeline.clips = timeline.clips.map((clip) => replacements.get(clip.clip_id) ?? clip);
}
function rippleTracks(timeline: StudioTimeline, targets: ReadonlySet<string>): Set<string> {
  for (const id of targets) unlocked(timeline, id);
  return new Set(timeline.tracks.filter((track) => targets.has(track.track_id) || (track.sync_lock && !track.locked)).map((track) => track.track_id));
}
function clearTransitionGuard(timeline: StudioTimeline, clip: TimelineClip): void {
  const clips = trackClips(timeline, clip.track_id);
  const index = clips.findIndex((candidate) => candidate.clip_id === clip.clip_id);
  const previous = clips[index - 1];
  if (activeTransition(clip.effects) || (previous && activeTransition(previous.effects))) reject(t("請先移除受影響編輯點的轉場"));
}
type TransitionPair = { leftId: string; rightId: string; transition: NonNullable<ReturnType<typeof activeTransition>> };
function transitionPairs(timeline: StudioTimeline): TransitionPair[] {
  return timeline.tracks.flatMap((track) => {
    const clips = trackClips(timeline, track.track_id);
    return clips.flatMap((clip, index) => {
      const transition = activeTransition(clip.effects);
      const next = clips[index + 1];
      return transition && next ? [{ leftId: clip.clip_id, rightId: next.clip_id, transition }] : [];
    });
  });
}
function transitionNeighbours(timeline: StudioTimeline, ids: ReadonlySet<string>) {
  const incoming = new Set<string>(); const outgoing = new Set<string>();
  for (const pair of transitionPairs(timeline)) {
    if (ids.has(pair.leftId) && !ids.has(pair.rightId)) outgoing.add(pair.rightId);
    if (ids.has(pair.rightId) && !ids.has(pair.leftId)) incoming.add(pair.leftId);
  }
  return { incoming, outgoing };
}
function withoutTransition(clip: TimelineClip): TimelineClip {
  if (!activeTransition(clip.effects)) return clip;
  const effects = { ...clip.effects }; delete effects.transition_out;
  return { ...clip, effects };
}
/** Resize source geometry first; the original neighbours restore any surviving transition below. */
function resizeForEdit(clip: TimelineClip, edge: "in" | "out", delta: number): TimelineClip {
  return unwrap(resizeClip(withoutTransition(clip), edge, delta));
}
/** A clip without its outgoing transition and without an effects object left empty. */
function bare(clip: TimelineClip): TimelineClip {
  const { effects, ...rest } = withoutTransitionOut(clip);
  return effects && Object.keys(effects).length > 0 ? { ...rest, effects } : rest;
}
/** Whether an edit left a clip exactly as it was (its transition aside). */
function untouched(original: StudioTimeline, clip: TimelineClip): boolean {
  const before = original.clips.find((item) => item.clip_id === clip.clip_id);
  return before !== undefined && valuesEqual(bare(before), bare(clip));
}
/** Whether a clip of a separated pair gives back what it lent: it is still there, unlocked, as the edit found it. */
function givenBack(original: StudioTimeline, timeline: StudioTimeline, clipId: string): boolean {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  const track = clip && timeline.tracks.find((item) => item.track_id === clip.track_id);
  return clip !== undefined && track !== undefined && !track.locked && untouched(original, clip);
}
/**
 * A transition belongs to its original pair, never to whichever clip happens to become next. While the pair still
 * overlaps it takes the new overlap, and a recorded cut moves with the edge that moved (reconciledCut). When the pair
 * came apart the transition goes; a clip the edit left as it was then gives back what it lent the transition beyond
 * the cut (a clip the edit moved or cut keeps what the edit gave it).
 */
function reconcileTransitions(original: StudioTimeline, timeline: StudioTimeline, origins: ReadonlyMap<string, string>): void {
  const pairs = new Map(transitionPairs(original).map((pair) => [pair.leftId, pair]));
  const kept = new Set<string>();
  for (const track of timeline.tracks) {
    const ordered = trackClips(timeline, track.track_id);
    for (const [index, clip] of ordered.entries()) {
      const pair = pairs.get(origins.get(clip.clip_id) ?? clip.clip_id);
      if (!pair) continue;
      const next = ordered[index + 1];
      const updated = withoutTransition(clip);
      const overlap = next && (origins.get(next.clip_id) ?? next.clip_id) === pair.rightId ? clipEnd(clip) - next.start_frame : 0;
      if (overlap <= 0 || !next) {
        replace(timeline, [updated]);
        continue;
      }
      kept.add(pair.leftId);
      // Geometry and source ranges stay untouched. Final validation rejects an invalid overlap.
      const transition = { ...pair.transition, frames: overlap };
      if (pair.transition.cut) transition.cut = reconciledCut(pair.transition.cut, { left: requiredClip(original, pair.leftId), right: requiredClip(original, pair.rightId) }, { left: clip, right: next });
      replace(timeline, [{ ...updated, effects: { ...updated.effects, transition_out: transition } }]);
    }
  }
  for (const pair of pairs.values()) {
    if (kept.has(pair.leftId) || !pair.transition.cut) continue;
    restorePair(timeline, pair, { left: givenBack(original, timeline, pair.leftId), right: givenBack(original, timeline, pair.rightId) });
  }
}
/**
 * A transition with a recorded cut that an edit separates: the named clips go back to the cut and give back what they
 * lent it, as the transition command leaves them (the outgoing clip also loses the transition). A clip that cannot
 * (what it lent no longer fits it) keeps its frames, as an edit always did.
 */
function restorePair(timeline: StudioTimeline, pair: TransitionPair, sides: { left: boolean; right: boolean }): void {
  const cut = cutOf(pair.transition);
  if (sides.left) {
    const outgoing = retractTail(withoutTransitionOut(requiredClip(timeline, pair.leftId)), cut.outgoing);
    if (outgoing.ok) replace(timeline, [outgoing.value]);
  }
  if (sides.right) {
    const clip = requiredClip(timeline, pair.rightId);
    const incoming = retractHead(clip, cut.incoming, sourceOf(timeline, clip));
    if (incoming.ok) replace(timeline, [incoming.value]);
  }
}
function shiftedMetadata(timeline: StudioTimeline, start: number, end: number, insert: boolean): void {
  const amount = end - start;
  const adjust = insert ? (position: number) => position >= start ? position + amount : position
    : (position: number) => position >= end ? position - amount : Math.min(position, start);
  timeline.markers = timeline.markers.map((marker) => ({ ...marker, frame: adjust(marker.frame) }));
  timeline.captions = timeline.captions.map((caption) => ({ ...caption, start_frame: adjust(caption.start_frame), end_frame: insert && caption.end_frame === start ? caption.end_frame : adjust(caption.end_frame) })).filter((caption) => caption.end_frame > caption.start_frame);
}
function rightLink(clip: TimelineClip, links: Map<string, string>, allocate: AllocateId): string | undefined {
  if (!clip.linked_id) return undefined;
  let link = links.get(clip.linked_id);
  if (!link) { link = allocate("link"); links.set(clip.linked_id, link); }
  return link;
}
/** A complete right-side member follows the new group even when another member supplied its ID later. */
function relinkRight(clip: TimelineClip, links: ReadonlyMap<string, string>): TimelineClip {
  const link = clip.linked_id ? links.get(clip.linked_id) : undefined;
  return link ? { ...clip, linked_id: link } : clip;
}
/** For each moved clip, the staying clips it still forms a transition with after the move (same track, same order, an overlap a transition can have). */
function keptPartners(timeline: StudioTimeline, moved: readonly TimelineClip[]): Map<string, Set<string>> {
  const byId = new Map(moved.map((clip) => [clip.clip_id, clip]));
  const kept = new Map<string, Set<string>>();
  for (const pair of transitionPairs(timeline)) {
    const leftMoved = byId.has(pair.leftId);
    if (leftMoved === byId.has(pair.rightId)) continue;
    const left = byId.get(pair.leftId) ?? requiredClip(timeline, pair.leftId);
    const right = byId.get(pair.rightId) ?? requiredClip(timeline, pair.rightId);
    const overlap = clipEnd(left) - right.start_frame;
    if (left.track_id !== right.track_id || left.start_frame >= right.start_frame || overlap < 1 || overlap > Math.min(clipDuration(left), clipDuration(right))) continue;
    const [movedId, partnerId] = leftMoved ? [pair.leftId, pair.rightId] : [pair.rightId, pair.leftId];
    kept.set(movedId, (kept.get(movedId) ?? new Set()).add(partnerId));
  }
  return kept;
}
function adjacent(left: TimelineClip, right: TimelineClip): boolean {
  return left.track_id === right.track_id && clipEnd(left) - (activeTransition(left.effects)?.frames ?? 0) === right.start_frame;
}
function splitSelected(timeline: StudioTimeline, command: Extract<EditCommand, { type: "split" }>, allocate: AllocateId): void {
  frame(command.frame);
  const selected = selection(timeline, command.clipIds, command.linked);
  const requested = new Set(command.clipIds);
  const links = new Map<string, string>();
  const right = new Set<string>();
  const output: TimelineClip[] = [];
  const ids = new Set(selected.map((clip) => clip.clip_id));
  for (const clip of selected) {
    const offset = command.frame - clip.start_frame;
    if (offset <= 0 || offset >= clipDuration(clip)) {
      if (requested.has(clip.clip_id)) reject(t("分割點必須位於所有選取片段的內部"));
      if (offset <= 0) right.add(clip.clip_id);
      output.push(clip); continue;
    }
    const ordered = trackClips(timeline, clip.track_id);
    const previous = ordered[ordered.findIndex((candidate) => candidate.clip_id === clip.clip_id) - 1];
    if (previous && activeTransition(previous.effects) && clipEnd(previous) > command.frame) reject(t("請先移除切點上的轉場"));
    // A split where the outgoing transition starts would leave a part wholly inside it, starting with the next clip
    const outgoing = activeTransition(clip.effects)?.frames ?? 0;
    if (outgoing > 0 && offset >= clipDuration(clip) - outgoing) reject(t("請先移除切點上的轉場"));
    const head = unwrap(sliceClip(clip, 0, offset, clip.clip_id));
    const tail = unwrap(sliceClip(clip, offset, clipDuration(clip), allocate("clip")));
    const link = rightLink(clip, links, allocate);
    if (link) tail.linked_id = link;
    output.push(head, tail);
  }
  timeline.clips = [...timeline.clips.filter((clip) => !ids.has(clip.clip_id)), ...output.map((clip) => right.has(clip.clip_id) ? relinkRight(clip, links) : clip)];
}
/** Empty [start, end) on `tracks` (overwrite, lift). Clips in `skip` stay; `links` shares new link ids between the calls of one edit. */
function clearRange(timeline: StudioTimeline, tracks: ReadonlySet<string>, start: number, end: number, allocate: AllocateId, skip: ReadonlySet<string> = new Set(), links = new Map<string, string>()): void {
  const output: TimelineClip[] = [];
  const right = new Set<string>();
  for (const clip of timeline.clips) {
    if (skip.has(clip.clip_id) || !tracks.has(clip.track_id) || clipEnd(clip) <= start) { output.push(clip); continue; }
    if (clip.start_frame >= end) { right.add(clip.clip_id); output.push(clip); continue; }
    unlocked(timeline, clip.track_id);
    clearTransitionGuard(timeline, clip);
    if (clip.start_frame < start) output.push(unwrap(sliceClip(clip, 0, start - clip.start_frame, clip.clip_id)));
    if (clipEnd(clip) > end) {
      const tail = unwrap(sliceClip(clip, end - clip.start_frame, clipDuration(clip), clip.start_frame < start ? allocate("clip") : clip.clip_id));
      const link = rightLink(clip, links, allocate);
      if (link) tail.linked_id = link;
      output.push(tail);
    }
  }
  timeline.clips = output.map((clip) => right.has(clip.clip_id) ? relinkRight(clip, links) : clip);
}
function place(timeline: StudioTimeline, command: Extract<EditCommand, { type: "place" }>, allocate: AllocateId): void {
  frame(command.at); frame(command.duration);
  if (command.at < 0 || command.duration <= 0 || command.clips.length === 0) reject(t("插入範圍無效"));
  const targets = new Set(command.clips.map((clip) => clip.track_id));
  for (const clip of command.clips) {
    unlocked(timeline, clip.track_id);
    if (clip.start_frame < 0 || clipEnd(clip) > command.duration) reject(t("插入片段必須位於指定範圍內"));
  }
  if (command.mode === "overwrite") clearRange(timeline, targets, command.at, command.at + command.duration, allocate);
  else {
    const tracks = rippleTracks(timeline, targets);
    const output: TimelineClip[] = [];
    const links = new Map<string, string>();
    const right = new Set<string>();
    for (const clip of timeline.clips) {
      if (!tracks.has(clip.track_id)) { output.push(clip); continue; }
      if (clip.start_frame >= command.at) {
        right.add(clip.clip_id);
        output.push({ ...clip, start_frame: clip.start_frame + command.duration });
      }
      else if (clipEnd(clip) > command.at) {
        clearTransitionGuard(timeline, clip);
        const offset = command.at - clip.start_frame;
        const head = unwrap(sliceClip(clip, 0, offset, clip.clip_id));
        const tail = unwrap(sliceClip(clip, offset, clipDuration(clip), allocate("clip")));
        tail.start_frame += command.duration;
        const link = rightLink(clip, links, allocate);
        if (link) tail.linked_id = link;
        output.push(head, tail);
      } else output.push(clip);
    }
    timeline.clips = output.map((clip) => right.has(clip.clip_id) ? relinkRight(clip, links) : clip);
    shiftedMetadata(timeline, command.at, command.at + command.duration, true);
  }
  timeline.clips.push(...command.clips.map((clip) => ({ ...structuredClone(clip), start_frame: clip.start_frame + command.at })));
}
function deleteSelected(timeline: StudioTimeline, command: Extract<EditCommand, { type: "delete" }>, allocate: AllocateId): void {
  const selected = selection(timeline, command.clipIds, command.linked);
  const ids = new Set(selected.map((clip) => clip.clip_id));
  const neighbours = transitionNeighbours(timeline, ids);
  // A clip that stays gives back what it lent a transition with a recorded cut into or out of a deleted clip: it ends
  // (or starts) at the cut again, and a ripple closes only the time from the cut on
  for (const pair of transitionPairs(timeline)) {
    if (pair.transition.cut && ids.has(pair.leftId) !== ids.has(pair.rightId)) restorePair(timeline, pair, { left: !ids.has(pair.leftId), right: !ids.has(pair.rightId) });
  }
  timeline.clips = timeline.clips.filter((clip) => !ids.has(clip.clip_id));
  if (!command.ripple) return;
  const tracks = rippleTracks(timeline, new Set(selected.map((clip) => clip.track_id)));
  let ranges: { start: number; end: number }[] = [];
  for (const clip of [...selected].sort((a, b) => a.start_frame - b.start_frame)) {
    const last = ranges.at(-1);
    if (last && clip.start_frame <= last.end) last.end = Math.max(last.end, clipEnd(clip));
    else ranges.push({ start: clip.start_frame, end: clipEnd(clip) });
  }
  // A surviving transition neighbour still owns its complete source interval. Close only time
  // freed by this deletion, rather than removing its overlapping picture or sound.
  for (const clip of timeline.clips) {
    if (!tracks.has(clip.track_id) || (!neighbours.incoming.has(clip.clip_id) && !neighbours.outgoing.has(clip.clip_id))) continue;
    ranges = ranges.flatMap((range) => {
      if (clip.start_frame >= range.end || clipEnd(clip) <= range.start) return [range];
      return [
        ...(range.start < clip.start_frame ? [{ start: range.start, end: clip.start_frame }] : []),
        ...(clipEnd(clip) < range.end ? [{ start: clipEnd(clip), end: range.end }] : []),
      ];
    });
  }
  for (const range of ranges.reverse()) {
    // As in Premiere, a sync-locked track gives up what it has in the freed time (extracted there, clips cut around
    // it), so every track stays in sync (the Python twin's close_ranges with allocate)
    if (!command.keepSynced) clearRange(timeline, tracks, range.start, range.end, allocate);
    for (const clip of timeline.clips) if (tracks.has(clip.track_id) && clip.start_frame < range.end && clipEnd(clip) > range.start) reject(t("同步鎖定軌道在刪除範圍內仍有片段；請一併選取或關閉同步鎖定"));
    timeline.clips = timeline.clips.map((clip) => tracks.has(clip.track_id) && clip.start_frame >= range.end ? { ...clip, start_frame: clip.start_frame - (range.end - range.start) } : clip);
    shiftedMetadata(timeline, range.start, range.end, false);
  }
}
/** Lift or extract a sequence range. Every surviving fragment retains its exact source samples. */
function rangeDelete(timeline: StudioTimeline, command: Extract<EditCommand, { type: "rangeDelete" }>, allocate: AllocateId, origins: Map<string, string>): void {
  const { startFrame: start, endFrame: end, ripple } = command;
  frame(start); frame(end);
  if (start < 0 || end <= start || end > MAX_TIMELINE_FRAMES) reject(t("序列入點與出點必須形成有效範圍"));
  const output: TimelineClip[] = [];
  const links = new Map<string, string>();
  const right = new Set<string>();
  // Preserve the original compositing order when overlapping fragments acquire the same start.
  for (const clip of timeline.tracks.flatMap((track) => trackClips(timeline, track.track_id))) {
    if (clipEnd(clip) <= start) { output.push(clip); continue; }
    if (clip.start_frame >= end) {
      if (ripple) unlocked(timeline, clip.track_id);
      right.add(clip.clip_id);
      output.push(ripple ? { ...clip, start_frame: clip.start_frame - (end - start) } : clip);
      continue;
    }
    unlocked(timeline, clip.track_id);
    const source = withoutTransition(clip);
    if (clip.start_frame < start) output.push(unwrap(sliceClip(source, 0, start - clip.start_frame, clip.clip_id)));
    if (clipEnd(clip) > end) {
      const tail = unwrap(sliceClip(source, end - clip.start_frame, clipDuration(clip), clip.start_frame < start ? allocate("clip") : clip.clip_id));
      const link = rightLink(clip, links, allocate);
      if (link) tail.linked_id = link;
      origins.set(tail.clip_id, clip.clip_id);
      if (ripple) tail.start_frame -= end - start;
      output.push(tail);
    }
  }
  timeline.clips = output.map((clip) => {
    if (!right.has(clip.clip_id)) return clip;
    const updated = relinkRight(clip, links);
    if (updated !== clip) unlocked(timeline, clip.track_id);
    return updated;
  });
  timeline.captions = timeline.captions.flatMap((caption) => {
    if (caption.end_frame <= start || caption.start_frame >= end) return [caption];
    const split = caption.start_frame < start && caption.end_frame > end;
    return [
      ...(caption.start_frame < start ? [{ ...caption, caption_id: split ? allocate("caption") : caption.caption_id, end_frame: start }] : []),
      ...(caption.end_frame > end ? [{ ...caption, caption_id: split ? allocate("caption") : caption.caption_id, start_frame: end }] : []),
    ];
  });
  if (ripple) {
    timeline.markers = timeline.markers.filter((marker) => marker.frame < start || marker.frame >= end);
    shiftedMetadata(timeline, start, end, false);
  }
}
function trim(timeline: StudioTimeline, command: Extract<EditCommand, { type: "trim" }>): void {
  frame(command.delta);
  const selected = selection(timeline, [command.clipId], command.linked);
  const primary = requiredClip(timeline, command.clipId);
  const resized = selected.map((clip) => resizeForEdit(clip, command.edge, command.delta));
  if (!command.ripple) { replace(timeline, resized); return; }
  const boundary = command.edge === "in" ? primary.start_frame : clipEnd(primary);
  if (selected.some((clip) => (command.edge === "in" ? clip.start_frame : clipEnd(clip)) !== boundary)) reject(t("連結片段的編輯點不同；請取消連結選取後修剪"));
  const change = command.edge === "in" ? -command.delta : command.delta;
  const tracks = rippleTracks(timeline, new Set(selected.map((clip) => clip.track_id)));
  const ids = new Set(selected.map((clip) => clip.clip_id));
  const neighbours = transitionNeighbours(timeline, ids);
  const removalStart = command.edge === "in" ? boundary : boundary + change;
  const removalEnd = removalStart - change;
  const pivot = change >= 0 ? boundary : removalEnd;
  for (const clip of timeline.clips) {
    if (ids.has(clip.clip_id) || !tracks.has(clip.track_id) || neighbours.incoming.has(clip.clip_id) || neighbours.outgoing.has(clip.clip_id)) continue;
    const conflict = change >= 0 ? clip.start_frame < pivot && clipEnd(clip) > pivot
      : clip.start_frame < removalEnd && clipEnd(clip) > removalStart;
    if (conflict) reject(t("同步鎖定軌道的片段跨越修剪點；請先分割或關閉同步鎖定"));
  }
  replace(timeline, resized.map((clip) => command.edge === "in" ? { ...clip, start_frame: clip.start_frame - command.delta } : clip));
  timeline.clips = timeline.clips.map((clip) => !ids.has(clip.clip_id) && tracks.has(clip.track_id) && (neighbours.outgoing.has(clip.clip_id) || (!neighbours.incoming.has(clip.clip_id) && clip.start_frame >= pivot)) ? { ...clip, start_frame: clip.start_frame + change } : clip);
  if (change > 0) shiftedMetadata(timeline, boundary, boundary + change, true);
  else shiftedMetadata(timeline, removalStart, removalEnd, false);
}
function roll(timeline: StudioTimeline, command: Extract<EditCommand, { type: "roll" }>): void {
  frame(command.delta);
  const left = requiredClip(timeline, command.leftId);
  const right = requiredClip(timeline, command.rightId);
  if (!adjacent(left, right)) reject(t("滾動編輯需要同軌且緊鄰的兩個片段"));
  const heads = selection(timeline, [left.clip_id], command.linked);
  const tails = selection(timeline, [right.clip_id], command.linked);
  if (heads.some((clip) => tails.some((tail) => tail.clip_id === clip.clip_id))) reject(t("兩側片段不可屬於同一連結群組"));
  for (const head of heads) {
    const tail = tails.find((candidate) => adjacent(head, candidate));
    if (!tail) reject(t("所有連結軌道都必須有相鄰的編輯點"));
  }
  if (heads.length !== tails.length) reject(t("兩側連結軌道數不同；請取消連結選取後修剪"));
  replace(timeline, [...heads.map((clip) => resizeForEdit(clip, "out", command.delta)), ...tails.map((clip) => resizeForEdit(clip, "in", command.delta))]);
}
/** A slide keeps the selected source and duration; only its two neighbours' edges move. */
function slide(timeline: StudioTimeline, command: Extract<EditCommand, { type: "slide" }>): void {
  frame(command.delta);
  const selected = selection(timeline, [command.clipId], command.linked);
  const roles = new Map<string, { clip: TimelineClip; edge: "in" | "out" | "move" }>();
  const add = (clip: TimelineClip, edge: "in" | "out" | "move") => {
    const previous = roles.get(clip.clip_id);
    if (previous && previous.edge !== edge) reject(t("連結片段的內滑範圍互相重疊"));
    roles.set(clip.clip_id, { clip, edge });
  };
  for (const clip of selected) {
    const ordered = trackClips(timeline, clip.track_id);
    const index = ordered.findIndex((item) => item.clip_id === clip.clip_id);
    const left = ordered[index - 1]; const right = ordered[index + 1];
    if (!left || !right || !adjacent(left, clip) || !adjacent(clip, right)) reject(t("內滑工具需要片段兩側都有相鄰片段"));
    if (selected.some((item) => item.clip_id === left.clip_id || item.clip_id === right.clip_id)) reject(t("內滑時請只選取中央片段及其連結片段"));
    add(clip, "move");
    for (const neighbour of selection(timeline, [left.clip_id], command.linked)) add(neighbour, "out");
    for (const neighbour of selection(timeline, [right.clip_id], command.linked)) add(neighbour, "in");
  }
  const updates = [...roles.values()].map(({ clip, edge }) => edge === "move"
    ? { ...clip, start_frame: clip.start_frame + command.delta }
    : resizeForEdit(clip, edge, command.delta));
  replace(timeline, updates);
}
/** The clip after a clip on its track. */
function nextOnTrack(timeline: StudioTimeline, clip: TimelineClip): TimelineClip | undefined {
  const ordered = trackClips(timeline, clip.track_id);
  return ordered[ordered.findIndex((item) => item.clip_id === clip.clip_id) + 1];
}
/** Where the cut between a clip and the next one is: inside the transition between them, else where they meet. */
function cutBetween(left: TimelineClip, right: TimelineClip): number {
  const current = activeTransition(left.effects);
  return current ? cutFrame(right, current) : clipEnd(left);
}
/**
 * A transition on the cut between a clip and the next clip of its track, placed as Premiere places one: by its
 * alignment, covered by the two clips' own frames beyond the cut (their hidden output, their source handles, a held
 * edge frame where the media runs out). Only those two clips (and their linked partners) change: nothing else moves,
 * whatever the sync locks, and the sequence keeps its length. A change starts again from the cut, and a cut gives both
 * clips back as they were there.
 */
function transition(timeline: StudioTimeline, command: Extract<EditCommand, { type: "transition" }>): void {
  frame(command.frames);
  const left = requiredClip(timeline, command.clipId);
  const selected = selection(timeline, [left.clip_id], command.linked);
  const current = activeTransition(left.effects);
  const frames = command.kind === "cut" ? 0 : command.frames;
  const hints: TransitionOptions = { ...current, ...command.options };
  if (frames < 0 || frames > 240 || (command.kind !== "cut" && frames < 1)) reject(t("轉場長度必須介於 1–240 影格"));
  const alignment = command.alignment ?? (current ? cutOf(current).alignment : DEFAULT_TRANSITION_ALIGNMENT);
  const primary = nextOnTrack(timeline, left);
  const at = primary && adjacent(left, primary) ? cutBetween(left, primary) : null;
  const ids = new Set(selected.map((clip) => clip.clip_id));
  const updates: TimelineClip[] = [];
  for (const clip of selected) {
    const next = nextOnTrack(timeline, clip);
    if (at === null || !next || !adjacent(clip, next) || cutBetween(clip, next) !== at) reject(t("轉場需要各連結軌道都有對齊的相鄰片段"));
    if (ids.has(next.clip_id)) reject(t("兩側片段不可屬於同一連結群組"));
    // An adjustment layer has no picture of its own to dissolve: its effect fades with its fades or its opacity
    if (command.kind !== "cut" && (isAdjustment(timeline, clip) || isAdjustment(timeline, next))) reject(ADJUSTMENT_TRANSITION);
    const existing = activeTransition(clip.effects);
    const restored = existing ? unwrap(restoreCut(clip, next, existing, sourceOf(timeline, next))) : { left: withoutTransitionOut(clip), right: next };
    if (command.kind === "cut") {
      updates.push(windowAsBefore(clip, restored.left), windowAsBefore(next, restored.right));
      continue;
    }
    if (frames > Math.min(clipDuration(restored.left), clipDuration(restored.right))) reject(t("轉場長度不得超過兩側片段長度"));
    const { before, after } = splitAtCut(frames, alignment);
    const tail = unwrap(extendTail(restored.left, after, sourceOf(timeline, clip)));
    const head = unwrap(extendHead(restored.right, before, sourceOf(timeline, next)));
    const value = { ...transitionOf(command.kind, frames, hints), cut: { alignment, outgoing: tail.side, incoming: head.side } };
    updates.push(windowAsBefore(clip, { ...tail.clip, effects: { ...tail.clip.effects, transition_out: value } }), windowAsBefore(next, head.clip));
  }
  replace(timeline, updates);
}
/** A clip that had no output window and shows its whole clock again keeps none (a transition made before cuts were recorded is restored by trimming). */
function windowAsBefore(before: TimelineClip, after: TimelineClip): TimelineClip {
  const window = after.output_window;
  if (before.output_window || !window || window.start_frame !== 0 || window.end_frame !== processedDuration(after)) return after;
  const { output_window: _window, ...rest } = after;
  return rest;
}
interface FlowItem {
  clip: TimelineClip;
  /** Frames between the previous clip's end and this clip's start; negative while a transition overlaps them. */
  lead: number;
}
/** One track after a rearrange: the block leaves, later clips close up, and the block lands before / after the anchor. */
function reflow(ordered: TimelineClip[], moving: ReadonlySet<string>, anchorId: string | null, side: "before" | "after"): FlowItem[] {
  const items: FlowItem[] = ordered.map((clip, index) => {
    const previous = ordered[index - 1];
    return { clip, lead: clip.start_frame - (previous ? clipEnd(previous) : 0) };
  });
  const rest: FlowItem[] = [];
  const block: FlowItem[] = [];
  let freed = 0;
  let lifted = false;
  items.forEach((item, index) => {
    if (moving.has(item.clip.clip_id)) {
      // Clips that travel together keep their distance; a clip joining the block from elsewhere is packed against it
      const together = moving.has(items[index - 1]?.clip.clip_id ?? "");
      block.push({ clip: item.clip, lead: together ? item.lead : 0 });
      if (!together) freed += Math.max(0, item.lead);
      lifted = true;
    } else {
      // The gaps on both sides of a lifted clip merge; a transition into or out of it goes with it
      rest.push({ clip: item.clip, lead: lifted ? Math.max(0, item.lead) + freed : item.lead });
      freed = 0;
      lifted = false;
    }
  });
  const first = block[0];
  if (!first) return rest;
  const anchorAt = anchorId === null ? rest.length - 1 : rest.findIndex((item) => item.clip.clip_id === anchorId);
  if (anchorId !== null && anchorAt < 0) reject(t("連結軌道上找不到對應的目標片段；請取消連結選取後再調整順序"));
  const at = anchorId === null || side === "after" ? anchorAt + 1 : anchorAt;
  const following = rest[at];
  if (following && side === "before" && anchorId !== null) {
    // The block takes the anchor's place, the anchor follows it directly
    first.lead = Math.max(0, following.lead);
    following.lead = 0;
  } else {
    first.lead = 0;
    if (following) following.lead = Math.max(0, following.lead);
  }
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}
/**
 * Rearrange edit: only the tracks the block is on re-flow, so nothing is overwritten and other tracks, captions and
 * markers stay where they are. A transition belongs to its original pair and goes when the pair is separated; linked
 * clips must stay aligned or the whole edit is refused.
 */
function rearrange(timeline: StudioTimeline, command: Extract<EditCommand, { type: "rearrange" }>): void {
  const requested = command.clipIds.map((id) => requiredClip(timeline, id));
  const trackId = requested[0]?.track_id ?? reject(t("請先選取片段"));
  if (requested.some((clip) => clip.track_id !== trackId)) reject(t("調整順序的片段必須在同一軌道"));
  const group = selection(timeline, command.clipIds, command.linked);
  const moving = new Set(group.map((clip) => clip.clip_id));
  const target = command.targetId === null ? null : requiredClip(timeline, command.targetId);
  if (target && (target.track_id !== trackId || moving.has(target.clip_id))) reject(t("目標片段必須是同一軌道上的其他片段"));
  const anchors = target ? selectClips(timeline, [target.clip_id], command.linked) : [];
  const tracks = [...new Set(group.map((clip) => clip.track_id))];
  const flowed = () => {
    const pairs = transitionPairs(timeline);
    const updated: TimelineClip[] = [];
    const separated: TransitionPair[] = [];
    for (const id of tracks) {
      const anchor = target === null ? null : (anchors.find((clip) => clip.track_id === id)?.clip_id ?? reject(t("連結軌道上找不到對應的目標片段；請取消連結選取後再調整順序")));
      const flow = reflow(trackClips(timeline, id), moving, anchor, command.side);
      let cursor = 0;
      let overlap = 0;
      flow.forEach((item, index) => {
        // A clip that keeps the transition into it overlaps the previous one by it, whatever gap the re-flow gave it
        const start = overlap > 0 ? cursor - overlap : cursor + item.lead;
        const next = flow[index + 1];
        const pair = pairs.find((candidate) => candidate.leftId === item.clip.clip_id);
        const kept = pair !== undefined && next?.clip.clip_id === pair.rightId;
        if (pair && !kept) separated.push(pair);
        updated.push({ ...(kept ? item.clip : withoutTransition(item.clip)), start_frame: start });
        cursor = start + clipDuration(item.clip);
        overlap = kept ? pair.transition.frames : 0;
      });
    }
    return { updated, separated: separated.filter((pair) => pair.transition.cut !== undefined) };
  };
  const first = flowed();
  let updated = first.updated;
  if (first.separated.length > 0) {
    // Transitions with a recorded cut that the new order separates go first: their clips are back at the cut, so
    // the clips that close up meet where the cuts are and the moved clips keep no borrowed frames
    for (const pair of first.separated) restorePair(timeline, pair, { left: true, right: true });
    updated = flowed().updated;
  }
  const shift = new Map<string, number>();
  for (const clip of updated) {
    const original = requiredClip(timeline, clip.clip_id);
    const delta = clip.start_frame - original.start_frame;
    if (!clip.linked_id) continue;
    const known = shift.get(clip.linked_id);
    if (known !== undefined && known !== delta) reject(t("連結片段會錯開；請取消連結選取後再調整順序"));
    shift.set(clip.linked_id, delta);
  }
  if (command.linked !== false) {
    const reflowed = new Set(updated.map((clip) => clip.clip_id));
    for (const clip of timeline.clips) {
      // A linked partner on a track that does not re-flow would be left behind
      if (clip.linked_id && !reflowed.has(clip.clip_id) && (shift.get(clip.linked_id) ?? 0) !== 0) reject(t("連結片段會錯開；請取消連結選取後再調整順序"));
    }
  }
  replace(timeline, updated);
}
function mutate(timeline: StudioTimeline, command: EditCommand, allocate: AllocateId, origins: Map<string, string>): void {
  switch (command.type) {
    case "transition": transition(timeline, command); return;
    case "split": splitSelected(timeline, command, allocate); return;
    case "place": place(timeline, command, allocate); return;
    case "delete": deleteSelected(timeline, command, allocate); return;
    case "rangeDelete": rangeDelete(timeline, command, allocate, origins); return;
    case "trim": trim(timeline, command); return;
    case "roll": roll(timeline, command); return;
    case "slide": slide(timeline, command); return;
    case "reorderTrack": {
      const track = unlocked(timeline, command.trackId); const target = unlocked(timeline, command.targetId);
      if (track.kind !== target.kind) reject(t("只能調整相同種類軌道的順序"));
      timeline.tracks = timeline.tracks.map((item) => item === track ? target : item === target ? track : item);
      return;
    }
    case "slip": {
      frame(command.delta);
      const selected = selection(timeline, [command.clipId], command.linked);
      replace(timeline, selected.map((clip) => {
        const source = timeline.sources.find((item) => item.source_id === clip.source_id);
        const fullFits = clip.in_frame + command.delta >= 0 && clip.out_frame + command.delta <= (source?.duration_frames ?? 0);
        const base = fullFits ? clip : unwrap(materializeClipWindow(clip));
        return { ...base, in_frame: base.in_frame + command.delta, out_frame: base.out_frame + command.delta };
      }));
      return;
    }
    case "move": {
      frame(command.startFrame);
      const primary = requiredClip(timeline, command.clipId);
      const target = unlocked(timeline, command.trackId);
      const original = unlocked(timeline, primary.track_id);
      if (target.kind !== original.kind) reject(t("只能移至相同種類的軌道"));
      const selected = selection(timeline, command.clipIds ?? [command.clipId], command.linked);
      if (!selected.some((clip) => clip.clip_id === primary.clip_id)) reject(t("找不到選取的片段"));
      const peers = timeline.tracks.filter((track) => track.kind === original.kind);
      const trackDelta = peers.findIndex((track) => track.track_id === target.track_id) - peers.findIndex((track) => track.track_id === original.track_id);
      const delta = command.startFrame - primary.start_frame;
      const moved = selected.map((clip) => {
        const source = unlocked(timeline, clip.track_id);
        const tracks = timeline.tracks.filter((track) => track.kind === source.kind);
        const destination = tracks[tracks.findIndex((track) => track.track_id === source.track_id) + trackDelta];
        if (!destination) reject(t("整組移動超出可用的同類軌道"));
        unlocked(timeline, destination.track_id);
        return { ...clip, start_frame: clip.start_frame + delta, track_id: destination.track_id };
      });
      // Overwrite, as in Premiere: what the clips land on is cleared (cut back or removed); the gap they leave stays.
      // A staying clip that keeps a transition with a moved one is not cleared: their overlap is the transition.
      const ids = new Set(selected.map((clip) => clip.clip_id));
      const kept = keptPartners(timeline, moved);
      const links = new Map<string, string>();
      for (const clip of moved) clearRange(timeline, new Set([clip.track_id]), clip.start_frame, clipEnd(clip), allocate, new Set([...ids, ...(kept.get(clip.clip_id) ?? [])]), links);
      replace(timeline, moved);
      return;
    }
    case "rearrange": rearrange(timeline, command); return;
    case "restoreTake": {
      frame(command.inFrame);
      unlocked(timeline, requiredClip(timeline, command.clipId).track_id);
      const { removed, clip } = unwrap(restoreTake(timeline, command.clipId, command.inFrame));
      const gone = new Set(removed);
      timeline.clips = timeline.clips.filter((item) => !gone.has(item.clip_id));
      replace(timeline, [clip]);
      return;
    }
    case "link": {
      const selected = selection(timeline, command.clipIds, true);
      if (selected.length < 2) reject(t("至少選取兩個片段才能連結"));
      const id = allocate("link");
      replace(timeline, selected.map((clip) => ({ ...clip, linked_id: id })));
      return;
    }
    case "unlink": {
      const selected = selection(timeline, command.clipIds, true);
      replace(timeline, selected.map((clip) => { const value = { ...clip }; delete value.linked_id; return value; }));
      return;
    }
    case "patchClip": {
      const clip = requiredClip(timeline, command.clipId);
      const peers = selection(timeline, [clip.clip_id], command.linked);
      const updated = { ...clip, ...structuredClone(command.patch) };
      const speedChanged = (updated.effects?.speed_percent ?? 100) !== (clip.effects?.speed_percent ?? 100);
      const holdStartChanged = (updated.effects?.hold?.start ?? 0) !== (clip.effects?.hold?.start ?? 0);
      const holdEndChanged = (updated.effects?.hold?.end ?? 0) !== (clip.effects?.hold?.end ?? 0);
      const timingChanged = speedChanged || holdStartChanged || holdEndChanged;
      const phaseChanged = timingChanged || JSON.stringify(updated.effects?.fade) !== JSON.stringify(clip.effects?.fade) || JSON.stringify(updated.effects?.impact) !== JSON.stringify(clip.effects?.impact) || (updated.effects?.frame_step ?? 1) !== (clip.effects?.frame_step ?? 1) || (updated.effects?.camera?.shake_px ?? 0) !== (clip.effects?.camera?.shake_px ?? 0) || (updated.effects?.camera?.shake_frames ?? 0) !== (clip.effects?.camera?.shake_frames ?? 0);
      replace(timeline, peers.map((item) => {
        if (!phaseChanged) return item.clip_id === clip.clip_id ? updated : item;
        if (item.clip_id !== clip.clip_id && !timingChanged) return item;
        let effects = updated.effects;
        if (item.clip_id !== clip.clip_id) {
          effects = { ...item.effects };
          if (speedChanged) effects.speed_percent = updated.effects?.speed_percent;
          if (holdStartChanged) effects.hold = { ...effects.hold, start: updated.effects?.hold?.start ?? 0 };
          if (holdEndChanged) effects.hold = { ...effects.hold, end: updated.effects?.hold?.end ?? 0 };
        }
        const retimed = unwrap(changeClipTiming(item.clip_id === clip.clip_id ? { ...updated, effects: item.effects } : item, effects));
        return item.clip_id === clip.clip_id ? { ...retimed, name: updated.name } : retimed;
      }));
      return;
    }
    case "patchTrack": {
      const track = timeline.tracks.find((candidate) => candidate.track_id === command.trackId) ?? reject(t("找不到選取的軌道"));
      timeline.tracks = timeline.tracks.map((candidate) => candidate === track ? { ...track, ...command.patch } : candidate);
      return;
    }
    case "addTrack": timeline.tracks.push(newTrack(allocate("track"), command.kind, command.name)); return;
    case "removeTrack": {
      unlocked(timeline, command.trackId);
      if (timeline.clips.some((clip) => clip.track_id === command.trackId)) reject(t("軌道仍有片段；請先移動或移除片段"));
      timeline.tracks = timeline.tracks.filter((track) => track.track_id !== command.trackId);
      return;
    }
  }
}
/** Transactional edit: only return a fully valid new document; the caller owns history and persistence. */
export function executeEdit(timeline: StudioTimeline, command: EditCommand, allocate: AllocateId = localId): TimelineResult<StudioTimeline> {
  const initial = timelineProblem(timeline);
  if (initial) return { ok: false, error: initial };
  const draft = structuredClone(timeline);
  try {
    const origins = new Map<string, string>();
    mutate(draft, command, allocate, origins);
    if (command.type === "move" || command.type === "trim" || command.type === "delete" || command.type === "rangeDelete" || command.type === "roll" || command.type === "slide") reconcileTransitions(timeline, draft, origins);
    // A text or an adjustment layer has no source to trim: its range restarts at 0 (and a text covers the clip)
    const kinds = new Map(draft.sources.map((source) => [source.source_id, source.kind]));
    draft.clips = draft.clips.map((clip) => {
      const kind = kinds.get(clip.source_id);
      const title = clip.effects?.title;
      if (kind !== "adjustment" && (kind !== "text" || !title)) return clip;
      const restarted = { ...clip, in_frame: 0, out_frame: clip.out_frame - clip.in_frame };
      return title && kind === "text" ? { ...restarted, effects: { ...clip.effects, title: { ...title, start_frame: 0, end_frame: null } } } : restarted;
    });
    const error = timelineProblem(draft);
    return error ? { ok: false, error } : { ok: true, value: draft };
  } catch (error) {
    if (error instanceof EditRejected) return { ok: false, error: error.message };
    throw error;
  }
}
