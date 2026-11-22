// Speed feel (pure): where a rendered take misses the hits of the motion reference it was made from, by these rules:
// - motion: the mean absolute difference (0–255) of consecutive 96×54 grayscale frames at the sequence's frame rate,
//   unblurred; entry k is the change that appears on frame k + 1. Luminance: each frame's mean (0–255).
// - accents: local maxima of the original's curve at or above max(p75, median + 2.5 · MAD · 1.4826), at least 4 frames
//   apart (strongest first), each on the first frame that shows the change; strength = (peak − median) ÷ (largest peak −
//   median), 0–1, rounded to 2 decimals like the prototype. Kinds, from the cuts within 3 frames ("near") and the largest
//   whole-picture luminance jump within a frame of the peak: near ≥ 2 and a jump ≥ 30 = flash (on the run's first cut);
//   near ≥ 2 without it = fast action animated on twos (every new drawing reads as a cut: no effect can add that
//   motion); one cut within a frame = an edit (whatever its brightness change); no cut but a jump ≥ 30 = flash; else
//   action.
// - cuts of the original: the prototype read them from the original's cut list (FFmpeg's scene score on the full
//   picture, no merging). The browser computes that score on the 96×54 frames, min(d, |d − previous d|) ÷ 100, above
//   SCENE_CUT = 0.25.
// - strobe run: 3 or more flashes within one second (24 frames at 24 fps).
// - gate: never an edit or on-twos action, only strictly inside the clip, strength ≥ 0.35 (≥ 0.2 for a flash in a
//   strobe run), and not where the take's own motion in entries f−3…f (frames f−2…f+1) already reaches 60 % of the
//   original's peak. Kept accents are 10 frames apart, strongest first; inside one strobe run 8 frames (a third of a
//   second) and at most 3 impact frames: broadcast photosensitivity guidance allows 3 flashes in any second.
// - recipe: action = a camera shake of round(6 + 14 · strength) px over 8 frames; flash = a 1-frame negative impact
//   frame and that shake, which in a strobe run only its first impact frame gets. The clip's length never changes.
// - flags: edit rhythm (the original cuts 3 times or more within a second: its speed comes from cutting) and the on-twos
//   accents the take does not move at (needs generation).
// - photosensitivity, a rough check: flashes per second of the planned picture, a flash being two opposite
//   whole-picture luminance changes of 25 or more; above 3 in any second gets a warning. Mean luminance only: no red
//   flashes, no partial-area flashes; not a PSE test.
// Verdict of the whole clip:
//   1. quiet: the original's p90 is under ORIGINAL_MOVES_P90 = 3 (on the same film the quietest tenth of its 4-second
//      windows measured p90 ≈ 1, a quarter of them ≥ 6.7) — nothing to emphasise;
//   2. moves_enough: the take's p90 is already ≥ the original's — no effects;
//   3. add: the gate kept accents — split there and add the recipe;
//   4. regenerate: on-twos action the take does not move at (needs generation) — effects cannot add motion;
//   5. covered: strong accents exist, but the take already moves at every one of them — no effects;
//   6. edits: the original's speed comes from cutting 3 or more times within a second — split the segment or change
//      the storyboard;
//   7. regenerate: no strong accent and the take is nearly still (p90 < STILL_TAKE_RATIO × the original's) — effects fix
//      the timing of hits, not missing motion: generate again (seed, prompt, reference window);
//   8. no_accents: the original has no strong accent — no effects.
// Frame counts (4, 10, ±3, ±1, f−3…f) are the prototype's at 24 fps; the one-second rules follow the sequence's rate.
// No imports at run time: the module is the measurement and stays checkable on its own.

export const ACCENT_MIN_GAP = 4;
const MAD_SCALE = 1.4826;
const ACCENT_MAD_FACTOR = 2.5;
/** Frames on either side of an accent in which cuts of the original classify it. */
const CUT_REACH = 3;
/** Whole-picture luminance jump (0–255) next to a peak that makes it a flash. */
export const FLASH_LUMA_JUMP = 30;
export const MIN_STRENGTH = 0.35;
/** The strength a flash inside a strobe run needs. */
export const STROBE_MIN_STRENGTH = 0.2;
/** Share of the original's peak the take's own motion must reach near an accent to count as already hitting it. */
export const COVERED_SHARE = 0.6;
/** Frames between two kept accents at least (outside one strobe run). */
export const ACCENT_SPACING = 10;
/** Flashes within one second that make a strobe run, impact frames one run gets at most, and the flashes per second the photosensitivity check allows. */
export const STROBE_MIN = 3;
export const STROBE_MAX_IMPACTS = 3;
export const FLASHES_PER_SECOND_LIMIT = 3;
/** Cuts within one second of the original that make its speed come from cutting. */
export const EDIT_RHYTHM_MIN = 3;
/** Whole-picture luminance change (0–255) counted as one half of a flash. */
const PSE_LUMA_STEP = 25;
export const SHAKE_FRAMES = 8;
const SHAKE_BASE_PX = 6;
const SHAKE_STRENGTH_PX = 14;
/** FFmpeg's scene score (0–1, on the 96×54 frames) above which a frame of the original starts a new picture. */
export const SCENE_CUT = 0.25;
/** p90 of the original's motion (0–255) under which it barely moves. */
export const ORIGINAL_MOVES_P90 = 3;
/** The take is nearly still when its p90 is under this share of the original's. */
export const STILL_TAKE_RATIO = 0.5;

export type AccentKind = "action" | "flash" | "twos" | "edit";

export interface Accent {
  /** The first frame that shows the change (clip frames from 0): where the clip is split. */
  frame: number;
  /** The original's motion at the peak (0–255). */
  motion: number;
  /** 0–1 relative to the clip's largest peak. */
  strength: number;
  kind: AccentKind;
}

export interface MotionStats {
  p90: number;
  max: number;
}

/** Frames of a strobe run (its first and last flash) and how many flashes it has. */
export interface StrobeRun {
  first: number;
  last: number;
  flashes: number;
}

/**
 * Why the gate let an accent go: an edit, on-twos action, outside the clip, too weak, already hit by the take, its
 * strobe run already has its impact frames, or too close to a stronger kept accent.
 */
export type SkipReason = "edit" | "twos" | "outside" | "weak" | "covered" | "strobe_full" | "crowded";

export interface AccentDecision {
  accent: Accent;
  kept: boolean;
  reason: SkipReason | null;
  /** The take's largest motion in entries f−3…f (null when not measured). */
  takePeak: number | null;
  /** On-twos action the take does not move at: only generation can add it. */
  needsGeneration: boolean;
}

export interface AccentEffects {
  camera?: { shake_px: number; shake_frames: number };
  impact?: { frames: number; style: "negative" };
}

export interface Hit {
  accent: Accent;
  effects: AccentEffects;
}

export type SpeedFeelVerdict = "quiet" | "moves_enough" | "add" | "covered" | "edits" | "regenerate" | "no_accents";

/** Python's round(): half to even, on `digits` decimals. */
export function roundHalfEven(value: number, digits = 0): number {
  const scale = 10 ** digits;
  const scaled = value * scale;
  const floor = Math.floor(scaled);
  const rest = scaled - floor;
  const whole = rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return whole / scale;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const entry = (values: readonly number[], index: number) => values[index] ?? 0;
const largest = (values: readonly number[]) => values.reduce((top, value) => Math.max(top, value), Number.NEGATIVE_INFINITY);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? entry(sorted, middle) : (entry(sorted, middle - 1) + entry(sorted, middle)) / 2;
}

/** NumPy's default (linear) percentile, its two-sided interpolation included. */
export function percentile(values: readonly number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (percent / 100) * (sorted.length - 1);
  const below = Math.floor(position);
  const a = entry(sorted, below);
  const b = entry(sorted, Math.min(below + 1, sorted.length - 1));
  const share = position - below;
  return share >= 0.5 ? b - (b - a) * (1 - share) : a + (b - a) * share;
}

/** Mean absolute difference (0–255) of two grayscale frames of the same size. */
export function frameDifference(before: ArrayLike<number>, after: ArrayLike<number>): number {
  const count = Math.min(before.length, after.length);
  let sum = 0;
  for (let index = 0; index < count; index += 1) sum += Math.abs((before[index] ?? 0) - (after[index] ?? 0));
  return count > 0 ? sum / count : 0;
}

/** Mean luminance (0–255) of a grayscale frame. */
export function frameLuma(frame: ArrayLike<number>): number {
  let sum = 0;
  // ArrayLike also accepts indexed buffers without an iterator.
  let index = 0;
  while (index < frame.length) {
    const sample = frame[index] ?? 0;
    sum += sample;
    index += 1;
  }
  return frame.length > 0 ? sum / frame.length : 0;
}

/** Mean luminance of the frame as the export's negative impact frame draws it: negated, gray, contrast 1.8 (phasyn_media impact_chain). */
export function impactLuma(frame: ArrayLike<number>): number {
  let sum = 0;
  // ArrayLike also accepts indexed buffers without an iterator.
  let index = 0;
  while (index < frame.length) {
    const sample = frame[index] ?? 0;
    sum += clamp(Math.round((127 - sample) * 1.8 + 128), 0, 255);
    index += 1;
  }
  return frame.length > 0 ? sum / frame.length : 0;
}

/** p90 (the prototype's quantile rule: the sorted value at floor(0.9 · n)) and the largest entry, 2 decimals. */
export function motionStats(curve: readonly number[]): MotionStats {
  const sorted = [...curve].sort((a, b) => a - b);
  const n = sorted.length;
  return { p90: roundHalfEven(entry(sorted, Math.min(n - 1, Math.floor(0.9 * n))), 2), max: roundHalfEven(entry(sorted, n - 1), 2) };
}

/**
 * The frames where the original starts a new picture: FFmpeg's scene score min(d, |d − previous d|) ÷ 100 above
 * `threshold`, every such frame (no merging). `first` is the frame the curve starts from (entry j is the change from
 * frame first + j to first + j + 1); the first entry has no previous difference and is never a cut.
 */
export function sceneCuts(curve: readonly number[], first: number, threshold = SCENE_CUT): number[] {
  const cuts: number[] = [];
  for (let index = 1; index < curve.length; index += 1) {
    const difference = entry(curve, index);
    if (Math.min(difference, Math.abs(difference - entry(curve, index - 1))) / 100 > threshold) cuts.push(first + index + 1);
  }
  return cuts;
}

function accentKind(near: readonly number[], peak: number, jump: number): AccentKind {
  // A run of cut-detector hits: a burst when the brightness jumps, else drawings on twos
  if (near.length >= 2) return jump >= FLASH_LUMA_JUMP ? "flash" : "twos";
  // One isolated cut: an edit, however much the brightness changes between the two shots
  if (near.length === 1 && Math.abs((near[0] ?? peak) - peak) <= 1) return "edit";
  return jump >= FLASH_LUMA_JUMP ? "flash" : "action";
}

/**
 * The original's accents (speedfx.find_accents), in the order of their peaks. `lumaJump` entry k is the luminance change
 * that appears on frame k + 1, like the curve's.
 */
export function findAccents(curve: readonly number[], cutFrames: readonly number[], lumaJump: readonly number[], minGap = ACCENT_MIN_GAP): Accent[] {
  const n = curve.length;
  if (n === 0) return [];
  const at = (index: number) => entry(curve, index);
  const middle = median(curve);
  const mad = median(curve.map((value) => Math.abs(value - middle))) * MAD_SCALE;
  const threshold = Math.max(percentile(curve, 75), middle + ACCENT_MAD_FACTOR * mad);
  const candidates: number[] = [];
  for (let k = 0; k < n; k += 1) {
    if (at(k) >= threshold && (k === 0 || at(k) >= at(k - 1)) && (k === n - 1 || at(k) >= at(k + 1))) candidates.push(k);
  }
  const chosen: number[] = [];
  // Strongest first; equal peaks keep their order (a stable sort, as Python's)
  for (const k of [...candidates].sort((a, b) => at(b) - at(a))) if (chosen.every((other) => Math.abs(k - other) >= minGap)) chosen.push(k);
  const top = largest(curve);
  return chosen
    .sort((a, b) => a - b)
    .map((k): Accent => {
      const peak = k + 1;
      const near = cutFrames.filter((cut) => Math.abs(cut - peak) <= CUT_REACH).sort((a, b) => a - b);
      const jump = largest(lumaJump.slice(Math.max(0, k - 1), Math.min(n, k + 2)));
      const kind = accentKind(near, peak, Math.max(0, jump));
      // A flash run lands on its first changed frame, not on its largest difference
      const frame = kind === "flash" && near.length > 0 ? Math.min(peak, near[0] ?? peak) : peak;
      const strength = top <= middle ? 0 : clamp((at(k) - middle) / (top - middle), 0, 1);
      return { frame, motion: roundHalfEven(at(k), 2), strength: roundHalfEven(strength, 2), kind };
    });
}

/** Runs of STROBE_MIN or more flash accents whose first and last lie within `window` frames (speedfx.strobe_runs). */
export function strobeRuns(accents: readonly Accent[], window: number): StrobeRun[] {
  const flashes = accents.filter((accent) => accent.kind === "flash").map((accent) => accent.frame).sort((a, b) => a - b);
  const runs: StrobeRun[] = [];
  let start = 0;
  while (start < flashes.length) {
    let end = start;
    while (end + 1 < flashes.length && entry(flashes, end + 1) - entry(flashes, start) <= window) end += 1;
    if (end - start + 1 >= STROBE_MIN) {
      runs.push({ first: entry(flashes, start), last: entry(flashes, end), flashes: end - start + 1 });
      start = end + 1;
    } else start += 1;
  }
  return runs;
}

/** The original cuts EDIT_RHYTHM_MIN times or more within `window` frames inside the clip (speedfx.edit_rhythm). */
export function editRhythm(cutFrames: readonly number[], length: number, window: number): boolean {
  const inside = cutFrames.filter((cut) => cut > 0 && cut < length).sort((a, b) => a - b);
  return inside.some((cut, index) => index + EDIT_RHYTHM_MIN - 1 < inside.length && entry(inside, index + EDIT_RHYTHM_MIN - 1) - cut <= window);
}

/** The take's largest motion in entries f−3…f; null when none of them was measured. */
function takePeakAt(takeCurve: readonly number[], frame: number): number | null {
  const low = Math.max(0, frame - 3);
  const high = Math.min(takeCurve.length, frame + 1);
  return high > low ? largest(takeCurve.slice(low, high)) : null;
}

const runOf = (runs: readonly StrobeRun[], accent: Accent): number | null => {
  if (accent.kind !== "flash") return null;
  const index = runs.findIndex((run) => run.first <= accent.frame && accent.frame <= run.last);
  return index < 0 ? null : index;
};

interface Gated {
  decisions: AccentDecision[];
  kept: Accent[];
}

/** The v2 gate (speedfx.gate_v2) with the reason of every accent it lets go; decisions keep the accents' order. */
export function gateAccents(accents: readonly Accent[], takeCurve: readonly number[], length: number, runs: readonly StrobeRun[], strobeSpacing: number): Gated {
  const outcomes = new Map<Accent, Omit<AccentDecision, "accent">>();
  const kept: Accent[] = [];
  const skip = (accent: Accent, reason: SkipReason, takePeak: number | null = null, needsGeneration = false) => outcomes.set(accent, { kept: false, reason, takePeak, needsGeneration });
  for (const accent of [...accents].sort((a, b) => b.strength - a.strength)) {
    const { frame } = accent;
    const inside = frame > 0 && frame < length;
    if (accent.kind === "edit") {
      skip(accent, "edit");
      continue;
    }
    if (accent.kind === "twos") {
      const peak = inside ? takePeakAt(takeCurve, frame) : null;
      skip(accent, "twos", peak, peak !== null && peak < COVERED_SHARE * accent.motion);
      continue;
    }
    if (!inside) {
      skip(accent, "outside");
      continue;
    }
    const run = runOf(runs, accent);
    if (accent.strength < (run !== null ? STROBE_MIN_STRENGTH : MIN_STRENGTH)) {
      skip(accent, "weak");
      continue;
    }
    const takePeak = takePeakAt(takeCurve, frame);
    if (takePeak !== null && takePeak >= COVERED_SHARE * accent.motion) skip(accent, "covered", takePeak);
    else if (run !== null && kept.filter((other) => runOf(runs, other) === run).length >= STROBE_MAX_IMPACTS) skip(accent, "strobe_full", takePeak);
    else if (kept.every((other) => Math.abs(frame - other.frame) >= (run !== null && runOf(runs, other) === run ? strobeSpacing : ACCENT_SPACING))) {
      kept.push(accent);
      outcomes.set(accent, { kept: true, reason: null, takePeak, needsGeneration: false });
    } else skip(accent, "crowded", takePeak);
  }
  const decisions = accents.map((accent): AccentDecision => ({ accent, ...(outcomes.get(accent) ?? { kept: false, reason: "outside", takePeak: null, needsGeneration: false }) }));
  return { decisions, kept: kept.sort((a, b) => a.frame - b.frame) };
}

/** The gated_strobe recipe for the kept accents (in frame order): shake, and a negative impact frame on a flash; inside a strobe run only its first impact frame shakes. */
export function hitEffects(kept: readonly Accent[], runs: readonly StrobeRun[]): Hit[] {
  return kept.map((accent): Hit => {
    const run = accent.kind === "flash" ? runs.find((item) => item.first <= accent.frame && accent.frame <= item.last) : undefined;
    const firstInRun = run !== undefined && kept.every((other) => !(run.first <= other.frame && other.frame < accent.frame));
    const effects: AccentEffects = {};
    if (run === undefined || firstInRun) effects.camera = { shake_px: roundHalfEven(SHAKE_BASE_PX + SHAKE_STRENGTH_PX * accent.strength), shake_frames: SHAKE_FRAMES };
    if (accent.kind === "flash") effects.impact = { frames: 1, style: "negative" };
    return { accent, effects };
  });
}

/** The most flashes in any `window` frames of a luminance series (speedfx.max_flashes_per_second), one decimal. */
export function maxFlashesPerSecond(luma: readonly number[], window: number): number {
  const steps = luma.slice(1).map((value, index) => {
    const change = value - entry(luma, index);
    return Math.abs(change) >= PSE_LUMA_STEP ? Math.sign(change) : 0;
  });
  let best = 0;
  for (let start = 0; start < Math.max(1, steps.length - window + 1); start += 1) {
    const signs = steps.slice(start, start + window).filter((step) => step !== 0);
    const pairs = signs.slice(1).filter((step, index) => step !== signs[index]).length;
    best = Math.max(best, pairs > 0 ? (pairs + 1) / 2 : 0);
  }
  return roundHalfEven(best, 1);
}

export interface SpeedFeelFlags {
  /** The original cuts 3 times or more within a second inside the clip. */
  editRhythm: boolean;
  strobeRuns: StrobeRun[];
  /** Frames of on-twos action the take does not move at. */
  needsGeneration: number[];
}

/** The verdict of the whole clip (the order in the header). */
export function judgeSpeedFeel(take: MotionStats, original: MotionStats, decisions: readonly AccentDecision[], kept: readonly Accent[], flags: SpeedFeelFlags): SpeedFeelVerdict {
  if (original.p90 < ORIGINAL_MOVES_P90) return "quiet";
  if (take.p90 >= original.p90) return "moves_enough";
  if (kept.length > 0) return "add";
  if (flags.needsGeneration.length > 0) return "regenerate";
  if (decisions.some((decision) => decision.reason === "covered")) return "covered";
  if (flags.editRhythm) return "edits";
  if (take.p90 < STILL_TAKE_RATIO * original.p90) return "regenerate";
  return "no_accents";
}

export interface ClipFrames {
  /** Entry i is the change from frame i to frame i + 1. */
  motion: readonly number[];
  /** Mean luminance (0–255) of every frame. */
  luma: readonly number[];
}

export interface SpeedFeelInput {
  /** The take over the clip from its frame 0, with the mean luminance each frame would have as a negative impact frame. */
  take: ClipFrames & { impact: readonly number[] };
  /** The original over the same moments, starting `lead` frames earlier (frames outside the clip only serve the cut detection). */
  original: ClipFrames;
  lead: number;
  /** Frames of the clip. */
  length: number;
  /** The sequence's frame rate: a second of it bounds strobe runs, the edit rhythm and the flash count. */
  fps: number;
}

export interface FlashCheck {
  /** The most flashes in any second of the original over the clip, and of the planned picture. */
  original: number;
  planned: number;
}

export interface SpeedFeelAnalysis {
  verdict: SpeedFeelVerdict;
  take: MotionStats;
  original: MotionStats;
  /** Every accent of the original with what the gate made of it, in the order of their peaks. */
  decisions: AccentDecision[];
  /** The accents to apply with their effects, in frame order (empty unless the verdict is "add"). */
  hits: Hit[];
  flags: SpeedFeelFlags;
  flashes: FlashCheck;
  /** Curve entries both clips were measured on. */
  measured: number;
}

/** The analysis of one clip, or null when fewer than two entries could be measured. */
export function analyseSpeedFeel(input: SpeedFeelInput): SpeedFeelAnalysis | null {
  const { lead, length } = input;
  const measured = Math.min(input.take.motion.length, input.original.motion.length - lead);
  if (measured < 2 || lead < 0) return null;
  const second = Math.max(1, Math.round(input.fps));
  const takeCurve = input.take.motion.slice(0, measured);
  const originalCurve = input.original.motion.slice(lead, lead + measured);
  const originalLuma = input.original.luma.slice(lead, lead + measured + 1);
  const lumaJump = originalCurve.map((_, k) => Math.abs(entry(originalLuma, k + 1) - entry(originalLuma, k)));
  const cuts = sceneCuts(input.original.motion, -lead);
  const accents = findAccents(originalCurve, cuts, lumaJump);
  const runs = strobeRuns(accents, second);
  const gated = gateAccents(accents, takeCurve, length, runs, Math.ceil(second / FLASHES_PER_SECOND_LIMIT));
  const flags: SpeedFeelFlags = {
    editRhythm: editRhythm(cuts, length, second),
    strobeRuns: runs,
    needsGeneration: gated.decisions.filter((decision) => decision.needsGeneration).map((decision) => decision.accent.frame).sort((a, b) => a - b),
  };
  const takeStats = motionStats(takeCurve);
  const originalStats = motionStats(originalCurve);
  const verdict = judgeSpeedFeel(takeStats, originalStats, gated.decisions, gated.kept, flags);
  const hits = verdict === "add" ? hitEffects(gated.kept, runs) : [];
  // The planned picture: the take, with the negative impact frames where they go
  const impacts = new Set(hits.filter((hit) => hit.effects.impact).map((hit) => hit.accent.frame));
  const planned = input.take.luma.slice(0, length).map((value, frame) => (impacts.has(frame) ? entry(input.take.impact, frame) : value));
  const flashes = { original: maxFlashesPerSecond(input.original.luma.slice(lead, lead + length), second), planned: maxFlashesPerSecond(planned, second) };
  return { verdict, take: takeStats, original: originalStats, decisions: gated.decisions, hits, flags, flashes, measured };
}
