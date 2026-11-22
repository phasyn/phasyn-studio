// Whole-clip shift (整段平移, pure): a take whose rhythm follows the original's but runs a constant few frames late or
// early is shifted back in step as a whole. It can pick the wrong direction on clips with camera motion and flashes,
// so it is only the fallback of the motion retime
// (retime.ts; choice.ts decides when it shows). The motion curves' correlation (correlation) is shared with both.
// - motion: the mean absolute luma difference of consecutive frames (the cut reader's 64×36 gray frames, cuts.ts
//   grayDifference), both over the clip's own frames (the reader leaves out the take's frames after its out point);
//   entry i is the change from frame i to frame i + 1;
// - lag L, −12…+12 frames (+: the take late): the normalized cross-correlation (Pearson) of the original's entries k and
//   the take's entries k + L over the entries both have, measured only where they cover at least 75 % of the clip's
//   frames and both change;
// - offered: the best lag (the smaller shift on equal correlations, late before early) when it is not 0, correlates at
//   least 0.5 and at least 0.1 above lag 0, and the original moves at all (its p90 reaches the speed-feel tool's
//   ORIGINAL_MOVES_P90; a still picture's correlation is noise);
// - the edit, one history step that keeps the clip's place and exact length and touches nothing else (its own linked
//   sound follows it). L < 0: the clip slips |L| frames earlier in its source as far as the take has frames before its
//   first one, and the first frame holds for the rest (hold.start: as many frames are trimmed off its end). L > 0: never
//   past the clip's out point — the take's frames after it can show the original character drawn as is (the swap's
//   held lead-out and borrowed shots) — so the first L frames are trimmed off and the last frame holds L frames
//   (hold.end). Refused like the cut conform: a locked track, retiming, holds or frame stepping on the clip or its sound,
//   a link to anything but its own sound; a hold also when it would move the clip's transitions, fades, impact frames,
//   shake, keyframe animation or text.
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { executeEdit, type EditCommand } from "../editor/commands";
import { clipDuration, clipEnd, sourceFrameAtTimeline, trackClips, windowBounds } from "../editor/model";
import { activeTransition } from "../model/clipEffects";
import { motionStats, ORIGINAL_MOVES_P90 } from "./analysis";
import { hasKeys, hasShake, linkedPeers, lockRefusal, soundRefusal } from "./conform";
import { retimingReason } from "./target";

/** Frames the take may run late or early that the sync looks for. */
export const SYNC_MAX_LAG = 12;
/** Share of the clip's frames both curves must cover at a lag. */
const SYNC_MIN_OVERLAP = 0.75;
/** Correlation the best lag needs, and how far above the unshifted curves. */
export const SYNC_MIN_CORRELATION = 0.5;
export const SYNC_MIN_GAIN = 0.1;
/** Mean squared deviation (motion is 0–255) under which a curve counts as not changing. */
const FLAT = 1e-9;

export interface LagScore {
  /** Frames the take runs late (+) or early (−): its entry k + lag against the original's entry k. */
  lag: number;
  correlation: number;
}

export interface MotionSync {
  /** The original barely moves: no lag means anything and none is offered. */
  still: boolean;
  /** The correlation unshifted; null when it cannot be measured (a curve that does not change). */
  unshifted: number | null;
  /** The best lag measured within ±SYNC_MAX_LAG frames; null when none could be. */
  best: LagScore | null;
  /** The lag the sync removes, when it is offered (best.lag); null when it is not. */
  offered: number | null;
}

/** Pearson's correlation of two series of the same length; null when either does not change. */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < n; index += 1) {
    meanA += a[index] ?? 0;
    meanB += b[index] ?? 0;
  }
  meanA /= n;
  meanB /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < n; index += 1) {
    const da = (a[index] ?? 0) - meanA;
    const db = (b[index] ?? 0) - meanB;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa / n > FLAT && bb / n > FLAT ? ab / Math.sqrt(aa * bb) : null;
}

/** The correlation when the take runs `lag` frames late (early when negative); null where too little overlaps or a side does not change. */
export function lagScore(original: readonly number[], take: readonly number[], length: number, lag: number): LagScore | null {
  const from = Math.max(0, -lag);
  const to = Math.min(original.length, take.length - lag);
  // n entries cover n + 1 frames
  if (to - from + 1 < SYNC_MIN_OVERLAP * length) return null;
  const value = correlation(original.slice(from, to), take.slice(from + lag, to + lag));
  return value === null ? null : { lag, correlation: value };
}

/** The lag between the original's motion and the take's over a clip of `length` frames, and whether a sync is offered. */
export function motionSync(original: readonly number[], take: readonly number[], length: number): MotionSync {
  const still = motionStats(original).p90 < ORIGINAL_MOVES_P90;
  const unshifted = lagScore(original, take, length, 0)?.correlation ?? null;
  let best: LagScore | null = null;
  for (let shift = 0; shift <= SYNC_MAX_LAG; shift += 1) {
    for (const lag of shift === 0 ? [0] : [shift, -shift]) {
      const score = lagScore(original, take, length, lag);
      if (score && (!best || score.correlation > best.correlation)) best = score;
    }
  }
  const offered = !still && best && best.lag !== 0 && unshifted !== null && best.correlation >= SYNC_MIN_CORRELATION && best.correlation - unshifted >= SYNC_MIN_GAIN ? best.lag : null;
  return { still, unshifted, best, offered };
}

export interface SyncEdit {
  /** Frames the clip's source range moves (its in and out points; + = later in the take). */
  slip: number;
  /** Frames the take does not have past the slip: its last frame held at the end (lag > 0) or its first at the start (lag < 0). */
  hold: number;
}

export interface SyncPlan {
  /** The edited document. */
  timeline: StudioTimeline;
  /** Frames the take ran late (+) or early (−). */
  lag: number;
  edit: SyncEdit;
  /** Its linked sound is edited with it. */
  linked: boolean;
  /** The take frame each clip frame shows after the edit (clip frames of the take). */
  mapping: number[];
}

export type SyncPlanResult = { ok: true; plan: SyncPlan } | { ok: false; reason: string };

export interface SyncInput {
  timeline: StudioTimeline;
  clipId: string;
  /** Frames of the clip when it was analysed. */
  length: number;
  lag: number;
}

const refusedSync = (reason: string): SyncPlanResult => ({ ok: false, reason });

/**
 * Whether a hold would move something of the clip: at the start (its end trimmed) an outgoing transition or a
 * fade-out; at the end (its start trimmed and moved back) an incoming or outgoing transition, a fade-in or the impact
 * frames; either way shake, keyframe animation or text.
 */
function holdMoves(timeline: StudioTimeline, item: TimelineClip, atEnd: boolean): boolean {
  const effects = item.effects;
  const fade = effects?.fade;
  const ordered = trackClips(timeline, item.track_id);
  const previous = ordered[ordered.findIndex((other) => other.clip_id === item.clip_id) - 1];
  const incoming = previous !== undefined && activeTransition(previous.effects) !== null && clipEnd(previous) > item.start_frame;
  if (activeTransition(effects) !== null || hasShake(item) || hasKeys(item) || Boolean(effects?.title)) return true;
  return atEnd ? incoming || (fade?.video_in ?? 0) > 0 || (fade?.audio_in ?? 0) > 0 || Boolean(effects?.impact) : (fade?.video_out ?? 0) > 0 || (fade?.audio_out ?? 0) > 0;
}

/** The take frame (clip frames of the take) clip frame `offset` shows after `edit` removes `lag`. */
export function syncFrame(edit: SyncEdit, lag: number, length: number, offset: number): number {
  return lag > 0 ? Math.min(offset + lag, length - 1 + edit.slip) : Math.max(offset + lag, edit.slip);
}

/** The edit that puts the take on the clip `clipId` back in step with the original's motion; a reason when there is none to make. */
export function planSync({ timeline, clipId, length, lag }: SyncInput): SyncPlanResult {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  if (!clip) return refusedSync(t("找不到這個片段（可能已經刪除，或被復原拿掉了）"));
  const peers = linkedPeers(timeline, clip);
  const items = [clip, ...peers];
  const refusal = lockRefusal(timeline, clip, peers) ?? items.map(retimingReason).find((reason) => reason !== null) ?? soundRefusal(clip, peers);
  if (refusal != null && refusal !== "") return refusedSync(refusal);
  if (clipDuration(clip) !== length) return refusedSync(t("片段在分析之後改變了，請重新分析"));
  if (lag === 0) return refusedSync(t("生成影片的動作節奏已經和原片同步，不需要調整。"));
  const first = clip.in_frame + windowBounds(clip).start_frame;
  const frames = Math.abs(lag);
  // Earlier frames as far as the take has them before the clip's first one; never any after its out point (they can
  // show the original character drawn as is): a late take is held instead
  const slip = lag > 0 ? 0 : -Math.min(frames, first);
  const edit: SyncEdit = { slip, hold: frames - Math.abs(slip) };
  if (edit.hold > 0 && items.some((item) => holdMoves(timeline, item, lag > 0))) {
    return refusedSync(
      lag > 0
        ? t("片段出點之後的畫格可能畫出原角色，不使用；要用停格補上 {frames} 影格，請先移除片段的轉場、淡入淡出、衝擊格、震動、關鍵影格或文字", { frames })
        : t("素材不夠外滑 {frames} 影格；要用停格補上剩下的 {hold} 影格，請先移除片段的轉場、淡入淡出、衝擊格、震動、關鍵影格或文字", { frames, hold: edit.hold }),
    );
  }
  const linked = clip.linked_id !== undefined;
  const commands: EditCommand[] = slip === 0 ? [] : [{ type: "slip", clipId, delta: slip, linked }];
  if (edit.hold > 0 && lag > 0) {
    // The first frames go (the start moves later and back), the last frame holds for the rest: never past the next clip
    commands.push({ type: "trim", clipId, edge: "in", delta: edit.hold, ripple: false, linked }, { type: "move", clipId, startFrame: clip.start_frame, trackId: clip.track_id, linked });
    commands.push({ type: "patchClip", clipId, patch: { effects: { ...clip.effects, hold: { ...clip.effects?.hold, end: edit.hold } } }, linked });
  } else if (edit.hold > 0) {
    // Shorter first, so the hold that lengthens it again never overlaps the next clip
    commands.push({ type: "trim", clipId, edge: "out", delta: -edit.hold, ripple: false, linked });
    commands.push({ type: "patchClip", clipId, patch: { effects: { ...clip.effects, hold: { ...clip.effects?.hold, start: edit.hold } } }, linked });
  }
  let document = timeline;
  for (const command of commands) {
    const result = executeEdit(document, command);
    if (!result.ok) return refusedSync(result.error);
    document = result.value;
  }
  // Checked: the clip and its sound keep their places, every clip frame shows the take frame the lag asks for (the held
  // one where the take has none, never one at or after the out point) and no other clip changed
  const mapping = Array.from({ length }, (_, offset) => syncFrame(edit, lag, length, offset));
  const edited = document.clips.find((item) => item.clip_id === clipId);
  const placed = items.every((before) => {
    const after = document.clips.find((item) => item.clip_id === before.clip_id);
    return after?.start_frame === before.start_frame && clipEnd(after) === clipEnd(before);
  });
  const plays = edited !== undefined && mapping.every((frame, offset) => frame < length && sourceFrameAtTimeline(edited, clip.start_frame + offset) === first + frame);
  const ids = new Set(items.map((item) => item.clip_id));
  const others = (doc: StudioTimeline) => JSON.stringify(doc.clips.filter((item) => !ids.has(item.clip_id)));
  if (!placed || !plays || others(document) !== others(timeline)) return refusedSync(t("對齊後的片段和計畫不一致"));
  return { ok: true, plan: { timeline: document, lag, edit, linked, mapping } };
}
