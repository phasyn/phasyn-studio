// One field of the shot's generation settings (GenerationRow.tsx, a 2×2 grid): a framed 40 px field with its label on
// top and its value below, opening the field's popover. The value truncates; the accessible name and the tooltip carry
// all of it. A value that cannot render as it is gets the warning frame and icon; the reason is said once, in the
// settings' status line, which the field names as its description (`describedBy`).
// Motion: press is pressable; hover and open change the frame on the shared fast transition; open tints the field and turns the
// chevron over (snappy spring).
import { ChevronDown, TriangleAlert, type LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export function SegmentButton({
  label,
  value,
  valueText,
  icon: Icon,
  warning = false,
  describedBy,
  open,
  popoverId,
  title,
  onClick,
  className,
  ref,
}: {
  label: string;
  value: ReactNode;
  /** The value as words (accessible name). */
  valueText: string;
  icon?: LucideIcon;
  /** The value cannot render as it is (the reason is in the element `describedBy` names). */
  warning?: boolean;
  /** Id of the element that says why (the settings' status line). */
  describedBy?: string;
  open: boolean;
  popoverId: string;
  /** Tooltip; defaults to the value. */
  title?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  const ValueIcon = warning ? TriangleAlert : Icon;
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popoverId : undefined}
      aria-label={t("{label}：{value}", { label, value: valueText })}
      aria-describedby={describedBy}
      title={title ?? valueText}
      onClick={onClick}
      className={cn(
        "pressable group/seg grid h-10 min-w-0 content-center rounded-lg border bg-sunken/40 px-3 text-left",
        "hover:bg-raised/70 active:bg-sunken",
        warning ? "border-warning/45 hover:border-warning/70" : "border-line-subtle hover:border-line",
        "aria-expanded:border-brand-blue/55 aria-expanded:bg-brand-gradient-soft",
        className,
      )}
    >
      <span className="truncate text-caption leading-4 text-fg-tertiary">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-data leading-5 text-fg">
        {ValueIcon ? <ValueIcon aria-hidden className={cn("size-3.5 shrink-0", warning ? "text-warning" : "text-brand-cyan/80")} /> : null}
        <span className="min-w-0 truncate">{value}</span>
        <ChevronDown
          aria-hidden
          className="ml-auto size-3.5 shrink-0 text-fg-tertiary transition-transform duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) group-aria-expanded/seg:rotate-180"
        />
      </span>
    </button>
  );
}
