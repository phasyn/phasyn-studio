// Reads every frame a speed-feel analysis needs, in this browser (frameSampler: one video at a time, one seek per
// frame), and keeps the result by target key while the page lives. The take is read over the clip (and the frame after
// it when the take has one); the original over the same moments plus LEAD frames before and TAIL after, which only
// serve the cut detection. Each frame becomes the 96×54 grayscale frame, rounded to 8 bits as FFmpeg's format=gray
// gives it, and only what the
// rules use is kept: its difference to the previous frame, its mean luminance and, for the take, the mean luminance it
// would have as a negative impact frame. One analysis runs at a time: a new one stops the other, and the dialog that
// asked for it cancels it when it closes.
import { useSyncExternalStore } from "react";
import { t } from "@/i18n";
import { FrameReadError, readVideo, type VideoReader } from "../swap/frameSampler";
import { snapshotStore } from "../swap/snapshotStore";
import { analyseSpeedFeel, frameDifference, frameLuma, impactLuma } from "./analysis";
import type { SpeedFeelAnalysis } from "./analysis";
import type { SpeedFeelTarget } from "./target";

/** Frames of the original read before and after the clip for the cut detection (the prototype's cut list reached 2 frames beyond the window). */
const LEAD = 4;
const TAIL = 3;
/** Analyses remembered (each is a few hundred numbers). */
const RESULT_LIMIT = 60;

export type SpeedFeelStatus =
  | { status: "running"; clip: "take" | "original"; done: number; total: number }
  | { status: "done"; analysis: SpeedFeelAnalysis }
  | { status: "failed"; reason: string };

interface Job {
  key: string;
  controller: AbortController;
}

const store = snapshotStore<SpeedFeelStatus>(RESULT_LIMIT);
let running: Job | null = null;

interface Moments {
  /** Seconds of each frame to read, in order. */
  times: number[];
  /** Frames from this index on are read only while they lie inside the video. */
  optionalFrom: number;
  /** Seconds a required frame may lie past the video's end (half a frame). */
  slack: number;
}

interface Measured {
  /** Entry i = the change from frame i to frame i + 1. */
  motion: number[];
  /** Mean luminance of every frame read, and the same as a negative impact frame (the take only). */
  luma: number[];
  impact: number[];
}

/** The frames along `moments`, measured. */
async function readFrames(reader: VideoReader, moments: Moments, withImpact: boolean, onProgress: (done: number, total: number) => void): Promise<Measured> {
  const required = moments.times.slice(0, moments.optionalFrom);
  const last = required.at(-1) ?? 0;
  if (last > reader.duration + moments.slack) throw new FrameReadError(t("影片只有 {duration} 秒，比對要讀到第 {needed} 秒", { duration: reader.duration.toFixed(2), needed: last.toFixed(2) }));
  const times = [...required, ...moments.times.slice(moments.optionalFrom).filter((time) => time < reader.duration)];
  const measured: Measured = { motion: [], luma: [], impact: [] };
  let previous: Uint8ClampedArray | null = null;
  for (const [index, time] of times.entries()) {
    await reader.seek(time);
    const frame = new Uint8ClampedArray(reader.luma());
    if (previous) measured.motion.push(frameDifference(previous, frame));
    measured.luma.push(frameLuma(frame));
    if (withImpact) measured.impact.push(impactLuma(frame));
    previous = frame;
    if (index % 4 === 3 || index === times.length - 1) onProgress(index + 1, times.length);
  }
  return measured;
}

/** What to read: the take over the clip (and the frame after it), the original from LEAD frames before to TAIL after. */
function readPlan(target: SpeedFeelTarget): { take: Moments; original: Moments; lead: number } {
  const { first, end, fps, refStart } = target;
  const length = end - first;
  const middle = (frame: number) => (frame + 0.5) / fps;
  const slack = 0.5 / fps;
  const takeFrames = end < target.sourceFrames ? length + 1 : length;
  // The original cannot be read before its start
  const lead = Math.max(0, Math.min(LEAD, Math.floor(refStart * fps + first)));
  return {
    take: { times: Array.from({ length: takeFrames }, (_, index) => middle(first + index)), optionalFrom: length, slack },
    original: { times: Array.from({ length: lead + length + TAIL }, (_, index) => refStart + middle(first - lead + index)), optionalFrom: lead + length, slack },
    lead,
  };
}

/** One analysis; null when it was cancelled. */
async function runAnalysis(target: SpeedFeelTarget, signal: AbortSignal, progress: (clip: "take" | "original", done: number, total: number) => void): Promise<SpeedFeelStatus | null> {
  const plan = readPlan(target);
  const take = await readVideo(target.takeUrl, signal, (reader) => readFrames(reader, plan.take, true, (done, total) => progress("take", done, total)));
  if (!take.ok) return take.aborted ? null : { status: "failed", reason: t("讀取生成的影片失敗：{reason}", { reason: take.reason }) };
  const original = await readVideo(target.originalUrl, signal, (reader) => readFrames(reader, plan.original, false, (done, total) => progress("original", done, total)));
  if (!original.ok) return original.aborted ? null : { status: "failed", reason: t("讀取原片失敗：{reason}", { reason: original.reason }) };
  const analysis = analyseSpeedFeel({ take: take.value, original: original.value, lead: plan.lead, length: target.end - target.first, fps: target.fps });
  if (!analysis) return { status: "failed", reason: t("讀到的影格不夠，無法比對") };
  return { status: "done", analysis };
}

/** Ends a job: its outcome is kept; a cancelled one is forgotten unless the same analysis was started again meanwhile. */
function settle(job: Job, outcome: SpeedFeelStatus | null): void {
  const restarted = running !== null && running !== job && running.key === job.key;
  if (running === job) running = null;
  if (outcome && !job.controller.signal.aborted) store.set(job.key, outcome);
  else if (!restarted) store.delete(job.key);
}

/** Starts the analysis of `target` (and stops another one that runs); nothing happens while the same one runs. */
export function startSpeedFeel(target: SpeedFeelTarget): void {
  if (running?.key === target.key && !running.controller.signal.aborted) return;
  running?.controller.abort();
  const job: Job = { key: target.key, controller: new AbortController() };
  running = job;
  store.set(job.key, { status: "running", clip: "take", done: 0, total: 0 });
  const progress = (clip: "take" | "original", done: number, total: number) => {
    if (!job.controller.signal.aborted) store.set(job.key, { status: "running", clip, done, total });
  };
  void runAnalysis(target, job.controller.signal, progress).then(
    (outcome) => settle(job, outcome),
    (error: unknown) => settle(job, { status: "failed", reason: t("比對失敗：{error}", { error: error instanceof Error ? error.message : String(error) }) }),
  );
}

/** Stops the analysis that runs (finished results stay). */
export function cancelSpeedFeel(): void {
  running?.controller.abort();
}

/** The analyses by target key. */
export function useSpeedFeelResults(): ReadonlyMap<string, SpeedFeelStatus> {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

if (import.meta.hot) import.meta.hot.dispose(() => cancelSpeedFeel());
