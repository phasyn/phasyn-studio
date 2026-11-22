// 縮圖（filmstrip）與音訊波形：只讀同源 /api/media 的完整檔案，在瀏覽器內擷取。
// 擷取依序執行（同時只解一支影片），結果以 URL 快取；失敗只是沒有縮圖，不影響其他功能。
import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { aggregateWaveform, WaveformError } from "@/compute/waveform";
import { MAX_PCM_CHANNELS, MAX_PCM_SAMPLES } from "@/compute/waveformProtocol";

const filmstripCache = new Map<string, Promise<string[]>>();
const waveformCache = new Map<string, Float32Array>();
const waveformPending = new Map<string, WaveformJob>();
const MAX_WAVEFORM_CACHE = 32;
const MAX_WAVEFORM_PENDING = 256;
const MAX_AUDIO_FILE_BYTES = 64 * 1024 * 1024;
const WAVEFORM_DEADLINE_MS = 60_000;
interface WaveformJob { users: number; controller: AbortController; promise: Promise<Float32Array> }
export interface WaveformPreview { peaks: Float32Array | null; error: WaveformError | null }
const EMPTY_WAVEFORM: WaveformPreview = { peaks: null, error: null };
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function waitFor(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(t("等待 {event} 逾時", { event })));
    }, timeoutMs);
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(t("影片載入失敗")));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", fail, { once: true });
  });
}

async function captureFrames(url: string, count: number, width: number): Promise<string[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  try {
    await waitFor(video, "loadeddata", 15000);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const height = Math.max(1, Math.round((width * video.videoHeight) / Math.max(1, video.videoWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context || duration <= 0) return [];
    const frames: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const time = Math.min(duration - 0.05, (duration * (i + 0.5)) / count);
      video.currentTime = Math.max(0, time);
      await waitFor(video, "seeked", 10000);
      context.drawImage(video, 0, 0, width, height);
      frames.push(canvas.toDataURL("image/jpeg", 0.72));
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** 一支影片的 count 張等距縮圖（寬 width px）。url 為 null 時回傳空陣列。 */
export function useFilmstrip(url: string | null, count: number, width = 96): string[] {
  const [result, setResult] = useState<{ key: string; frames: string[] } | null>(null);
  const key = (url != null && url !== "") ? `${url}|${String(count)}|${String(width)}` : "";
  useEffect(() => {
    if (!(url != null && url !== "") || count <= 0) return;
    let cancelled = false;
    let promise = filmstripCache.get(key);
    if (!promise) {
      promise = serial(() => captureFrames(url, count, width)).catch(() => []);
      filmstripCache.set(key, promise);
    }
    void promise.then((frames) => {
      if (!cancelled) setResult({ key, frames });
    });
    return () => {
      cancelled = true;
    };
  }, [key, url, count, width]);
  return result?.key === key ? result.frames : [];
}

export const WAVEFORM_BUCKETS = 600;

function abortError(signal: AbortSignal): WaveformError {
  return signal.reason instanceof WaveformError ? signal.reason : new WaveformError("CANCELLED");
}

function observeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { reject(abortError(signal)); };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    void work.then(
      (value) => { signal.removeEventListener("abort", cancel); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", cancel); reject(error instanceof Error ? error : new WaveformError("MEDIA_FAILED")); },
    );
  });
}

async function readAudio(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok || !response.body) throw new WaveformError("MEDIA_FAILED");
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_AUDIO_FILE_BYTES) { await response.body.cancel(); throw new WaveformError("INPUT_BOUNDS"); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_AUDIO_FILE_BYTES) throw new WaveformError("INPUT_BOUNDS");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function decodePeaks(url: string, signal: AbortSignal): Promise<Float32Array> {
  requireActive(signal);
  const buffer = await readAudio(url, signal);
  const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buffer);
  requireActive(signal);
  const length = audio.length * audio.numberOfChannels;
  if (audio.numberOfChannels <= 0 || audio.numberOfChannels > MAX_PCM_CHANNELS || length <= 0 || length > MAX_PCM_SAMPLES) throw new WaveformError("INPUT_BOUNDS");
  // AudioBuffer owns its channel views. Snapshot once into planar PCM before
  // transfer; no getChannelData() view is detached and no sample scan runs here.
  const samples = new Float32Array(length);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    audio.copyFromChannel(samples.subarray(channel * audio.length, (channel + 1) * audio.length), channel);
  }
  return aggregateWaveform(samples, audio.numberOfChannels, WAVEFORM_BUCKETS, signal);
}

function acquireWaveform(url: string): { promise: Promise<Float32Array>; release: () => void } {
  const cached = waveformCache.get(url);
  if (cached) {
    waveformCache.delete(url);
    waveformCache.set(url, cached);
    return { promise: Promise.resolve(cached), release: () => undefined };
  }
  let job = waveformPending.get(url);
  if (!job) {
    if (waveformPending.size >= MAX_WAVEFORM_PENDING) return { promise: Promise.reject(new WaveformError("INPUT_BOUNDS")), release: () => undefined };
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(new WaveformError("TIMEOUT")); }, WAVEFORM_DEADLINE_MS);
    // Keep the actual native decode in the serial queue until it finishes, even
    // when observers cancel. Web Audio decoding itself cannot be interrupted.
    const work = serial(() => decodePeaks(url, controller.signal));
    const promise = observeAbort(work, controller.signal).then((peaks) => {
      waveformCache.set(url, peaks);
      while (waveformCache.size > MAX_WAVEFORM_CACHE) {
        const oldest = waveformCache.keys().next().value;
        if (oldest === undefined) break;
        waveformCache.delete(oldest);
      }
      return peaks;
    }).finally(() => {
      clearTimeout(timer);
      if (waveformPending.get(url)?.controller === controller) waveformPending.delete(url);
    });
    job = { users: 0, controller, promise };
    waveformPending.set(url, job);
  }
  job.users += 1;
  const owned = job;
  return { promise: job.promise, release: () => {
    owned.users -= 1;
    if (owned.users === 0) {
      owned.controller.abort();
      if (waveformPending.get(url) === owned) waveformPending.delete(url);
    }
  } };
}

/** Full-source waveform plus an explicit failure state; failed jobs are never cached. */
export function useWaveformPreview(url: string | null): WaveformPreview {
  const [result, setResult] = useState<(WaveformPreview & { url: string }) | null>(null);
  useEffect(() => {
    if (!(url != null && url !== "")) return;
    let active = true;
    const lease = acquireWaveform(url);
    void lease.promise.then(
      (peaks) => { if (active) setResult({ url, peaks, error: null }); },
      (error: unknown) => { if (active) setResult({ url, peaks: null, error: error instanceof WaveformError ? error : new WaveformError("MEDIA_FAILED") }); },
    );
    return () => { active = false; lease.release(); };
  }, [url]);
  return result?.url === url ? result : EMPTY_WAVEFORM;
}

/** Backward-compatible waveform-only facade. */
export function useWaveform(url: string | null): Float32Array | null {
  return useWaveformPreview(url).peaks;
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  for (const job of waveformPending.values()) job.controller.abort();
  waveformPending.clear();
  waveformCache.clear();
});
