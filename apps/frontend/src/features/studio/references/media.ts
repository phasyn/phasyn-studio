// 上傳前在瀏覽器讀取媒體資訊（寬高、長度、有沒有音軌）。讀不到就是 null（未知），不填 0、不猜。
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { blobSource, mp4HasAudio } from "./mp4";
import type { ReferenceKind } from "./materials";
import { t } from "@/i18n";

export type MediaFacts = Pick<StudioLibraryItem, "width" | "height" | "duration_seconds" | "has_audio">;

const EXTENSION_KIND: Record<string, ReferenceKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image", avif: "image",
  mp4: "video", m4v: "video", mov: "video", webm: "video", mkv: "video",
  wav: "audio", mp3: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio", opus: "audio",
};

/** 依 MIME（缺少時依副檔名）判斷素材類型；不是圖片／影片／聲音 → null。 */
export function kindForFile(file: { name: string; type: string }): ReferenceKind | null {
  const major = file.type.split("/")[0];
  if (major === "image" || major === "video" || major === "audio") return major;
  if (file.type && file.type !== "application/octet-stream") return null;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_KIND[extension] ?? null;
}

/** 契約欄位範圍內的整數尺寸（1–16384）；其他值＝未知。 */
export function dimension(value: number): number | null {
  return Number.isInteger(value) && value >= 1 && value <= 16384 ? value : null;
}

/** 有限且非負的秒數；NaN／Infinity（串流或無法解碼）＝未知。 */
export function durationOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** 素材庫名稱（契約 1–200 字）。 */
export function libraryName(fileName: string): string {
  const trimmed = fileName.trim();
  return trimmed.length === 0 ? t("未命名檔案") : [...trimmed].slice(0, 200).join("");
}

function waitForMetadata(element: HTMLMediaElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onError);
      resolve(ok);
    };
    const onLoaded = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    element.addEventListener("loadedmetadata", onLoaded, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

interface BrowserAudioHints {
  audioTracks?: { length: number };
  mozHasAudio?: boolean;
}

async function imageFacts(file: File): Promise<MediaFacts> {
  try {
    const bitmap = await createImageBitmap(file);
    const facts = { width: dimension(bitmap.width), height: dimension(bitmap.height), duration_seconds: null, has_audio: false };
    bitmap.close();
    return facts;
  } catch {
    return { width: null, height: null, duration_seconds: null, has_audio: false };
  }
}

async function timedFacts(file: File, kind: "video" | "audio"): Promise<MediaFacts> {
  const url = URL.createObjectURL(file);
  const element = document.createElement(kind);
  element.preload = "metadata";
  element.muted = true;
  try {
    element.src = url;
    const loaded = await waitForMetadata(element, 15000);
    if (kind === "audio") {
      const duration = loaded ? durationOrNull(element.duration) : null;
      return { width: null, height: null, duration_seconds: duration, has_audio: duration === null ? null : true };
    }
    const video = element as HTMLVideoElement;
    let hasAudio: boolean | null = await mp4HasAudio(blobSource(file)).catch(() => null);
    if (hasAudio === null && loaded) {
      const hints = video as unknown as BrowserAudioHints;
      if (hints.audioTracks) hasAudio = hints.audioTracks.length > 0;
      else if (typeof hints.mozHasAudio === "boolean") hasAudio = hints.mozHasAudio;
    }
    return {
      width: loaded ? dimension(video.videoWidth) : null,
      height: loaded ? dimension(video.videoHeight) : null,
      duration_seconds: loaded ? durationOrNull(video.duration) : null,
      has_audio: hasAudio,
    };
  } finally {
    element.removeAttribute("src");
    element.load();
    URL.revokeObjectURL(url);
  }
}

/** 讀取上傳檔的媒體資訊；任何一項讀不到都回 null。 */
export function readMediaFacts(file: File, kind: ReferenceKind): Promise<MediaFacts> {
  return kind === "image" ? imageFacts(file) : timedFacts(file, kind);
}
