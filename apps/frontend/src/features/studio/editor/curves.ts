import type { TimelineKeyframe } from "@/api/generated/contracts";

export const DEFAULT_BEZIER = [0.25, 0.1, 0.25, 1];

/** Pure, monotone curves. The left key owns the segment and its preserved easing interval. */
export function easing(interpolation: TimelineKeyframe["interpolation"], progress: number, bezier?: number[]): number {
  const value = Math.max(0, Math.min(1, progress));
  switch (interpolation) {
    case "bezier": {
      const [x1 = 0.25, y1 = 0.1, x2 = 0.25, y2 = 1] = bezier ?? [];
      const cubic = (at: number, a: number, b: number) => 3 * (1 - at) ** 2 * at * a + 3 * (1 - at) * at ** 2 * b + at ** 3;
      if (value === 0 || value === 1) return value;
      let low = 0; let high = 1;
      for (let i = 0; i < 32; i += 1) { const mid = (low + high) / 2; if (cubic(mid, x1, x2) < value) low = mid; else high = mid; }
      return cubic((low + high) / 2, y1, y2);
    }
    case "hold": return value < 1 ? 0 : 1;
    case "ease_in": return value * value;
    case "ease_out": return value * (2 - value);
    case "ease_in_out": return value * value * (3 - 2 * value);
    default: return value;
  }
}

export function segmentProgress(key: TimelineKeyframe, progress: number): number {
  if (key.interpolation === "hold") return progress < 1 ? 0 : 1;
  const [start = 0, end = 1] = key.curve_range ?? [0, 1];
  const span = end - start;
  const value = Math.max(0, Math.min(1, progress));
  if (key.interpolation === "bezier") {
    const low = easing("bezier", start, key.bezier);
    const high = easing("bezier", end, key.bezier);
    if (value === 0 || value === 1) return value;
    return high <= low ? value : Math.max(0, Math.min(1, (easing("bezier", start + span * value, key.bezier) - low) / (high - low)));
  }
  if (key.interpolation === "ease_in") {
    const bend = span / (start + end);
    return value * (1 - bend + bend * value);
  }
  if (key.interpolation === "ease_out") {
    const bend = span / ((1 - start) + (1 - end));
    return value * (1 + bend - bend * value);
  }
  if (key.interpolation === "ease_in_out") {
    const first = start * (1 - start);
    const middle = (start * (1 - end) + end * (1 - start)) / 2;
    const last = end * (1 - end);
    const total = first + middle + last;
    const c1 = first / total;
    const c2 = (first + middle) / total;
    return value * (3 * c1 + value * (3 * c2 - 6 * c1 + value * (1 + 3 * c1 - 3 * c2)));
  }
  return value;
}

export function evaluateCurve(keys: readonly TimelineKeyframe[] | undefined, frame: number, fallback: number): number {
  if (!keys?.length) return fallback;
  const first = keys[0];
  if (!first || frame <= first.frame) return first?.value ?? fallback;
  for (let i = 1; i < keys.length; i += 1) {
    const left = keys[i - 1];
    const right = keys[i];
    if (left && right && frame < right.frame) return left.value + (right.value - left.value) * segmentProgress(left, (frame - left.frame) / (right.frame - left.frame));
  }
  return keys.at(-1)?.value ?? fallback;
}

/** Reparameterize an interval without restarting its easing at a cut. */
export function curveSlice(keys: readonly TimelineKeyframe[], from: number, to: number, fallback: number): TimelineKeyframe[] {
  if (!keys.length) return [];
  const times = [from, ...keys.filter((point) => point.frame > from && point.frame < to).map((point) => point.frame), to];
  return times.map((time, index) => {
    const left = keys.findLast((point) => point.frame <= time);
    const right = keys.find((point) => point.frame > time);
    const value = evaluateCurve(keys, time, fallback);
    if (!left || !right) return { frame: time - from, value, interpolation: "linear" };
    const next = times[index + 1] ?? time;
    const [a = 0, b = 1] = left.curve_range ?? [0, 1];
    const at = (position: number) => Math.max(0, Math.min(1, a + (b - a) * (position - left.frame) / (right.frame - left.frame)));
    const range = next > time ? { curve_range: [at(time), at(Math.min(next, right.frame))] } : {};
    return { frame: time - from, value, interpolation: left.interpolation, ...(left.bezier ? { bezier: [...left.bezier] } : {}), ...range };
  });
}

/** Insert without restarting either half of an existing curve; overwrite retains its metadata. */
export function upsertCurveKey(keys: readonly TimelineKeyframe[], frame: number, value: number): TimelineKeyframe[] {
  if (keys.some((key) => key.frame === frame)) return keys.map((key) => key.frame === frame ? { ...key, value } : key);
  const left = keys.findLast((key) => key.frame < frame);
  const right = keys.find((key) => key.frame > frame);
  const inserted: TimelineKeyframe = left ? { ...left, frame, value } : { frame, value, interpolation: "linear" };
  delete inserted.curve_range;
  let previous = left;
  if (left && right) {
    const [start = 0, end = 1] = left.curve_range ?? [0, 1];
    const split = start + (end - start) * (frame - left.frame) / (right.frame - left.frame);
    previous = { ...left, curve_range: [start, split] };
    inserted.curve_range = [split, end];
  }
  return [...keys.map((key) => key === left && previous ? previous : key), inserted].sort((a, b) => a.frame - b.frame);
}

/** Validate each scalar curve before recording a command; the wire schema remains authoritative. */
export function curveProblem(keys: readonly TimelineKeyframe[], duration: number, low: number, high: number): boolean {
  const bounded = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  return keys.length > 128 || keys.some((point, index) =>
    !Number.isSafeInteger(point.frame) || !bounded(point.frame, 0, duration) || !bounded(point.value, low, high) ||
    !["hold", "linear", "ease_in", "ease_out", "ease_in_out", "bezier"].includes(point.interpolation) ||
    (point.interpolation === "bezier" && point.bezier === undefined) ||
    (point.bezier !== undefined && (point.bezier.length !== 4 || point.bezier.some((value) => !bounded(value, 0, 1)))) ||
    (point.curve_range !== undefined && (point.curve_range.length !== 2 || !bounded(point.curve_range[0] ?? NaN, 0, 1) || !bounded(point.curve_range[1] ?? NaN, 0, 1) || (point.curve_range[0] ?? 1) >= (point.curve_range[1] ?? 0))) ||
    (index > 0 && point.frame <= (keys[index - 1]?.frame ?? 0)),
  );
}
