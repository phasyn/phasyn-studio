// How many segments of a one-click swap one render sends: a few at a time, so every segment can be checked against the
// original as soon as it is done and a drifting one fixed before the next batch (a review-as-you-go
// workflow), or as many as one run holds. Remembered per browser; the run's step limit always applies on top.
import { createPersistentStore } from "@/lib/persistentStore";
import { t } from "@/i18n";

/** The choices offered; null = as many as one run holds. */
export const BATCH_SIZES = [1, 2, 3, 5, 10, null] as const;
export type BatchSize = (typeof BATCH_SIZES)[number];

/** Segments per batch (per browser; 3 unless changed). */
export const swapBatchSize = createPersistentStore<BatchSize>({
  key: "phasyn.studio.swap.batch-size",
  initial: 3,
  parse: (raw) => (BATCH_SIZES as readonly unknown[]).includes(raw) ? (raw as BatchSize) : 3,
});

export function batchSizeLabel(size: BatchSize): string {
  return size === null ? t("一個 run 放得下的全部") : t("{count} 段", { count: size });
}

/** The segments the next render sends: in order, at most `size` and at most `perRun` (null = no limit). */
export function nextBatch(remaining: readonly string[], perRun: number | null, size: BatchSize = null): string[] {
  const limits = [perRun, size].filter((value): value is number => value !== null && value > 0);
  return limits.length > 0 ? remaining.slice(0, Math.min(...limits)) : [...remaining];
}

/** How many renders a plan of `segments` takes with this batch size and run limit. */
export function batchCount(segments: number, perRun: number | null, size: BatchSize): number {
  const limits = [perRun, size].filter((value): value is number => value !== null && value > 0);
  const per = limits.length > 0 ? Math.min(...limits) : segments;
  return per > 0 ? Math.ceil(segments / per) : 0;
}
