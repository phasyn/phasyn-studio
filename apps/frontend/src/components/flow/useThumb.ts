// 分段控制的滑動底塊（segmented thumb 用 snappy 彈簧滑動）：把 thumb 放到 container 內目前選項的位置與大小
// （transform＋width／height；container 必須是 position: relative，選項是它的子元素）。選取改變時滑過去，第一次出現直接就位；
// 尺寸變化（字型載入、視窗縮放、標籤換語言變長）由 ResizeObserver 補上。純呈現：選取狀態由原生 radio／aria-selected 決定，
// 不等動畫。
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export function useThumb(containerRef: RefObject<HTMLElement | null>, thumbRef: RefObject<HTMLElement | null>, selector: string): void {
  const placedRef = useRef(false);
  const placeRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    placeRef.current = () => {
      const container = containerRef.current;
      const thumb = thumbRef.current;
      if (!container || !thumb) return;
      const active = container.querySelector<HTMLElement>(selector);
      if (!active || active.offsetWidth === 0) {
        thumb.style.opacity = "0";
        placedRef.current = false;
        return;
      }
      const first = !placedRef.current;
      if (first) thumb.style.transition = "none";
      thumb.style.transform = `translate(${String(active.offsetLeft)}px, ${String(active.offsetTop)}px)`;
      thumb.style.width = `${String(active.offsetWidth)}px`;
      thumb.style.height = `${String(active.offsetHeight)}px`;
      thumb.style.opacity = "1";
      if (first) {
        thumb.getBoundingClientRect();
        thumb.style.removeProperty("transition");
        placedRef.current = true;
      }
    };
    placeRef.current();
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { placeRef.current(); });
    observer.observe(container);
    for (const child of Array.from(container.children)) if (child !== thumbRef.current) observer.observe(child);
    return () => { observer.disconnect(); };
  }, [containerRef, thumbRef]);
}
