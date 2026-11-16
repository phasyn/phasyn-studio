// The edit points of a track as transitions use them: a cut where a clip meets the next one (inside their overlap
// when a transition is already there), and a clip end that touches no other clip (a free start or end, where a
// transition can only be a fade). Clips that overlap in a transition are divided where they are drawn: at its cut.
// Pure.
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { activeTransition } from "../model/clipEffects";
import { clipEnd, trackClips } from "./model";
import { cutOf, cutFrame } from "./transitionCut";

export type EditSpot =
  /** frame: where the cut is (inside a transition's overlap where its cut is, else where the two clips meet). */
  | { kind: "cut"; trackId: string; frame: number; leftId: string; rightId: string }
  | { kind: "head" | "tail"; trackId: string; frame: number; clipId: string };

/** Whether `right` follows `left` on their track without a gap: the clips meet, or overlap by left's transition. */
export function meets(left: TimelineClip, right: TimelineClip): boolean {
  return left.track_id === right.track_id && right.start_frame === clipEnd(left) - (activeTransition(left.effects)?.frames ?? 0);
}

function cut(left: TimelineClip, right: TimelineClip): EditSpot {
  const transition = activeTransition(left.effects);
  return { kind: "cut", trackId: left.track_id, frame: transition ? cutFrame(right, transition) : clipEnd(left), leftId: left.clip_id, rightId: right.clip_id };
}

/** A clip with its neighbours on the track. */
interface Placed {
  clip: TimelineClip;
  previous: TimelineClip | undefined;
  next: TimelineClip | undefined;
}

function placed(ordered: readonly TimelineClip[], index: number): Placed | null {
  const clip = ordered[index];
  return clip ? { clip, previous: ordered[index - 1], next: ordered[index + 1] } : null;
}

function headOf({ clip, previous }: Placed): EditSpot {
  return previous && meets(previous, clip) ? cut(previous, clip) : { kind: "head", trackId: clip.track_id, frame: clip.start_frame, clipId: clip.clip_id };
}

function tailOf({ clip, next }: Placed): EditSpot {
  return next && meets(clip, next) ? cut(clip, next) : { kind: "tail", trackId: clip.track_id, frame: clipEnd(clip), clipId: clip.clip_id };
}

/** The frames a clip is drawn over: from the cut of the transition into it to the cut of its own transition. */
function drawnRange({ clip, previous, next }: Placed): { start: number; end: number } {
  const incoming = previous && meets(previous, clip) ? activeTransition(previous.effects) : null;
  const outgoing = next && meets(clip, next) ? activeTransition(clip.effects) : null;
  return { start: clip.start_frame + (incoming ? cutOf(incoming).incoming.frames : 0), end: clipEnd(clip) - (outgoing ? cutOf(outgoing).outgoing.frames : 0) };
}

/** The clip a (fractional) frame of a track falls on, as the clips are drawn; null over a gap or no track. */
function placedAt(timeline: StudioTimeline, trackId: string, frame: number): Placed | null {
  const ordered = trackClips(timeline, trackId);
  for (let index = 0; index < ordered.length; index += 1) {
    const item = placed(ordered, index);
    if (!item) continue;
    const range = drawnRange(item);
    if (frame >= range.start && frame < range.end) return item;
  }
  return null;
}

export function clipAtFrame(timeline: StudioTimeline, trackId: string, frame: number): TimelineClip | null {
  return placedAt(timeline, trackId, frame)?.clip ?? null;
}

/** The two ends of a clip: a cut with the neighbour it meets, or a free end. */
export function clipEndSpots(timeline: StudioTimeline, clip: TimelineClip): { head: EditSpot; tail: EditSpot } {
  const ordered = trackClips(timeline, clip.track_id);
  const item = placed(ordered, ordered.findIndex((candidate) => candidate.clip_id === clip.clip_id)) ?? { clip, previous: undefined, next: undefined };
  return { head: headOf(item), tail: tailOf(item) };
}

/** Where a transition dropped on a frame of a track lands: the nearer end of the clip under the pointer. */
export function spotAtFrame(timeline: StudioTimeline, trackId: string, frame: number): EditSpot | null {
  const item = placedAt(timeline, trackId, frame);
  if (!item) return null;
  const range = drawnRange(item);
  return frame - range.start < range.end - frame ? headOf(item) : tailOf(item);
}

/** Every edit spot of a track in time order; a cut is listed once. */
export function trackSpots(timeline: StudioTimeline, trackId: string): EditSpot[] {
  const ordered = trackClips(timeline, trackId);
  return ordered.flatMap((_, index) => {
    const item = placed(ordered, index);
    if (!item) return [];
    const head = headOf(item);
    return head.kind === "cut" ? [tailOf(item)] : [head, tailOf(item)];
  });
}

/** The spots nearest to a frame on the given tracks: several when they lie at the same distance (V1 and V2 cut together). */
export function nearestSpots(timeline: StudioTimeline, trackIds: Iterable<string>, frame: number): EditSpot[] {
  const spots = [...trackIds].flatMap((trackId) => trackSpots(timeline, trackId));
  const distance = Math.min(...spots.map((spot) => Math.abs(spot.frame - frame)));
  return spots.filter((spot) => Math.abs(spot.frame - frame) === distance);
}

/** Identifies a spot by the clips it belongs to (a cut once, whichever of its two clips it was found from). */
export function spotKey(spot: EditSpot): string {
  return spot.kind === "cut" ? `cut:${spot.leftId}` : `${spot.kind}:${spot.clipId}`;
}

/**
 * The same spot in another version of the timeline (after an earlier edit of a batch moved clips): found again by
 * its clips; null when they are gone or no longer meet there.
 */
export function refreshSpot(timeline: StudioTimeline, spot: EditSpot): EditSpot | null {
  const clipId = spot.kind === "cut" ? spot.leftId : spot.clipId;
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  if (!clip) return null;
  const ends = clipEndSpots(timeline, clip);
  const found = spot.kind === "head" ? ends.head : ends.tail;
  if (spot.kind === "cut") return found.kind === "cut" && found.rightId === spot.rightId ? found : null;
  return found.kind === spot.kind ? found : null;
}
