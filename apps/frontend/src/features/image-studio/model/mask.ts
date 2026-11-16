import { t } from "@/i18n";
// 遮罩的像素規則（純函式）：
// - 編輯中的遮罩是一張 RGBA 畫布：白色＋alpha，alpha＝可編輯程度（255＝使用新生成內容、0＝保留底圖、中間＝柔化邊界）。
// - 匯出成灰階 PNG：疊在黑底上（灰階值＝alpha），白＝新內容、黑＝保留底圖（inputs.py 的合成規則）。
// - 反轉（mask_invert）是送給 qimg.prepare 的參數，不改匯出的像素；畫面上的藍色覆蓋與「全選／清空」都依「實際可編輯範圍」。
// - 匯入灰階圖：亮度（Pillow L 的權重）變成 alpha。

export interface CanvasPoint {
  x: number;
  y: number;
}

export const BRUSH = { min: 4, max: 256, step: 4, initial: 48 } as const;

/** 視窗座標 → 畫布座標（畫布以 CSS 縮放顯示；夾在畫布範圍內）。 */
export function canvasPoint(clientX: number, clientY: number, bounds: { left: number; top: number; width: number; height: number }, width: number, height: number): CanvasPoint {
  return {
    x: Math.max(0, Math.min(width, ((clientX - bounds.left) / Math.max(1, bounds.width)) * width)),
    y: Math.max(0, Math.min(height, ((clientY - bounds.top) / Math.max(1, bounds.height)) * height)),
  };
}

/** Pillow convert("L") 的權重；匯入的 alpha 不看（與後端匯入一致）。原地改寫成「白色＋alpha」。 */
export function luminanceToAlpha(pixels: Uint8ClampedArray): void {
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = Math.round((pixels[index] ?? 0) * 0.299 + (pixels[index + 1] ?? 0) * 0.587 + (pixels[index + 2] ?? 0) * 0.114);
    pixels[index] = 255;
    pixels[index + 1] = 255;
    pixels[index + 2] = 255;
    pixels[index + 3] = luminance;
  }
}

/** 編輯中的遮罩（白色＋alpha）→ 匯出用的灰階像素（RGBA，不透明）：疊在黑底上，灰階＝alpha。 */
export function maskExportPixels(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    // 遮罩一律是白色筆觸：白×alpha＋黑×(1−alpha)＝alpha（四捨五入與 canvas 合成一致）
    const grey = Math.round(((pixels[index] ?? 255) * alpha) / 255);
    out[index] = grey;
    out[index + 1] = grey;
    out[index + 2] = grey;
    out[index + 3] = 255;
  }
  return out;
}

/** 「全選」（全部可編輯）或「清空」（全部保留）在反轉狀態下該填的 alpha：反轉時填的值相反。 */
export function fillAlpha(editableEverywhere: boolean, invert: boolean): 0 | 255 {
  return editableEverywhere !== invert ? 255 : 0;
}

/** 實際可編輯範圍（0–1）：alpha 的平均，反轉時取補數；沒有像素時 0。 */
export function editableFraction(pixels: Uint8ClampedArray, invert: boolean): number {
  let sum = 0;
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    sum += pixels[index] ?? 0;
    count += 1;
  }
  if (count === 0) return 0;
  const fraction = sum / (count * 255);
  return invert ? 1 - fraction : fraction;
}

/**
 * The note for the mask as it is now (coverage from editableFraction; null while it is read): the whole image
 * regenerated, or the whole image kept although a mask is on; anything in between needs no note. It is derived from
 * the pixels, never from the last button pressed, so undo and later strokes cannot leave it stale.
 */
export function maskExtentNote(coverage: number | null): string | null {
  if (coverage === 1) return t("整張都會使用新生成內容。");
  if (coverage === 0) return t("整張都會保留底圖（遮罩仍啟用）。");
  return null;
}

/** 復原步數上限：每一步存一張整張畫布，總量約 32 MiB（1–8 步）。 */
export function historyLimit(width: number, height: number): number {
  return Math.max(1, Math.min(8, Math.floor((32 * 1024 * 1024) / Math.max(1, width * height * 4))));
}

export function clampBrush(size: number): number {
  if (!Number.isFinite(size)) return BRUSH.initial;
  return Math.min(BRUSH.max, Math.max(BRUSH.min, Math.round(size / BRUSH.step) * BRUSH.step));
}

/** 鍵盤移動游標的距離（畫布像素）：一般＝畫布長邊的 1/64，Shift＝1/16。 */
export function keyboardStep(width: number, height: number, large: boolean): number {
  const side = Math.max(width, height);
  return Math.max(1, Math.round(side / (large ? 16 : 64)));
}

/** 鍵盤游標移動（夾在畫布內）。 */
export function moveCursor(point: CanvasPoint, key: string, step: number, width: number, height: number): CanvasPoint | null {
  const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const move = delta[key];
  if (!move) return null;
  return { x: Math.max(0, Math.min(width, point.x + move[0])), y: Math.max(0, Math.min(height, point.y + move[1])) };
}

/** 匯入的遮罩圖片的大小限制（與 qimg.prepare 相同：≤ 2,000 萬像素、最長邊 ≤ 8192）。 */
export function importSizeProblem(width: number, height: number): string | null {
  if (width * height > 20_000_000 || Math.max(width, height) > 8192) return t("圖片不可超過 2,000 萬像素，且最長邊不可超過 8192 像素");
  return null;
}
