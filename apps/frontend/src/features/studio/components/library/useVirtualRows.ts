// 素材庫的視窗化（只掛上看得到的列＋上下各幾列）：捲動容器的高度、寬度與捲動位置由 ResizeObserver／scroll 事件更新。
// 素材庫最多 500 個項目，但影片縮圖是 <video preload="metadata">，全部掛上會同時讀幾百個檔頭，所以只掛看得到的。
import { useLayoutEffect, useState, type RefObject } from "react";

export interface VirtualViewport {
  width: number;
  height: number;
  scrollTop: number;
}

export interface VirtualRows {
  /** 要掛上的第一列與最後一列之後（不含）。 */
  start: number;
  end: number;
  /** 上方與下方的留白（px）。 */
  padTop: number;
  padBottom: number;
  viewport: VirtualViewport;
}

const EMPTY: VirtualViewport = { width: 0, height: 0, scrollTop: 0 };

/** 量捲動容器（寬、高、捲動位置）；容器換掉時重新訂閱。 */
export function useViewport(scrollRef: RefObject<HTMLElement | null>, deps: unknown): VirtualViewport {
  const [viewport, setViewport] = useState<VirtualViewport>(EMPTY);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const read = () => { setViewport((current) =>
        current.width === element.clientWidth && current.height === element.clientHeight && current.scrollTop === element.scrollTop
          ? current
          : { width: element.clientWidth, height: element.clientHeight, scrollTop: element.scrollTop },
      ); };
    const observer = new ResizeObserver(read);
    observer.observe(element);
    element.addEventListener("scroll", read, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", read);
    };
  }, [scrollRef, deps]);
  return viewport;
}

/** rowCount 列、每列 rowHeight px（含間距）時要掛上的範圍。 */
export function virtualRows(viewport: VirtualViewport, rowCount: number, rowHeight: number, overscan = 3): VirtualRows {
  if (rowCount === 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, viewport };
  // 還沒量到高度（第一次 render）時先掛一屏左右，避免先閃一下空白
  const height = viewport.height || 900;
  const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan);
  const end = Math.min(rowCount, Math.ceil((viewport.scrollTop + height) / rowHeight) + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (rowCount - end) * rowHeight, viewport };
}
