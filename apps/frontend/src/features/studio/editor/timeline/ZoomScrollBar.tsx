// The navigator under the tracks: the bar is the whole sequence, the thumb the visible span. Drag the thumb to scroll,
// drag one of its ends to zoom while the other end stays put.
import type { PointerEvent } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

export interface ZoomScrollBarProps {
  /** Width of the whole content in px at the current zoom. */
  content: number;
  /** Visible width in px. */
  viewport: number;
  scrollLeft: number;
  zoom: number;
  onScroll: (left: number) => void;
  /** New zoom with the frame that must stay at the left edge of the view. */
  onZoom: (zoom: number, firstFrame: number) => void;
}

type Part = "thumb" | "start" | "end";

export function ZoomScrollBar({ content, viewport, scrollLeft, zoom, onScroll, onZoom }: ZoomScrollBarProps) {
  const total = Math.max(1, content);
  const start = Math.max(0, Math.min(1, scrollLeft / total));
  const size = Math.max(0.02, Math.min(1, viewport / total));
  const drag = (event: PointerEvent<HTMLElement>, part: Part) => {
    const bar = event.currentTarget.closest<HTMLElement>("[data-zoom-bar]");
    if (event.button !== 0 || !bar) return;
    event.preventDefault();
    event.stopPropagation();
    const width = bar.getBoundingClientRect().width;
    const origin = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const firstFrame = scrollLeft / zoom;
    const lastFrame = (scrollLeft + viewport) / zoom;
    const move = (moved: globalThis.PointerEvent) => {
      const delta = ((moved.clientX - origin) / Math.max(1, width)) * (total / zoom);
      if (part === "thumb") {
        onScroll((firstFrame + delta) * zoom);
        return;
      }
      // The dragged end follows the pointer; the opposite end keeps its frame
      const from = part === "start" ? Math.min(lastFrame - 1, Math.max(0, firstFrame + delta)) : firstFrame;
      const to = part === "end" ? Math.max(firstFrame + 1, lastFrame + delta) : lastFrame;
      onZoom(viewport / Math.max(1, to - from), from);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const handle = "absolute inset-y-0 w-2 cursor-ew-resize touch-none rounded-full bg-fg-tertiary/70 transition-colors duration-(--duration-fast) hover:bg-brand-cyan";
  return (
    <div data-zoom-bar="" data-keep-focus="" className="relative mx-2 my-1 h-3 shrink-0 rounded-full bg-sunken" role="group" aria-label={t("時間軸導覽列")}>
      <div
        className={cn("absolute inset-y-0 cursor-grab touch-none rounded-full bg-line-strong transition-colors duration-(--duration-fast) hover:bg-line-control active:cursor-grabbing")}
        style={{ left: `${start * 100}%`, width: `${Math.min(size, 1 - start) * 100}%` }}
        onPointerDown={(event) => drag(event, "thumb")}
        title={t("拖曳捲動；拖曳兩端縮放")}
      >
        <span className={cn(handle, "left-0")} onPointerDown={(event) => drag(event, "start")} />
        <span className={cn(handle, "right-0")} onPointerDown={(event) => drag(event, "end")} />
      </div>
    </div>
  );
}
