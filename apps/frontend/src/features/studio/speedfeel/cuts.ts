// Cuts of a take and of the original it was made from, and how they pair up (pure), by these rules:
// - frame: 64×36 RGB (0–255). Its features: a 16×9 grid of 4×4-pixel cells (each cell's mean R, G and B), a 48-bin
//   histogram of the pixels' luma (the mean of R, G and B as float32, bins of 256/48 from 0 to 256, as shares of the
//   pixels) and the frame's mean luma.
// - score of frame i (the change from frame i − 1): 0.5 · mean |grid difference| ÷ 64 + 0.5 · histogram L1 ÷ 2; frame 0
//   scores 0.
// - flash: for a width w of 1–3, the mean luma rising by more than 30 into frame i and falling by more than 30 after
//   frame i + w − 1 makes frames i…i + w flash frames: a white flash is an effect, never a cut.
// - cut: not a flash frame, a score of at least CUT_THRESHOLD, a local maximum (at least the previous and the next score)
//   and at least 2.5 × max(the median of the 6 scores before it and the 6 after it (frame 0's left out), 0.01). No
//   minimum shot length: the local-maximum rule already keeps two cuts apart.
// - pairs: the two cut lists in order, by dynamic programming: a match costs its |offset| and is allowed up to 24
//   frames, a cut left unmatched on either side costs 8; equal costs keep the first path found (the prototype's strict
//   comparisons).
// - timing: the offsets (take − original) of the matched cuts; a cut is on time within ±3 frames.
// - anchors: (0, 0) and the matched pairs, each kept only when the take moves on from the previous kept anchor and the
//   stretch between them (take frames ÷ original frames) lies within [1/1.5, 1.5]; the others are usually a take flash
//   taken for a cut and paired with a real cut of the original.
// - early switch at the clip's end: a take cut in the clip's last 24 frames that pairs with nothing while the original
//   shows no cut from there to the end is the take cutting to the next shot early (the original's cut is the segment
//   boundary, just past the clip); the conform anchors it on the clip's end.
// - motion: the mean absolute difference of two frames' per-pixel luma; the conform drops or repeats the stillest frames.
// No imports at run time: the module is the measurement and stays checkable on its own.

export const CUT_FRAME_WIDTH = 64;
export const CUT_FRAME_HEIGHT = 36;
const CELL = 4;
const GRID_VALUES = (CUT_FRAME_WIDTH / CELL) * (CUT_FRAME_HEIGHT / CELL) * 3;
const PIXELS = CUT_FRAME_WIDTH * CUT_FRAME_HEIGHT;
const BINS = 48;
/** Score a cut needs at least (0.22 found the cuts of fast-cut stretches slightly better; 0.18 is the measured default). */
export const CUT_THRESHOLD = 0.18;
const FLASH_STEP = 30;
const FLASH_WIDTHS = [1, 2, 3] as const;
const MEDIAN_REACH = 6;
const MEDIAN_FACTOR = 2.5;
const MEDIAN_FLOOR = 0.01;
/** Frames a take's cut may lie from the original's and still pair with it. */
export const MAX_CUT_SHIFT = 24;
const UNMATCHED_COST = 8;
/** A matched cut within this many frames of the original's is on time. */
export const ON_TIME_FRAMES = 3;
/** The take may run at most this much faster or slower than the original between two anchors. */
export const MAX_STRETCH = 1.5;

export interface CutFeatures {
  /** Mean R, G and B of the 16×9 cells, row by row. */
  grid: Float32Array;
  /** Share of the pixels in each of the 48 luma bins. */
  hist: Float64Array;
  /** Mean luma (0–255). */
  luma: number;
}

/** A cut of the original and the take's cut paired with it; null on the side that has none. */
export interface CutPair {
  original: number | null;
  take: number | null;
}

export interface CutTiming {
  originalCuts: number;
  takeCuts: number;
  matched: number;
  /** Matched cuts within ±ON_TIME_FRAMES. */
  onTime: number;
  /** take − original of every matched cut, in order. */
  offsets: number[];
  /** Cuts of the original the take has no cut for, and cuts of the take the original has none for. */
  missing: number;
  extra: number;
}

/** A cut of the original (clip frames) and the take's frame that should land on it. */
export interface CutAnchor {
  original: number;
  take: number;
}

const at = (values: ArrayLike<number>, index: number) => values[index] ?? 0;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? at(sorted, middle) : (at(sorted, middle - 1) + at(sorted, middle)) / 2;
}

/** Bin of a pixel by the sum of its R, G and B: NumPy's float32 luma placed against its float64 bin edges. */
const BIN_OF_SUM = (() => {
  const step = 256 / BINS;
  const bins = new Uint8Array(3 * 255 + 1);
  for (let sum = 0; sum < bins.length; sum += 1) {
    const luma = Math.fround(sum / 3);
    let bin = Math.min(BINS - 1, Math.floor(luma / step));
    while (bin > 0 && luma < bin * step) bin -= 1;
    while (bin < BINS - 1 && luma >= (bin + 1) * step) bin += 1;
    bins[sum] = bin;
  }
  return bins;
})();

/** The features of one 64×36 RGB frame (3 values a pixel, row by row). */
export function cutFeatures(rgb: ArrayLike<number>): CutFeatures {
  const columns = CUT_FRAME_WIDTH / CELL;
  const grid = new Float32Array(GRID_VALUES);
  const counts = new Float64Array(BINS);
  let lumaSum = 0;
  for (let y = 0; y < CUT_FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < CUT_FRAME_WIDTH; x += 1) {
      const pixel = (y * CUT_FRAME_WIDTH + x) * 3;
      const cell = (Math.floor(y / CELL) * columns + Math.floor(x / CELL)) * 3;
      const r = at(rgb, pixel);
      const g = at(rgb, pixel + 1);
      const b = at(rgb, pixel + 2);
      grid[cell] = at(grid, cell) + r;
      grid[cell + 1] = at(grid, cell + 1) + g;
      grid[cell + 2] = at(grid, cell + 2) + b;
      const bin = BIN_OF_SUM[Math.min(BIN_OF_SUM.length - 1, Math.max(0, Math.round(r + g + b)))] ?? BINS - 1;
      counts[bin] = at(counts, bin) + 1;
      lumaSum += Math.fround((r + g + b) / 3);
    }
  }
  for (let index = 0; index < GRID_VALUES; index += 1) grid[index] = at(grid, index) / (CELL * CELL);
  for (let index = 0; index < BINS; index += 1) counts[index] = at(counts, index) / PIXELS;
  return { grid, hist: counts, luma: lumaSum / PIXELS };
}

/** The per-pixel luma of a 64×36 RGB frame (float32, as the prototype's motion measures it). */
export function cutGray(rgb: ArrayLike<number>): Float32Array {
  const gray = new Float32Array(PIXELS);
  for (let index = 0; index < PIXELS; index += 1) gray[index] = (at(rgb, index * 3) + at(rgb, index * 3 + 1) + at(rgb, index * 3 + 2)) / 3;
  return gray;
}

/** Motion between two frames: the mean absolute difference of their per-pixel luma. */
export function grayDifference(before: ArrayLike<number>, after: ArrayLike<number>): number {
  const count = Math.min(before.length, after.length);
  let sum = 0;
  for (let index = 0; index < count; index += 1) sum += Math.abs(at(after, index) - at(before, index));
  return count > 0 ? sum / count : 0;
}

/** The score of the change from one frame to the next. */
export function cutScore(before: CutFeatures, after: CutFeatures): number {
  let grid = 0;
  for (let index = 0; index < GRID_VALUES; index += 1) grid += Math.abs(at(after.grid, index) - at(before.grid, index));
  let hist = 0;
  for (let index = 0; index < BINS; index += 1) hist += Math.abs(at(after.hist, index) - at(before.hist, index));
  return (0.5 * (grid / GRID_VALUES)) / 64 + (0.5 * hist) / 2;
}

/** The score of every frame of a sequence (frame 0 scores 0). */
export function cutScores(frames: readonly CutFeatures[]): number[] {
  return frames.map((frame, index) => {
    const previous = frames[index - 1];
    return previous ? cutScore(previous, frame) : 0;
  });
}

/** The frames of white flashes: a rise of the mean luma by more than 30 and a fall by more than 30 within 1–3 frames. */
export function flashFrames(luma: readonly number[]): Set<number> {
  const n = luma.length;
  const flashes = new Set<number>();
  for (let i = 1; i < n - 1; i += 1) {
    for (const width of FLASH_WIDTHS) {
      const j = i + width;
      if (j < n && at(luma, i) - at(luma, i - 1) > FLASH_STEP && at(luma, j - 1) - at(luma, j) > FLASH_STEP) {
        for (let frame = i; frame <= j; frame += 1) flashes.add(frame);
      }
    }
  }
  return flashes;
}

/** The cut frames of a sequence (each the first frame of a new picture), from its scores and its frames' mean luma. */
export function detectCuts(scores: readonly number[], luma: readonly number[], threshold = CUT_THRESHOLD): number[] {
  const n = scores.length;
  const flashes = flashFrames(luma);
  const cuts: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const score = at(scores, i);
    if (flashes.has(i) || score < threshold) continue;
    if (score < at(scores, i - 1) || (i + 1 < n && score < at(scores, i + 1))) continue;
    const around = [...scores.slice(Math.max(1, i - MEDIAN_REACH), i), ...scores.slice(i + 1, i + 1 + MEDIAN_REACH)];
    if (around.length > 0 && score < MEDIAN_FACTOR * Math.max(median(around), MEDIAN_FLOOR)) continue;
    cuts.push(i);
  }
  return cuts;
}

/** The cuts of a sequence of frames. */
export function sequenceCuts(frames: readonly CutFeatures[], threshold = CUT_THRESHOLD): number[] {
  return detectCuts(
    cutScores(frames),
    frames.map((frame) => frame.luma),
    threshold,
  );
}

/** The two cut lists paired in order (dynamic programming; see the header). */
export function alignCuts(original: readonly number[], take: readonly number[], maxShift = MAX_CUT_SHIFT, gap = UNMATCHED_COST): CutPair[] {
  const n = original.length;
  const m = take.length;
  const width = m + 1;
  const cell = (i: number, j: number) => i * width + j;
  const cost = new Float64Array((n + 1) * width).fill(Number.POSITIVE_INFINITY);
  const back = new Int32Array((n + 1) * width).fill(-1);
  cost[0] = 0;
  const relax = (from: number, to: number, value: number) => {
    if (value < at(cost, to)) {
      cost[to] = value;
      back[to] = from;
    }
  };
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      const here = cell(i, j);
      const value = at(cost, here);
      if (value === Number.POSITIVE_INFINITY) continue;
      if (i < n) relax(here, cell(i + 1, j), value + gap);
      if (j < m) relax(here, cell(i, j + 1), value + gap);
      const shift = Math.abs(at(take, j) - at(original, i));
      if (i < n && j < m && shift <= maxShift) relax(here, cell(i + 1, j + 1), value + shift);
    }
  }
  const pairs: CutPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const from = at(back, cell(i, j));
    if (from < 0) break;
    const pi = Math.floor(from / width);
    const pj = from % width;
    if (pi === i - 1 && pj === j - 1) pairs.push({ original: at(original, i - 1), take: at(take, j - 1) });
    else if (pi === i - 1) pairs.push({ original: at(original, i - 1), take: null });
    else pairs.push({ original: null, take: at(take, j - 1) });
    i = pi;
    j = pj;
  }
  return pairs.reverse();
}

/** How the take's cuts land against the original's. */
export function cutTiming(pairs: readonly CutPair[], tolerance = ON_TIME_FRAMES): CutTiming {
  const offsets = pairs.flatMap((pair) => (pair.original !== null && pair.take !== null ? [pair.take - pair.original] : []));
  return {
    originalCuts: pairs.filter((pair) => pair.original !== null).length,
    takeCuts: pairs.filter((pair) => pair.take !== null).length,
    matched: offsets.length,
    onTime: offsets.filter((offset) => Math.abs(offset) <= tolerance).length,
    offsets,
    missing: pairs.filter((pair) => pair.original !== null && pair.take === null).length,
    extra: pairs.filter((pair) => pair.original === null && pair.take !== null).length,
  };
}

/** Whether the take may go from one anchor to the next: it moves on, by 1/1.5 to 1.5 times the original's frames. */
export function stretchFits(from: CutAnchor, to: CutAnchor): boolean {
  const take = to.take - from.take;
  const original = to.original - from.original;
  return take > 0 && original > 0 && 2 * original <= 3 * take && 2 * take <= 3 * original;
}

export interface ConformAnalysis {
  /** Frames of the clip (both sequences are counted in its frames from 0). */
  length: number;
  originalCuts: number[];
  /** The take's cuts inside the clip (detected with the frames read after its end; a cut there can never move). */
  takeCuts: number[];
  pairs: CutPair[];
  timing: CutTiming;
  /** The take's motion: entry i is the change from its frame i to frame i + 1. */
  takeMotion: number[];
  /** The take's motion over two frames: entry i is the change from its frame i to frame i + 2 (empty when not measured). */
  takeMotion2: number[];
  /** The take's features, kept to measure the cuts of the retimed picture. */
  takeFeatures: CutFeatures[];
  /** The original's motion over the clip, as the take's (empty when not measured): the motion retime and shift compare the two. */
  originalMotion: number[];
}

export interface CutInput {
  /** The take from the clip's frame 0, and the frames read after the clip's end (motion2: over two frames). */
  take: { features: CutFeatures[]; motion: number[]; motion2?: number[] };
  /** The original over the clip's moments. */
  original: CutFeatures[];
  /** The original's motion over them (entry i: frame i to frame i + 1). */
  originalMotion?: number[];
  length: number;
}

/** The cuts of both clips and their pairs; null when too few frames were read. */
export function analyseCuts(input: CutInput): ConformAnalysis | null {
  if (input.original.length < 2 || input.take.features.length < 2 || input.length < 2) return null;
  const originalCuts = sequenceCuts(input.original);
  // Only cuts the clip shows can move: a take cut at or after the clip's end is never an anchor (the planner leaves it
  // out), so it must not win a pairing over a usable cut inside the clip (segment 6: the original's cut on the clip's
  // last frames paired with a take cut 3 frames past the end instead of the visible one 5 frames early)
  const takeCuts = sequenceCuts(input.take.features).filter((frame) => frame < input.length);
  const pairs = alignCuts(originalCuts, takeCuts);
  return {
    length: input.length,
    originalCuts,
    takeCuts,
    pairs,
    timing: cutTiming(pairs),
    takeMotion: input.take.motion,
    takeMotion2: input.take.motion2 ?? [],
    takeFeatures: input.take.features,
    originalMotion: input.originalMotion ?? [],
  };
}

/**
 * The take's early switch at the clip's end: its first cut in the clip's last MAX_CUT_SHIFT frames that pairs with no
 * cut of the original and comes after every cut of the original and every matched cut (segment 9 of the swap film cut to
 * the next segment's shot at clip frame 80 of 86). Null when the take has none.
 */
export function endSwitchCut(analysis: Pick<ConformAnalysis, "length" | "originalCuts" | "pairs">): number | null {
  const { length, originalCuts, pairs } = analysis;
  const last = (frame: number) => originalCuts.every((cut) => cut < frame) && pairs.every((pair) => pair.original === null || pair.take === null || pair.take < frame);
  let found: number | null = null;
  for (const { original, take } of pairs) {
    if (original !== null || take === null || take >= length || take < length - MAX_CUT_SHIFT || !last(take)) continue;
    if (found === null || take < found) found = take;
  }
  return found;
}

/** How the take's cuts land against the original's as `mapping` plays it (entry k: the take frame shown on clip frame k). */
export function retimedTiming(analysis: ConformAnalysis, mapping: readonly number[]): CutTiming {
  const last = analysis.takeFeatures.length - 1;
  const frames = mapping.flatMap((frame) => {
    const features = analysis.takeFeatures[Math.min(Math.max(0, frame), last)];
    return features ? [features] : [];
  });
  return cutTiming(alignCuts(analysis.originalCuts, sequenceCuts(frames)));
}
