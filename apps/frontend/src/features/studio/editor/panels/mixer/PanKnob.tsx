// The pan control of a channel strip: a knob from full left (-1) over the centre (0) to full right (1). Dragging up
// or to the right turns it clockwise (Shift makes it finer), a double click centres it, and the pan is committed
// once, on release. Arrow keys step by 5 (Shift: 1) hundredths.
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

/** Pointer travel in px from the centre to one end. */
const TRAVEL = 120;
/** Degrees the knob turns to each side. */
const SWEEP = 135;
const CENTRE = 18;
const RING = 16;
const POINTER = 9;

interface Drag {
  value: number;
  x: number;
  y: number;
  moved: boolean;
}

export interface PanKnobProps {
  /** Name of the control (its accessible name and tooltip). */
  label: string;
  /** -1 (left) … 1 (right). */
  value: number;
  onCommit: (pan: number) => void;
  className?: string;
}

const clampPan = (value: number) => Math.round(Math.min(1, Math.max(-1, value)) * 100) / 100;

/** "左 40", "置中", "右 100": the side and how far, in hundredths. */
function panText(value: number): string {
  const amount = Math.round(Math.abs(value) * 100);
  if (amount === 0) return t("置中");
  return value < 0 ? t("左 {amount}", { amount }) : t("右 {amount}", { amount });
}

/** The point on a circle around the knob's centre, `degrees` clockwise from the top. */
function pointAt(radius: number, degrees: number): string {
  const angle = (degrees * Math.PI) / 180;
  return `${(CENTRE + radius * Math.sin(angle)).toFixed(2)} ${(CENTRE - radius * Math.cos(angle)).toFixed(2)}`;
}

export function PanKnob({ label, value, onCommit, className }: PanKnobProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const shown = drag?.moved ? drag.value : value;
  const degrees = shown * SWEEP;
  const commit = (pan: number) => {
    const next = clampPan(pan);
    if (next !== value) onCommit(next);
  };

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ value, x: event.clientX, y: event.clientY, moved: false });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const moved = event.clientX - drag.x + (drag.y - event.clientY);
    if (moved === 0) return;
    const next = drag.value + (moved * (event.shiftKey ? 0.25 : 1)) / TRAVEL;
    setDrag({ value: Math.min(1, Math.max(-1, next)), x: event.clientX, y: event.clientY, moved: true });
  };
  const end = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.moved) commit(drag.value);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 0.01 : 0.05;
    const targets: Record<string, number> = {
      ArrowRight: value + step,
      ArrowUp: value + step,
      ArrowLeft: value - step,
      ArrowDown: value - step,
      Home: -1,
      End: 1,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    commit(target);
  };

  return (
    <div className={cn("grid justify-items-center gap-0.5", className)}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        aria-valuetext={panText(shown)}
        title={t("{label}：拖曳調整（Shift 微調），按兩下置中", { label })}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={() => commit(0)}
        onKeyDown={keys}
        className="group/knob size-9 cursor-ns-resize touch-none rounded-full select-none"
      >
        <svg viewBox="0 0 36 36" aria-hidden className="size-full">
          <path d={`M ${pointAt(RING, -SWEEP)} A ${RING} ${RING} 0 1 1 ${pointAt(RING, SWEEP)}`} fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-line-strong" />
          {degrees !== 0 ? (
            <path d={`M ${pointAt(RING, 0)} A ${RING} ${RING} 0 0 ${degrees > 0 ? 1 : 0} ${pointAt(RING, degrees)}`} fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-brand-cyan" />
          ) : null}
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r="11.5"
            className={cn("fill-raised transition-colors duration-(--duration-fast)", drag ? "stroke-brand-cyan" : "stroke-line-control group-hover/knob:stroke-fg-secondary")}
          />
          <path d={`M ${pointAt(3, degrees)} L ${pointAt(POINTER, degrees)}`} strokeWidth="2" strokeLinecap="round" className="stroke-brand-cyan" />
        </svg>
      </div>
      <span aria-hidden className={cn("text-[11px] leading-4 whitespace-nowrap", shown === 0 ? "text-fg-tertiary" : "text-fg-secondary")}>
        {panText(shown)}
      </span>
    </div>
  );
}
