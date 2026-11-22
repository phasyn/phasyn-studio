// macOS 式分段控制外觀的分頁（APG tabs：單一 Tab 停駐點、←→／Home／End 自動切換；tab id＝`${idPrefix}-tab-${id}`、
// tabpanel id＝`${idPrefix}-panel-${id}` 由呼叫端渲染）。用在少數幾個平行選項（使用中／已封存、core／detailed）：
// 選取的底塊以 snappy 彈簧滑到新選項（useThumb），按下有 pressable 回饋，切換時對應的 tabpanel 短暫淡入。
// 選取狀態永遠由 aria-selected 表達，不等動畫。
import { useLayoutEffect, useRef } from "react";
import { playSwap } from "@/components/ui/motion";
import { StableLabel } from "@/components/ui/stable-label";
import { cn } from "@/lib/cn";
import { useThumb } from "./useThumb";

export interface SegmentedTabItem {
  id: string;
  label: string;
  count?: number | null;
  /** tooltip（例如說明這一類的內容）。 */
  title?: string;
}

export function SegmentedTabs({
  tabs,
  value,
  onChange,
  idPrefix,
  label,
  className,
}: {
  tabs: readonly SegmentedTabItem[];
  value: string;
  onChange: (id: string) => void;
  idPrefix: string;
  label: string;
  className?: string;
}) {
  const refsRef = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(value);
  useThumb(listRef, thumbRef, '[role="tab"][aria-selected="true"]');
  // 選取改變時，對應的 tabpanel 短暫淡入（第一次出現不播放）
  useLayoutEffect(() => {
    if (shownRef.current === value) return;
    shownRef.current = value;
    playSwap(document.getElementById(`${idPrefix}-panel-${value}`));
  }, [value, idPrefix]);
  const focusAt = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    onChange(tab.id);
    refsRef.current.get(tab.id)?.focus();
  };
  return (
    <div ref={listRef} role="tablist" aria-label={label} className={cn("relative inline-flex min-w-0 shrink-0 rounded-lg border border-line-control/70 bg-sunken p-0.5", className)}>
      <span
        ref={thumbRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-md border border-white/[0.07] bg-overlay opacity-0 shadow-[0_1px_2px_rgb(0_0_0/0.4),inset_0_1px_0_rgb(255_255_255/0.06)] transition-[transform,width,height,opacity] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)"
      />
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
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
            title={tab.title}
            onClick={() => { onChange(tab.id); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") focusAt(index + 1);
              else if (event.key === "ArrowLeft") focusAt(index - 1);
              else if (event.key === "Home") focusAt(0);
              else if (event.key === "End") focusAt(tabs.length - 1);
              else return;
              event.preventDefault();
            }}
            className={cn(
              "pressable relative z-[1] inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-3 text-caption whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-focus",
              selected ? "text-fg" : "text-fg-tertiary hover:text-fg-secondary",
            )}
          >
            <StableLabel weight="medium" {...(selected ? { className: "font-medium" } : {})}>
              {tab.label}
            </StableLabel>
            {tab.count !== undefined && tab.count !== null ? <span className="machine rounded-full bg-overlay px-1.5 text-[11px] leading-4 text-fg-tertiary">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
