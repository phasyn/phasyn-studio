import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/**
 * The 6 px gap between panels, which doubles as the drag handle: pointer drag or keyboard (arrow keys ± 16, Home / End;
 * with a defaultValue, Enter or a double click restores it). orientation="vertical" is a vertical line dragged left and
 * right; invert is for a right or bottom panel (dragging left / up makes it larger).
 * The hit area extends 3 px to each side (12 px in all, without changing the layout); the line and the centre grip show
 * on hover, focus and drag, and with grip="always" a faint grip also shows at rest (the Studios' floating panels).
 * Dragging captures the pointer, fixes the page cursor and blocks text selection; unmounting removes the listeners and
 * the cursor style too.
 */
export function Splitter({
  orientation,
  value,
  min,
  max,
  onChange,
  label,
  invert = false,
  defaultValue,
  grip = "hover",
  className,
}: {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  invert?: boolean;
  /** The size Enter or a double click restores; without it there is no restore. */
  defaultValue?: number;
  /** When the centre grip shows: only on hover, focus or drag (default), or always, faintly at rest. */
  grip?: "hover" | "always";
  className?: string;
}) {
  const vertical = orientation === "vertical";
  const activeRef = useRef<{ pointerId: number; stop: () => void } | null>(null);
  /** Time and place of the last press: a second press within 400 ms and 4 px is a double click (no reliance on dblclick, which browsers may skip when pointerdown's default is prevented). */
  const lastPressRef = useRef({ time: -Infinity, x: 0, y: 0 });
  useEffect(
    () => () => {
      activeRef.current?.stop();
    },
    [],
  );
  const clampSize = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  const reset = () => {
    if (defaultValue !== undefined) onChange(clampSize(defaultValue));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    activeRef.current?.stop();
    const previous = lastPressRef.current;
    if (defaultValue !== undefined && event.timeStamp - previous.time < 400 && Math.abs(event.clientX - previous.x) < 4 && Math.abs(event.clientY - previous.y) < 4) {
      lastPressRef.current = { time: -Infinity, x: 0, y: 0 };
      reset();
      return;
    }
    lastPressRef.current = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const origin = vertical ? event.clientX : event.clientY;
    const start = value;
    const style = document.createElement("style");
    style.textContent = `*,*::before,*::after{cursor:${vertical ? "col-resize" : "row-resize"}!important;user-select:none!important;-webkit-user-select:none!important}`;
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const delta = (vertical ? moveEvent.clientX : moveEvent.clientY) - origin;
      onChange(clampSize(start + (invert ? -delta : delta)));
    };
    const up = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId === pointerId) stop();
    };
    const stop = () => {
      if (activeRef.current?.pointerId === pointerId) activeRef.current = null;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", stop);
      style.remove();
      delete element.dataset["dragging"];
      try {
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      } catch {
        // The element is gone: the capture was released with it
      }
    };
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // The pointer is already up: the window listeners still finish the drag
    }
    document.head.append(style);
    element.dataset["dragging"] = "";
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", stop);
    activeRef.current = { pointerId, stop };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = vertical ? (invert ? "ArrowLeft" : "ArrowRight") : invert ? "ArrowUp" : "ArrowDown";
    const shrink = vertical ? (invert ? "ArrowRight" : "ArrowLeft") : invert ? "ArrowDown" : "ArrowUp";
    if (event.key === grow) onChange(clampSize(value + 16));
    else if (event.key === shrink) onChange(clampSize(value - 16));
    else if (event.key === "Home") onChange(min);
    else if (event.key === "End") onChange(max);
    else if (event.key === "Enter" && defaultValue !== undefined) reset();
    else return;
    event.preventDefault();
  };
  return (
    <div /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- This adjustable ARIA separator is operable with arrows and exposes the current value. */
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
       /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- This adjustable ARIA separator is operable with arrows and exposes the current value. */ tabIndex={0}
      title={defaultValue === undefined ? t("拖曳調整大小（焦點在這裡時方向鍵微調）") : t("拖曳調整大小；雙擊或 Enter 還原預設（焦點在這裡時方向鍵微調）")}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      data-grip={grip}
      className={cn("group/splitter relative z-10 shrink-0 touch-none outline-none select-none", vertical ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize", className)}
    >
      <span aria-hidden className={cn("absolute", vertical ? "inset-y-0 -inset-x-[3px]" : "inset-x-0 -inset-y-[3px]")} />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute rounded-full bg-transparent transition-colors duration-150 ease-standard group-hover/splitter:bg-brand-blue/60 group-focus-visible/splitter:bg-focus group-data-[dragging]/splitter:bg-brand-cyan",
          vertical ? "inset-y-2 left-1/2 w-0.5 -translate-x-1/2" : "inset-x-2 top-1/2 h-0.5 -translate-y-1/2",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,box-shadow] duration-150 ease-standard group-hover/splitter:bg-brand-blue group-focus-visible/splitter:bg-focus group-data-[dragging]/splitter:bg-brand-cyan group-data-[dragging]/splitter:shadow-glow-sm",
          grip === "always" ? "bg-line" : "bg-transparent",
          vertical ? "h-8 w-[3px]" : "h-[3px] w-8",
        )}
      />
    </div>
  );
}
