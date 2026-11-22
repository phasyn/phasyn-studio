import { t } from "@/i18n";
import { H3_RULES } from "../../model/providerTraits";
// H3 的時間規則（與 SGLang minimax_h3/time_request.py、phasyn_h3/recipe/adapter/geometry.py 相同）：
// 固定 24 fps；要求的影格數往上對齊到 17n+5（F + (5 − F) mod 17）；Studio 的輸出採 preserve_generated，
// 所以實際片長＝對齊後影格數 ÷ 24。分鏡時間戳必須落在這個片長內。
// 數值的來源是 model/providerTraits.ts 的 H3_RULES（同一份 H3 規則，DiT 的 facts.cost_model 可以覆寫 fps）。
export const H3_FPS = H3_RULES.fps;
/** 要求時長界線（SGLang constants.py MINIMAX_H3_MIN/MAX_DURATION_SECONDS；phasyn_h3.recipe.adapter build_geometry）。 */
export const H3_MIN_SECONDS = H3_RULES.minSeconds;
export const H3_MAX_SECONDS = H3_RULES.maxSeconds;

/** 往上對齊到 17n+5；≤ 0 → 1（照抄 SGLang 的邊界行為）。 */
export function alignFrames(frames: number): number {
  if (!Number.isFinite(frames) || frames <= 0) return 1;
  const f = Math.trunc(frames);
  return f + ((((5 - f) % 17) + 17) % 17);
}

export interface ClipTiming {
  /** 鏡頭設定的影格數。 */
  frames: number;
  /** 對齊 17n+5 後實際生成的影格數。 */
  alignedFrames: number;
  /** 實際片長（秒）＝ alignedFrames ÷ 24。 */
  seconds: number;
  /** 要求時長（秒）＝ frames ÷ 24（4–15 秒檢查用）。 */
  requestedSeconds: number;
}

/** 影格數 → 片長；未知（≤ 0、非數字）→ null。 */
export function clipTiming(frames: number): ClipTiming | null {
  if (!Number.isFinite(frames) || frames <= 0) return null;
  const f = Math.trunc(frames);
  const aligned = alignFrames(f);
  return { frames: f, alignedFrames: aligned, seconds: aligned / H3_FPS, requestedSeconds: f / H3_FPS };
}

/** 官方時間戳格式 MM:SS.mmm（例如 00:03.500）。 */
export function formatCueTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(ms / 60000);
  const rest = (ms - minutes * 60000) / 1000;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

/** "00:03.500"、"0:03.5"、"3.5" → 秒；格式不符或秒欄 ≥ 60 → null。 */
export function parseCueTime(text: string): number | null {
  const value = text.trim();
  const clock = /^(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(value);
  if (clock) {
    const seconds = Number(clock[2]);
    return seconds >= 60 ? null : Number(clock[1]) * 60 + seconds;
  }
  const plain = /^(\d{1,3}(?:\.\d{1,3})?)$/.exec(value);
  return plain ? Number(plain[1]) : null;
}

/** 是否已是官方的 MM:SS.mmm 寫法。 */
export function isCanonicalCueTime(text: string): boolean {
  return /^\d{2}:\d{2}\.\d{3}$/.test(text.trim());
}

/** 秒數顯示：最多 3 位小數，去掉多餘的 0（10.125、10、4.458）。 */
export function formatSeconds(seconds: number): string {
  return String(Number(seconds.toFixed(3)));
}

/** 介面上一般的秒數：一位小數（5.167 → 5.2）。切鏡時間的上限這類要精確的地方用 formatSeconds。 */
export function formatShortSeconds(seconds: number): string {
  return String(Number(seconds.toFixed(1)));
}

/** 給人看的片長說明（一句）：設定幾幀、H3 實際生成幾幀、播放多久。 */
export function explainClip(timing: ClipTiming): string {
  const values = { frames: timing.frames, alignedFrames: timing.alignedFrames, fps: H3_FPS, seconds: formatSeconds(timing.seconds) };
  return timing.alignedFrames === timing.frames
    ? t("這個鏡頭 {frames} 幀，以每秒 {fps} 幀播放，實際長 {seconds} 秒。", values)
    : t("這個鏡頭設定 {frames} 幀，H3 會補成 {alignedFrames} 幀，以每秒 {fps} 幀播放，實際長 {seconds} 秒。", values);
}

/** 「240 幀 → 對齊 17n+5 後 243 幀 ÷ 24 fps ＝ 10.125 秒」（給 LLM 的改寫指令用）。 */
export function describeClip(timing: ClipTiming): string {
  const head = timing.alignedFrames === timing.frames ? t("{frames} 幀（已對齊 17n+5）", { frames: timing.frames }) : t("{frames} 幀 → 對齊 17n+5 後 {alignedFrames} 幀", { frames: timing.frames, alignedFrames: timing.alignedFrames });
  return t("{head} ÷ {h3Fps} fps ＝ {seconds} 秒", { head, h3Fps: H3_FPS, seconds: formatSeconds(timing.seconds) });
}
