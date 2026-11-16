// The cut a transition sits on, the way Premiere places one: on the edit point between two clips, centred on it,
// starting at it or ending at it (its alignment), covered by the two clips' own frames beyond the cut. The outgoing
// clip runs on after the cut and the incoming clip starts before it, each first from its hidden output, then from the
// source beyond its range, and where the media runs out by holding its edge frame (insufficient media). Nothing else
// moves: applying, changing or removing a transition only lengthens or shortens the two clips at the cut, and what
// each clip lent is recorded in the transition (`cut`), so that removing it gives back exactly what it took. Pure; the
// Controller's twin is phasyn_components.timeline_edit.handles.
import type { MediaClipEffects, MediaClipTransitionCut, MediaClipTransitionSide, TimelineClip, TimelineKeyframe, TimelineSource } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { Transition, TransitionAlignment } from "../model/clipEffects";
import { compositingChannels, mapClipKeyframes } from "./animation";
import { clipEnd, processedDuration, windowBounds, type TimelineResult } from "./model";

type TransitionSide = MediaClipTransitionSide;
type TransitionCut = MediaClipTransitionCut;

/** A new transition is centred on its cut, and a transition made before cuts were recorded is read as centred. */
export const DEFAULT_TRANSITION_ALIGNMENT: TransitionAlignment = "center";

const NOTHING: TransitionSide = { frames: 0, source: 0, freeze: 0 };
const INEXACT = t("這個切點無法保留變速片段的精確長度");

/** Frames of a transition before and after its cut. A centred transition of odd length has its extra frame after the cut. */
export function splitAtCut(frames: number, alignment: TransitionAlignment): { before: number; after: number } {
  const before = alignment === "start" ? 0 : alignment === "end" ? frames : Math.floor(frames / 2);
  return { before, after: frames - before };
}

/**
 * The cut of a transition: the recorded one, else (a transition made before cuts were recorded, by the old ripple
 * rule or the swap planner's overlapping windows) the middle of its overlap, as a centred transition the two clips
 * cover with their own frames.
 */
export function cutOf(transition: Transition): TransitionCut {
  if (transition.cut) return transition.cut;
  const { before, after } = splitAtCut(transition.frames, DEFAULT_TRANSITION_ALIGNMENT);
  return { alignment: DEFAULT_TRANSITION_ALIGNMENT, outgoing: { ...NOTHING, frames: after }, incoming: { ...NOTHING, frames: before } };
}

/** The sequence frame of the cut between a clip with a transition and the clip it leads into. */
export function cutFrame(right: TimelineClip, transition: Transition): number {
  return right.start_frame + cutOf(transition).incoming.frames;
}

/**
 * Frames of the two clips that repeat an edge frame because the media ran out (Premiere's insufficient media): the
 * freezes the transition added, as far as they are still shown.
 */
export function repeatedFrames(left: TimelineClip, right: TimelineClip, transition: Transition): { outgoing: number; incoming: number } {
  const cut = transition.cut;
  if (!cut) return { outgoing: 0, incoming: 0 };
  // The frames it froze are the last of the outgoing clip's hold and the first of the incoming clip's
  const outgoing = Math.min(cut.outgoing.freeze, left.effects?.hold?.end ?? 0);
  const incoming = Math.min(cut.incoming.freeze, right.effects?.hold?.start ?? 0);
  const hiddenTail = processedDuration(left) - windowBounds(left).end_frame;
  const hiddenHead = windowBounds(right).start_frame;
  return { outgoing: Math.max(0, outgoing - hiddenTail), incoming: Math.max(0, incoming - hiddenHead) };
}

const speedOf = (clip: TimelineClip) => clip.effects?.speed_percent ?? 100;

/** Effects tied to the end of a clip's clock: growing or shrinking the clock there moves them. */
function endAnchored(clip: TimelineClip): boolean {
  const fade = clip.effects?.fade;
  return (fade?.video_out ?? 0) > 0 || (fade?.audio_out ?? 0) > 0;
}

/** Effects tied to its start: fades in, impact frames and a shake that begins on the first frame. */
function startAnchored(clip: TimelineClip): boolean {
  const fx = clip.effects;
  return (fx?.fade?.video_in ?? 0) > 0 || (fx?.fade?.audio_in ?? 0) > 0 || fx?.impact !== undefined || ((fx?.camera?.shake_px ?? 0) > 0 && (fx?.camera?.shake_frames ?? 0) > 0);
}

/**
 * The most frames, up to `wanted`, that cover whole source frames at the clip's speed within `available` source
 * frames (null: no limit, a text layer); at the start also whole frame-step drawings, so the sampling keeps its phase.
 */
function wholeFrames(clip: TimelineClip, wanted: number, available: number | null, phase: boolean): number {
  const speed = speedOf(clip);
  const step = phase ? (clip.effects?.frame_step ?? 1) : 1;
  for (let frames = available === null ? wanted : Math.min(wanted, Math.floor((available * 100) / speed)); frames > 0; frames -= 1) {
    if ((frames * speed) % 100 === 0 && frames % step === 0) return frames;
  }
  return 0;
}

/** The clip with these effects; an effects object left empty goes. */
function withEffects(clip: TimelineClip, effects: MediaClipEffects): TimelineClip {
  const { effects: _previous, ...rest } = clip;
  return Object.keys(effects).length > 0 ? { ...rest, effects } : rest;
}

/** The hold at one edge changed by `frames` (negative gives frames back); an edge back at 0, and then an empty hold, go. */
function withHold(clip: TimelineClip, edge: "start" | "end", frames: number): TimelineClip {
  const effects: MediaClipEffects = { ...clip.effects };
  const hold = { ...effects.hold };
  const held = (hold[edge] ?? 0) + frames;
  if (held > 0) hold[edge] = held;
  else delete hold[edge];
  if (Object.keys(hold).length > 0) effects.hold = hold;
  else delete effects.hold;
  return withEffects(clip, effects);
}

/** The clip without its outgoing transition (an effects object left empty goes). */
export function withoutTransitionOut(clip: TimelineClip): TimelineClip {
  if (!clip.effects?.transition_out) return clip;
  const { transition_out: _transition, ...effects } = clip.effects;
  return withEffects(clip, effects);
}

/** The clip's clock moved by `frames` at its start: keys and the title stay on the content they belong to. */
function shiftClock(clip: TimelineClip, frames: number): TimelineClip {
  if (frames === 0) return clip;
  const value = mapClipKeyframes(clip, (keys) => keys.map((key) => ({ ...key, frame: key.frame + frames })));
  const title = value.effects?.title;
  if (!title) return value;
  return { ...value, effects: { ...value.effects, title: { ...title, start_frame: title.start_frame + frames, end_frame: title.end_frame === null ? null : title.end_frame + frames } } };
}

/** The visible window [start, end) of the clip's processed frames; a clip that had none and shows all of them keeps none. */
function withWindow(clip: TimelineClip, start: number, end: number, explicit: boolean): TimelineClip {
  if (explicit || start !== 0 || end !== processedDuration(clip)) return { ...clip, output_window: { start_frame: start, end_frame: end } };
  const { output_window: _window, ...rest } = clip;
  return rest;
}

/** Every key list of a clip: its motion, its effect stack and its mask (the Controller's curves.clip_curves). */
function keyLists(clip: TimelineClip): (TimelineKeyframe[] | undefined)[] {
  return [...Object.values(clip.motion.keyframes), ...compositingChannels(clip).map((channel) => channel.keys)];
}

/** Whether the keys, the title, the fades and the impact frames of a clip still fit a clock of `complete` frames. */
function fitsClock(clip: TimelineClip, complete: number): boolean {
  if (keyLists(clip).some((keys) => keys?.some((key) => key.frame > complete))) return false;
  const fx = clip.effects;
  const title = fx?.title;
  if (title && (title.start_frame >= complete || (title.end_frame !== null && title.end_frame > complete))) return false;
  const fade = fx?.fade;
  if ((fade?.video_in ?? 0) + (fade?.video_out ?? 0) > complete || (fade?.audio_in ?? 0) + (fade?.audio_out ?? 0) > complete || (fade?.video_out ?? 0) >= complete) return false;
  return (fx?.impact?.frames ?? 0) <= complete;
}

/**
 * Whether the keys and the title of a clip stay on its clock when its first `frames` frames go. A text layer's title
 * always covers the whole layer (the edit sets it so again), so it does not count.
 */
function fitsShift(clip: TimelineClip, frames: number, text: boolean): boolean {
  if (keyLists(clip).some((keys) => keys?.some((key) => key.frame < frames))) return false;
  return text || (clip.effects?.title?.start_frame ?? frames) >= frames;
}

interface Lent {
  clip: TimelineClip;
  side: TransitionSide;
}

/**
 * The outgoing clip running on `frames` frames past its end, for a transition: its hidden output first, then the
 * source after its out point (whole source frames at its speed, never past the end of the source), then a hold of its
 * last frame. A fade-out moves when the clock grows, so a clip with one refuses frames it does not have.
 */
export function extendTail(clip: TimelineClip, frames: number, source: TimelineSource | undefined): TimelineResult<Lent> {
  const explicit = clip.output_window !== undefined;
  const { start_frame: start, end_frame: end } = windowBounds(clip);
  const complete = processedDuration(clip);
  let rest = frames - Math.min(frames, complete - end);
  let value = clip;
  let extended = 0;
  if (rest > 0 && !endAnchored(clip) && !clip.effects?.hold?.end) {
    extended = wholeFrames(clip, rest, source ? source.duration_frames - clip.out_frame : 0, false);
    value = { ...value, out_frame: value.out_frame + (extended * speedOf(clip)) / 100 };
    rest -= extended;
  }
  if (rest > 0) {
    if (endAnchored(clip)) return { ok: false, error: t("「{name}」結尾有淡出，素材不足時無法在切點後重複影格；請先移除淡出，或改用「在切點結束」", { name: clip.name }) };
    value = withHold(value, "end", rest);
  }
  if (processedDuration(value) !== complete + extended + rest) return { ok: false, error: INEXACT };
  return { ok: true, value: { clip: withWindow(value, start, end + frames, explicit), side: { frames, source: extended, freeze: rest } } };
}

/**
 * The incoming clip starting `frames` frames earlier, for a transition: its hidden output first, then the source
 * before its in point (whole source frames at its speed and whole frame-step drawings, never before the start of the
 * source), then a hold of its first frame. Fades in, impact frames and a shake begin on the clip's first frame, so a
 * clip with one refuses frames it does not have.
 */
export function extendHead(clip: TimelineClip, frames: number, source: TimelineSource | undefined): TimelineResult<Lent> {
  const explicit = clip.output_window !== undefined;
  const { start_frame: start, end_frame: end } = windowBounds(clip);
  const complete = processedDuration(clip);
  const shown = Math.min(frames, start);
  let rest = frames - shown;
  let value = clip;
  let extended = 0;
  if (rest > 0 && !startAnchored(clip) && !clip.effects?.hold?.start) {
    // A text layer has no source frames: any frame of it is the same layer
    extended = wholeFrames(clip, rest, source?.kind === "text" ? null : clip.in_frame, true);
    value = { ...value, in_frame: value.in_frame - (extended * speedOf(clip)) / 100 };
    rest -= extended;
  }
  if (rest > 0) {
    if (startAnchored(clip)) return { ok: false, error: t("「{name}」開頭有淡入、衝擊格或震動，素材不足時無法在切點前重複影格；請先移除，或改用「從切點開始」", { name: clip.name }) };
    value = withHold(value, "start", rest);
  }
  const added = extended + rest;
  if (processedDuration(value) !== complete + added) return { ok: false, error: INEXACT };
  value = withWindow(shiftClock(value, added), start - shown, end + added, explicit);
  return { ok: true, value: { clip: { ...value, start_frame: clip.start_frame - frames }, side: { frames, source: extended, freeze: rest } } };
}

/**
 * The outgoing clip back at the cut: it ends `side.frames` earlier, and the hold and the source frames the transition
 * added go again where they are still hidden beyond the cut (what an edit since has shown or tied to them stays).
 */
export function retractTail(clip: TimelineClip, side: TransitionSide): TimelineResult<TimelineClip> {
  const explicit = clip.output_window !== undefined;
  const { start_frame: start, end_frame: end } = windowBounds(clip);
  const cut = end - side.frames;
  if (side.frames < 0 || cut <= start) return { ok: false, error: t("裁切範圍必須位於片段內") };
  let value = clip;
  let complete = processedDuration(clip);
  if (!endAnchored(clip)) {
    const thaw = Math.min(side.freeze, clip.effects?.hold?.end ?? 0, complete - cut);
    if (thaw > 0 && fitsClock(value, complete - thaw)) {
      value = withHold(value, "end", -thaw);
      complete -= thaw;
    }
    if (side.source > 0 && !value.effects?.hold?.end) {
      const given = wholeFrames(value, Math.min(side.source, complete - cut), null, false);
      if (given > 0 && fitsClock(value, complete - given)) {
        value = { ...value, out_frame: value.out_frame - (given * speedOf(value)) / 100 };
        complete -= given;
      }
    }
  }
  if (processedDuration(value) !== complete) return { ok: false, error: INEXACT };
  return { ok: true, value: withWindow(value, start, cut, explicit) };
}

/**
 * The incoming clip back at the cut: it starts `side.frames` later, and the hold and the source frames the transition
 * added go again where they are still hidden before the cut.
 */
export function retractHead(clip: TimelineClip, side: TransitionSide, source: TimelineSource | undefined): TimelineResult<TimelineClip> {
  const text = source?.kind === "text";
  const explicit = clip.output_window !== undefined;
  const { start_frame: start, end_frame: end } = windowBounds(clip);
  const cut = start + side.frames;
  if (side.frames < 0 || cut >= end) return { ok: false, error: t("裁切範圍必須位於片段內") };
  let value = clip;
  let removed = 0;
  if (!startAnchored(clip)) {
    const thaw = Math.min(side.freeze, clip.effects?.hold?.start ?? 0, cut);
    if (thaw > 0 && fitsShift(value, thaw, text)) {
      value = withHold(value, "start", -thaw);
      removed = thaw;
    }
    if (side.source > 0 && !value.effects?.hold?.start) {
      const given = wholeFrames(value, Math.min(side.source, cut - removed), null, true);
      if (given > 0 && fitsShift(value, removed + given, text)) {
        value = { ...value, in_frame: value.in_frame + (given * speedOf(value)) / 100 };
        removed += given;
      }
    }
  }
  if (processedDuration(value) !== processedDuration(clip) - removed) return { ok: false, error: INEXACT };
  value = withWindow(shiftClock(value, -removed), cut - removed, end - removed, explicit);
  return { ok: true, value: { ...value, start_frame: clip.start_frame + side.frames } };
}

/** A transition's two clips back at its cut, without the transition: what the transition lent and added given back. */
export function restoreCut(left: TimelineClip, right: TimelineClip, transition: Transition, source: TimelineSource | undefined): TimelineResult<{ left: TimelineClip; right: TimelineClip }> {
  const cut = cutOf(transition);
  const outgoing = retractTail(withoutTransitionOut(left), cut.outgoing);
  if (!outgoing.ok) return outgoing;
  const incoming = retractHead(right, cut.incoming, source);
  return incoming.ok ? { ok: true, value: { left: outgoing.value, right: incoming.value } } : incoming;
}

/**
 * The cut of a transition that an edit changed the overlap of (a trim, a move, a roll): the cut moves with the edge
 * that moved and that side keeps its frames; when both moved alike (or neither did) it moves with both. What the
 * clips lent beyond the cut (source frames, freezes) stays recorded, so removing the transition still gives it back.
 */
export function reconciledCut(cut: TransitionCut, before: { left: TimelineClip; right: TimelineClip }, after: { left: TimelineClip; right: TimelineClip }): TransitionCut {
  const overlap = clipEnd(after.left) - after.right.start_frame;
  const endMoved = clipEnd(after.left) !== clipEnd(before.left);
  const startMoved = after.right.start_frame !== before.right.start_frame;
  const outgoing = !endMoved && startMoved ? overlap - Math.min(cut.incoming.frames, overlap) : Math.min(cut.outgoing.frames, overlap);
  return { ...cut, outgoing: { ...cut.outgoing, frames: outgoing }, incoming: { ...cut.incoming, frames: overlap - outgoing } };
}
