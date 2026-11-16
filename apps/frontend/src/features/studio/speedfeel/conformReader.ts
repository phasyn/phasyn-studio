// Reads every frame the cut conform needs, in this browser (frameSampler, as the speed-feel reader does: one video at a
// time, one seek per frame), and keeps the result by target key while the page lives. The take is read over the clip
// and up to MAX_CUT_SHIFT frames after it (the prototype read as far, so a late cut near the end still pairs), the
// original over the clip's moments. Each frame becomes the cut detector's 64×36 RGB frame: frameSampler draws a frame
// only as grayscale or as a JPEG thumbnail, so the thumbnail 128 px wide (its colour then sampled at 64×36) is decoded,
// drawn at 128×72 with the browser's high-quality scaling and averaged 2×2, the way frameSampler makes its grayscale
// frame. Only the features and the motion curves are kept (cuts.ts): both clips' over one frame, the take's also over two
// (the motion retime compares them, retime.ts; the whole-clip shift too, sync.ts). One analysis runs at a time: a new
// one stops the other, and the dialog that asked for it cancels it when it closes.
import { useSyncExternalStore } from "react";
import { t } from "@/i18n";
import { FrameReadError, readVideo, type VideoReader } from "../swap/frameSampler";
import { snapshotStore } from "../swap/snapshotStore";
import { analyseCuts, CUT_FRAME_HEIGHT, CUT_FRAME_WIDTH, cutFeatures, cutGray, grayDifference, MAX_CUT_SHIFT, type ConformAnalysis, type CutFeatures } from "./cuts";
import { motionSync, type MotionSync } from "./sync";
import type { SpeedFeelTarget } from "./target";

const DRAW_WIDTH = CUT_FRAME_WIDTH * 2;
const DRAW_HEIGHT = CUT_FRAME_HEIGHT * 2;
const QUAD = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;
/** Analyses remembered (each keeps the features of a few hundred frames, about 2 KB a frame). */
const RESULT_LIMIT = 8;

export type ConformStatus =
  | { status: "running"; clip: "take" | "original"; done: number; total: number }
  | { status: "done"; analysis: ConformAnalysis; sync: MotionSync }
  | { status: "failed"; reason: string };

interface Job {
  key: string;
  controller: AbortController;
}

const store = snapshotStore<ConformStatus>(RESULT_LIMIT);
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
  features: CutFeatures[];
  /** Entry i = the change from frame i to frame i + 1, and (`twoStep` only) to frame i + 2. */
  motion: number[];
  motion2: number[];
}

function drawingContext(): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = DRAW_WIDTH;
  canvas.height = DRAW_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new FrameReadError(t("瀏覽器無法建立畫布"));
  context.imageSmoothingQuality = "high";
  return context;
}

/** The shown frame as 64×36 RGB (3 values a pixel, row by row). */
async function rgbFrame(reader: VideoReader, context: CanvasRenderingContext2D): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = reader.thumbnail(DRAW_WIDTH);
  try {
    await image.decode();
  } catch {
    throw new FrameReadError(t("瀏覽器無法解碼影格的縮圖"));
  }
  context.drawImage(image, 0, 0, DRAW_WIDTH, DRAW_HEIGHT);
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, DRAW_WIDTH, DRAW_HEIGHT).data;
  } catch {
    throw new FrameReadError(t("瀏覽器不允許讀取這支影片的畫面"));
  }
  const rgb = new Uint8ClampedArray(CUT_FRAME_WIDTH * CUT_FRAME_HEIGHT * 3);
  for (let y = 0; y < CUT_FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < CUT_FRAME_WIDTH; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (const [dx, dy] of QUAD) sum += data[((2 * y + dy) * DRAW_WIDTH + 2 * x + dx) * 4 + channel] ?? 0;
        rgb[(y * CUT_FRAME_WIDTH + x) * 3 + channel] = sum / 4;
      }
    }
  }
  return rgb;
}

/** The frames along `moments`, measured with their motion (`twoStep`: over two frames too). */
async function readFrames(reader: VideoReader, moments: Moments, twoStep: boolean, onProgress: (done: number, total: number) => void): Promise<Measured> {
  const required = moments.times.slice(0, moments.optionalFrom);
  const last = required.at(-1) ?? 0;
  if (last > reader.duration + moments.slack) throw new FrameReadError(t("影片只有 {duration} 秒，比對要讀到第 {needed} 秒", { duration: reader.duration.toFixed(2), needed: last.toFixed(2) }));
  const times = [...required, ...moments.times.slice(moments.optionalFrom).filter((time) => time < reader.duration)];
  const context = drawingContext();
  const measured: Measured = { features: [], motion: [], motion2: [] };
  let previous: Float32Array | null = null;
  let beforePrevious: Float32Array | null = null;
  for (const [index, time] of times.entries()) {
    await reader.seek(time);
    const rgb = await rgbFrame(reader, context);
    measured.features.push(cutFeatures(rgb));
    const gray = cutGray(rgb);
    if (previous) measured.motion.push(grayDifference(previous, gray));
    if (twoStep && beforePrevious) measured.motion2.push(grayDifference(beforePrevious, gray));
    beforePrevious = previous;
    previous = gray;
    if (index % 4 === 3 || index === times.length - 1) onProgress(index + 1, times.length);
  }
  return measured;
}

/** What to read: the take over the clip and the frames after it, the original over the clip's moments. */
function readPlan(target: SpeedFeelTarget): { take: Moments; original: Moments } {
  const { first, end, fps, refStart } = target;
  const length = end - first;
  const middle = (frame: number) => (frame + 0.5) / fps;
  const slack = 0.5 / fps;
  const after = Math.max(0, Math.min(MAX_CUT_SHIFT, target.sourceFrames - end));
  return {
    take: { times: Array.from({ length: length + after }, (_, index) => middle(first + index)), optionalFrom: length, slack },
    original: { times: Array.from({ length }, (_, index) => refStart + middle(first + index)), optionalFrom: length, slack },
  };
}

/** One analysis; null when it was cancelled. */
async function runConform(target: SpeedFeelTarget, signal: AbortSignal, progress: (clip: "take" | "original", done: number, total: number) => void): Promise<ConformStatus | null> {
  const plan = readPlan(target);
  const take = await readVideo(target.takeUrl, signal, (reader) => readFrames(reader, plan.take, true, (done, total) => progress("take", done, total)));
  if (!take.ok) return take.aborted ? null : { status: "failed", reason: t("讀取生成的影片失敗：{reason}", { reason: take.reason }) };
  const original = await readVideo(target.originalUrl, signal, (reader) => readFrames(reader, plan.original, false, (done, total) => progress("original", done, total)));
  if (!original.ok) return original.aborted ? null : { status: "failed", reason: t("讀取原片失敗：{reason}", { reason: original.reason }) };
  const analysis = analyseCuts({ take: take.value, original: original.value.features, originalMotion: original.value.motion, length: target.end - target.first });
  if (!analysis) return { status: "failed", reason: t("讀到的影格不夠，無法比對") };
  // The shift is measured on the clip's own frames: the take's frames after its out point never show (and can copy the
  // original). The retime is measured with the clip's transitions where the options are made (choice.ts)
  return { status: "done", analysis, sync: motionSync(analysis.originalMotion, analysis.takeMotion.slice(0, analysis.length - 1), analysis.length) };
}

/** Ends a job: its outcome is kept; a cancelled one is forgotten unless the same analysis was started again meanwhile. */
function settle(job: Job, outcome: ConformStatus | null): void {
  const restarted = running !== null && running !== job && running.key === job.key;
  if (running === job) running = null;
  if (outcome && !job.controller.signal.aborted) store.set(job.key, outcome);
  else if (!restarted) store.delete(job.key);
}

/** Starts the cut analysis of `target` (and stops another one that runs); nothing happens while the same one runs. */
export function startConform(target: SpeedFeelTarget): void {
  if (running?.key === target.key && !running.controller.signal.aborted) return;
  running?.controller.abort();
  const job: Job = { key: target.key, controller: new AbortController() };
  running = job;
  store.set(job.key, { status: "running", clip: "take", done: 0, total: 0 });
  const progress = (clip: "take" | "original", done: number, total: number) => {
    if (!job.controller.signal.aborted) store.set(job.key, { status: "running", clip, done, total });
  };
  void runConform(target, job.controller.signal, progress).then(
    (outcome) => settle(job, outcome),
    (error: unknown) => settle(job, { status: "failed", reason: t("比對失敗：{error}", { error: error instanceof Error ? error.message : String(error) }) }),
  );
}

/** Stops the analysis that runs (finished results stay). */
export function cancelConform(): void {
  running?.controller.abort();
}

/** The cut analyses by target key. */
export function useConformResults(): ReadonlyMap<string, ConformStatus> {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

if (import.meta.hot) import.meta.hot.dispose(() => cancelConform());
