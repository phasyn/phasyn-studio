// One field of the generation row: a small label over its value, opening the field's popover (36 px; the row is 40 px).
// The row is the container `genrow` (GenerationRow.tsx): under 22.5rem of width a field shows its compact value and no
// chevron, so the row stays one line. The value truncates; the accessible name and the tooltip carry all of it. A
// warning dot marks a value that cannot render as it is, with the reason in the tooltip and the accessible description
// (and in the popover). Motion: press is pressable; open tints the field and turns the chevron over (snappy spring).
import { ChevronDown, type LucideIcon } from "lucide-react";
import { useId, type MouseEvent, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export function SegmentButton({
  label,
  value,
  compactValue,
  valueText,
  icon: Icon,
  warning = null,
  open,
  popoverId,
  title,
  onClick,
  className,
  ref,
}: {
  label: string;
  value: ReactNode;
  /** What a narrow row shows instead of `value`; omitted = the same. */
  compactValue?: ReactNode;
  /** The value as words (accessible name). */
  valueText: string;
  icon?: LucideIcon;
  /** Why the value cannot render as it is; null = it can. */
  warning?: string | null;
  open: boolean;
  popoverId: string;
  /** Tooltip; defaults to the value. */
  title?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  const warningId = useId();
  const tip = title ?? valueText;
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popoverId : undefined}
      aria-label={t("{label}：{value}", { label, value: valueText })}
      aria-describedby={warning ? warningId : undefined}
      title={warning ? `${tip}\n${warning}` : tip}
      onClick={onClick}
      className={cn(
        "pressable group/seg relative grid h-9 min-w-0 content-center rounded-md px-2 text-left hover:bg-raised/70 active:bg-sunken",
        "aria-expanded:bg-brand-gradient-soft aria-expanded:ring-1 aria-expanded:ring-brand-blue/45 aria-expanded:ring-inset",
        className,
      )}
    >
      <span className="truncate text-[11px] leading-3.5 text-fg-tertiary">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-data leading-[18px] text-fg">
        {Icon ? <Icon aria-hidden className="size-3.5 shrink-0 text-brand-cyan/80" /> : null}
        {compactValue === undefined ? (
          <span className="min-w-0 truncate">{value}</span>
        ) : (
          <>
            <span className="min-w-0 truncate @max-[22.5rem]/genrow:hidden">{value}</span>
            <span className="hidden min-w-0 truncate @max-[22.5rem]/genrow:block">{compactValue}</span>
          </>
        )}
        <ChevronDown
          aria-hidden
          className="ml-auto size-3 shrink-0 text-fg-tertiary transition-transform duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) group-aria-expanded/seg:rotate-180 @max-[22.5rem]/genrow:hidden"
        />
      </span>
      {warning ? (
        <>
          <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warning ring-2 ring-warning/20 animate-fade-in" />
          <span id={warningId} className="sr-only">
            {warning}
          </span>
        </>
      ) : null}
    </button>
  );
}
