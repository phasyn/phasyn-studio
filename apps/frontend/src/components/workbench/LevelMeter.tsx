// A vertical level meter bar and its scale. The bar is a dark track with a fill whose colour zones stay at their place
// on the scale (normal, hot, over), a line for the held peak and tick lines. It is driven through its handle instead of
// props: a meter changes on every animation frame, and that must not re-render React. The bar never eases on its own;
// whoever samples the signal moves it frame by frame. LevelScale prints the dB labels that go beside one or more bars.
import { useImperativeHandle, useRef, type Ref } from "react";
import { cn } from "@/lib/cn";

const EMPTY_ITEMS = [] as const;

export interface LevelMeterHandle {
  /** Show a level and a held peak, both in dB; -Infinity (or anything below the bar's range) shows nothing. */
  set: (level: number, peak: number) => void;
}

export interface LevelRangeProps {
  /** dB at the bottom of the bar. */
  min?: number;
  /** dB at the top of the bar. */
  max?: number;
}

export interface LevelMeterProps extends LevelRangeProps {
  ref?: Ref<LevelMeterHandle>;
  /** From this level the fill is drawn in the "hot" colour. */
  hotFrom?: number;
  /** From this level the fill is drawn in the "over" colour. */
  overFrom?: number;
  /** dB values that get a tick line across the bar. */
  ticks?: readonly number[];
  className?: string;
}

const DEFAULT_MIN = -60;
const DEFAULT_MAX = 0;

/** Where a level sits on the bar: 0 at the bottom, 1 at the top. */
function fraction(level: number, min: number, max: number): number {
  if (!(level > min)) return 0;
  return Math.min(1, (level - min) / (max - min));
}

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

export function LevelMeter({ ref, min = DEFAULT_MIN, max = DEFAULT_MAX, hotFrom = -12, overFrom = -3, ticks = EMPTY_ITEMS, className }: LevelMeterProps) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const heldRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef({ level: 0, peak: 0 });
  useImperativeHandle(
    ref,
    () => ({
      set(level, peak) {
        const next = { level: fraction(level, min, max), peak: fraction(peak, min, max) };
        if (next.level !== shownRef.current.level && fillRef.current) fillRef.current.style.clipPath = `inset(${percent(1 - next.level)} 0 0 0)`;
        if (next.peak !== shownRef.current.peak && heldRef.current) {
          heldRef.current.style.transform = `translateY(${percent(1 - next.peak)})`;
          heldRef.current.style.opacity = next.peak > 0 ? "1" : "0";
        }
        shownRef.current = next;
      },
    }),
    [min, max],
  );
  const hot = fraction(hotFrom, min, max);
  const over = fraction(overFrom, min, max);
  return (
    <span aria-hidden className={cn("relative block min-h-0 overflow-hidden rounded-[3px] border border-line-subtle bg-sunken", className)}>
      <span ref={fillRef} className="absolute inset-0" style={{ clipPath: "inset(100% 0 0 0)" }}>
        <span className="absolute inset-x-0 bottom-0 bg-success" style={{ height: percent(hot) }} />
        <span className="absolute inset-x-0 bg-warning" style={{ bottom: percent(hot), height: percent(over - hot) }} />
        <span className="absolute inset-x-0 top-0 bg-danger" style={{ height: percent(1 - over) }} />
      </span>
      {ticks.map((tick) => (
        <span key={tick} className="absolute inset-x-0 h-px bg-surface/85" style={{ bottom: percent(fraction(tick, min, max)) }} />
      ))}
      <span ref={heldRef} className="absolute inset-0 opacity-0">
        <span className="absolute inset-x-0 top-0 h-0.5 bg-fg" />
      </span>
    </span>
  );
}

export interface LevelScaleProps extends LevelRangeProps {
  /** dB values to label (printed without their sign: a level scale only counts down from the top). */
  ticks: readonly number[];
  className?: string;
}

/** The labels of a level scale, aligned with the tick lines of a LevelMeter of the same height and range. */
export function LevelScale({ min = DEFAULT_MIN, max = DEFAULT_MAX, ticks, className }: LevelScaleProps) {
  return (
    <span aria-hidden className={cn("relative block min-h-0", className)}>
      {ticks.map((tick) => {
        const at = fraction(tick, min, max);
        // The labels at the two ends stay inside the scale; the others are centred on their tick
        const shift = at >= 0.98 ? "translate-y-0" : at <= 0.02 ? "-translate-y-full" : "-translate-y-1/2";
        return (
          <span key={tick} className={cn("machine absolute right-0 text-[10px] leading-none whitespace-nowrap text-fg-tertiary", shift)} style={{ top: percent(1 - at) }}>
            {Math.abs(tick)}
          </span>
        );
      })}
    </span>
  );
}
