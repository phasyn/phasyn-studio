// 輸出尺寸：寬高都必須是 32 的倍數、介於 256–2048（qimg.prepare／qimg.dit 的參數範圍：一個 VLM 影像槽＝2×2 latent
// token，pipeline 對齊 32）。不合法時說明原因並給最接近的合法值讓使用者自己按，不默默改值。純函式。
import type { StudioImageShot } from "../types";
import { LIMITS } from "./constants";
import { t } from "@/i18n";

const { min, max, multiple } = LIMITS.side;

export interface SizePreset {
  id: string;
  width: number;
  height: number;
  label: string;
  hint: string;
}

/** 三個常用尺寸（正方形）。 */
export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: "512", width: 512, height: 512, label: "512", hint: t("草稿") },
  { id: "1024", width: 1024, height: 1024, label: "1024", hint: t("標準") },
  { id: "1536", width: 1536, height: 1536, label: "1536", hint: t("大圖") },
];

/** 單邊是否合法（整數、32 的倍數、256–2048）。 */
export function sideValid(value: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max && value % multiple === 0;
}

/** 單邊的問題（繁中）；合法時 null。 */
export function sideProblem(value: number, label: string, alignment: number = multiple): string | null {
  if (!Number.isFinite(value)) return t("{label}必須是數字", { label });
  if (!Number.isInteger(value)) return t("{label}必須是整數", { label });
  if (value < min || value > max) return t("{label}須介於 {min}–{max}", { label, min, max });
  if (value % alignment !== 0) return t("{label}必須是 {multiple} 的倍數（最接近的是 {snapSide}）", { label, multiple: alignment, snapSide: snapSide(value, alignment) });
  return null;
}

export function sizeProblem(width: number, height: number, alignment?: number): string | null {
  return sideProblem(width, t("寬度"), alignment) ?? sideProblem(height, t("高度"), alignment);
}

/** 最接近的合法單邊（四捨五入到 32 的倍數，再夾到 256–2048）。 */
export function snapSide(value: number, alignment: number = multiple): number {
  if (!Number.isFinite(value)) return min;
  const snapped = Math.round(value / alignment) * alignment;
  return Math.min(max, Math.max(min, snapped));
}

/** 目前尺寸對應的預設（不是預設時為 null＝自訂）。 */
export function presetOf(width: number, height: number): SizePreset | null {
  return SIZE_PRESETS.find((preset) => preset.width === width && preset.height === height) ?? null;
}

/** 百萬像素（顯示用，兩位小數）。 */
export function megapixels(width: number, height: number): string {
  return ((width * height) / 1_000_000).toFixed(2);
}

/** 最大公因數化簡後的比例（例如 1024×576 → 16:9）。 */
export function aspectLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return "—";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${String(Math.round(width) / divisor)}:${String(Math.round(height) / divisor)}`;
}

/** 兩種解碼方式的固定說明（「採樣」分頁的 ⓘ）。 */
export const DECODE_INFO: readonly string[] = [t("完整解碼：一次解碼整張圖，沒有接縫。"), t("分塊解碼較省顯存，但塊與塊的接縫處可能看得出痕跡。")];

/** 完整解碼的預設上限（像素）：比這大的尺寸預設改用分塊解碼（16 GB 顯示卡上更大的完整解碼會顯存不足）。 */
export const FULL_DECODE_MAX_PIXELS = 1024 * 1024;

/** 完整解碼在這個尺寸是否超過預設上限。 */
export function fullDecodeTooLarge(width: number, height: number): boolean {
  return width * height > FULL_DECODE_MAX_PIXELS;
}

/**
 * 改尺寸的 patch：從上限以內改到超過上限、而且目前是完整解碼時，同時改成分塊解碼（「採樣」分頁會顯示）。之後使用者
 * 自己選回完整解碼就照他的選擇，不再改。
 */
export function sizePatch(shot: Pick<StudioImageShot, "width" | "height" | "decode">, width: number, height: number): Partial<StudioImageShot> {
  const crossing = shot.decode === "full" && !fullDecodeTooLarge(shot.width, shot.height) && fullDecodeTooLarge(width, height);
  return crossing ? { width, height, decode: "tiled" } : { width, height };
}

/**
 * 解碼方式在目前尺寸下的提醒；沒有要提醒的時 null。分塊：接縫可能看得出來；完整解碼而比 1024² 大：顯存可能不足，
 * 建議分塊（不放量測數字、不推估）。
 */
export function decodeWarning(width: number, height: number, decode: "full" | "tiled"): string | null {
  if (decode === "tiled") return t("分塊解碼較省顯存，但塊與塊的接縫處可能看得出痕跡。");
  if (fullDecodeTooLarge(width, height)) return t("完整解碼：這個尺寸比 1024×1024 大，顯存可能不足（元件會回錯誤，不會自動改成分塊）。建議改成分塊解碼。");
  return null;
}
