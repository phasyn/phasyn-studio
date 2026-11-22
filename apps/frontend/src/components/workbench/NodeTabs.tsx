import { Server } from "lucide-react";
import { useRef } from "react";
import { ActiveIndicator } from "@/components/ui/active-indicator";
import { cn } from "@/lib/cn";
import { DOT_TONE, type Tone } from "./tones";

export interface NodeTabItem {
  id: string;
  label: string;
  /** tooltip（完整名稱、node_id、連線狀態）。 */
  title?: string;
  count?: number | null;
  /** 連線狀態點；文字（dotLabel）同時給輔助技術，顏色不是唯一線索。 */
  dot: Tone;
  dotLabel: string;
  /** 離線（資料過時）：文字降一級。 */
  muted?: boolean;
}

/**
 * Node 分頁（APG tabs：單一 Tab 停駐點，方向鍵／Home／End 移動並啟用）。
 * horizontal：頁首下方的分頁列（底線標示）；vertical：窄欄（左側導覽）裡的整列分頁（選取底＋左側標記）。
 * 對應的 tabpanel 由呼叫端渲染（id＝panelId，aria-labelledby＝`${idPrefix}-tab-${id}`）。
 * 底線（水平）或左側標記（垂直）會滑到新的 Node。
 */
export function NodeTabs({
  items,
  value,
  onChange,
  idPrefix,
  label,
  orientation = "horizontal",
  panelId,
  className,
}: {
  items: readonly NodeTabItem[];
  value: string | null;
  onChange: (id: string) => void;
  idPrefix: string;
  label: string;
  orientation?: "horizontal" | "vertical";
  panelId?: string;
  className?: string;
}) {
  const refsRef = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const vertical = orientation === "vertical";
  const focusAt = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onChange(item.id);
    refsRef.current.get(item.id)?.focus();
  };
  const selectedIndex = items.findIndex((item) => item.id === value);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      className={cn("relative", vertical ? "grid content-start gap-0.5" : "flex min-w-0 items-stretch gap-0.5 overflow-x-auto", className)}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        // 沒有選取任何分頁時，第一個分頁是 Tab 停駐點。
        const tabbable = selected || (selectedIndex < 0 && index === 0);
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) refsRef.current.set(item.id, node);
              else refsRef.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={selected ? panelId : undefined}
            tabIndex={tabbable ? 0 : -1}
            title={item.title ?? item.label}
            onClick={() => { onChange(item.id); }}
            onKeyDown={(event) => {
              if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) focusAt(index + 1);
              else if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) focusAt(index - 1);
              else if (event.key === "Home") focusAt(0);
              else if (event.key === "End") focusAt(items.length - 1);
              else return;
              event.preventDefault();
            }}
            className={cn(
              "relative flex min-w-0 items-center gap-2 text-data whitespace-nowrap transition-colors duration-(--duration-fast) outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-colors [&_svg]:duration-(--duration-fast)",
              vertical ? "h-8 w-full rounded-md pr-2 pl-2.5 text-left" : "h-9 shrink-0 px-3",
              selected
                ? vertical
                  ? "bg-brand-gradient-soft font-semibold text-fg"
                  : "font-semibold text-fg"
                : vertical
                  ? "text-fg-secondary hover:bg-raised hover:text-fg"
                  : "text-fg-secondary hover:bg-raised/60 hover:text-fg",
            )}
          >
            <Server aria-hidden className={selected ? "text-action-fg" : "text-fg-tertiary"} />
            <span className={cn("min-w-0 truncate", vertical && "flex-1", (item.muted === true) && !selected && "text-fg-tertiary")}>{item.label}</span>
            {item.count !== undefined && item.count !== null ? (
              <span className="machine shrink-0 rounded-full bg-overlay px-1.5 text-caption font-normal text-fg-tertiary">{item.count}</span>
            ) : null}
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_TONE[item.dot])} />
            <span className="sr-only">{item.dotLabel}</span>
          </button>
        );
      })}
      {vertical ? <ActiveIndicator container={listRef} edge="left" inset={4} /> : <ActiveIndicator container={listRef} edge="bottom" />}
    </div>
  );
}
