import { t } from "@/i18n";
// H3 的時間單位：24 fps；要求的影格數會被「往上」對齊到 17n+5（phasyn_h3/recipe/adapter/geometry.py：F + (5 − F) mod 17）。
// Studio 只提供對齊後的值，畫面上的長度就是實際生成的長度。

export const H3_FPS = 24;
export const H3_FRAME_MIN = 96;
export const H3_FRAME_MAX = 360;
export const DEFAULT_FRAMES = 124;

/** 往上對齊到 17n+5（與 H3 runtime 相同的規則）。 */
export function alignFrames(frames: number): number {
  const f = Math.max(1, Math.round(frames));
  return f + (((5 - f) % 17) + 17) % 17;
}

/** 在 H3 參數範圍（96–360）內、對齊後仍不超過上限的所有影格數：107、124、…、345。 */
export function frameOptions(): number[] {
  const out: number[] = [];
  for (let f = alignFrames(H3_FRAME_MIN); f <= H3_FRAME_MAX; f += 17) out.push(f);
  return out;
}

/** 把任意影格數夾到合法選項中最接近的一個（舊資料或手動輸入時用）。 */
export function nearestFrameOption(frames: number): number {
  const options = frameOptions();
  let best = options[0] ?? DEFAULT_FRAMES;
  for (const option of options) if (Math.abs(option - frames) < Math.abs(best - frames)) best = option;
  return best;
}

export function framesToSeconds(frames: number, fps = H3_FPS): number {
  return frames / fps;
}

export function secondsToFrames(seconds: number, fps = H3_FPS): number {
  return Math.round(seconds * fps);
}

/** HH:MM:SS:FF（非 drop-frame）。負值當 0。 */
export function formatTimecode(totalFrames: number, fps = H3_FPS): string {
  const frames = Math.max(0, Math.floor(totalFrames));
  const perSecond = Math.max(1, Math.round(fps));
  const ff = frames % perSecond;
  const totalSeconds = Math.floor(frames / perSecond);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return [hh, mm, ss, ff].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 「5.17 秒」：時長的人類可讀寫法。 */
export function formatDuration(frames: number, fps = H3_FPS): string {
  const seconds = frames / fps;
  return t("{value} 秒", { value: seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2) });
}

/**
 * A typed position: a frame number, a timecode (HH:MM:SS:FF, missing fields count from the right) or a relative move
 * (+12, -1:00). Returns the frame, or null when the text is neither.
 */
export function parseTimecode(text: string, fps: number, current = 0): number | null {
  const raw = text.trim();
  if (!raw) return null;
  const relative = raw.startsWith("+") || raw.startsWith("-");
  const body = relative ? raw.slice(1) : raw;
  const parts = body.split(/[:;.]/);
  if (parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const perSecond = Math.max(1, Math.round(fps));
  const numbers = parts.map(Number);
  const frames = numbers.at(-1) ?? 0;
  const seconds = (numbers.at(-2) ?? 0) + (numbers.at(-3) ?? 0) * 60 + (numbers.at(-4) ?? 0) * 3600;
  const value = parts.length === 1 ? frames : seconds * perSecond + frames;
  if (!Number.isSafeInteger(value)) return null;
  return relative ? Math.max(0, current + (raw.startsWith("-") ? -value : value)) : value;
}
