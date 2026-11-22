import { hasSlotContent } from "@/lib/dom";
import type { LucideIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { ActiveIndicator } from "@/components/ui/active-indicator";
import { StableLabel } from "@/components/ui/stable-label";
import { cn } from "@/lib/cn";
import { useFitLevel } from "@/lib/useFitLevel";

export interface PanelTabItem<Id extends string = string> {
  id: Id;
  label: string;
  icon?: LucideIcon;
  count?: number | null;
  /** Semantic color of the count (for example an error count). */
  countTone?: "neutral" | "danger" | "warning";
}

export type PanelTabsVariant = "header" | "underline" | "studio";

/** The 44 px strip (height, rule) the tabs and the actions share: tabs are large and clearly marked. */
const FRAME_CLASS: Record<PanelTabsVariant, string> = {
  header: "h-full",
  underline: "h-11 shrink-0 border-b border-line-subtle",
  studio: "h-11 shrink-0 border-b border-line-subtle",
};
const LIST_CLASS: Record<PanelTabsVariant, string> = {
  header: "",
  underline: "gap-0.5 px-1.5",
  studio: "px-1 [scrollbar-width:none]",
};
const TONE_CLASS = { danger: "bg-danger/15 text-danger", warning: "bg-warning/15 text-warning" } as const;

/**
 * A strip narrower than its tabs collapses by measurement (useFitLevel), so it holds for every language and label; a
 * strip that fits looks exactly as before.
 * 1: tighter padding (often enough on its own, and nothing is hidden);
 * 2: also no icons, neutral counts only for screen readers (still part of the tab's name; a danger or warning count
 *    stays, it is a status);
 * 3: when not even that fits one row, the tighter tabs wrap onto more rows, icons and counts back (the rows give them
 *    room); the sliding underline (it only moves sideways) hides and the selected tab draws its own.
 */
const FIT_LEVELS = 3;
const FIT_PADDING: Record<PanelTabsVariant, readonly [string, string]> = {
  header: ["px-4", "px-2.5"],
  underline: ["px-3", "px-2"],
  studio: ["px-3", "px-2"],
};
/** Each row keeps the strip's 36 px height (the studio pills keep their 4 px margin). */
const ROW_CLASS: Record<PanelTabsVariant, string> = { header: "min-h-11", underline: "min-h-11", studio: "min-h-9" };
const OWN_UNDERLINE: Record<PanelTabsVariant, string> = {
  header: "after:inset-x-0 after:bottom-0",
  underline: "after:inset-x-0 after:bottom-0",
  studio: "after:inset-x-2.5 after:-bottom-1",
};

function tabClass(variant: PanelTabsVariant, selected: boolean, fit: number): string {
  const padding = FIT_PADDING[variant][fit >= 1 ? 1 : 0];
  const wrapped = fit >= 3 && cn(ROW_CLASS[variant], selected && cn("after:pointer-events-none after:absolute after:h-0.5 after:rounded-full after:bg-brand-gradient", OWN_UNDERLINE[variant]));
  if (variant === "studio") {
    return cn(
      "pressable relative my-1.5 inline-flex shrink-0 items-center gap-2 rounded-lg text-body whitespace-nowrap transition-[background-color,color,box-shadow] duration-(--duration-fast) active:bg-sunken [&_svg]:size-4 [&_svg]:transition-colors [&_svg]:duration-(--duration-fast)",
      padding,
      selected
        ? "bg-brand-gradient-soft font-semibold text-fg shadow-glow-sm ring-1 ring-brand-blue/45 ring-inset [&_svg]:text-brand-cyan"
        : "text-fg-secondary hover:bg-raised/80 hover:text-fg",
      wrapped,
    );
  }
  return cn(
    "relative inline-flex shrink-0 items-center gap-2 text-body whitespace-nowrap transition-colors duration-(--duration-fast) outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-colors [&_svg]:duration-(--duration-fast)",
    padding,
    variant === "header"
      ? selected
        ? "bg-raised font-semibold text-fg"
        : "text-fg-secondary hover:bg-raised/60 hover:text-fg"
      : selected
        ? "bg-brand-gradient-soft font-semibold text-fg"
        : "text-fg-secondary hover:bg-raised/60 hover:text-fg",
    wrapped,
  );
}

function countClass(variant: PanelTabsVariant, tab: PanelTabItem, selected: boolean, fit: number): string {
  const tone = tab.countTone === "danger" || tab.countTone === "warning" ? TONE_CLASS[tab.countTone] : null;
  if (fit === 2 && !tone) return "sr-only";
  if (variant === "studio") {
    return cn("machine min-w-4 rounded-full px-1 text-center text-[11px] leading-4", tone ?? (selected ? "bg-brand-blue/20 text-fg-secondary" : "bg-raised text-fg-tertiary"));
  }
  return cn("machine rounded-full px-1.5 text-caption font-normal", tone ?? "bg-overlay text-fg-tertiary");
}

/** What the strip shows, for useFitLevel: a change (label, count, language) measures again from level 0. */
function fitContent(tabs: readonly PanelTabItem[]): string {
  return tabs.map((tab) => `${tab.id}\u0000${tab.label}\u0000${String(tab.icon ? 1 : 0)}\u0000${String(tab.count ?? "")}\u0000${tab.countTone ?? ""}`).join("\u0001");
}

/**
 * Panel tabs (APG tabs: one Tab stop, arrow keys / Home / End select as they move focus). The caller renders each tab
 * panel with id=`${idPrefix}-panel-${id}` and aria-labelledby=`${idPrefix}-tab-${id}`.
 * - header: inside a 36 px panel header (inspector, provider library, bottom dock).
 * - underline: sub-tabs inside a panel (properties / inputs / outputs).
 * - studio: the Studio panels' strip: pill tabs, a brand-gradient underline inset by 10 px, and a count chip that turns
 *   blue on the selected tab.
 * `actions` (for example a collapse button) sit at the right end of the strip, outside the tablist. The underline
 * slides to the new tab and the tab panel fades in (ActiveIndicator).
 * Narrower than its tabs, the strip collapses (FIT_LEVELS). Without actions the tablist is the strip itself: the caller
 * gives it its width (a column stretches it; in a row give it `flex-1`), and a parent with a fixed height uses
 * `min-h-9` so a wrapped strip can grow.
 */
export function PanelTabs<Id extends string>({
  tabs,
  value,
  onChange,
  idPrefix,
  label,
  variant = "header",
  actions,
  className,
}: {
  tabs: readonly PanelTabItem<Id>[];
  value: string;
  onChange: (id: Id) => void;
  idPrefix: string;
  label: string;
  variant?: PanelTabsVariant;
  actions?: ReactNode;
  className?: string;
}) {
  const refsRef = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const studio = variant === "studio";
  const framed = studio || actions !== undefined;
  const fit = useFitLevel(listRef, FIT_LEVELS, fitContent(tabs));
  const wrapped = fit >= 3;
  const focusAt = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    onChange(tab.id);
    refsRef.current.get(tab.id)?.focus();
  };
  const list = (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      data-fit={fit}
      className={cn(
        "relative flex min-w-0 items-stretch overflow-x-auto",
        LIST_CLASS[variant],
        framed ? "flex-1" : cn(FRAME_CLASS[variant], className),
        wrapped && cn("flex-wrap", !framed && "h-auto"),
      )}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        const Icon = fit === 2 ? undefined : tab.icon;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) refsRef.current.set(tab.id, node);
              else refsRef.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => { onChange(tab.id); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") focusAt(index + 1);
              else if (event.key === "ArrowLeft") focusAt(index - 1);
              else if (event.key === "Home") focusAt(0);
              else if (event.key === "End") focusAt(tabs.length - 1);
              else return;
              event.preventDefault();
            }}
            className={tabClass(variant, selected, fit)}
          >
            {Icon ? <Icon aria-hidden className={studio ? undefined : selected ? "text-action-fg" : "text-fg-tertiary"} /> : null}
            {/* Every variant draws the selected tab in font-semibold, so the hidden copy reserves that weight: a tab is
                as wide selected as not, and switching tabs never changes what the strip needs (with a lighter copy the
                selected tab grew, and a strip near its fit threshold collapsed when one tab was selected) */}
            <StableLabel weight="semibold">{tab.label}</StableLabel>
            {tab.count !== undefined && tab.count !== null ? <span className={countClass(variant, tab, selected, fit)}>{tab.count}</span> : null}
          </button>
        );
      })}
      {studio ? (
        <ActiveIndicator container={listRef} edge="bottom" inset={10} className={cn("bg-brand-gradient forced-colors:bg-none", wrapped && "hidden")} />
      ) : (
        <ActiveIndicator container={listRef} edge="bottom" {...(wrapped ? { className: "hidden" } : {})} />
      )}
    </div>
  );
  if (!framed) return list;
  return (
    <div className={cn("flex min-w-0 items-stretch", FRAME_CLASS[variant], className, wrapped && "h-auto min-h-11")}>
      {list}
      {hasSlotContent(actions) ? <div className={cn("ml-auto flex shrink-0 items-center gap-1 pr-1.5 pl-1", wrapped && "h-11 self-start")}>{actions}</div> : null}
    </div>
  );
}
