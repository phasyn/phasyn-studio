// A small segmented choice (Seed: 每次隨機｜固定; variants: how many new random seeds): equal cells, the chosen one marked
// by a thumb that slides over with the snappy spring (transform only). Native radios: the arrow keys move and choose.
// `autofocus` marks the chosen radio as the one a popover focuses when it opens (data-autofocus, Popover.tsx).
import type { CSSProperties, ReactNode } from "react";
import { SPRING_SNAPPY } from "@/components/ui/look";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** The thumb: cells are equal, so it is placed by index alone (its own width plus the 2 px gap per step). */
function thumbStyle(index: number, count: number): CSSProperties {
  return { width: `calc((100% - ${4 + (count - 1) * 2}px) / ${count})`, transform: `translateX(calc(${index} * (100% + 2px)))` };
}

export function Segmented<T extends string | number>({
  name,
  label,
  value,
  options,
  onChange,
  className,
  autofocus = false,
}: {
  name: string;
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  autofocus?: boolean;
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("relative grid gap-0.5 rounded-lg border border-line-control bg-sunken p-0.5", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 rounded-md bg-brand-gradient-soft shadow-edge ring-1 ring-brand-blue/55 ring-inset transition-transform forced-colors:bg-none forced-colors:ring-[Highlight]",
          SPRING_SNAPPY,
        )}
        style={thumbStyle(index, options.length)}
      />
      {options.map((option) => (
        <label
          key={String(option.value)}
          title={option.title}
          className={cn(
            "pressable relative z-[1] inline-flex h-8 min-w-0 cursor-pointer items-center justify-center rounded-md px-2 text-data whitespace-nowrap has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
            option.value === value ? "font-medium text-fg" : "text-fg-tertiary hover:text-fg-secondary",
          )}
        >
          <input
            type="radio"
            name={name}
            value={String(option.value)}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
            data-autofocus={autofocus && option.value === value ? "" : undefined}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
