// Segment check against the original (pure): how closely a finished swap segment follows the original clip, measured on
// grayscale frames of 96×54 (frameSampler reads them in the browser). It mirrors an ffmpeg measurement
// (fps=24, scale=96:54, format=gray, gblur=sigma=1.2: blurFrame is that filter), so the thresholds calibrated there apply:
// - layout: the SSIM of each pair (take frame k against the original at window start + k/fps), computed the way
//   ffmpeg's ssim filter does (x264's 8×8 windows on a 4-pixel grid, the same constants) after the blur. A segment that
//   followed the original scored about 0.60 (0.64 in its first second); drifting ones 0.12–0.30.
// - motion: the mean absolute difference between consecutive samples of each clip (its "speed"); the ratio take ÷
//   original, leaving out the samples where either clip cuts (a cut is not motion). A too-slow take measured 0.49.
// - cuts: a sample whose difference to the previous sample is at least CUT_MEDIAN_FACTOR × the clip's median
//   difference and at least CUT_MIN_DIFF (0–255) starts a new shot; a run of such samples (a fast dissolve) is one cut,
//   placed at its largest jump.
// Verdict (layout first, then speed): mean SSIM < LAYOUT_OFF → layout_off; a speed ratio outside MOTION_RANGE →
// motion_off; mean SSIM ≥ LAYOUT_FOLLOWS → follows; otherwise partly. No speed ratio (the original barely moves) never
// fails a segment.

export const FRAME_WIDTH = 96;
export const FRAME_HEIGHT = 54;
/** gblur's sigma in the reference measurement. */
export const BLUR_SIGMA = 1.2;
/** Mean SSIM from which a segment follows the original. */
export const LAYOUT_FOLLOWS = 0.45;
/** Mean SSIM below which the composition is off. */
export const LAYOUT_OFF = 0.3;
/** Speed ratio (take ÷ original) that still counts as the original's speed. */
export const MOTION_RANGE = { min: 0.6, max: 1.7 } as const;
/** Mean difference (0–255) under which the original barely moves: no speed ratio then. */
export const STILL_MOTION = 0.5;
export const CUT_MIN_DIFF = 20;
export const CUT_MEDIAN_FACTOR = 3;

/** One grayscale frame, row by row (FRAME_WIDTH × FRAME_HEIGHT values on the 0–255 scale). */
export type FrameData = ArrayLike<number>;

export type Verdict = "follows" | "layout_off" | "motion_off" | "partly";

export interface SegmentComparison {
  /** Mean SSIM over the samples. */
  layout: number;
  /** Mean SSIM of each second of the kept range (second n = offsets n·fps … (n+1)·fps − 1). */
  layoutPerSecond: number[];
  /** SSIM of every sample (in sample order). */
  layoutPerFrame: number[];
  /** Mean motion of the take ÷ the original's; null when the original barely moves or too few samples remain. */
  motionRatio: number | null;
  /** Frame offsets (from the first kept frame) of the first sample after each cut. */
  cutsOriginal: number[];
  cutsTake: number[];
  verdict: Verdict;
}

// ffmpeg's gblur (steps=1, the default): per axis a causal and an anticausal first-order recursive pass with the border
// treated as continuing (its variance is σ², but it is far more peaked than a sampled Gaussian), then the gain is
// normalized and the result is stored as 8-bit like a gray frame.
const LAMBDA = (BLUR_SIGMA * BLUR_SIGMA) / 2;
const NU = (1 + 2 * LAMBDA - Math.sqrt(1 + 4 * LAMBDA)) / (2 * LAMBDA);
const BORDER = 1 / (1 - NU);
/** (ν/λ) per axis: brings the gain of both passes back to 1. */
const POSTSCALE = (NU / LAMBDA) ** 2;

function smoothLine(values: Float32Array, start: number, count: number, stride: number): void {
  const at = (index: number) => start + index * stride;
  values[at(0)] = (values[at(0)] ?? 0) * BORDER;
  for (let index = 1; index < count; index += 1) values[at(index)] = (values[at(index)] ?? 0) + NU * (values[at(index - 1)] ?? 0);
  values[at(count - 1)] = (values[at(count - 1)] ?? 0) * BORDER;
  for (let index = count - 1; index > 0; index -= 1) values[at(index - 1)] = (values[at(index - 1)] ?? 0) + NU * (values[at(index)] ?? 0);
}

/** The blur of ffmpeg's `gblur=sigma=1.2` on an 8-bit gray frame (rows, then columns, then the gain), rounded to 8 bits. */
export function blurFrame(frame: FrameData, width = FRAME_WIDTH, height = FRAME_HEIGHT): Float32Array {
  const out = new Float32Array(width * height);
  for (let index = 0; index < out.length; index += 1) out[index] = Math.round(frame[index] ?? 0);
  for (let y = 0; y < height; y += 1) smoothLine(out, y * width, width, 1);
  for (let x = 0; x < width; x += 1) smoothLine(out, x, height, width);
  for (let index = 0; index < out.length; index += 1) out[index] = Math.round(Math.min(255, Math.max(0, (out[index] ?? 0) * POSTSCALE)));
  return out;
}

// ffmpeg's (x264's) constants for sums over 64 pixels: (int)(.01²·255²·64 + .5) and (int)(.03²·255²·64·63 + .5)
const SSIM_C1 = 416;
const SSIM_C2 = 235963;

function windowSsim(s1: number, s2: number, ss: number, s12: number): number {
  const variances = ss * 64 - s1 * s1 - s2 * s2;
  const covariance = s12 * 64 - s1 * s2;
  return ((2 * s1 * s2 + SSIM_C1) * (2 * covariance + SSIM_C2)) / ((s1 * s1 + s2 * s2 + SSIM_C1) * (variances + SSIM_C2));
}

/** SSIM of two frames like ffmpeg's ssim filter: 4×4 block sums, every 8×8 window of 2×2 blocks, averaged. */
export function frameSsim(a: FrameData, b: FrameData, width = FRAME_WIDTH, height = FRAME_HEIGHT): number {
  const columns = Math.floor(width / 4);
  const rows = Math.floor(height / 4);
  if (columns < 2 || rows < 2) return Number.NaN;
  // per block: Σa, Σb, Σ(a² + b²), Σab
  const sums = new Float64Array(columns * rows * 4);
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < columns; bx += 1) {
      let s1 = 0;
      let s2 = 0;
      let ss = 0;
      let s12 = 0;
      for (let y = 0; y < 4; y += 1) {
        for (let x = 0; x < 4; x += 1) {
          const index = (by * 4 + y) * width + bx * 4 + x;
          const p = a[index] ?? 0;
          const q = b[index] ?? 0;
          s1 += p;
          s2 += q;
          ss += p * p + q * q;
          s12 += p * q;
        }
      }
      sums.set([s1, s2, ss, s12], (by * columns + bx) * 4);
    }
  }
  const windowSum = (by: number, bx: number, part: number) =>
    (sums[(by * columns + bx) * 4 + part] ?? 0) + (sums[(by * columns + bx + 1) * 4 + part] ?? 0) + (sums[((by + 1) * columns + bx) * 4 + part] ?? 0) + (sums[((by + 1) * columns + bx + 1) * 4 + part] ?? 0);
  let total = 0;
  for (let by = 0; by + 1 < rows; by += 1) {
    for (let bx = 0; bx + 1 < columns; bx += 1) total += windowSsim(windowSum(by, bx, 0), windowSum(by, bx, 1), windowSum(by, bx, 2), windowSum(by, bx, 3));
  }
  return total / ((rows - 1) * (columns - 1));
}

/** Mean absolute difference between each sample and the one before it (entry i = samples i and i + 1). */
export function motionCurve(frames: readonly FrameData[]): number[] {
  const curve: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const before = frames[index - 1];
    const after = frames[index];
    if (before === undefined || after === undefined) break;
    const count = Math.min(before.length, after.length);
    let sum = 0;
    for (let p = 0; p < count; p += 1) sum += Math.abs((before[p] ?? 0) - (after[p] ?? 0));
    curve.push(count > 0 ? sum / count : 0);
  }
  return curve;
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The motion-curve entries that are cuts (the rule above); each run of jumps counts once, at its largest. */
export function cutEntries(curve: readonly number[]): number[] {
  if (curve.length === 0) return [];
  const threshold = Math.max(CUT_MIN_DIFF, CUT_MEDIAN_FACTOR * median(curve));
  const cuts: number[] = [];
  let peak = -1;
  curve.forEach((value, index) => {
    if (value >= threshold) {
      if (peak < 0 || value > (curve[peak] ?? 0)) peak = index;
    } else if (peak >= 0) {
      cuts.push(peak);
      peak = -1;
    }
  });
  if (peak >= 0) cuts.push(peak);
  return cuts;
}

export function judge(layout: number, motionRatio: number | null): Verdict {
  if (layout < LAYOUT_OFF) return "layout_off";
  if (motionRatio !== null && (motionRatio < MOTION_RANGE.min || motionRatio > MOTION_RANGE.max)) return "motion_off";
  return layout >= LAYOUT_FOLLOWS ? "follows" : "partly";
}

export interface CompareInput {
  /** Unblurred grayscale samples of the original and of the take, in the same order. */
  original: readonly FrameData[];
  take: readonly FrameData[];
  /** Frame offset of each sample from the first kept frame (the same for both clips). */
  offsets: readonly number[];
  fps: number;
  width?: number;
  height?: number;
}

/** The comparison of two equally sampled clips; null with fewer than two samples or no frame rate. */
export function compareFrames(input: CompareInput): SegmentComparison | null {
  const { fps, width = FRAME_WIDTH, height = FRAME_HEIGHT } = input;
  const count = Math.min(input.original.length, input.take.length, input.offsets.length);
  if (count < 2 || !(fps > 0)) return null;
  const original = input.original.slice(0, count).map((frame) => blurFrame(frame, width, height));
  const take = input.take.slice(0, count).map((frame) => blurFrame(frame, width, height));
  const layoutPerFrame = original.map((frame, index) => frameSsim(frame, take[index] ?? frame, width, height));
  const seconds: number[][] = [];
  layoutPerFrame.forEach((value, index) => {
    const second = Math.floor((input.offsets[index] ?? 0) / fps);
    (seconds[second] ??= []).push(value);
  });
  const layoutPerSecond = Array.from({ length: seconds.length }, (_, second) => mean(seconds[second] ?? []));
  const curveOriginal = motionCurve(original);
  const curveTake = motionCurve(take);
  const cutsOriginal = cutEntries(curveOriginal);
  const cutsTake = cutEntries(curveTake);
  const skip = new Set([...cutsOriginal, ...cutsTake]);
  const kept = curveOriginal.flatMap((_, index) => (skip.has(index) ? [] : [index]));
  const moveOriginal = mean(kept.map((index) => curveOriginal[index] ?? 0));
  const moveTake = mean(kept.map((index) => curveTake[index] ?? 0));
  const motionRatio = kept.length >= 2 && moveOriginal >= STILL_MOTION ? moveTake / moveOriginal : null;
  const layout = mean(layoutPerFrame);
  const atSample = (entries: readonly number[]) => entries.map((entry) => input.offsets[entry + 1] ?? 0);
  return {
    layout,
    layoutPerSecond,
    layoutPerFrame,
    motionRatio,
    cutsOriginal: atSample(cutsOriginal),
    cutsTake: atSample(cutsTake),
    verdict: judge(layout, motionRatio),
  };
}
