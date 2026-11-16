// 建立研究時的來源檢查與額外局部觀察（純函式）：PNG／JPEG／WebP、最多 24 MiB；局部最多 2 區、0–1 座標、
// 左上角小於右下角、換算成像素至少 32×32（以 floor 計算）。輸入中的座標是原文草稿，檢查與建立時才換算成數字。
import type { PromptCrop } from "../types";
import { t } from "@/i18n";

export const SOURCE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
export const MAX_CROPS = 2;
export const MIN_CROP_PIXELS = 32;

/** 來源圖片檔不能用的原因；可以時為 null。 */
export function sourceFileProblem(file: { type: string; size: number }): string | null {
  if (!SOURCE_TYPES.includes(file.type)) return t("只接受 PNG、JPEG 或 WebP 圖片");
  if (file.size > MAX_SOURCE_BYTES) return t("圖片超過 24 MiB");
  if (file.size === 0) return t("檔案是空的");
  return null;
}

export function newCrop(existing: readonly PromptCrop[]): PromptCrop | null {
  if (existing.length >= MAX_CROPS) return null;
  const view = existing.some((crop) => crop.view_id === "v-crop-1") ? "v-crop-2" : "v-crop-1";
  return { view_id: view, x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 };
}

export const CROP_KEYS = ["x0", "y0", "x1", "y1"] as const;
export type CropKey = (typeof CROP_KEYS)[number];

/** 局部的輸入草稿：座標保留使用者打的原文（打到一半的「0.」「.」或清空都照樣顯示，不會先變成 0）。 */
export type CropDraft = Pick<PromptCrop, "view_id"> & Record<CropKey, string>;

export function cropDraft(crop: PromptCrop): CropDraft {
  return { view_id: crop.view_id, x0: String(crop.x0), y0: String(crop.y0), x1: String(crop.x1), y1: String(crop.y1) };
}

/** 草稿換算成局部：空白或讀不出數字的座標是 NaN，由 cropProblems 擋下，不會被當成 0 送出。 */
export function cropFromDraft(draft: CropDraft): PromptCrop {
  const read = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));
  return { view_id: draft.view_id, x0: read(draft.x0), y0: read(draft.y0), x1: read(draft.x1), y1: read(draft.y1) };
}

/** 座標是否在 0–1（NaN 不算）。 */
export function coordinateInRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** 局部座標的問題（依序列出）；size 未知時不檢查像素下限。 */
export function cropProblems(crops: readonly PromptCrop[], size: { width: number; height: number } | null): string[] {
  const problems: string[] = [];
  if (crops.length > MAX_CROPS) problems.push(t("最多 {maxCrops} 個局部", { maxCrops: MAX_CROPS }));
  if (new Set(crops.map((crop) => crop.view_id)).size !== crops.length) problems.push(t("局部的 view_id 不可重複"));
  for (const crop of crops) {
    if (CROP_KEYS.some((key) => !coordinateInRange(crop[key]))) {
      problems.push(t("{view_id}：座標必須在 0–1", { view_id: crop.view_id }));
      continue;
    }
    if (crop.x0 >= crop.x1 || crop.y0 >= crop.y1) {
      problems.push(t("{view_id}：左上角必須小於右下角（x0<x1、y0<y1）", { view_id: crop.view_id }));
      continue;
    }
    if (size) {
      const width = Math.floor(crop.x1 * size.width) - Math.floor(crop.x0 * size.width);
      const height = Math.floor(crop.y1 * size.height) - Math.floor(crop.y0 * size.height);
      if (width < MIN_CROP_PIXELS || height < MIN_CROP_PIXELS) problems.push(t("{view_id}：換算後只有 {width}×{height} px，至少要 {minCropPixels}×{minCropPixels2}", { view_id: crop.view_id, width, height, minCropPixels: MIN_CROP_PIXELS, minCropPixels2: MIN_CROP_PIXELS }));
    }
  }
  return problems;
}

/** 建立研究用的預設名稱：檔名去掉副檔名。 */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 120);
}
