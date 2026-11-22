// 介面動作（motion）的純函式：分頁指示線的位置、CSS 時間與位移 token 的解析。
// 只做資料運算；DOM、Motion 與 React hook 在 motion.ts。

export type IndicatorAxis = "x" | "y";

/** 目前分頁在 tablist 內容座標中的起點與長度（沿指示線的軸，px）。 */
export interface AxisBox {
  start: number;
  size: number;
}

export interface IndicatorPlacement {
  offset: number;
  size: number;
}

/** 指示線放在目前分頁上，兩端各內縮 inset px；分頁比兩端內縮還窄時長度為 0（置中）。 */
export function indicatorPlacement(box: AxisBox, inset = 0): IndicatorPlacement {
  const size = Math.max(0, box.size - 2 * Math.max(0, inset));
  return { offset: box.start + (box.size - size) / 2, size };
}

const round = (value: number) => Math.round(value * 100) / 100;

/** 基準長度 1 px 的指示線以 translate＋scale 定位：只改 transform，切換時由合成器補間，不觸發版面計算。 */
export function indicatorTransform(axis: IndicatorAxis, placement: IndicatorPlacement): string {
  const offset = round(placement.offset);
  const size = round(placement.size);
  return axis === "x" ? `translateX(${String(offset)}px) scaleX(${String(size)})` : `translateY(${String(offset)}px) scaleY(${String(size)})`;
}

/** CSS 時間值（"180ms"、"0.24s"）→ 毫秒；空字串或無法解析回 null（呼叫端改用預設）。 */
export function parseCssDuration(raw: string): number | null {
  const match = /^\s*(-?\d*\.?\d+)(ms|s)\s*$/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]) * (match[2]?.toLowerCase() === "s" ? 1000 : 1);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** CSS 長度（"4px"）→ px；無法解析回 null。 */
export function parseCssPixels(raw: string): number | null {
  const match = /^\s*(-?\d*\.?\d+)px\s*$/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
