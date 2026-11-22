// The swap panel's segment checks, one at a time: each reads the take and then the original (one video at a time,
// frameSampler), measures them (compare.ts) and keeps the result by target key (the take, the original's window and
// the kept range) while the page lives, so a closed and reopened panel still shows it. An automatic check (a take that
// just finished) keeps only the newest one waiting; leaving the panel cancels what is waiting and running.
import { useEffect, useSyncExternalStore } from "react";
import { compareFrames, type SegmentComparison } from "./compare";
import { samplePlan, type CompareTargetReady } from "./compareTarget";
import { FrameReadError, readVideo, type VideoReader } from "./frameSampler";
import { snapshotStore } from "./snapshotStore";
import { t } from "@/i18n";

/** Width the filmstrip pictures are read at (shown smaller, so they stay sharp on a 2× screen). */
const STRIP_WIDTH = 160;
/** Checks remembered (each holds a few dozen small JPEGs). */
const RESULT_LIMIT = 80;

export interface StripFrame {
  /** Seconds from the first kept frame. */
  offset: number;
  original: string | null;
  take: string | null;
  /** SSIM of this pair; null when the frame was not among the measured samples. */
  layout: number | null;
}

export interface ComparisonResult {
  metrics: SegmentComparison;
  strip: StripFrame[];
  /** Seconds between two filmstrip pictures. */
  stripEvery: number;
  /** Frames between two measured samples, and how many were measured. */
  step: number;
  samples: number;
  fps: number;
  first: number;
  end: number;
  refStart: number;
  clips: number;
}

export type CompareStatus =
  | { status: "queued" }
  | { status: "running"; clip: "take" | "original"; done: number; total: number }
  | { status: "done"; result: ComparisonResult }
  | { status: "failed"; reason: string };

interface Job {
  target: CompareTargetReady;
  auto: boolean;
}

const store = snapshotStore<CompareStatus>(RESULT_LIMIT);
let queue: Job[] = [];
let running: { key: string; controller: AbortController } | null = null;

interface ClipFrames {
  luma: Float32Array[];
  pictures: Map<number, string>;
}

async function readClip(reader: VideoReader, frames: readonly number[], timeOf: (frame: number) => number, wanted: { metric: ReadonlySet<number>; strip: ReadonlySet<number>; slack: number }, onProgress: (done: number, total: number) => void): Promise<ClipFrames> {
  const last = timeOf(frames.at(-1) ?? 0);
  if (last > reader.duration + wanted.slack) throw new FrameReadError(t("影片只有 {duration} 秒，比對要讀到第 {needed} 秒", { duration: reader.duration.toFixed(2), needed: last.toFixed(2) }));
  const luma: Float32Array[] = [];
  const pictures = new Map<number, string>();
  for (const [index, frame] of frames.entries()) {
    await reader.seek(timeOf(frame));
    if (wanted.metric.has(frame)) luma.push(reader.luma());
    if (wanted.strip.has(frame)) pictures.set(frame, reader.thumbnail(STRIP_WIDTH));
    if (index % 4 === 3 || index === frames.length - 1) onProgress(index + 1, frames.length);
  }
  return { luma, pictures };
}

/** One check; null when it was cancelled. Take frame k is read at (k + 0.5)/fps, the original at refStart + that. */
async function runComparison(target: CompareTargetReady, signal: AbortSignal, progress: (clip: "take" | "original", done: number, total: number) => void): Promise<CompareStatus | null> {
  const plan = samplePlan(target.first, target.end, target.fps);
  const frames = [...new Set([...plan.metric, ...plan.strip])].sort((a, b) => a - b);
  const wanted = { metric: new Set(plan.metric), strip: new Set(plan.strip), slack: 0.5 / target.fps };
  const takeTime = (frame: number) => (frame + 0.5) / target.fps;
  const take = await readVideo(target.takeUrl, signal, (reader) => readClip(reader, frames, takeTime, wanted, (done, total) => { progress("take", done, total); }));
  if (!take.ok) return take.aborted ? null : { status: "failed", reason: t("讀取生成的影片失敗：{reason}", { reason: take.reason }) };
  const original = await readVideo(target.originalUrl, signal, (reader) => readClip(reader, frames, (frame) => target.refStart + takeTime(frame), wanted, (done, total) => { progress("original", done, total); }));
  if (!original.ok) return original.aborted ? null : { status: "failed", reason: t("讀取原片失敗：{reason}", { reason: original.reason }) };
  const metrics = compareFrames({ original: original.value.luma, take: take.value.luma, offsets: plan.metric.map((frame) => frame - target.first), fps: target.fps });
  if (!metrics) return { status: "failed", reason: t("讀到的影格不夠，無法比對") };
  const sampleIndex = new Map(plan.metric.map((frame, index) => [frame, index]));
  const strip = plan.strip.map((frame) => ({
    offset: (frame - target.first) / target.fps,
    original: original.value.pictures.get(frame) ?? null,
    take: take.value.pictures.get(frame) ?? null,
    layout: metrics.layoutPerFrame[sampleIndex.get(frame) ?? -1] ?? null,
  }));
  return {
    status: "done",
    result: { metrics, strip, stripEvery: plan.stripEvery, step: plan.step, samples: plan.metric.length, fps: target.fps, first: target.first, end: target.end, refStart: target.refStart, clips: target.clips },
  };
}

async function pump(): Promise<void> {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  const { key } = job.target;
  const controller = new AbortController();
  running = { key, controller };
  try {
    const outcome = await runComparison(job.target, controller.signal, (clip, done, total) => {
      if (!controller.signal.aborted) store.set(key, { status: "running", clip, done, total });
    });
    if (outcome) store.set(key, outcome);
    // cancelled: forget it, unless it was asked for again meanwhile
    else if (queue.some((item) => item.target.key === key)) store.set(key, { status: "queued" });
    else store.delete(key);
  } catch (error) {
    store.set(key, { status: "failed", reason: t("比對失敗：{error}", { error: error instanceof Error ? error.message : String(error) }) });
  } finally {
    running = null;
  }
  void pump();
}

/** Asks for a check (not again while one is waiting or running, nor when a result exists unless `force`). */
export function requestComparison(target: CompareTargetReady, options: { auto?: boolean; force?: boolean } = {}): void {
  const { key } = target;
  if ((running?.key === key && !running.controller.signal.aborted) || queue.some((job) => job.target.key === key)) return;
  if (store.get(key)?.status === "done" && !(options.force === true)) return;
  if (options.auto === true) {
    // Only the newest automatic check waits
    for (const job of queue) if (job.auto) store.delete(job.target.key);
    queue = queue.filter((job) => !job.auto);
  }
  queue.push({ target, auto: options.auto === true });
  store.set(key, { status: "queued" });
  void pump();
}

/** Drops what is waiting and stops what is running (finished results stay). */
export function cancelComparisons(): void {
  for (const job of queue) store.delete(job.target.key);
  queue = [];
  running?.controller.abort();
}

/** The checks by target key; unmounting the caller cancels what is waiting and running. */
export function useComparisons(): ReadonlyMap<string, CompareStatus> {
  useEffect(() => cancelComparisons, []);
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

if (import.meta.hot) import.meta.hot.dispose(() => { cancelComparisons(); });
