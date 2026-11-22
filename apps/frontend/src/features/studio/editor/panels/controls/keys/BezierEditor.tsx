// The easing of a Bezier key: the curve from the key (bottom left) to the next one (top right) with its two handles.
// BezierEditor: a handle is dragged (committed once, on release) or moved with the arrow keys by 0.01 (Shift: 0.1).
// BezierFields: the same four numbers as fields, where the strip has room for them.
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { NumberField } from "../fields";
import { roundTo } from "../numbers";
import type { CommitHandler } from "../useFieldDraft";

/** Room around the unit square, in px. */
const PAD = 10;
const HANDLES = [0, 1] as const;
type Handle = (typeof HANDLES)[number];

function unit(value: number): number {
  return Math.max(0, Math.min(1, roundTo(value, 3)));
}

/** The controls with one handle at another place: handle 0 is [x1, y1], handle 1 is [x2, y2]. */
function withHandle(value: readonly number[], handle: Handle, x: number, y: number): number[] {
  return [0, 1, 2, 3].map((index) => (index === handle * 2 ? unit(x) : index === handle * 2 + 1 ? unit(y) : (value[index] ?? 0)));
}

export interface BezierEditorProps {
  /** [x1, y1, x2, y2] between (0, 0) and (1, 1): time and progress of the outgoing and of the incoming handle. */
  value: readonly number[];
  /** Side of the square, in px. */
  size: number;
  /** Why the handles cannot be changed; null when they can. */
  locked: string | null;
  onChange: (value: number[]) => void;
}

export function BezierEditor({ value, size, locked, onChange }: BezierEditorProps) {
  const [drag, setDrag] = useState<number[] | null>(null);
  const shown = drag ?? value;
  const side = Math.max(1, size - 2 * PAD);
  const px = (time: number) => PAD + time * side;
  const py = (progress: number) => PAD + (1 - progress) * side;
  const point = (handle: Handle) => ({ x: shown[handle * 2] ?? 0, y: shown[handle * 2 + 1] ?? 0 });
  const out = point(0);
  const into = point(1);

  const at = (event: PointerEvent<SVGCircleElement>, handle: Handle): number[] => {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box) return [...value];
    return withHandle(value, handle, (event.clientX - box.left - PAD) / side, 1 - (event.clientY - box.top - PAD) / side);
  };
  const nudge = (event: KeyboardEvent<SVGCircleElement>, handle: Handle) => {
    const amount = event.shiftKey ? 0.1 : 0.01;
    const byX = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
    const byY = event.key === "ArrowDown" ? -amount : event.key === "ArrowUp" ? amount : 0;
    if (byX === 0 && byY === 0) return;
    event.preventDefault();
    if (!(locked != null && locked !== "") && !event.repeat) onChange(withHandle(value, handle, (value[handle * 2] ?? 0) + byX, (value[handle * 2 + 1] ?? 0) + byY));
  };

  if (size < 4 * PAD) return null;
  const start = `${String(px(0))},${String(py(0))}`;
  const end = `${String(px(1))},${String(py(1))}`;
  const outgoing = `${String(px(out.x))},${String(py(out.y))}`;
  const incoming = `${String(px(into.x))},${String(py(into.y))}`;
  return (
    <svg
      width={size}
      height={size}
      role="group"
      aria-label={t("貝茲曲線控制柄")}
      className="shrink-0 touch-none rounded-md border border-line-subtle bg-sunken"
    >
      <path d={`M${start}L${end}`} className="fill-none stroke-line-subtle" strokeWidth="1" />
      <path d={`M${start}L${outgoing}M${end}L${incoming}`} className="fill-none stroke-brand-violet" strokeWidth="1" />
      <path d={`M${start}C${outgoing} ${incoming} ${end}`} className="fill-none stroke-brand-cyan" strokeWidth="1.5" />
      {HANDLES.map((handle) => {
        const { x, y } = point(handle);
        return (
          <circle
            key={handle}
            cx={px(x)}
            cy={py(y)}
            r="5"
            tabIndex={0}
            role="slider"
            aria-label={handle === 0 ? t("出柄") : t("入柄")}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={x}
            aria-valuetext={t("時間 {x}，進度 {y}", { x: x.toFixed(2), y: y.toFixed(2) })}
            strokeWidth="1.5"
            className={cn("fill-brand-violet stroke-sunken outline-none focus-visible:stroke-focus", !(locked != null && locked !== "") && "cursor-grab active:cursor-grabbing")}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              if (locked != null && locked !== "") return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag([...value]);
            }}
            onPointerMove={(event) => {
              if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) setDrag(at(event, handle));
            }}
            onPointerUp={(event) => {
              if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              event.currentTarget.releasePointerCapture(event.pointerId);
              setDrag(null);
              onChange(at(event, handle));
            }}
            onPointerCancel={() => { setDrag(null); }}
            onKeyDown={(event) => { nudge(event, handle); }}
          />
        );
      })}
    </svg>
  );
}

const FIELDS: readonly { index: number; label: string }[] = [
  { index: 0, label: t("出柄時間") },
  { index: 1, label: t("出柄進度") },
  { index: 2, label: t("入柄時間") },
  { index: 3, label: t("入柄進度") },
];

export interface BezierFieldsProps {
  value: readonly number[];
  /** Applies the controls; the answer is the field's: true, or why they were refused. */
  onChange: CommitHandler<number[]>;
}

/** The two handles as numbers: a row per handle, a column for its time and one for its progress. */
export function BezierFields({ value, onChange }: BezierFieldsProps) {
  const field = ({ index, label }: { index: number; label: string }) => (
    <NumberField
      key={index}
      label={label}
      value={value[index] ?? 0}
      min={0}
      max={1}
      decimals={2}
      step={0.01}
      onCommit={(next) => onChange([0, 1, 2, 3].map((at) => (at === index ? next : (value[at] ?? 0))))}
    />
  );
  return (
    <div className="grid shrink-0 grid-cols-[auto_auto_auto] content-center items-center gap-x-1.5 gap-y-1 text-caption text-fg-tertiary">
      <span aria-hidden />
      <span>{t("時間")}</span>
      <span>{t("進度")}</span>
      <span>{t("出柄")}</span>
      {FIELDS.slice(0, 2).map(field)}
      <span>{t("入柄")}</span>
      {FIELDS.slice(2).map(field)}
    </div>
  );
}
