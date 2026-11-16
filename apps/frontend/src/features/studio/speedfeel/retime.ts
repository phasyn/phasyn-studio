// Motion retime (依動作同步, pure): the take re-timed frame by frame to the original's motion rhythm by a constrained
// dynamic time warping (max_lag 12, lam 0.35).
// - curves: the original's motion (mean |adjacent-frame gray difference|; entry k: frame k to k + 1) and the take's for a
//   1-frame step (d1) and a 2-frame step (d2), on the cut reader's 64×36 gray frames; log1p, z-scored (the take's over
//   its first n + 12 entries, population deviation + 1e-6). The take has only the clip's own n frames (t_len = n): its
//   frames after the clip's out point can show the original character drawn as is (the swap's held lead-out and
//   borrowed shots), so a late take repeats frames (where allowed) instead of reaching them;
// - path: clip frame k shows take frame m[k]; m[0] anywhere in 0…12, |m[k] − k| ≤ 12, steps of 1, 0 (the frame repeats)
//   or 2 (one frame dropped), never two irregular steps in a row; a step costs the squared difference of the take's
//   z-scored motion for it (a repeat: none) and the original's, an irregular one 0.35 more; the cheapest path wins and
//   equal costs keep the first found (smaller frames first, a regular last step before an irregular one);
// - safety, constraints of the path: a frame repeats or drops only where the take's adjacent differences both lie
//   under the clip's 75th percentile, or next to a cut or a flash (a mean luma jump above 20); after a take's early
//   switch at the clip's end (cuts.ts endSwitchCut) the path stays before the switch, so the next shot never shows (no
//   path within the band when the switch comes more than 12 frames early);
// - the edit: the clip (with its own linked sound) is split wherever the lag m[k] − k changes and each part is slipped
//   by its lag — a repeat is a part starting on the frame the previous one ended on, a drop a part starting one frame
//   later — so no part moves or changes length: the clip keeps its exact length and place and nothing else moves.
//   A split may not land in a transition, a fade or the impact frames, so the path takes no repeat or drop into a frame
//   there: a clip that dissolves into the next one is retimed between its transitions (the swap film's segments all do).
//   Refused like the cut conform (a locked track, retiming, holds or frame stepping, shake, keyframe animation, text, a
//   link to anything but its own sound).
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { executeEdit, type EditCommand } from "../editor/commands";
import { clipDuration, clipEnd, selectClips, sourceFrameAtTimeline, windowBounds } from "../editor/model";
import { percentile } from "./analysis";
import { hasKeys, linkedPeers, LUMA_JUMP, splitRefusal, zoneOf } from "./conform";
import { endSwitchCut, sequenceCuts, type ConformAnalysis } from "./cuts";

export const DTW_MAX_LAG = 12;
export const DTW_LAMBDA = 0.35;
/** Percentile of the clip's adjacent differences under which a frame may repeat or drop unseen. */
const QUIET_PERCENTILE = 75;
const BIG = 1e18;
const BAND = 2 * DTW_MAX_LAG + 1;

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const deviation = (values: readonly number[], center: number) => Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);

/** Whether take frame `frame` may repeat or drop: quiet on both sides, or next to a cut or a flash. */
export function retimeSafety(analysis: Pick<ConformAnalysis, "length" | "takeMotion" | "takeFeatures">): (frame: number) => boolean {
  const d1 = analysis.takeMotion;
  const quietBelow = percentile(d1.slice(0, Math.max(0, analysis.length - 1)), QUIET_PERCENTILE);
  const luma = analysis.takeFeatures.map((features) => features.luma);
  const cuts = new Set(sequenceCuts(analysis.takeFeatures));
  const jump = (a: number, b: number) => {
    const from = luma[a];
    const to = luma[b];
    return from !== undefined && to !== undefined && Math.abs(to - from) > LUMA_JUMP;
  };
  return (frame) => {
    const before = d1[frame - 1];
    const after = d1[frame];
    const quiet = (before === undefined || before < quietBelow) && (after === undefined || after < quietBelow);
    return quiet || jump(frame - 1, frame) || jump(frame, frame + 1) || cuts.has(frame) || cuts.has(frame + 1);
  };
}

/**
 * The take frame each of the clip's `n` frames shows (the reference's dtw_map with the safety constraint): monotone,
 * steps 0, 1 or 2, never past take frame `last` (the frame before an early switch at the clip's end), a repeat or a drop
 * only into a clip frame where `splitAllowed` lets a part start; null when no path keeps to that.
 */
export function dtwMap(original: readonly number[], d1: readonly number[], d2: readonly number[], n: number, takeFrames: number, allowed: (frame: number) => boolean, last = takeFrames - 1, splitAllowed: (k: number) => boolean = () => true): number[] | null {
  const top = Math.min(takeFrames - 1, last);
  const f = Math.log1p;
  const fo = original.map(f);
  const meanO = mean(fo);
  const sdO = deviation(fo, meanO) + 1e-6;
  const zo = fo.map((value) => (value - meanO) / sdO);
  const ref = d1.slice(0, n + DTW_MAX_LAG).map(f);
  const mu = mean(ref);
  const sd = deviation(ref, mu) + 1e-6;
  const motionOf = (frame: number, step: number) => (step === 0 ? 0 : step === 1 ? (d1[frame] ?? 0) : (d2[frame] ?? 0));
  const r = (frame: number, step: number) => (f(motionOf(frame, step)) - mu) / sd;
  // Only the band |t − k| ≤ 12 is reachable: cell (k, t, last step irregular)
  const cell = (k: number, frame: number, irregular: number) => {
    const offset = frame - k + DTW_MAX_LAG;
    return offset < 0 || offset >= BAND ? -1 : (k * BAND + offset) * 2 + irregular;
  };
  const cost = new Float64Array(n * BAND * 2).fill(BIG);
  const backFrame = new Int32Array(n * BAND * 2);
  const backIrregular = new Uint8Array(n * BAND * 2);
  const costAt = (index: number) => (index < 0 ? BIG : (cost[index] ?? BIG));
  for (let frame = 0; frame <= Math.min(DTW_MAX_LAG, top); frame += 1) cost[cell(0, frame, 0)] = 0;
  for (let k = 1; k < n; k += 1) {
    const target = zo[k - 1] ?? 0;
    // A repeat or a drop into frame k starts a part there
    const steps = splitAllowed(k) ? [0, 1, 2] : [1];
    for (let frame = Math.max(0, k - DTW_MAX_LAG); frame <= Math.min(top, k + DTW_MAX_LAG); frame += 1) {
      for (const step of steps) {
        const from = frame - step;
        if (from < 0) continue;
        const irregular = step === 1 ? 0 : 1;
        // The repeated frame (from) or the dropped one (from + 1) must not show
        if (irregular === 1 && !allowed(step === 0 ? from : from + 1)) continue;
        const stepCost = (r(from, step) - target) ** 2 + (irregular === 1 ? DTW_LAMBDA : 0);
        const here = cell(k, frame, irregular);
        for (const previous of [0, 1]) {
          if (irregular === 1 && previous === 1) continue;
          const c = costAt(cell(k - 1, from, previous));
          if (c >= BIG) continue;
          if (c + stepCost < costAt(here)) {
            cost[here] = c + stepCost;
            backFrame[here] = from;
            backIrregular[here] = previous;
          }
        }
      }
    }
  }
  let endFrame = 0;
  let endIrregular = 0;
  let best = BIG;
  for (let frame = Math.max(0, n - 1 - DTW_MAX_LAG); frame <= Math.min(top, n - 1 + DTW_MAX_LAG); frame += 1) {
    for (const irregular of [0, 1]) {
      const c = costAt(cell(n - 1, frame, irregular));
      if (c < best) {
        best = c;
        endFrame = frame;
        endIrregular = irregular;
      }
    }
  }
  if (best >= BIG) return null;
  const mapping = Array.from({ length: n }, () => 0);
  let frame = endFrame;
  let irregular = endIrregular;
  for (let k = n - 1; k >= 0; k -= 1) {
    mapping[k] = frame;
    if (k > 0) {
      const here = cell(k, frame, irregular);
      frame = backFrame[here] ?? 0;
      irregular = backIrregular[here] ?? 0;
    }
  }
  return mapping;
}

export interface RetimeMeasure {
  /** The take frame each clip frame shows (clip frames of the take); empty when no path keeps off an early switch's next shot. */
  mapping: number[];
  /** Frames shown twice (steps of 0) and frames left out (steps of 2). */
  holds: number;
  drops: number;
  /** The take's early switch at the clip's end (cuts.ts endSwitchCut): the path shows none of its frames. */
  switched: number | null;
  /** The take runs past the clip's out point (over every frame read, the path would use frames after it): it repeats frames instead. */
  capped: boolean;
}

/**
 * The retime of an analysis, its repeats and drops kept to the clip frames where `splitAllowed` lets a part start (see
 * retimeZone); null when its curves were not measured.
 */
export function measureRetime(analysis: ConformAnalysis, splitAllowed: (k: number) => boolean = () => true): RetimeMeasure | null {
  const n = analysis.length;
  const read = analysis.takeMotion.length + 1;
  if (analysis.originalMotion.length < n - 1 || analysis.takeMotion2.length === 0 || read < n || analysis.takeFeatures.length < read) return null;
  const original = analysis.originalMotion.slice(0, n - 1);
  const allowed = retimeSafety(analysis);
  // The take's frames after the clip's out point are never shown (the swap's held lead-out and borrowed shots can draw
  // the original character as is): the path has the clip's own n frames. A take that switches to the next shot early
  // must not show that shot either: the path ends before the switch
  const switched = endSwitchCut(analysis);
  const mapping = dtwMap(original, analysis.takeMotion.slice(0, n - 1), analysis.takeMotion2.slice(0, Math.max(0, n - 2)), n, n, allowed, switched === null ? n - 1 : switched - 1, splitAllowed) ?? [];
  const steps = mapping.slice(1).map((frame, index) => frame - (mapping[index] ?? 0));
  // Over every frame read, would the path have gone past the out point? (then the repeats stand in for those frames)
  const capped = switched === null && (dtwMap(original, analysis.takeMotion, analysis.takeMotion2, n, read, allowed, read - 1, splitAllowed) ?? []).some((frame) => frame >= n);
  return { mapping, holds: steps.filter((step) => step === 0).length, drops: steps.filter((step) => step === 2).length, switched, capped };
}

/** Why the clip `clipId` (or its linked sound) cannot start a part at clip frame k (a transition, a fade, the impact frames); null when it can. */
export function retimeZone(timeline: StudioTimeline, clipId: string): (k: number) => string | null {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  return clip ? zoneOf(timeline, selectClips(timeline, [clip.clip_id], true)) : () => null;
}

export interface RetimePlan {
  /** The edited document. */
  timeline: StudioTimeline;
  mapping: number[];
  holds: number;
  drops: number;
  /** Clips the clip becomes. */
  parts: number;
  /** Its linked sound is edited with it. */
  linked: boolean;
  /** The take runs past the clip's out point: repeats stand in for its frames after it (RetimeMeasure). */
  capped: boolean;
}

/** settled: the take already follows the original's rhythm. */
export type RetimePlanResult = { ok: true; plan: RetimePlan } | { ok: false; reason: string; settled: boolean };

export interface RetimeInput {
  timeline: StudioTimeline;
  clipId: string;
  /** Frames of the clip when it was analysed. */
  length: number;
  measure: RetimeMeasure;
}

const refusedRetime = (reason: string, settled = false): RetimePlanResult => ({ ok: false, reason, settled });

/** The retime's words for keyframe animation and text (splitRefusal). */
function retimeAnimated(item: TimelineClip): string | null {
  return hasKeys(item) || item.effects?.title ? t("這個片段有關鍵影格動畫或文字：依動作同步要分割片段並調整時間，請先移除") : null;
}

/** The edit that plays the retime's mapping on the clip `clipId`; a reason when there is none to make. */
export function planRetime({ timeline, clipId, length, measure }: RetimeInput): RetimePlanResult {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  if (!clip) return refusedRetime(t("找不到這個片段（可能已經刪除，或被復原拿掉了）"));
  const peers = linkedPeers(timeline, clip);
  const refusal = splitRefusal(timeline, clip, peers, retimeAnimated);
  if (refusal) return refusedRetime(refusal);
  const { mapping } = measure;
  if (mapping.length === 0 && measure.switched !== null) {
    return refusedRetime(t("生成在片段結尾前 {frames} 影格就切到下一個鏡頭，依動作同步補不到片段結尾（最多補 {max} 影格，而且只在動作少、切鏡或閃光的地方停格）", { frames: length - measure.switched, max: DTW_MAX_LAG }));
  }
  if (clipDuration(clip) !== length || mapping.length !== length) return refusedRetime(t("片段在分析之後改變了，請重新分析"));
  if (mapping.every((frame, offset) => frame === offset)) return refusedRetime(t("生成影片的動作節奏已經和原片同步，不需要調整。"), true);
  // A part starts wherever the lag changes; none of those splits may land in a transition, a fade or the impact frames
  // (measureRetime keeps the path off them when it is given the clip's retimeZone)
  const starts = [0, ...mapping.flatMap((frame, offset) => (offset > 0 && frame - (mapping[offset - 1] ?? 0) !== 1 ? [offset] : []))];
  const zone = retimeZone(timeline, clip.clip_id);
  for (const start of starts.slice(1)) {
    const reason = zone(start);
    if (reason) return refusedRetime(t("依動作同步要在片段中間分割，分割點{reason}", { reason }));
  }
  const linked = clip.linked_id !== undefined;
  const origin = clip.start_frame;
  const commands: EditCommand[] = starts
    .slice(1)
    .reverse()
    .map((start) => ({ type: "split", clipIds: [clip.clip_id], frame: origin + start, linked }));
  let document = timeline;
  const run = (command: EditCommand): string | null => {
    const result = executeEdit(document, command);
    if (!result.ok) return result.error;
    document = result.value;
    return null;
  };
  for (const command of commands) {
    const error = run(command);
    if (error) return refusedRetime(error);
  }
  // Every part slips by its lag (a split keeps the clip's id on the first part)
  const partAt = (start: number) => document.clips.find((item) => item.track_id === clip.track_id && item.source_id === clip.source_id && item.start_frame === origin + start);
  const ids: string[] = [];
  for (const start of starts) {
    const part = partAt(start);
    if (!part) return refusedRetime(t("找不到分割後的片段"));
    ids.push(part.clip_id);
    const lag = (mapping[start] ?? start) - start;
    const error = lag === 0 ? null : run({ type: "slip", clipId: part.clip_id, delta: lag, linked });
    if (error) return refusedRetime(error);
  }
  // Checked: the parts cover the clip's frames exactly, each frame shows the mapped take frame (never one at or after
  // the clip's out point), nothing else changed
  const first = clip.in_frame + windowBounds(clip).start_frame;
  const parts = ids.map((id) => document.clips.find((item) => item.clip_id === id)).filter((part) => part !== undefined);
  const covers = parts.length === ids.length && parts.every((part, index) => part.start_frame === origin + (starts[index] ?? 0) && clipEnd(part) === origin + (starts[index + 1] ?? length));
  const plays = covers && mapping.every((frame, offset) => {
    const part = parts.find((item) => item.start_frame <= origin + offset && origin + offset < clipEnd(item));
    return frame < length && part !== undefined && sourceFrameAtTimeline(part, origin + offset) === first + frame;
  });
  // The clip's parts and their sound parts (each part's link) are its own; every other clip must stay as it was
  const own = new Set([clip.clip_id, ...peers.map((peer) => peer.clip_id), ...ids]);
  const links = new Set(parts.flatMap((part) => (part.linked_id === undefined ? [] : [part.linked_id])));
  const others = (doc: StudioTimeline) => JSON.stringify(doc.clips.filter((item) => !own.has(item.clip_id) && !(item.linked_id !== undefined && links.has(item.linked_id))));
  if (!plays || others(document) !== others(timeline)) return refusedRetime(t("對齊後的片段和計畫不一致"));
  return { ok: true, plan: { timeline: document, mapping, holds: measure.holds, drops: measure.drops, parts: parts.length, linked, capped: measure.capped } };
}
