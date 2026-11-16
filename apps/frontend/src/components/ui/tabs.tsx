import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ActiveIndicator } from "./active-indicator";

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

/**
 * WAI-ARIA tabs：單一可 Tab 停駐點，方向鍵／Home／End 切換並自動啟用（面板內容即時呈現）。
 * 目前分頁的頂線（品牌漸層）會滑到新分頁，對應的 tabpanel 短暫淡入。
 */
export function Tabs({
  items,
  value,
  onChange,
  idPrefix,
  label,
  className,
  size = "md",
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  idPrefix: string;
  label: string;
  className?: string;
  /** sm：窄面板（例如 360 px 檢視器）用的緊湊頁籤。 */
  size?: "md" | "sm";
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const focusTab = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onChange(item.id);
    refs.current.get(item.id)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") focusTab(index + 1);
    else if (event.key === "ArrowLeft") focusTab(index - 1);
    else if (event.key === "Home") focusTab(0);
    else if (event.key === "End") focusTab(items.length - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div ref={listRef} role="tablist" aria-label={label} className={cn("relative flex shrink-0 overflow-x-auto border-b border-line", size === "sm" ? "gap-0" : "gap-1", className)}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) refs.current.set(item.id, node);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex shrink-0 items-center border-t-2 border-t-transparent whitespace-nowrap transition-colors duration-(--duration-fast)",
              size === "sm" ? "min-h-9 gap-1.5 px-2 text-data [&_svg]:size-3.5" : "min-h-10 gap-2 px-3 text-body [&_svg]:size-4",
              selected ? "bg-surface text-fg [&_svg]:text-action-fg" : "text-fg-secondary hover:bg-raised/70 hover:text-fg",
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined ? <span className="machine text-caption text-fg-tertiary">{item.count}</span> : null}
          </button>
        );
      })}
      <ActiveIndicator container={listRef} edge="top" />
    </div>
  );
}

export function TabPanel({ idPrefix, id, children, className }: { idPrefix: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
