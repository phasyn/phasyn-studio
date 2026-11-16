// Frames of a same-origin video read in this browser (the swap panel's segment check, the wizard's segment pictures):
// a detached <video> element seeks to each time asked (one seek at a time), waits for `seeked` and draws the frame on a
// canvas — the 96×54 grayscale frame the metrics use (drawn at 192×108 with the browser's high-quality scaling, then
// averaged 2×2; BT.601 luma) and, when asked, a small JPEG. Every failure comes back as a readable reason, never as a
// thrown error; a cancelled read says so. The element is let go after each read.
import { t } from "@/i18n";
import { FRAME_HEIGHT, FRAME_WIDTH } from "./compare";

const LOAD_TIMEOUT_MS = 30_000;
const SEEK_TIMEOUT_MS = 20_000;
/** HTMLMediaElement.HAVE_CURRENT_DATA: the frame at the current position can be drawn. */
const HAVE_CURRENT_DATA = 2;
const DRAW_WIDTH = FRAME_WIDTH * 2;
const DRAW_HEIGHT = FRAME_HEIGHT * 2;
const QUAD = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

/** A failure while reading frames; aborted = the read was cancelled. */
export class FrameReadError extends Error {
  readonly aborted: boolean;
  constructor(message: string, aborted = false) {
    super(message);
    this.name = "FrameReadError";
    this.aborted = aborted;
  }
}

export interface VideoReader {
  /** Seconds. */
  readonly duration: number;
  /** Shows the frame displayed at `time` seconds (kept inside the video). */
  seek(time: number): Promise<void>;
  /** The shown frame as FRAME_WIDTH × FRAME_HEIGHT grayscale (0–255). */
  luma(): Float32Array;
  /** The shown frame as a JPEG data URL `width` pixels wide (the video's own aspect). */
  thumbnail(width: number): string;
}

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; aborted: boolean; reason: string };

const cancelled = () => new FrameReadError(t("已取消"), true);

function mediaErrorText(error: MediaError | null): string {
  if (error?.code === 2) return t("讀取影片時網路中斷");
  if (error?.code === 3) return t("瀏覽器無法解碼這支影片");
  if (error?.code === 4) return t("讀不到影片檔（檔案不在 Node 上，或瀏覽器不支援這個格式）");
  return t("影片載入失敗");
}

function waitFor(video: HTMLVideoElement, event: "loadedmetadata" | "seeked", signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new FrameReadError(event === "seeked" ? t("影片定位逾時（{seconds} 秒）", { seconds: timeoutMs / 1000 }) : t("影片載入逾時（{seconds} 秒）", { seconds: timeoutMs / 1000 })));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new FrameReadError(mediaErrorText(video.error)));
    };
    const abort = () => {
      cleanup();
      reject(cancelled());
    };
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const abort = () => {
      window.clearTimeout(timer);
      reject(cancelled());
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function pixels(context: CanvasRenderingContext2D, width: number, height: number) {
  try {
    return context.getImageData(0, 0, width, height).data;
  } catch {
    throw new FrameReadError(t("瀏覽器不允許讀取這支影片的畫面"));
  }
}

function makeReader(video: HTMLVideoElement, signal: AbortSignal): VideoReader {
  const canvas = document.createElement("canvas");
  canvas.width = DRAW_WIDTH;
  canvas.height = DRAW_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const picture = document.createElement("canvas");
  const pictureContext = picture.getContext("2d");
  if (!context || !pictureContext) throw new FrameReadError(t("瀏覽器無法建立畫布"));
  context.imageSmoothingQuality = "high";
  const duration = video.duration;
  return {
    duration,
    async seek(time) {
      if (signal.aborted) throw cancelled();
      const target = Math.min(Math.max(0, time), Math.max(0, duration - 0.001));
      if (video.readyState >= HAVE_CURRENT_DATA && !video.seeking && Math.abs(video.currentTime - target) < 1e-6) return;
      const seeked = waitFor(video, "seeked", signal, SEEK_TIMEOUT_MS);
      video.currentTime = target;
      await seeked;
      // After `seeked` the frame is normally decoded; give a slow decoder a moment before giving up
      for (let tries = 0; video.readyState < HAVE_CURRENT_DATA; tries += 1) {
        if (tries >= 40) throw new FrameReadError(t("定位後的畫面一直沒有解碼出來"));
        await pause(50, signal);
      }
    },
    luma() {
      context.drawImage(video, 0, 0, DRAW_WIDTH, DRAW_HEIGHT);
      const data = pixels(context, DRAW_WIDTH, DRAW_HEIGHT);
      const frame = new Float32Array(FRAME_WIDTH * FRAME_HEIGHT);
      for (let y = 0; y < FRAME_HEIGHT; y += 1) {
        for (let x = 0; x < FRAME_WIDTH; x += 1) {
          let sum = 0;
          for (const [dx, dy] of QUAD) {
            const at = ((2 * y + dy) * DRAW_WIDTH + 2 * x + dx) * 4;
            sum += 0.299 * (data[at] ?? 0) + 0.587 * (data[at + 1] ?? 0) + 0.114 * (data[at + 2] ?? 0);
          }
          frame[y * FRAME_WIDTH + x] = sum / 4;
        }
      }
      return frame;
    },
    thumbnail(width) {
      // Resizing a canvas resets its context, so the scaling quality is set after it
      picture.width = Math.max(1, Math.round(width));
      picture.height = Math.max(1, Math.round((picture.width * video.videoHeight) / video.videoWidth));
      pictureContext.imageSmoothingQuality = "high";
      pictureContext.drawImage(video, 0, 0, picture.width, picture.height);
      try {
        return picture.toDataURL("image/jpeg", 0.82);
      } catch {
        throw new FrameReadError(t("瀏覽器不允許讀取這支影片的畫面"));
      }
    },
  };
}

/** Opens `url`, runs `work` with a reader and lets the element go; failures (and an abort) come back as a reason. */
export async function readVideo<T>(url: string, signal: AbortSignal, work: (reader: VideoReader) => Promise<T>): Promise<ReadOutcome<T>> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  try {
    const loaded = waitFor(video, "loadedmetadata", signal, LOAD_TIMEOUT_MS);
    video.src = url;
    await loaded;
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) throw new FrameReadError(t("這個檔案沒有可以讀取的畫面"));
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new FrameReadError(t("影片長度未知"));
    return { ok: true, value: await work(makeReader(video, signal)) };
  } catch (error) {
    if (error instanceof FrameReadError) return { ok: false, aborted: error.aborted, reason: error.message };
    if (signal.aborted) return { ok: false, aborted: true, reason: t("已取消") };
    return { ok: false, aborted: false, reason: t("讀取影格失敗：{error}", { error: error instanceof Error ? error.message : String(error) }) };
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
