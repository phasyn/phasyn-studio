// A group of panels that share one frame: a 44 px tab strip (PanelTabs, studio variant) over the selected panel. The
// group collapses to a 44 px rail of its tab icons; choosing an icon expands it on that tab. The frame can show that
// it has the keyboard focus (a 1 px brand-cyan border).
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { PANEL, TOOL_BUTTON } from "@/components/ui/look";
import { notePanelToggle, useContentSwapMotion, usePanelEnter } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { PanelTabs } from "./PanelTabs";

export interface PanelGroupTab {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number | null;
  countTone?: "neutral" | "danger" | "warning";
}

export interface PanelGroupProps {
  /** Prefix of the tab and tab-panel ids. */
  idPrefix: string;
  /** Name of the group (the tablist's name, and what collapse / expand announce). */
  label: string;
  tabs: readonly PanelGroupTab[];
  value: string;
  onChange: (id: string) => void;
  /** Which edge the group sits on: the collapse button points there and the panel fades in from there. */
  side: "left" | "right";
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Draws the focus frame. */
  focused?: boolean;
  /** Extra controls in the tab strip, left of the collapse button. */
  actions?: ReactNode;
  /** Attributes for the frame (for example a data attribute naming the panel for a key map). */
  frameProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>;
  className?: string;
  /** The selected panel. */
  children: ReactNode;
}

export function PanelGroup({ idPrefix, label, tabs, value, onChange, side, collapsed, onCollapsedChange, focused = false, actions, frameProps, className, children }: PanelGroupProps) {
  const enter = usePanelEnter<HTMLElement>(label, collapsed ? "none" : side);
  const swap = useContentSwapMotion<HTMLDivElement>();
  const current = tabs.find((tab) => tab.id === value) ?? tabs[0];
  const toggle = (next: boolean) => {
    notePanelToggle(label);
    onCollapsedChange(next);
  };
  if (collapsed) {
    const Expand = side === "left" ? PanelLeftOpen : PanelRightOpen;
    return (
      <section ref={enter} aria-label={label} {...frameProps} className={cn("flex min-h-0 w-11 shrink-0 flex-col items-center gap-1 overflow-hidden rounded-xl border border-line-subtle bg-surface py-1.5 shadow-edge", className)}>
        <button type="button" data-panel-toggle="" className={cn(TOOL_BUTTON, "size-9 [&_svg]:size-4")} aria-label={t("展開{label}", { label })} title={t("展開{label}", { label })} onClick={() => toggle(false)}>
          <Expand aria-hidden />
        </button>
        <span aria-hidden className="h-px w-6 bg-line-subtle" />
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cn(TOOL_BUTTON, "size-9 [&_svg]:size-4", tab.id === current?.id && "text-brand-cyan")}
            aria-label={t("展開{label}：{tab}", { label, tab: tab.label })}
            title={tab.label}
            onClick={() => {
              onChange(tab.id);
              toggle(false);
            }}
          >
            <tab.icon aria-hidden />
          </button>
        ))}
      </section>
    );
  }
  const Collapse = side === "left" ? PanelLeftClose : PanelRightClose;
  return (
    <section ref={enter} aria-label={label} {...frameProps} className={cn(PANEL, focused && "border-brand-cyan/70", className)}>
      <PanelTabs
        variant="studio"
        idPrefix={idPrefix}
        label={label}
        value={current?.id ?? ""}
        onChange={onChange}
        tabs={tabs}
        actions={
          <span className="flex items-center gap-1 pr-1">
            {actions}
            <button type="button" data-panel-toggle="" className={cn(TOOL_BUTTON, "text-fg-tertiary")} aria-label={t("收合{label}", { label })} title={t("收合{label}", { label })} onClick={() => toggle(true)}>
              <Collapse aria-hidden />
            </button>
          </span>
        }
      />
      <div ref={swap} className="flex min-h-0 flex-1 flex-col">
        {current ? (
          <div key={current.id} role="tabpanel" id={`${idPrefix}-panel-${current.id}`} aria-labelledby={`${idPrefix}-tab-${current.id}`} className="flex min-h-0 flex-1 flex-col">
            {children}
          </div>
        ) : null}
      </div>
    </section>
  );
}
