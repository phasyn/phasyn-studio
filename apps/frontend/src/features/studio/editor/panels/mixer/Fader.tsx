// A vertical gain fader of the mixer. Dragging is relative to where the cap is (pressing the lane never jumps the
// gain), Shift makes it four times finer and a double click returns to unity. While it is dragged the fader shows the
// draft; the gain is committed once, on release, so one move is one undo step. Arrow keys step by 1 dB (Shift: 0.1),
// Page Up / Down by 6 dB. The scale sits left of the lane; its numbers are printed without sign, as on a console.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useElementSize } from "@/lib/useElementSize";
import { clampGain, FADER_TICKS, faderGain, faderPosition, formatDb, GAIN_MAX_DB, GAIN_MIN_DB } from "./decibels";

/** Height of the cap in px; the scale runs between the cap's centre at the bottom and at the top. */
const CAP = 18;
/** From this height the fader labels every tick. */
const ROOMY_FROM = 190;
const SPARSE_LABELS: ReadonlySet<number> = new Set([12, 0, -12, -24, -60]);

interface Drag {
  position: number;
  y: number;
  /** A press without movement commits nothing (a double click resets instead). */
  moved: boolean;
}

export interface FaderProps {
  /** Name of what the fader controls (its accessible name and tooltip). */
  label: string;
  /** Gain in dB. */
  value: number;
  onCommit: (db: number) => void;
  className?: string;
}

/** Where the cap's centre sits for a position, as a CSS length from the bottom of the lane. */
const centreAt = (position: number) => `calc(${position.toFixed(4)} * (100% - ${CAP}px) + ${CAP / 2}px)`;

function Tick({ db, labelled }: { db: number; labelled: boolean }) {
  const unity = db === 0;
  const line = cn("absolute h-px", unity ? "w-3 bg-fg-secondary" : "w-2 bg-line-strong");
  return (
    <span aria-hidden className="pointer-events-none absolute inset-x-0 h-0" style={{ bottom: centreAt(faderPosition(db)) }}>
      <span className={cn(line, "right-[calc(50%-1px)]")} />
      <span className={cn(line, "left-[calc(50%+11px)]")} />
      {labelled ? (
        <span className={cn("machine absolute right-[calc(50%+14px)] -translate-y-1/2 text-[10px] leading-none whitespace-nowrap", unity ? "text-fg-secondary" : "text-fg-tertiary")}>
          {Math.abs(db)}
        </span>
      ) : null}
    </span>
  );
}

export function Fader({ label, value, onCommit, className }: FaderProps) {
  const lane = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(lane);
  const [drag, setDrag] = useState<Drag | null>(null);
  const shown = drag?.moved ? faderGain(drag.position) : value;
  const position = drag?.moved ? drag.position : faderPosition(value);
  const commit = (db: number) => {
    const next = clampGain(db);
    if (next !== value) onCommit(next);
  };

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ position: faderPosition(value), y: event.clientY, moved: false });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || event.clientY === drag.y || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const travel = Math.max(1, height - CAP);
    const moved = ((drag.y - event.clientY) * (event.shiftKey ? 0.25 : 1)) / travel;
    setDrag({ position: Math.min(1, Math.max(0, drag.position + moved)), y: event.clientY, moved: true });
  };
  const end = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.moved) commit(faderGain(drag.position));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 0.1 : 1;
    const targets: Record<string, number> = {
      ArrowUp: value + step,
      ArrowRight: value + step,
      ArrowDown: value - step,
      ArrowLeft: value - step,
      PageUp: value + 6,
      PageDown: value - 6,
      Home: GAIN_MAX_DB,
      End: GAIN_MIN_DB,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    commit(target);
  };

  return (
    <div
      ref={lane}
      role="slider"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={GAIN_MIN_DB}
      aria-valuemax={GAIN_MAX_DB}
      aria-valuenow={shown}
      aria-valuetext={t("{value} dB", { value: formatDb(shown) })}
      title={t("{label}：拖曳調整（Shift 微調），按兩下回到 0 dB", { label })}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={() => commit(0)}
      onKeyDown={keys}
      className={cn("group/fader relative min-h-20 min-w-0 cursor-ns-resize touch-none rounded-md select-none", className)}
    >
      <span aria-hidden className="absolute left-[calc(50%+6px)] w-1 -translate-x-1/2 rounded-full border border-line-subtle bg-sunken" style={{ top: CAP / 2 - 2, bottom: CAP / 2 - 2 }} />
      {FADER_TICKS.map((tick) => (
        <Tick key={tick} db={tick} labelled={height >= ROOMY_FROM || SPARSE_LABELS.has(tick)} />
      ))}
      <span
        aria-hidden
        className={cn(
          "absolute left-[calc(50%+6px)] w-8 -translate-x-1/2 rounded-[5px] border shadow-edge transition-colors duration-(--duration-fast)",
          drag ? "border-brand-cyan bg-overlay" : "border-line-control bg-raised group-hover/fader:border-fg-secondary",
        )}
        style={{ height: CAP, bottom: `calc(${position.toFixed(4)} * (100% - ${CAP}px))` }}
      >
        <span className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-brand-cyan" />
      </span>
    </div>
  );
}
