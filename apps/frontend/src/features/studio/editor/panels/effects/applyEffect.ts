// Applying an item of the Effects browser to the timeline: an effect or preset to clips (a double click or Enter on
// the selection, a drop on a clip), a transition to the edit spot a drop lands on (near a cut, or a clip's free end).
// Each application is one document, written by the caller as one step of the history. Pure.
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { executeEdit } from "../../commands";
import { clipAtFrame, spotAtFrame } from "../../editSpots";
import { clipEnd, selectClips, type AllocateId, type TimelineResult } from "../../model";
import { describeSpotPlan, planAtSpot } from "../../transitionPlacement";
import type { EffectItem, EffectPlan } from "./catalog";

export interface ClipsApplication {
  timeline: StudioTimeline;
  /** The clips that took the item (for a sound effect: the sound of a selected picture). */
  clips: TimelineClip[];
  /** Selected clips it did not fit, or that had it already. */
  skipped: number;
}

/** The name of the history step that applies an item. */
export function applyLabel(item: EffectItem): string {
  return t("套用「{effect}」", { effect: item.label });
}

/**
 * An effect or preset on clips, as Premiere applies one to a selection. The first clip decides: what keeps it from
 * taking the item refuses the whole application with that reason, unless it simply has the item already. The other
 * clips take it where it fits and are passed over where it does not (a picture effect on a sound clip); two clips that
 * lead to one sound give it once.
 */
export function applyToClips(
  timeline: StudioTimeline,
  item: EffectItem,
  clipIds: readonly string[],
  linked: boolean,
  allocate: AllocateId,
): TimelineResult<ClipsApplication> {
  let current = timeline;
  const clips: TimelineClip[] = [];
  let skipped = 0;
  let firstReason: string | null = null;
  for (const [index, id] of clipIds.entries()) {
    const clip = current.clips.find((candidate) => candidate.clip_id === id);
    const plan: EffectPlan = clip ? item.plan({ timeline: current, clip, transitionClip: null, linked }, allocate) : { ok: false, reason: t("找不到選取的片段"), applied: false };
    if (plan.ok && clips.some((done) => done.clip_id === plan.clip.clip_id)) continue;
    const result = plan.ok ? executeEdit(current, plan.command, allocate) : null;
    if (plan.ok && result?.ok) {
      current = result.value;
      clips.push(plan.clip);
      continue;
    }
    const reason = result && !result.ok ? result.error : !plan.ok ? plan.reason : "";
    if (index === 0 && !(!plan.ok && plan.applied)) return { ok: false, error: reason };
    firstReason ??= reason;
    skipped += 1;
  }
  if (clips.length === 0) return { ok: false, error: firstReason ?? t("請先選取片段") };
  return { ok: true, value: { timeline: current, clips, skipped } };
}

/** A part of a track the drop highlights: the clips that take an effect, or the frames a transition covers. */
export interface DropMark {
  trackId: string;
  start: number;
  end: number;
}

export type EffectDrop =
  | { ok: true; timeline: StudioTimeline; label: string; hint: string; marks: DropMark[] }
  | { ok: false; error: string; marks: DropMark[] };

export interface DropPoint {
  /** The track under the pointer; null over no track. */
  trackId: string | null;
  /** The frame under the pointer (fractional: where between two frames decides the nearer end). */
  frame: number;
}

const NO_CLIP = t("這裡沒有片段；把效果放到片段上");
const NO_SPOT = t("這裡沒有片段；把轉場放到兩個片段之間的編輯點，或片段的一端");

function markOf(clip: TimelineClip): DropMark {
  return { trackId: clip.track_id, start: clip.start_frame, end: clipEnd(clip) };
}

/**
 * An effect or preset dropped on a clip: on that clip, and on every selected clip when it is one of the selection
 * (the clip under the pointer decides, as in applyToClips).
 */
function clipDrop(timeline: StudioTimeline, item: EffectItem, at: DropPoint & { trackId: string }, selected: readonly string[], linked: boolean, allocate: AllocateId): EffectDrop {
  const clip = clipAtFrame(timeline, at.trackId, at.frame);
  if (!clip) return { ok: false, error: NO_CLIP, marks: [] };
  const selection = selectClips(timeline, selected, linked).map((candidate) => candidate.clip_id);
  const ids = selection.includes(clip.clip_id) ? [clip.clip_id, ...selection.filter((id) => id !== clip.clip_id)] : [clip.clip_id];
  const result = applyToClips(timeline, item, ids, linked, allocate);
  if (!result.ok) return { ok: false, error: result.error, marks: [markOf(clip)] };
  const { clips } = result.value;
  const hint =
    clips.length > 1
      ? t("把「{effect}」套用到 {count} 個片段", { effect: item.label, count: clips.length })
      : t("把「{effect}」套用到「{clip}」", { effect: item.label, clip: clips[0]?.name ?? clip.name });
  return { ok: true, timeline: result.value.timeline, label: applyLabel(item), hint, marks: clips.map(markOf) };
}

/** A transition dropped on a track: on the nearer end of the clip under the pointer (a cut, or a fade on a free end). */
function spotDrop(timeline: StudioTimeline, item: EffectItem, at: DropPoint & { trackId: string }, linked: boolean, allocate: AllocateId): EffectDrop {
  const spot = spotAtFrame(timeline, at.trackId, at.frame);
  if (!spot || !item.transition) return { ok: false, error: NO_SPOT, marks: [] };
  const here = { trackId: spot.trackId, start: spot.frame, end: spot.frame };
  const plan = planAtSpot(timeline, spot, item.transition, linked);
  if (!plan.ok) return { ok: false, error: plan.reason, marks: [here] };
  const result = executeEdit(timeline, plan.command, allocate);
  if (!result.ok) return { ok: false, error: result.error, marks: [here] };
  // A transition on a cut takes the linked clips along (their sound crossfades with the picture): all of them are marked
  const tracks = spot.kind === "cut" && linked ? selectClips(timeline, [plan.clip.clip_id], true).map((clip) => clip.track_id) : [spot.trackId];
  return {
    ok: true,
    timeline: result.value,
    label: applyLabel(item),
    hint: describeSpotPlan(timeline, spot, item.transition, plan),
    marks: [...new Set(tracks)].map((trackId) => ({ trackId, ...plan.range })),
  };
}

/** What dropping an item at a point of the timeline does: the document after it, or why it is refused there. */
export function planEffectDrop(
  timeline: StudioTimeline,
  item: EffectItem,
  at: DropPoint,
  context: { selected: readonly string[]; linked: boolean },
  allocate: AllocateId,
): EffectDrop {
  const { trackId } = at;
  if (trackId === null) return { ok: false, error: item.lands === "cut" ? NO_SPOT : NO_CLIP, marks: [] };
  return item.lands === "cut" ? spotDrop(timeline, item, { ...at, trackId }, context.linked, allocate) : clipDrop(timeline, item, { ...at, trackId }, context.selected, context.linked, allocate);
}
