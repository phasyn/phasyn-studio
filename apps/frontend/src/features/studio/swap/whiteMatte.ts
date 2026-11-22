import { t } from "@/i18n";
// 角色圖鋪白底：H3 runtime 讀透明 PNG 時會自己鋪白底（舊版直接丟掉 alpha，透明區變成黑底貼圖）。精靈仍在瀏覽器把圖畫到白底上，
// 讓使用者看到模型實際讀到的畫面，另存一張新 PNG
// 上傳；原圖不修改（保留在素材庫）。不裁切：裁到人物範圍會讓圖更細長，H3 預處理（短邊 2048）後面積更大、更耗顯存。
// 像素判斷是純函式（可測）；解碼與畫布只在瀏覽器執行。

/** 有沒有不透明度低於 255 的像素（RGBA 位元組陣列）。 */
export function hasTransparency(data: Uint8ClampedArray | Uint8Array): boolean {
  for (let index = 3; index < data.length; index += 4) if ((data[index] ?? 255) < 255) return true;
  return false;
}

/** 白底合成後的像素（純函式，給測試與說明用）：out = α·c + (1 − α)·255。 */
export function compositeOnWhite(r: number, g: number, b: number, a: number): [number, number, number] {
  const alpha = a / 255;
  const mix = (channel: number) => Math.round(channel * alpha + 255 * (1 - alpha));
  return [mix(r), mix(g), mix(b)];
}

/** 白底副本的檔名：「名稱（白底）.png」。 */
export function matteName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return t("{base}（白底）.png", { base }).slice(0, 200);
}

export interface ImageCheck {
  width: number;
  height: number;
  transparent: boolean;
  /** 白底副本（透明圖才有）。 */
  matte: Blob | null;
}

/** 解碼圖片、判斷透明，透明時產生白底 PNG。JPEG 一律不透明，不必掃描。 */
export async function checkImage(blob: Blob): Promise<ImageCheck> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (blob.type === "image/jpeg") return { width, height, transparent: false, matte: null };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(t("瀏覽器無法建立畫布"));
    context.drawImage(bitmap, 0, 0);
    const transparent = hasTransparency(context.getImageData(0, 0, width, height).data);
    if (!transparent) return { width, height, transparent: false, matte: null };
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    const matte = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, "image/png"); });
    if (!matte) throw new Error(t("瀏覽器無法輸出白底 PNG"));
    return { width, height, transparent: true, matte };
  } finally {
    bitmap.close();
  }
}
