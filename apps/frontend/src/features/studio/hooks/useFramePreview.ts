// 單一影格的瀏覽器預覽：解碼同源 /api/media 的影片，定位到該影格顯示區間的中點（(index + 0.5) / fps 秒）後畫成縮圖。
// 只是預覽：實際生成用的首幀由節點上的 media.frame 從原檔解碼取出（PNG、原解析度）；瀏覽器的定位可能差一幀。
// 擷取依序執行，結果以 url|index|fps|width 快取；失敗只是沒有預覽，不影響渲染。
import { useEffect, useState } from "react";
import { t } from "@/i18n";

export type FramePreview = { status: "idle" | "loading" | "error"; src: null } | { status: "ready"; src: string };

const cache = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
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

async function captureFrame(url: string, seconds: number, width: number): Promise<string | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  try {
    await once(video, "loadeddata", 15000);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.001));
    await once(video, "seeked", 10000);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** 影片第 frameIndex 幀（0 起）的預覽縮圖（寬 width px）。url 為 null 時為 idle。 */
export function useFramePreview(url: string | null, frameIndex: number, fps: number, width = 160): FramePreview {
  const key = (url != null && url !== "") ? `${url}|${String(frameIndex)}|${String(fps)}|${String(width)}` : "";
  const [result, setResult] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    if (!(url != null && url !== "") || !(fps > 0)) return;
    let cancelled = false;
    let promise = cache.get(key);
    if (!promise) {
      promise = serial(() => captureFrame(url, (frameIndex + 0.5) / fps, width)).catch(() => null);
      cache.set(key, promise);
    }
    void promise.then((src) => {
      if (!cancelled) setResult({ key, src });
    });
    return () => {
      cancelled = true;
    };
  }, [key, url, frameIndex, fps, width]);
  if (!(url != null && url !== "")) return { status: "idle", src: null };
  if (!(fps > 0)) return { status: "error", src: null };
  if (result?.key !== key) return { status: "loading", src: null };
  return (result.src != null && result.src !== "") ? { status: "ready", src: result.src } : { status: "error", src: null };
}
