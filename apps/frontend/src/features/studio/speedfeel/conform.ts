// The timeline edit that conforms a take's cuts to the original's (pure): a retiming with an anchor filter and judder
// rules, in the editor's own terms, so the preview and the export already play it and nothing new reaches the back end.
// - anchors: (0, 0) and the matched cut pairs (cuts.ts), walked in order, then the take's early switch at the clip's end
//   (cuts.ts endSwitchCut) paired with the clip's end, as the original's cut there. An anchor is left out, with its
//   reason, when the take's cut lies past the clip's end, when either cut lands in a transition, a fade or the impact
//   frames (the clip could not be split or keep them there), when the stretch from the previous kept anchor leaves
//   [1/1.5, 1.5] (usually a take flash taken for a cut), or when the part before it cannot be retimed by the rules below;
// - between two anchors the take's frames [t0, t1) fill the original's [o0, o1). The same count moves as it is. Fewer
//   take frames are slowed down by a hold of the stillest frame (the part is split after it and that piece holds it:
//   hold.end). More take frames are sped up on the stillest window of the part: that window plays at an integer speed
//   of at most 150 % that gives exactly the frames needed, so the picture advances 1 or 2 take frames a step (never
//   more, the window's edges included); where no window fits, single frames are left out, never two side by side.
//   A frame next to a luminance jump (a mean luma change above 20 to a neighbour: a flash or a cut) is never skipped,
//   and holds go elsewhere when they can; only when a part has no other way are those frames used. Stillness: the
//   take's motion on both sides of a frame (the prototype's measure), summed over a window;
// - after the last anchor the take keeps its speed: when it was early the clip's last frames are dropped, when it was
//   late the last frame is held for the frames it lacks — the take's frames after the clip's out point are never used
//   (the swap's held lead-out and borrowed next-segment shots can show the original character drawn as is: segment 13's
//   frames 64–77 copied the original mage, cos 0.97); after an early switch the take's frames from the switch to the
//   clip's end (the next shot) are removed;
// - the take never plays backwards, and never jumps more than 2 frames at once.
// It is one edit (the caller records it as one history step) made only of the editor's commands — split, delete,
// move, trim, slip and patchClip (speed_percent, hold.end) — in an order in which no step overlaps another clip, so
// the clip keeps its exact length: nothing after it moves and the soundtrack stays in sync (conformEdit.ts).
// - sound: a clip linked to its own sound (the take's audio over the same frames) is edited together with it by the
//   same commands, so the sound is retimed with the picture; any other link is refused. The swap's original
//   soundtrack is a separate clip and is never touched;
// - refused, with the reason: a locked track, retiming, holds or frame stepping already on the clip, shake, keyframe
//   animation or text on it.
// The edited document is checked against the plan (every piece where it should be, every kept anchor's original frame
// showing its take frame, the take never going back nor jumping more than 2 frames), and the cuts of the edited
// picture are measured again for the expected on-time count.
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { compositingChannels } from "../editor/animation";
import { clipDuration, clipEnd, processedDuration, selectClips, trackClips, windowBounds } from "../editor/model";
import { activeTransition, HOLD_MAX_FRAMES, retimedFrames, sourceFrameAt } from "../model/clipEffects";
import { applyPieces, piecesOf, plain, takeMapping, type ConformSpan } from "./conformEdit";
import { endSwitchCut, MAX_CUT_SHIFT, MAX_STRETCH, retimedTiming, stretchFits, type ConformAnalysis, type CutAnchor, type CutTiming } from "./cuts";
import { retimingReason } from "./target";

export type { ConformSpan, ConformTreatment } from "./conformEdit";

/** The fastest a window may play (the stretch limit, in integer percent): it then steps 1 or 2 take frames. */
const SPEED_HIGH = Math.floor(100 * MAX_STRETCH);
/** Most take frames one output frame may advance by. */
export const MAX_STEP = 2;
/** A mean luma change (0–255) between neighbouring frames above which neither frame is skipped (a flash or a cut). */
export const LUMA_JUMP = 20;

export interface BlockedAnchor extends CutAnchor {
  reason: string;
}

export interface ConformPlan {
  /** The edited document. */
  timeline: StudioTimeline;
  /** The anchors applied, in order ((0, 0) not included): each take cut lands on the original's (an early switch on the clip's end: original = the clip's length). */
  anchors: CutAnchor[];
  blocked: BlockedAnchor[];
  spans: ConformSpan[];
  /** Clips the clip becomes. */
  parts: number;
  /** Its linked sound is edited with it. */
  linked: boolean;
  /** The cut timing now, and as the edited clip plays it (its cuts measured again on the take's frames). */
  before: CutTiming;
  after: CutTiming;
  /** The take frame each clip frame shows after the edit (clip frames of the take). */
  mapping: number[];
}

/** settled: there is nothing to do (no cut in the original, or the cuts are already on their frames). */
export type ConformPlanResult = { ok: true; plan: ConformPlan } | { ok: false; reason: string; blocked: BlockedAnchor[]; settled: boolean };

export interface ConformInput {
  timeline: StudioTimeline;
  clipId: string;
  analysis: ConformAnalysis;
}

export const hasKeys = (clip: TimelineClip) => Object.values(clip.motion.keyframes).some((keys) => keys.length > 0) || compositingChannels(clip).some((channel) => channel.keys.length > 0);

export const hasShake = (clip: TimelineClip) => (clip.effects?.camera?.shake_px ?? 0) > 0 && (clip.effects?.camera?.shake_frames ?? 0) > 0;

/** The clips linked to `clip` (a take's own sound), which every tool edits with it. */
export const linkedPeers = (timeline: StudioTimeline, clip: TimelineClip) => selectClips(timeline, [clip.clip_id], true).filter((item) => item.clip_id !== clip.clip_id);

/** Why the clip or its linked clips cannot be edited: a locked track; null when they can (every tool's rule). */
export function lockRefusal(timeline: StudioTimeline, clip: TimelineClip, peers: readonly TimelineClip[]): string | null {
  const locked = new Set(timeline.tracks.filter((track) => track.locked).map((track) => track.track_id));
  if (locked.has(clip.track_id)) return t("軌道已鎖定；請先解鎖再編輯");
  if (peers.some((peer) => locked.has(peer.track_id))) return t("連結的片段所在的軌道已鎖定；請先解鎖再套用");
  return null;
}

/** Why the linked clips cannot follow the clip's frames (they are not its own sound); null when they can. */
export function soundRefusal(clip: TimelineClip, peers: readonly TimelineClip[]): string | null {
  const window = JSON.stringify(clip.output_window ?? null);
  const sameFrames = (peer: TimelineClip) =>
    peer.source_id === clip.source_id && peer.start_frame === clip.start_frame && peer.in_frame === clip.in_frame && peer.out_frame === clip.out_frame && JSON.stringify(peer.output_window ?? null) === window;
  return peers.every(sameFrames) ? null : t("連結的片段不是這段畫面自己的聲音（來源或範圍不同），無法跟著一起調整時間：請先取消連結再對齊");
}

/**
 * Why the clip (or its linked sound) cannot be split and retimed by the cut conform or the motion retime: a locked
 * track, retiming, holds or frame stepping, shake, keyframe animation or text (`animated` words those two for the
 * tool), a link to anything but its own sound; null when it can.
 */
export function splitRefusal(timeline: StudioTimeline, clip: TimelineClip, peers: readonly TimelineClip[], animated: (item: TimelineClip) => string | null): string | null {
  const locked = lockRefusal(timeline, clip, peers);
  if (locked != null && locked !== "") return locked;
  for (const item of [clip, ...peers]) {
    const reason = retimingReason(item) ?? (hasShake(item) ? t("這個片段已經有震動：請先在「效果控制」重設鏡頭運動") : animated(item));
    if (reason != null && reason !== "") return reason;
  }
  return soundRefusal(clip, peers);
}

/** The cut conform's words for keyframe animation and text (splitRefusal). */
function conformAnimated(item: TimelineClip): string | null {
  if (hasKeys(item)) return t("這個片段有關鍵影格動畫：對齊切點要分割片段並調整時間，請先移除關鍵影格");
  return item.effects?.title ? t("這個片段有文字：對齊切點要分割片段並調整時間，請先移除文字") : null;
}

/**
 * Why a cut at clip frame `frame` cannot be split or kept there in `items` (a clip and the clips linked to it, which
 * share its frames): a transition, a fade or the impact frames of one of them, the first found in their order; null
 * when it can. Every tool that splits a clip keeps to it (the cut conform, the motion retime, the speed-feel effects).
 */
export function zoneOf(timeline: StudioTimeline, items: readonly TimelineClip[]): (frame: number) => string | null {
  const zones = items.map((item) => clipZone(timeline, item));
  return (frame) => zones.reduce<string | null>((found, check) => found ?? check(frame), null);
}

/** Why a part of `clip` cannot start at its clip frame `frame`; null when it can. */
function clipZone(timeline: StudioTimeline, clip: TimelineClip): (frame: number) => string | null {
  const length = clipDuration(clip);
  const ordered = trackClips(timeline, clip.track_id);
  const previous = ordered[ordered.findIndex((item) => item.clip_id === clip.clip_id) - 1];
  const incoming = previous && activeTransition(previous.effects) ? clipEnd(previous) - clip.start_frame : 0;
  const outgoing = activeTransition(clip.effects)?.frames ?? 0;
  const fade = clip.effects?.fade;
  const fadeIn = Math.max(fade?.video_in ?? 0, fade?.audio_in ?? 0);
  const fadeOut = Math.max(fade?.video_out ?? 0, fade?.audio_out ?? 0);
  const impact = clip.effects?.impact?.frames ?? 0;
  const start = windowBounds(clip).start_frame;
  const duration = processedDuration(clip);
  return (frame) => {
    if (frame < incoming) return t("落在進場的轉場裡");
    // A part starting where the outgoing transition starts would lie wholly inside it (the editor's split refuses it)
    if (outgoing > 0 && frame >= length - outgoing) return t("落在出場的轉場裡");
    const offset = start + frame;
    if (offset < fadeIn) return t("落在淡入的範圍內");
    if (offset > duration - fadeOut) return t("落在淡出的範圍內");
    if (offset < impact) return t("落在衝擊格的範圍內");
    return null;
  };
}

const anchorKey = (anchor: CutAnchor) => `${String(anchor.original)}:${String(anchor.take)}`;

/**
 * The matched pairs walked in order, then the early switch on the clip's end: the anchors kept and the ones left out
 * with their reasons (`excluded` first).
 */
function chooseAnchors(analysis: ConformAnalysis, length: number, zone: (frame: number) => string | null, excluded: ReadonlyMap<string, string>): { kept: CutAnchor[]; blocked: BlockedAnchor[] } {
  const kept: CutAnchor[] = [];
  const blocked: BlockedAnchor[] = [];
  let previous: CutAnchor = { original: 0, take: 0 };
  const consider = (anchor: CutAnchor) => {
    const stretch = () => (stretchFits(previous, anchor) ? null : t("和前一個對齊的切點之間，生成要拉長或壓縮超過 {max} 倍（多半是把閃光誤判成切點）", { max: MAX_STRETCH }));
    const reason = excluded.get(anchorKey(anchor)) ?? (anchor.take >= length ? t("生成的切點在片段結尾之後") : (zone(anchor.take) ?? zone(anchor.original) ?? stretch()));
    if (reason != null && reason !== "") blocked.push({ ...anchor, reason });
    else {
      kept.push(anchor);
      previous = anchor;
    }
  };
  for (const pair of analysis.pairs) {
    if (pair.original === null || pair.take === null) continue;
    consider({ original: pair.original, take: pair.take });
  }
  // It comes after every matched cut, so it stays in order
  const switched = endSwitchCut(analysis);
  if (switched !== null) consider({ original: length, take: switched });
  return { kept, blocked };
}

interface PartContext {
  /** The take's motion: entry i = the change from frame i to i + 1. */
  motion: readonly number[];
  /** The take's mean luma by frame. */
  luma: readonly number[];
  zone: (frame: number) => string | null;
}

/** How invisible a drop or a repeat of take frame `frame` is: the take's motion on both sides of it (lower = stiller). */
const stillness = (motion: readonly number[], frame: number) => (frame >= 1 ? (motion[frame - 1] ?? 0) : 0) + (motion[frame] ?? 0);

/** Whether neither neighbour of take frame `frame` is a luminance jump away (a flash or a cut). */
function steady(luma: readonly number[], frame: number): boolean {
  const here = luma[frame];
  if (here === undefined) return false;
  const before = luma[frame - 1];
  const after = luma[frame + 1];
  return (before === undefined || Math.abs(here - before) <= LUMA_JUMP) && (after === undefined || Math.abs(after - here) <= LUMA_JUMP);
}

const splittable = (context: PartContext, take: number, output: number) => context.zone(take) === null && context.zone(output) === null;

/** The frame to hold: a steady one when there is, then the stillest (the part's last frame needs no split of its own). */
function holdFrame(from: CutAnchor, to: CutAnchor, frames: number, context: PartContext): number | null {
  if (frames > HOLD_MAX_FRAMES) return null;
  let best: { frame: number; steady: boolean; cost: number } | null = null;
  for (let frame = from.take; frame < to.take; frame += 1) {
    const next = frame + 1;
    if (next < to.take && !splittable(context, next, from.original + next - from.take + frames)) continue;
    const option = { frame, steady: steady(context.luma, frame), cost: stillness(context.motion, frame) };
    if (!best || (option.steady && !best.steady) || (option.steady === best.steady && option.cost < best.cost)) best = option;
  }
  return best?.frame ?? null;
}

/**
 * Offsets (from a window's start) of the take frames that `speed` skips over a window of `length` frames, when it
 * plays exactly `length − dropped` frames and never advances more than MAX_STEP frames at once, out of the window
 * included; null when it does not.
 */
function skippedOffsets(length: number, dropped: number, speed: number): number[] | null {
  const frames = retimedFrames(length, speed);
  if (frames !== length - dropped) return null;
  const shown = new Set<number>();
  let previous = -1;
  for (let output = 0; output < frames; output += 1) {
    const offset = sourceFrameAt(output, speed);
    if (offset - previous > MAX_STEP) return null;
    shown.add(offset);
    previous = offset;
  }
  if (length - previous > MAX_STEP) return null;
  return Array.from({ length }, (_, offset) => offset).filter((offset) => !shown.has(offset));
}

/** The stillest window that loses `dropped` frames at a speed of at most 150 %; `safe` keeps it off luminance jumps. */
function fasterWindow(from: CutAnchor, to: CutAnchor, dropped: number, context: PartContext, safe: boolean): { from: number; length: number; speed: number } | null {
  const prefix = [0];
  for (let frame = from.take; frame < to.take; frame += 1) prefix.push((prefix.at(-1) ?? 0) + stillness(context.motion, frame));
  let best: { from: number; length: number; speed: number; cost: number } | null = null;
  // At 150 % a window of 3 frames loses 1: shorter windows cannot lose enough
  for (let length = 3 * dropped; length <= to.take - from.take; length += 1) {
    for (let speed = 101; speed <= SPEED_HIGH; speed += 1) {
      const skipped = skippedOffsets(length, dropped, speed);
      if (!skipped) continue;
      for (let start = from.take; start + length <= to.take; start += 1) {
        const place = from.original + start - from.take;
        if (start > from.take && !splittable(context, start, place)) continue;
        if (start + length < to.take && !splittable(context, start + length, place + length - dropped)) continue;
        if (safe && !skipped.every((offset) => steady(context.luma, start + offset))) continue;
        const cost = (prefix[start - from.take + length] ?? 0) - (prefix[start - from.take] ?? 0);
        if (!best || cost < best.cost) best = { from: start, length, speed, cost };
      }
    }
  }
  return best;
}

/** `dropped` single frames to leave out (never the cut frame, never two side by side), the stillest first; null when they do not fit. */
function singleDrops(from: CutAnchor, to: CutAnchor, dropped: number, context: PartContext, safe: boolean): number[] | null {
  const candidates: number[] = [];
  for (let frame = from.take + 1; frame < to.take; frame += 1) {
    if (context.zone(frame) !== null || (frame + 1 < to.take && context.zone(frame + 1) !== null)) continue;
    if (!safe || steady(context.luma, frame)) candidates.push(frame);
  }
  candidates.sort((a, b) => stillness(context.motion, a) - stillness(context.motion, b) || a - b);
  const picked: number[] = [];
  for (const frame of candidates) {
    if (picked.length === dropped) break;
    if (picked.every((other) => Math.abs(other - frame) >= MAX_STEP)) picked.push(frame);
  }
  if (picked.length < dropped) return null;
  picked.sort((a, b) => a - b);
  // Each drop splits the part where it lands; those places must be free of transitions and fades too
  const fits = picked.every((frame, index) => context.zone(from.original + frame - from.take - index) === null);
  return fits ? picked : null;
}

/** The part between two anchors; null when it cannot be retimed by the rules. */
function partSpan(from: CutAnchor, to: CutAnchor, context: PartContext): ConformSpan | null {
  const take = { from: from.take, to: to.take };
  const output = { from: from.original, to: to.original };
  const takeLength = to.take - from.take;
  const outputLength = to.original - from.original;
  if (takeLength === outputLength) return { take, output, treatment: { kind: "keep" } };
  if (takeLength < outputLength) {
    const frames = outputLength - takeLength;
    const at = holdFrame(from, to, frames, context);
    return at === null ? null : { take, output, treatment: { kind: "hold", frames, at } };
  }
  const frames = takeLength - outputLength;
  // Steady places first; only a part without any is retimed over its jumps
  for (const safe of [true, false]) {
    const faster = fasterWindow(from, to, frames, context, safe);
    if (faster) return { take, output, treatment: { kind: "faster", from: faster.from, length: faster.length, speed: faster.speed, frames } };
    const drops = singleDrops(from, to, frames, context, safe);
    if (drops) return { take, output, treatment: { kind: "drops", frames: drops } };
  }
  return null;
}

interface TailRoom {
  /** The take has frames after the clip's out point, which are never used (they can show the original character drawn as is). */
  withheld: boolean;
  /** The clip ends in a transition: its end must not move, so it cannot hold. */
  transition: boolean;
}

/** The part after the last anchor; a reason when the clip cannot end that way. */
function tailSpan(last: CutAnchor, length: number, room: TailRoom): ConformSpan | string {
  // An early switch anchored on the clip's end: nothing of the take plays after it
  if (last.original >= length) return { take: { from: last.take, to: length }, output: { from: length, to: length }, treatment: { kind: "end", frames: length - last.take } };
  const shift = last.original - last.take;
  const output = { from: last.original, to: length };
  if (shift >= 0) return { take: { from: last.take, to: length - shift }, output, treatment: { kind: "tail", shift, extended: 0, hold: 0 } };
  // Late: the frames after the clip's out point are never shown (the swap's lead-out and borrowed shots can draw the
  // original character as is), so the last frame holds for them
  const late = -shift;
  if (room.transition) {
    return room.withheld
      ? t("片段結尾有轉場，生成在這裡晚了 {frames} 影格：片段出點之後的畫格可能畫出原角色，不使用，有轉場的結尾又不能停格", { frames: late })
      : t("片段結尾有轉場，生成在這裡晚了 {frames} 影格，片段後面的素材又不夠補上", { frames: late });
  }
  return { take: { from: last.take, to: length }, output, treatment: { kind: "tail", shift, extended: 0, hold: late, ...(room.withheld ? { withheld: true as const } : {}) } };
}

const refused = (reason: string, blocked: BlockedAnchor[] = [], settled = false): ConformPlanResult => ({ ok: false, reason, blocked, settled });

/** The edit that conforms the take's cuts on the clip `clipId` to the original's; a reason when there is none to make. */
export function planConform({ timeline, clipId, analysis }: ConformInput): ConformPlanResult {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  if (!clip) return refused(t("找不到這個片段（可能已經刪除，或被復原拿掉了）"));
  const peers = linkedPeers(timeline, clip);
  const refusal = splitRefusal(timeline, clip, peers, conformAnimated);
  if (refusal != null && refusal !== "") return refused(refusal);
  const length = clipDuration(clip);
  if (length !== analysis.length) return refused(t("片段在分析之後改變了，請重新分析"));
  // An early switch at the clip's end is conformed whatever the original's other cuts
  const switched = endSwitchCut(analysis) !== null;
  if (analysis.originalCuts.length === 0 && !switched) return refused(t("原片這段沒有切鏡，不需要對齊切點。"), [], true);
  if (analysis.timing.matched === 0 && !switched) return refused(t("生成沒有能和原片配對的切點（相差 {frames} 影格以內才配對）：對齊補不了，可以重新生成這段。", { frames: MAX_CUT_SHIFT }));

  const items = [clip, ...peers];
  const zone = zoneOf(timeline, items);
  const context: PartContext = { motion: analysis.takeMotion, luma: analysis.takeFeatures.map((features) => features.luma), zone };
  const first = clip.in_frame + windowBounds(clip).start_frame;
  const sourceFrames = timeline.sources.find((source) => source.source_id === clip.source_id)?.duration_frames ?? first + length;
  const room: TailRoom = { withheld: sourceFrames - first - length > 0, transition: items.some((item) => activeTransition(item.effects) !== null) };

  // An anchor the clip cannot end after, or whose part cannot be retimed, is left out and the anchors chosen again
  const excluded = new Map<string, string>();
  for (;;) {
    const { kept, blocked } = chooseAnchors(analysis, length, zone, excluded);
    const last = kept.at(-1);
    const tail = tailSpan(last ?? { original: 0, take: 0 }, length, room);
    if (typeof tail === "string") {
      if (!last) return refused(tail, blocked);
      excluded.set(anchorKey(last), tail);
      continue;
    }
    const spans: ConformSpan[] = [];
    let previous: CutAnchor = { original: 0, take: 0 };
    let failed: CutAnchor | null = null;
    for (const anchor of kept) {
      const span = partSpan(previous, anchor, context);
      if (!span) {
        failed = anchor;
        break;
      }
      spans.push(span);
      previous = anchor;
    }
    if (failed) {
      excluded.set(anchorKey(failed), t("前一段找不到能安全加速或停格的位置（轉場、淡入淡出擋住）"));
      continue;
    }
    spans.push(tail);
    const { pieces, dropped } = piecesOf(spans, length);
    if (pieces.every(plain) && dropped.length === 0) {
      if (kept.length === 0) return refused(t("每個切點都不能用（原因列在表格裡）"), blocked);
      return refused(blocked.length > 0 ? t("能用的切點都已經對齊；其他的不能用（原因列在表格裡）。") : t("生成的切點已經對齊原片，不需要調整。"), blocked, blocked.length === 0);
    }
    const linked = clip.linked_id !== undefined;
    const edited = applyPieces(timeline, clip, pieces, dropped, linked);
    if (!edited.ok) return refused(edited.reason, blocked);
    const mapping = takeMapping(edited.parts, clip.start_frame, first, length);
    const steps = mapping.slice(1).map((frame, index) => frame - (mapping[index] ?? 0));
    // A kept anchor's original frame shows its take frame; on the clip's end (an early switch), no frame from it on shows
    const lands = (anchor: CutAnchor) => (anchor.original < length ? mapping[anchor.original] === anchor.take : (mapping[length - 1] ?? anchor.take) < anchor.take);
    // …and no frame at or after the clip's out point shows
    const broken = mapping.some((frame) => frame < 0 || frame >= length) || steps.some((step) => step < 0 || step > MAX_STEP) || kept.some((anchor) => !lands(anchor));
    if (broken) return refused(t("對齊後的片段和計畫不一致"), blocked);
    return {
      ok: true,
      plan: { timeline: edited.timeline, anchors: kept, blocked, spans, parts: pieces.length, linked, before: analysis.timing, after: retimedTiming(analysis, mapping), mapping },
    };
  }
}
