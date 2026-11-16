// Head thumbnails of the timeline's video clips: the frame a clip starts with, decoded in this browser from the
// same-origin media file. Captures run one at a time; consecutive captures of one file share a single video element,
// which is let go once the queue has been idle for a moment. The results are kept in a bounded cache by media file and
// frame (the oldest go first); a capture that fails leaves its clip without a thumbnail. Nothing here touches the
// document, and a thumbnail is only a picture: the frame shown can differ by one from the exported frame.
import { useEffect, useState } from "react";
import { t } from "@/i18n";

/** Thumbnails kept (a JPEG of about 6 KB each). */
const CACHE_LIMIT = 160;
/** Captures waiting at most; a clip asks again when it renders after the queue has moved. */
const PENDING_LIMIT = 128;
/** Width a frame is captured at: twice the widest thumbnail (a large track shows about 112 px). */
const CAPTURE_WIDTH = 224;
/** The video element of the last file is let go after the queue has been idle this long. */
const IDLE_MS = 4000;

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
let idle: number | undefined;
let player: { url: string; video: HTMLVideoElement; ready: Promise<void> } | null = null;

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

function letGo(): void {
  if (!player) return;
  player.video.removeAttribute("src");
  player.video.load();
  player = null;
}

function playerFor(url: string): { video: HTMLVideoElement; ready: Promise<void> } {
  if (player?.url === url) return player;
  letGo();
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  player = { url, video, ready: waitFor(video, "loadeddata", 15000) };
  return player;
}

/** One capture after the other (one decoder at a time); the video element goes when nothing waits any more. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  waiting += 1;
  window.clearTimeout(idle);
  const next = queue.then(task, task);
  queue = next
    .catch(() => undefined)
    .finally(() => {
      waiting -= 1;
      if (waiting === 0) idle = window.setTimeout(letGo, IDLE_MS);
    });
  return next;
}

async function capture(url: string, seconds: number): Promise<string | null> {
  const { video, ready } = playerFor(url);
  await ready;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
  video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.001));
  await waitFor(video, "seeked", 10000);
  const canvas = document.createElement("canvas");
  canvas.width = CAPTURE_WIDTH;
  canvas.height = Math.max(1, Math.round((CAPTURE_WIDTH * video.videoHeight) / video.videoWidth));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

function remember(key: string, src: string | null): void {
  cache.delete(key);
  cache.set(key, src);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** The capture of a frame, shared by every clip that asks for it; null when the queue is full. */
function request(key: string, url: string, seconds: number): Promise<string | null> | null {
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= PENDING_LIMIT) return null;
  const job = serial(() => capture(url, seconds))
    .catch((): null => {
      letGo();
      return null;
    })
    .then((src) => {
      pending.delete(key);
      remember(key, src);
      return src;
    });
  pending.set(key, job);
  return job;
}

/**
 * The thumbnail of a frame of a media file (frames counted at the sequence's rate); null until it is ready, when it
 * failed, while `url` is null, and while `paused` keeps new captures from starting (a cached one still shows).
 */
export function useHeadThumbnail(url: string | null, frame: number, fps: number, paused: boolean): string | null {
  const key = url && fps > 0 ? `${url}|${frame}|${fps}` : null;
  const cached = key === null ? undefined : cache.get(key);
  const [result, setResult] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    if (key === null || url === null || paused || cached !== undefined) return;
    let active = true;
    void request(key, url, (frame + 0.5) / fps)?.then((src) => {
      if (active) setResult({ key, src });
    });
    return () => {
      active = false;
    };
  }, [key, url, frame, fps, paused, cached]);
  if (key === null) return null;
  if (cached !== undefined) return cached;
  return result?.key === key ? result.src : null;
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  window.clearTimeout(idle);
  letGo();
  cache.clear();
  pending.clear();
});
