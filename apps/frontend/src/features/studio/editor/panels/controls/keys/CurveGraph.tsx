// The curve of an animated property over the part of its clip that plays, in the key strip. Every key is a point,
// known by its frame (a removed key takes its point with it): a press selects it (and moves the playhead there), a
// drag changes its frame and its value and is committed once, on release. With the keyboard: the left and right arrows
// move the focused key by a frame, up and down change its value by one step of its field (Shift: ten), Enter selects
// it, Delete removes it; a key that moved keeps the focus at its new frame. The graph is drawn at the size it is
// given, so it fits whatever height the strip has.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useElementSize } from "@/lib/useElementSize";
import { evaluateCurve } from "../../../curves";
import { toClipLocalFrame } from "../../../model";
import { shortTimecode } from "../lanes/laneGeometry";
import { roundTo } from "../numbers";
import { useClipPanel } from "../panelContext";
import { documentStep, formatShown, keyFrameRange, playheadIn, propertyName, shownKeys, shownValue, valueAt, type ClipProperty } from "../properties";
import { usePlayheadValue } from "../usePlayheadValue";

/** Room around the plot, in px: a point on an edge is drawn whole. */
const PAD = 10;
/** A point follows the pointer on an axis only after this many px, so a move along one axis leaves the other alone. */
const SLACK = 4;
const AXIS_LABEL = "pointer-events-none absolute left-1 font-mono text-[11px] leading-3 text-fg-tertiary";

/** Gives the focus to a key that has just moved to another frame: its point is a new element there. */
const takeFocus = (node: SVGCircleElement | null) => {
  node?.focus({ preventScroll: true });
};

/** A key's frame and value: where it is, or where a drag or a nudge takes it. */
interface KeyPlace {
  frame: number;
  value: number;
}

interface PointDrag extends KeyPlace {
  /** The key's frame in the document. */
  from: number;
  /** Where the pointer went down. */
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The values the graph shows from bottom to top: what the curve reaches with some air around it, and never less than
 * a quarter of the property's range, so a flat curve still leaves room to drag a key somewhere else.
 */
function valueScale(property: ClipProperty, owner: TimelineClip, step: number): { low: number; high: number } {
  const range = keyFrameRange(owner);
  const values = [valueAt(property, range.min), ...shownKeys(owner, property).map((key) => key.value), valueAt(property, range.max)];
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  const air = Math.max(step * 5, (highest - lowest) * 0.15);
  const reach = Math.min(property.max - property.min, Math.max(highest - lowest + 2 * air, (property.max - property.min) / 4));
  // Centred on the curve, pushed back inside the property's range where it would leave it
  const low = clamp((highest + lowest - reach) / 2, property.min, property.max - reach);
  return { low, high: Math.max(low + reach, low + step) };
}

/** The keys with the dragged one where the pointer has it, in time order: the curve as it will be. */
function previewKeys(keys: TimelineKeyframe[], drag: PointDrag | null): TimelineKeyframe[] {
  if (!drag) return keys;
  return keys.map((key) => (key.frame === drag.from ? { ...key, frame: drag.frame, value: drag.value } : key)).sort((a, b) => a.frame - b.frame);
}

/** The playhead on the graph, while it is on the clip. It follows the playhead by itself. */
function GraphPlayhead({ owner, width }: { owner: TimelineClip; width: number }) {
  const panel = useClipPanel();
  const range = keyFrameRange(owner);
  const fraction = usePlayheadValue(panel.playhead, (frame) => {
    const at = playheadIn(owner, frame);
    return at.inside ? (at.processing - range.min) / Math.max(1, range.max - range.min) : -1;
  });
  if (fraction < 0) return null;
  const left = PAD + fraction * Math.max(1, width - 2 * PAD);
  return <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-playhead/70" style={{ left }} />;
}

export interface CurveGraphProps {
  property: ClipProperty;
  /** The clip the property belongs to. */
  owner: TimelineClip;
  /** Frame of the selected key. */
  selected: number;
  /** Why the keys cannot be changed; null when they can. */
  locked: string | null;
  onSelect: (key: TimelineKeyframe) => void;
  /** A key was dragged or nudged: its frame in the document, and its frame and value now; true when the document took it. */
  onChange: (from: number, to: KeyPlace) => boolean;
  onRemove: (key: TimelineKeyframe) => void;
}

export function CurveGraph({ property, owner, selected, locked, onSelect, onChange, onRemove }: CurveGraphProps) {
  const panel = useClipPanel();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const [drag, setDrag] = useState<PointDrag | null>(null);
  const [moved, setMoved] = useState<number | null>(null);
  const { unit } = property;
  const range = keyFrameRange(owner);
  const frames = Math.max(1, range.max - range.min);
  const step = documentStep(unit);
  const scale = valueScale(property, owner, step);
  const span = scale.high - scale.low;
  const plotWidth = Math.max(1, width - 2 * PAD);
  const plotHeight = Math.max(1, height - 2 * PAD);
  const x = (frame: number) => PAD + ((frame - range.min) / frames) * plotWidth;
  const y = (value: number) => PAD + plotHeight - clamp((value - scale.low) / span, 0, 1) * plotHeight;
  /** A key moved by frames and by steps of its value, kept inside the part of the clip that plays and the property's range. */
  const shifted = (key: TimelineKeyframe, byFrames: number, bySteps: number): KeyPlace => ({
    frame: clamp(key.frame + byFrames, range.min, range.max),
    // A value that is not moved stays exactly what it is: rounding it would count as a change
    value: bySteps === 0 ? key.value : clamp(roundTo(key.value + bySteps * step, 6), property.min, property.max),
  });

  const keys = previewKeys(property.keys, drag);
  const samples = Math.max(2, Math.round(plotWidth / 2));
  let curve = "";
  for (let index = 0; index <= samples; index += 1) {
    const at = range.min + (frames * index) / samples;
    curve += `${index === 0 ? "M" : "L"}${x(at).toFixed(1)},${y(evaluateCurve(keys, at, property.value)).toFixed(1)}`;
  }
  const guides = [0, 0.5, 1].map((fraction) => `M${String(PAD)},${(PAD + fraction * plotHeight).toFixed(1)}H${(PAD + plotWidth).toFixed(1)}`).join("");

  const dragged = (event: PointerEvent<SVGCircleElement>, key: TimelineKeyframe, from: PointDrag): PointDrag => {
    const slack = (delta: number) => Math.sign(delta) * Math.max(0, Math.abs(delta) - SLACK);
    const byFrames = Math.round((slack(event.clientX - from.x) / plotWidth) * frames);
    const bySteps = Math.round((-(slack(event.clientY - from.y) / plotHeight) * span) / step);
    return { ...from, ...shifted(key, byFrames, bySteps) };
  };
  /** A change of a key; when it took the key to another frame, its new point takes the focus. */
  const change = (from: number, to: KeyPlace) => {
    if (onChange(from, to) && to.frame !== from) setMoved(to.frame);
  };
  const nudge = (event: KeyboardEvent<SVGCircleElement>, key: TimelineKeyframe) => {
    const large = event.shiftKey ? 10 : 1;
    const byFrames = event.key === "ArrowLeft" ? -large : event.key === "ArrowRight" ? large : 0;
    const bySteps = event.key === "ArrowUp" ? large : event.key === "ArrowDown" ? -large : 0;
    if (byFrames !== 0 || bySteps !== 0) {
      event.preventDefault();
      if (!(locked != null && locked !== "") && !event.repeat) change(key.frame, shifted(key, byFrames, bySteps));
    } else if (event.key === "Enter") {
      event.preventDefault();
      onSelect(key);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!(locked != null && locked !== "") && !event.repeat) onRemove(key);
    }
  };

  return (
    <div ref={boxRef} className="relative h-full min-w-0 flex-1 overflow-hidden rounded-md border border-line-subtle bg-sunken">
      {width > 0 && height > 0 ? (
        <svg
          width={width}
          height={height}
          role="group"
          aria-label={t("{name} 的曲線", { name: propertyName(property) })}
          className="absolute inset-0 touch-none"
        >
          <path d={guides} className="fill-none stroke-line-subtle" strokeWidth="1" />
          <path d={curve} className="fill-none stroke-brand-cyan" strokeWidth="1.5" />
          {shownKeys(owner, property).map((key) => {
            const point: KeyPlace = drag?.from === key.frame ? drag : key;
            const chosen = key.frame === selected;
            return (
              <circle
                key={key.frame}
                ref={key.frame === moved ? takeFocus : undefined}
                cx={x(point.frame)}
                cy={y(point.value)}
                r={chosen ? 5 : 4}
                tabIndex={0}
                role="slider"
                aria-label={t("{time} 的關鍵影格", { time: shortTimecode(toClipLocalFrame(owner, point.frame), panel.fps) })}
                aria-valuemin={shownValue(unit, property.min)}
                aria-valuemax={shownValue(unit, property.max)}
                aria-valuenow={shownValue(unit, point.value)}
                aria-valuetext={formatShown(unit, point.value)}
                strokeWidth="1.5"
                className={cn(
                  "outline-none focus-visible:stroke-focus",
                  chosen ? "fill-brand-cyan stroke-fg" : "fill-sunken stroke-brand-cyan",
                  !(locked != null && locked !== "") && "cursor-grab active:cursor-grabbing",
                )}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDrag({ from: key.frame, frame: key.frame, value: key.value, x: event.clientX, y: event.clientY });
                }}
                onPointerMove={(event) => {
                  if (drag?.from !== key.frame || (locked != null && locked !== "") || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  setDrag(dragged(event, key, drag));
                }}
                onPointerUp={(event) => {
                  if (drag?.from !== key.frame) return;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                  setDrag(null);
                  if (drag.frame === key.frame && drag.value === key.value) onSelect(key);
                  else change(key.frame, { frame: drag.frame, value: drag.value });
                }}
                onPointerCancel={() => { setDrag(null); }}
                onFocus={() => {
                  if (moved !== null) setMoved(null);
                }}
                onKeyDown={(event) => { nudge(event, key); }}
              />
            );
          })}
        </svg>
      ) : null}
      <GraphPlayhead owner={owner} width={width} />
      <span aria-hidden className={cn(AXIS_LABEL, "top-0.5")}>
        {formatShown(unit, scale.high)}
      </span>
      <span aria-hidden className={cn(AXIS_LABEL, "bottom-0.5")}>
        {formatShown(unit, scale.low)}
      </span>
    </div>
  );
}
