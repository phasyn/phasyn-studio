// Transitions placed on an edit spot, the way the timeline holds them. On a cut it is the `transition` command,
// placed as Premiere places one: centred on the cut, the outgoing clip runs on past the cut and the incoming clip
// starts before it, both into their own frames beyond the cut (their handles; an edge frame held where the media runs
// out), and nothing else moves (transitionCut.ts; the Controller's rule too). On a clip end that touches no other clip
// it is a fade: from and to black for a dip to black and for a cross dissolve on the lowest video track (nothing lies
// under it), a dissolve to transparency (two opacity keys) for a cross dissolve on a higher track, from and to silence
// for sound; a dip to white and the moving transitions (push, slide, whip, wipe, zoom) need the clip on the other side.
// An adjustment layer takes no transition on a cut; on its free end a dissolve or a dip eases its effect in or out.
// Every placement is one command, refused for the same reasons as any edit. The Effects browser's drop and the
// default-transition keys (Ctrl/⌘+D, Ctrl/⌘+Shift+D, Shift+D) place transitions through here. Pure.
import type { StudioTimeline, TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { activeTransition, DEFAULT_TRANSITION_FRAMES, TRANSITION_LABELS, TRANSITION_MAX_FRAMES, type TransitionKind } from "../model/clipEffects";
import { ADJUSTMENT_TRANSITION, isAdjustment } from "./adjustment";
import { executeEdit, type EditCommand } from "./commands";
import { clipEndSpots, meets, nearestSpots, refreshSpot, spotKey, type EditSpot } from "./editSpots";
import { clipDuration, clipEnd, selectClips, trackClips, windowBounds, type AllocateId } from "./model";
import { withFade } from "./panels/controls/fades";
import { DEFAULT_TRANSITION_ALIGNMENT, splitAtCut } from "./transitionCut";

export type TransitionStyle = Exclude<TransitionKind, "cut">;

/** A transition of the Effects browser: one for the picture (video tracks) or the crossfade of the sound (audio tracks). */
export interface TransitionSpec {
  kind: TransitionStyle;
  sound: boolean;
  /** Its name, for reasons and history steps. */
  label: string;
}

export const AUDIO_CROSSFADE_LABEL = t("音訊交叉淡化");
/** Premiere's default video transition. */
export const DEFAULT_VIDEO_TRANSITION: TransitionSpec = { kind: "crossfade", sound: false, label: TRANSITION_LABELS.crossfade };
/**
 * The default audio transition: the timeline's one sound transition, a crossfade (the export mixes it with equal-gain
 * curves; Premiere's default is a constant-power crossfade, which the document cannot ask for).
 */
export const DEFAULT_AUDIO_TRANSITION: TransitionSpec = { kind: "crossfade", sound: true, label: AUDIO_CROSSFADE_LABEL };

export type FadeEdge = "video_in" | "video_out" | "audio_in" | "audio_out";

/** Frames a new fade can take: fades of one kind share the clip's length, and a picture never fades out over all of it. */
export function fadeRoom(clip: TimelineClip, edge: FadeEdge): number {
  const fade = clip.effects?.fade ?? {};
  const duration = clipDuration(clip);
  switch (edge) {
    case "video_in":
      return duration - (fade.video_out ?? 0);
    case "video_out":
      return Math.min(duration - (fade.video_in ?? 0), duration - 1);
    case "audio_in":
      return duration - (fade.audio_out ?? 0);
    case "audio_out":
      return duration - (fade.audio_in ?? 0);
  }
}

/** The sequence frames a placed transition covers (the drop shows them before the release). */
export interface FrameRange {
  start: number;
  end: number;
}

export type SpotPlan =
  /** clip: the clip the command changes (the outgoing clip of a cut). */
  | { ok: true; clip: TimelineClip; command: EditCommand; frames: number; range: FrameRange }
  /** applied = the spot already has this transition. */
  | { ok: false; reason: string; applied: boolean };

const ALREADY_FADED = t("片段這一端已經有淡化；在「效果控制」調整");
const TOO_SHORT = t("片段太短，放不下淡化");

function refused(reason: string): SpotPlan {
  return { ok: false, reason, applied: false };
}

function clipOf(timeline: StudioTimeline, clipId: string): TimelineClip | undefined {
  return timeline.clips.find((clip) => clip.clip_id === clipId);
}

/** Whether a clip on an audio track is linked to a picture: its sound then crossfades with the picture's transition. */
function linkedPicture(timeline: StudioTimeline, clip: TimelineClip): boolean {
  if (!clip.linked_id) return false;
  const video = new Set(timeline.tracks.filter((track) => track.kind === "video").map((track) => track.track_id));
  return timeline.clips.some((item) => item.clip_id !== clip.clip_id && item.linked_id === clip.linked_id && video.has(item.track_id));
}

/** The overlap of the transition that leads into a clip (0 when none does). */
function incoming(timeline: StudioTimeline, clip: TimelineClip): number {
  const ordered = trackClips(timeline, clip.track_id);
  const previous = ordered[ordered.findIndex((item) => item.clip_id === clip.clip_id) - 1];
  return previous && meets(previous, clip) ? (activeTransition(previous.effects)?.frames ?? 0) : 0;
}

function cutPlan(timeline: StudioTimeline, spot: Extract<EditSpot, { kind: "cut" }>, spec: TransitionSpec, linked: boolean, frames: number): SpotPlan {
  const left = clipOf(timeline, spot.leftId);
  const right = clipOf(timeline, spot.rightId);
  if (!left || !right) return refused(t("找不到選取的片段"));
  if (isAdjustment(timeline, left) || isAdjustment(timeline, right)) return refused(ADJUSTMENT_TRANSITION);
  // The sound of linked clips moves with their picture: it crossfades when the picture's transition is applied
  if (spec.sound && linked && linkedPicture(timeline, left)) return refused(t("連結的影像會一起轉場；請套用視訊轉場的交叉溶接，聲音會同時交叉淡化"));
  const current = activeTransition(left.effects);
  if (current?.kind === spec.kind) return { ok: false, reason: t("這個編輯點已經是{name}", { name: spec.label }), applied: true };
  // A transition takes frames of both clips: never more than either has beside its other transition
  const room = Math.min(TRANSITION_MAX_FRAMES, clipDuration(left) - incoming(timeline, left), clipDuration(right) - (activeTransition(right.effects)?.frames ?? 0));
  const length = current?.frames ?? Math.min(frames, room);
  if (length < 1) return refused(t("兩側片段太短，放不下轉場"));
  // A new transition is centred on the cut; another kind keeps the one that is there where it is
  const { before, after } = splitAtCut(length, DEFAULT_TRANSITION_ALIGNMENT);
  const range = current ? { start: right.start_frame, end: clipEnd(left) } : { start: clipEnd(left) - before, end: clipEnd(left) + after };
  return { ok: true, clip: left, command: { type: "transition", clipId: left.clip_id, kind: spec.kind, frames: length, linked }, frames: length, range };
}

function fadePlan(clip: TimelineClip, edge: FadeEdge, linked: boolean, frames: number): SpotPlan {
  const effects = clip.effects ?? {};
  if ((effects.fade?.[edge] ?? 0) > 0) return { ok: false, reason: ALREADY_FADED, applied: true };
  const length = Math.min(frames, fadeRoom(clip, edge));
  if (length < 1) return refused(TOO_SHORT);
  const range = edge.endsWith("_in") ? { start: clip.start_frame, end: clip.start_frame + length } : { start: clipEnd(clip) - length, end: clipEnd(clip) };
  return { ok: true, clip, command: { type: "patchClip", clipId: clip.clip_id, linked, patch: { effects: withFade(effects, { [edge]: length }) } }, frames: length, range };
}

function linear(frame: number, value: number): TimelineKeyframe {
  return { frame, value, interpolation: "linear" };
}

/**
 * A cross dissolve on a free end of a clip above the lowest video track: the clip fades from or to transparency (what
 * lies under it shows through), written as two opacity keys at the visible end. Keys the clip already has stay as they
 * are; they must lie outside the dissolve, beyond its far key (a key at the end itself means it is already there).
 */
function dissolvePlan(clip: TimelineClip, head: boolean, linked: boolean, frames: number): SpotPlan {
  const keys = clip.motion.keyframes.opacity ?? [];
  const { start_frame: from, end_frame: to } = windowBounds(clip);
  const last = to - 1;
  if (keys.find((key) => key.frame === (head ? from : last))?.value === 0) return { ok: false, reason: ALREADY_FADED, applied: true };
  const first = keys[0];
  const final = keys.at(-1);
  const room = head ? Math.min(last, (first?.frame ?? Number.POSITIVE_INFINITY) - 1) - from : last - Math.max(from, (final?.frame ?? Number.NEGATIVE_INFINITY) + 1);
  const length = Math.min(frames, room);
  if (keys.length > 0 && length < 1) return refused(t("不透明度在片段這一端已有關鍵影格；請先移除，或改用淡入黑場"));
  if (length < 1) return refused(TOO_SHORT);
  // Where the dissolve ends the clip stands at its opacity: the fixed value, or the nearest key's (the curve stays flat there)
  const opacity = (head ? first?.value : final?.value) ?? clip.motion.opacity;
  const opacityKeys = head ? [linear(from, 0), linear(from + length, opacity), ...keys] : [...keys, linear(last - length, opacity), linear(last, 0)];
  const range = head ? { start: clip.start_frame, end: clip.start_frame + length } : { start: clipEnd(clip) - 1 - length, end: clipEnd(clip) };
  const motion = { ...clip.motion, keyframes: { ...clip.motion.keyframes, opacity: opacityKeys } };
  return { ok: true, clip, command: { type: "patchClip", clipId: clip.clip_id, linked, patch: { motion } }, frames: length, range };
}

function endPlan(timeline: StudioTimeline, spot: Extract<EditSpot, { kind: "head" | "tail" }>, spec: TransitionSpec, linked: boolean, frames: number): SpotPlan {
  const clip = clipOf(timeline, spot.clipId);
  if (!clip) return refused(t("找不到選取的片段"));
  const head = spot.kind === "head";
  if (spec.sound) return fadePlan(clip, head ? "audio_in" : "audio_out", linked, frames);
  if (spec.kind === "dip_to_white") return refused(t("這一端沒有相鄰的片段；淡入白場要放在兩個片段之間"));
  // Push, slide, whip, wipe and zoom move one picture into another: there is none at a free end
  if (spec.kind !== "crossfade" && spec.kind !== "dip_to_black") return refused(t("這一端沒有相鄰的片段；{name}要放在兩個片段之間", { name: spec.label }));
  const lowest = timeline.tracks.find((track) => track.kind === "video")?.track_id === clip.track_id;
  if (spec.kind === "dip_to_black" || lowest) return fadePlan(clip, head ? "video_in" : "video_out", linked, frames);
  return dissolvePlan(clip, head, linked, frames);
}

/** The edit that puts a transition on a spot, or why it cannot go there. `frames` is its length when it is new. */
export function planAtSpot(timeline: StudioTimeline, spot: EditSpot, spec: TransitionSpec, linked: boolean, frames = DEFAULT_TRANSITION_FRAMES): SpotPlan {
  const track = timeline.tracks.find((item) => item.track_id === spot.trackId);
  if (!track) return refused(t("找不到選取的軌道"));
  if (spec.sound && track.kind !== "audio") return refused(t("音訊轉場要放在音訊軌的片段上"));
  if (!spec.sound && track.kind !== "video") return refused(t("視訊轉場要套用在視訊軌的片段"));
  return spot.kind === "cut" ? cutPlan(timeline, spot, spec, linked, frames) : endPlan(timeline, spot, spec, linked, frames);
}

/** What placing a transition on a spot does, for the timeline's status line. */
export function describeSpotPlan(timeline: StudioTimeline, spot: EditSpot, spec: TransitionSpec, plan: Extract<SpotPlan, { ok: true }>): string {
  if (spot.kind === "cut") {
    const left = clipOf(timeline, spot.leftId);
    const names = { from: left?.name ?? "", to: clipOf(timeline, spot.rightId)?.name ?? "", name: spec.label };
    if (activeTransition(left?.effects)) return t("把「{from}」和「{to}」之間的轉場換成{name}", names);
    return t("在「{from}」和「{to}」之間加上{name}，{frames} 影格", { ...names, frames: plan.frames });
  }
  if (spot.kind === "head") return t("「{clip}」的開頭淡入，{frames} 影格", { clip: plan.clip.name, frames: plan.frames });
  return t("「{clip}」的結尾淡出，{frames} 影格", { clip: plan.clip.name, frames: plan.frames });
}

export interface SpotEntry {
  spot: EditSpot;
  spec: TransitionSpec;
}

export interface SpotsResult {
  timeline: StudioTimeline;
  /** How many spots took their transition. */
  applied: number;
  /** Why the others did not, in order; applied = it was already there. */
  refusals: { reason: string; applied: boolean }[];
}

/**
 * Places transitions on spots one after another, as one document: each spot is found again by its clips in the
 * document the previous placements left (a transition lengthens the clips at its cut). A spot that cannot take its
 * transition is passed over with the reason.
 */
export function applyAtSpots(timeline: StudioTimeline, entries: readonly SpotEntry[], linked: boolean, frames = DEFAULT_TRANSITION_FRAMES, allocate?: AllocateId): SpotsResult {
  let current = timeline;
  let applied = 0;
  const refusals: SpotsResult["refusals"] = [];
  for (const entry of entries) {
    const spot = refreshSpot(current, entry.spot);
    const plan = spot ? planAtSpot(current, spot, entry.spec, linked, frames) : refused(t("這個編輯點已經不在了"));
    if (!plan.ok) {
      refusals.push({ reason: plan.reason, applied: plan.applied });
      continue;
    }
    const result = executeEdit(current, plan.command, allocate);
    if (!result.ok) {
      refusals.push({ reason: result.error, applied: false });
      continue;
    }
    current = result.value;
    applied += 1;
  }
  return { timeline: current, applied, refusals };
}

export type DefaultTransitions = "video" | "audio" | "both";

export interface DefaultTransitionContext {
  /** The selected clips: their ends take the transitions. Empty = the spot nearest the playhead. */
  selected: readonly string[];
  linked: boolean;
  /** The targeted tracks (the spot nearest the playhead is looked for on these). */
  targets: ReadonlySet<string>;
  /** The playhead. */
  frame: number;
}

/**
 * Where the default transitions go (Premiere's Ctrl/⌘+D, Ctrl/⌘+Shift+D and Shift+D): at both ends of the selected
 * clips, else at the edit spot nearest the playhead on the targeted, unlocked tracks. Picture first, so the sound of
 * linked clips is already crossfading with it when the sound's turn comes.
 */
export function defaultTransitionSpots(timeline: StudioTimeline, which: DefaultTransitions, context: DefaultTransitionContext): SpotEntry[] {
  const kinds: ("video" | "audio")[] = which === "both" ? ["video", "audio"] : [which];
  const seen = new Set<string>();
  const entries: SpotEntry[] = [];
  for (const kind of kinds) {
    const spec = kind === "video" ? DEFAULT_VIDEO_TRANSITION : DEFAULT_AUDIO_TRANSITION;
    const tracks = timeline.tracks.filter((track) => track.kind === kind);
    const ids = new Set(tracks.map((track) => track.track_id));
    const spots =
      context.selected.length > 0
        ? selectClips(timeline, [...context.selected], context.linked)
            .filter((clip) => ids.has(clip.track_id))
            .flatMap((clip) => {
              const ends = clipEndSpots(timeline, clip);
              return [ends.head, ends.tail];
            })
        : nearestSpots(
            timeline,
            tracks.filter((track) => context.targets.has(track.track_id) && !track.locked).map((track) => track.track_id),
            context.frame,
          );
    for (const spot of spots) {
      const key = spotKey(spot);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ spot, spec });
    }
  }
  return entries;
}

/** The name of the history step of the default transitions. */
export function defaultTransitionsLabel(which: DefaultTransitions): string {
  if (which === "video") return t("套用預設視訊轉場");
  if (which === "audio") return t("套用預設音訊轉場");
  return t("套用預設轉場");
}
