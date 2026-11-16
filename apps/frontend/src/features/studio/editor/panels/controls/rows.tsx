// The rows of the property panels. A row is one line: a label and its controls and, in Effect Controls, the keyframe
// lane of that row beside it. The row and its lane are the two cells of one grid row whose first column has the
// panel's fixed width (--ec-props), so they cannot drift apart, even when a refused value puts its reason on a line
// under the row. Controls are direct children of the row: it wraps instead of clipping when a panel is dragged very
// narrow. IconButton and TextButton are the 28 px and the labelled button of rows and headers.
import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { LIST_ROW, LIST_ROW_SELECTED, TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { DensityContext } from "./controlsContext";
import { laneFrameAt } from "./lanes/laneGeometry";
import { RowLayoutContext, useClipPanel } from "./panelContext";
import { ROW_LABEL, ROW_LEAD, UNAVAILABLE } from "./rowLook";

export interface IconButtonProps {
  /** The button's name; also its tooltip unless `title` says more. */
  label: string;
  title?: string;
  /** Why it cannot be used: the button stays focusable and says so. */
  disabledReason?: string | null;
  pressed?: boolean;
  /** The pressed state is announced but not drawn as a lit button (the icon itself shows it). */
  plain?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}

export function IconButton({ label, title, disabledReason, pressed, plain = false, onClick, className, children }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabledReason ? true : undefined}
      title={disabledReason ?? title ?? label}
      onClick={() => {
        if (!disabledReason) onClick();
      }}
      className={cn(TOOL_BUTTON, "text-fg-tertiary", pressed && !plain && TOOL_BUTTON_ON, disabledReason && UNAVAILABLE, className)}
    >
      {children}
    </button>
  );
}

const TEXT_BUTTON =
  "pressable inline-flex max-w-full shrink-0 items-center gap-1 rounded-md border font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0";
const TEXT_BUTTON_SIZE = { compact: "h-6 px-2 text-caption", comfortable: "h-8 px-3 text-data" } as const;
const TEXT_BUTTON_TONE = {
  neutral: "border-line-strong bg-raised text-fg hover:border-action/60 hover:bg-overlay active:bg-sunken",
  danger: "border-danger/40 bg-danger/10 text-danger hover:border-danger/70 hover:bg-danger/15 active:bg-danger/20",
} as const;
const TEXT_BUTTON_UNAVAILABLE =
  "cursor-not-allowed border-line-subtle bg-raised text-fg-disabled hover:border-line-subtle hover:bg-raised active:bg-raised";

export interface TextButtonProps {
  tone?: keyof typeof TEXT_BUTTON_TONE;
  icon?: ReactNode;
  title?: string;
  disabledReason?: string | null;
  onClick: () => void;
  children: ReactNode;
}

/** A labelled button that fits a row: 24 px in Effect Controls, 32 px in the docks. */
export function TextButton({ tone = "neutral", icon, title, disabledReason, onClick, children }: TextButtonProps) {
  const density = useContext(DensityContext);
  return (
    <button
      type="button"
      aria-disabled={disabledReason ? true : undefined}
      title={disabledReason ?? title}
      onClick={() => {
        if (!disabledReason) onClick();
      }}
      className={cn(TEXT_BUTTON, TEXT_BUTTON_SIZE[density], TEXT_BUTTON_TONE[tone], disabledReason && TEXT_BUTTON_UNAVAILABLE)}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

/** The mark of a group or a panel whose values differ from their defaults. */
export function ChangedDot({ className }: { className?: string }) {
  return <span role="img" aria-label={t("已調整")} title={t("已調整")} className={cn("size-1.5 shrink-0 rounded-full bg-brand-cyan", className)} />;
}

/** The lane cell of a row: a press on its empty part moves the playhead there (the keys on it take their own presses). */
function LaneCell({ children }: { children?: ReactNode }) {
  const panel = useClipPanel();
  return (
    <div
      className="relative min-w-0"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        panel.seek(laneFrameAt(panel.clip, event.currentTarget.getBoundingClientRect(), event.clientX));
      }}
    >
      {children}
    </div>
  );
}

export interface RowFrameProps {
  /** What the row's lane shows (the keys of an animated property); without it the lane is empty. */
  lane?: ReactNode;
  /** The row of the selected key, or a chosen group. */
  selected?: boolean;
  /** header: a group's header (32 px, a band across the panel); sub: the header of one effect of the stack. */
  variant?: "row" | "header" | "sub";
  children: ReactNode;
}

export function RowFrame({ lane, selected = false, variant = "row", children }: RowFrameProps) {
  const density = useContext(DensityContext);
  const { lanes } = useContext(RowLayoutContext);
  const frame = useRef<HTMLDivElement>(null);
  // Selecting a key opens the key strip, which takes room from the rows: the row of that key stays in view
  const follows = selected && variant === "row";
  useLayoutEffect(() => {
    if (follows) frame.current?.scrollIntoView({ block: "nearest" });
  }, [follows]);
  return (
    <div
      ref={frame}
      className={cn(
        LIST_ROW,
        // Room for the ruler that sticks to the top of the lanes, when the row is scrolled into view
        "scroll-mt-6",
        lanes && "grid grid-cols-[var(--ec-props)_minmax(0,1fr)]",
        variant === "header" && "-mt-px border-y border-line-subtle bg-raised/60",
        variant === "sub" && "bg-raised/30",
        selected ? LIST_ROW_SELECTED : variant === "row" && "hover:bg-raised/40",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center",
          density === "compact" ? "min-h-7 gap-x-1 pr-1.5 pl-1" : "min-h-9 gap-x-2 px-3",
          variant === "header" && "min-h-8",
        )}
      >
        {children}
      </div>
      {lanes ? <LaneCell>{lane}</LaneCell> : null}
    </div>
  );
}

export interface RowProps {
  label: string;
  /** A fact about the property, for the label's tooltip. */
  hint?: string;
  /** The control is several lines tall (a text box): the label stands beside its first line instead of its middle. */
  tall?: boolean;
  children: ReactNode;
}

/** A property that is not animated: its label and its controls. */
export function Row({ label, hint, tall = false, children }: RowProps) {
  const { lead } = useContext(RowLayoutContext);
  return (
    <RowFrame>
      {lead ? <span aria-hidden className={ROW_LEAD} /> : null}
      <span className={cn(ROW_LABEL, tall && "self-start pt-[11px]")} title={hint ? t("{label}：{hint}", { label, hint }) : label}>
        {label}
      </span>
      {children}
    </RowFrame>
  );
}

/** A row without a label: buttons that act on the group (add, remove, restore). */
export function ActionRow({ children }: { children: ReactNode }) {
  const { lead } = useContext(RowLayoutContext);
  return (
    <RowFrame>
      {lead ? <span aria-hidden className={ROW_LEAD} /> : null}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-0.5">{children}</span>
    </RowFrame>
  );
}
