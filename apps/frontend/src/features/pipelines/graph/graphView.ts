// 畫布視角（純函式）：平移＋縮放、符合視窗、讓節點進入畫面、方向鍵找最近節點、小地圖比例。
// 視角 transform：螢幕座標 = 內容座標 × k + (x, y)。
import type { NodeBox, Point } from "./graphTypes";

export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 1.2;
/** 符合視窗時的邊距（上方留給工具列）。 */
export const FIT_MARGIN = { top: 48, right: 16, bottom: 16, left: 16 } as const;
/** 平移時至少保留在畫面內的內容寬度，避免把整張圖拖丟。 */
const KEEP_VISIBLE = 48;

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
}

/** 初次顯示時的最小縮放：再小節點文字就讀不到；整張放不下時改從左上（輸入端）開始，其餘以平移或小地圖查看。 */
export const AUTO_FIT_MIN = 0.6;

/**
 * 整張圖置中並縮到能完整顯示（最大 100%，不放大小圖）。minZoom：縮放下限；被下限擋住而放不下的方向改為從起點（左／上）對齊。
 */
export function fitView(content: Size, viewport: Size, minZoom = ZOOM_MIN): ViewTransform {
  const availableW = Math.max(1, viewport.width - FIT_MARGIN.left - FIT_MARGIN.right);
  const availableH = Math.max(1, viewport.height - FIT_MARGIN.top - FIT_MARGIN.bottom);
  const raw = Math.min(1, availableW / Math.max(1, content.width), availableH / Math.max(1, content.height));
  const k = clampZoom(Math.max(raw, Math.min(1, minZoom)));
  const width = content.width * k;
  const height = content.height * k;
  return {
    k,
    x: width <= availableW ? FIT_MARGIN.left + (availableW - width) / 2 : FIT_MARGIN.left,
    y: height <= availableH ? FIT_MARGIN.top + (availableH - height) / 2 : FIT_MARGIN.top,
  };
}

/** 以螢幕上的 point 為中心縮放（該點下的內容不動）。 */
export function zoomAround(view: ViewTransform, nextK: number, point: Point): ViewTransform {
  const k = clampZoom(nextK);
  const contentX = (point.x - view.x) / view.k;
  const contentY = (point.y - view.y) / view.k;
  return { k, x: point.x - contentX * k, y: point.y - contentY * k };
}

/** 平移限制：內容至少有 KEEP_VISIBLE px 留在畫面內。 */
export function clampView(view: ViewTransform, content: Size, viewport: Size): ViewTransform {
  if (viewport.width <= 0 || viewport.height <= 0) return view;
  const keepX = Math.min(KEEP_VISIBLE, content.width * view.k);
  const keepY = Math.min(KEEP_VISIBLE, content.height * view.k);
  return {
    k: view.k,
    x: Math.min(viewport.width - keepX, Math.max(keepX - content.width * view.k, view.x)),
    y: Math.min(viewport.height - keepY, Math.max(keepY - content.height * view.k, view.y)),
  };
}

export function screenRect(box: Rect, view: ViewTransform): Rect {
  return { x: box.x * view.k + view.x, y: box.y * view.k + view.y, width: box.width * view.k, height: box.height * view.k };
}

/** 節點是否完整在畫面內（留 margin）。 */
export function isBoxVisible(box: Rect, view: ViewTransform, viewport: Size, margin = 8): boolean {
  const rect = screenRect(box, view);
  return rect.x >= margin && rect.y >= margin && rect.x + rect.width <= viewport.width - margin && rect.y + rect.height <= viewport.height - margin;
}

function revealAxis(start: number, length: number, viewportLength: number, margin: number): number {
  if (length > viewportLength - margin * 2) return margin - start; // 比畫面大：對齊起點。
  if (start < margin) return margin - start;
  if (start + length > viewportLength - margin) return viewportLength - margin - (start + length);
  return 0;
}

/** 最小平移讓節點進入畫面（不改縮放、不做動畫）。 */
export function revealBox(view: ViewTransform, box: Rect, viewport: Size, margin = 24): ViewTransform {
  const rect = screenRect(box, view);
  return {
    k: view.k,
    x: view.x + revealAxis(rect.x, rect.width, viewport.width, margin),
    y: view.y + revealAxis(rect.y, rect.height, viewport.height, margin),
  };
}

/** 目前畫面對應的內容範圍（小地圖的視窗框）。 */
export function visibleContentRect(view: ViewTransform, viewport: Size): Rect {
  return { x: -view.x / view.k, y: -view.y / view.k, width: viewport.width / view.k, height: viewport.height / view.k };
}

/** 內容是否超出畫面（決定是否顯示小地圖）。 */
export function contentOverflows(content: Size, view: ViewTransform, viewport: Size): boolean {
  const rect = screenRect({ x: 0, y: 0, ...content }, view);
  return rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height;
}

/** 讓內容座標 point 落在畫面中央。 */
export function centerOn(view: ViewTransform, point: Point, viewport: Size): ViewTransform {
  return { k: view.k, x: viewport.width / 2 - point.x * view.k, y: viewport.height / 2 - point.y * view.k };
}

export type Direction = "left" | "right" | "up" | "down";

/** 方向鍵：在該方向（半平面）內找加權距離最近的節點（主軸距離＋2×副軸距離）。 */
export function nearestInDirection(boxes: Iterable<NodeBox>, fromKey: string, direction: Direction): NodeBox | null {
  const all = [...boxes];
  const from = all.find((box) => box.key === fromKey);
  if (!from) return null;
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  let best: NodeBox | null = null;
  let bestScore = Infinity;
  for (const box of all) {
    if (box.key === fromKey) continue;
    const dx = box.x + box.width / 2 - cx;
    const dy = box.y + box.height / 2 - cy;
    const primary = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (primary <= 1) continue;
    const score = primary + secondary * 2;
    if (score < bestScore) {
      best = box;
      bestScore = score;
    }
  }
  return best;
}

/** 閱讀順序：由左到右（層）、由上到下。 */
export function readingOrder(boxes: Iterable<NodeBox>): NodeBox[] {
  return [...boxes].sort((a, b) => a.layer - b.layer || a.y - b.y);
}
